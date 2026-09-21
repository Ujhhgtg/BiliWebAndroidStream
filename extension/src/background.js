// The former Rust native helper runs as plain JS in this background page
// (see native-api.js): passport QR login/refresh, the PlayViewUnite gRPC
// resolver, and token storage in chrome.storage.local.

// Both Firefox and Chrome (MV3) define the `chrome` namespace with
// promise-based APIs, so the code standardizes on `chrome` and the same
// source builds for both browsers.

const requestOrigins = new Map();

// Two kinds of signed stream URLs flow through the bilivideo hosts and they
// have opposite header requirements:
//   - the page's boot-time `__playinfo__` URLs (platform=pc) only work with
//     completely stock browser headers; mutating them 403s and wedges the
//     player on "Timeout:20s" before the helper's response even arrives.
//   - the Android stream URLs (platform=android) 403 as soon as the request
//     carries a Referer or a desktop User-Agent (the CDN now requires the
//     app's own UA: BILI_APP_UA, defined in native-api.js which loads before
//     this file), on most CDN families (upos-*, cn-*-cm, mountaintoys PCDN)
//     while the mcdn hosts tolerate both.
// So only touch the requests that are actually ours: strip Referer (and the
// Sec-Fetch metadata, which some edges dislike) and send the app User-Agent
// on Android-platform URLs, and leave every other request exactly as the page
// issued it. Origin stays: CDN mirrors echo it into
// Access-Control-Allow-Origin, which the cross-origin segment XHRs need.
// Match the android-platform marker on ANY host: the gRPC reply may return
// PCDN proxies on arbitrary domains (e.g. nexusedgeio.com proxies), which are
// indistinguishable from official CDN hosts by domain alone. The platform
// parameter itself is the precise discriminator (official boot URLs are
// platform=pc and are left untouched).
const ANDROID_URL_FILTER = "[?&]platform=android(_tv_yst)?(&|$)";
const BILI_API_DOMAINS = ["passport.bilibili.com", "api.bilibili.com", "grpc.biliapi.net"];

// Branch on manifest version: Firefox runs this source as MV2 (blocking
// webRequest) while Chrome requires MV3 (declarativeNetRequest). Feature-
// detecting DNR is NOT enough: Firefox 113+ also implements DNR, but its
// initiatorDomains cannot match moz-extension origins, and Chrome MV3 also
// exposes chrome.webRequest (observation only) where blocking listeners
// throw. Only the manifest version separates the two cleanly.
if (chrome.runtime.getManifest().manifest_version >= 3) {
  // Chrome MV3: blocking webRequest is gone; equivalent behavior via
  // declarativeNetRequest session rules. Lookaheads are not RE2, hence the
  // (&|$) form of the android-platform filter. (Checked first: Chrome also
  // exposes chrome.webRequest for observation, so a webRequest check first
  // would misroute Chrome into the listener path below, which throws.)
  const extensionHost = new URL(chrome.runtime.getURL("")).host;
  chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "remove" },
            { header: "Sec-Fetch-Site", operation: "remove" },
            { header: "Sec-Fetch-Mode", operation: "remove" },
            { header: "Sec-Fetch-Dest", operation: "remove" },
            { header: "User-Agent", operation: "set", value: BILI_APP_UA }
          ]
        },
        condition: {
          regexFilter: ANDROID_URL_FILTER,
          resourceTypes: ["xmlhttprequest", "media", "other"]
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "Origin", operation: "remove" }]
        },
        condition: {
          initiatorDomains: [extensionHost],
          requestDomains: BILI_API_DOMAINS,
          resourceTypes: ["xmlhttprequest"]
        }
      }
    ]
  }).catch((error) => console.log('[BiliWAS] DNR setup failed', String(error)));
} else if (chrome.webRequest?.onBeforeSendHeaders) {
  // Firefox: blocking webRequest.
  const stripAndroidHeaders = (details) => {
    if (!/[?&]platform=android(_tv_yst)?(?=&|$)/.test(details.url)) return {};
    return {
      requestHeaders: (details.requestHeaders || [])
        .filter((header) => !["referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"].includes(header.name.toLowerCase()))
        .concat([{ name: "User-Agent", value: BILI_APP_UA }])
    };
  };
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      stripAndroidHeaders,
      { urls: ["*://*/*"] },
      ["blocking", "requestHeaders", "extraHeaders"]
    );
  } catch (_) {
    // Older Firefox builds may reject the extraHeaders option. Retry without it.
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(
        stripAndroidHeaders,
        { urls: ["*://*/*"] },
        ["blocking", "requestHeaders"]
      );
    } catch (_) {
      // Native playback remains usable when request-header filtering is absent.
    }
  }
  // The extension's background fetches carry `Origin: moz-extension://...`,
  // which bilibili's WAF answers with an HTML block page instead of JSON (the
  // page context works because it sends the site origin). Strip the Origin for
  // passport/api requests that originate from this extension; the endpoints
  // are origin-agnostic (they authenticate via signed params / access_key).
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        const originUrl = details.originUrl || details.documentUrl || "";
        if (!originUrl.startsWith("moz-extension://")) return {};
        return {
          requestHeaders: (details.requestHeaders || []).filter(
            (header) => header.name.toLowerCase() !== "origin"
          )
        };
      },
      { urls: ["https://passport.bilibili.com/*", "https://api.bilibili.com/*", "https://grpc.biliapi.net/*"] },
      ["blocking", "requestHeaders"]
    );
  } catch (_) {
    // Without header filtering the WAF may block background requests; the
    // options page calls would fail while page-context playback still works.
  }
}

// Firefox's chrome.runtime.onMessage does not honor promise returns from
// listeners; browser.runtime.onMessage (Chrome: chrome) does.
const messaging = globalThis.browser || globalThis.chrome;
messaging.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return undefined;
  console.log('[BiliWAS] bg message', message.type, 'qn', message.qn ?? '');

  if (message.type === "bili-playurl-request") {
    return BiliNative.resolvePlayUrl({
      bvid: message.bvid || "",
      aid: message.aid == null ? null : Number(message.aid),
      cid: Number(message.cid || 0),
      qn: message.qn == null ? null : Number(message.qn),
      fnval: message.fnval == null ? null : Number(message.fnval),
      fourk: message.fourk == null ? null : Boolean(message.fourk),
      page_url: sender && sender.tab ? sender.tab.url || "" : ""
    }).then((response) => {
      console.log('[BiliWAS] playurl answer type', response.type, 'code', response.code || '', 'quality', response.response?.quality ?? '');
      // Hand the raw Android response to the page bridge: the player's
      // DashBilibiliParser only accepts manifests that carry MP4
      // segment_base ranges, and the page builds the final body by splicing
      // the Android streams into the official web response (which already
      // has every field the parser expects).
      if (response.type === "play_url" && response.response) {
        return { ok: true, android: response.response, requestedQuality: message.qn };
      }
      return response;
    }).catch((error) => ({
      ok: false,
      code: "resolve_failed",
      message: String(error)
    }));
  }

  if (message.type === "token-clear") {
    return BiliNative.clearToken()
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "storage_error", message: String(error) }));
  }

  if (message.type === "helper-info") {
    return Promise.resolve(BiliNative.info());
  }

  if (message.type === "helper-status") {
    return BiliNative.tokenStatus()
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "storage_error", message: String(error) }));
  }

  if (message.type === "helper-refresh") {
    return BiliNative.refresh()
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "token_refresh_failed", message: String(error) }));
  }

  if (message.type === "playback-auth") {
    return BiliNative.playbackAuth()
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "playback_auth_failed", message: String(error), stack: String(error.stack || "").split("\n").slice(0, 5).join(" | ") }));
  }

  if (message.type === "qr-start") {
    return BiliNative.qrStart()
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "qr_start_failed", message: String(error) }));
  }

  if (message.type === "qr-poll") {
    return BiliNative.qrPoll()
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "qr_poll_failed", message: String(error) }));
  }

  if (message.type === "set-buvid") {
    return BiliNative.setBuvid(message.buvid)
      .then((response) => response)
      .catch((error) => ({ type: "error", code: "set_buvid_failed", message: String(error) }));
  }

  if (message.type === "open-options") {
    // The login action inside the player's failure toast; options.html hosts the
    // QR login, and content scripts cannot call openOptionsPage themselves.
    const opened = chrome.runtime.openOptionsPage();
    if (opened && typeof opened.catch === "function") opened.catch(() => {});
    return Promise.resolve({ type: "options_opened" });
  }

  return undefined;
});
