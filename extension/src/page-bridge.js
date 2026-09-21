(() => {
  if (window.__BILI_WEB_ANDROID_STREAM__) return;
  window.__BILI_WEB_ANDROID_STREAM__ = true;

  const nativeFetch = window.fetch.bind(window);
  let nextId = 1;
  const pending = new Map();

  // Quality ids → short labels, used where the official response carries no
  // description for a quality (see mergeAndroidIntoOfficial and the login hint).
  const qualityLabel = (quality) => ({
    16: "360P", 32: "480P", 64: "720P", 74: "720P 60帧", 80: "1080P",
    112: "1080P 高码率", 116: "1080P 60帧", 120: "4K", 125: "HDR",
    126: "杜比视界", 127: "8K"
  }[quality] || `${quality}P`);

  function rewriteAccountBody(body) {
    if (!body || body.code !== 0 || !body.data) return body;
    const data = body.data;
    data.vip = { ...(data.vip || {}), type: 2, status: 1 };
    data.options = { ...(data.options || {}), without_vip: false };
    return body;
  }

  function rewriteXhrResponse(xhr) {
    if (xhr.__biliWebAndroidStreamRewritten) return;
    xhr.__biliWebAndroidStreamRewritten = true;
    try {
      const text = xhr.responseType && xhr.responseType !== "text" && xhr.responseType !== ""
        ? new TextDecoder().decode(xhr.response)
        : xhr.responseText;
      const body = rewriteAccountBody(JSON.parse(text));
      const rewritten = JSON.stringify(body);
      Object.defineProperty(xhr, "responseText", { configurable: true, value: rewritten });
      Object.defineProperty(xhr, "response", { configurable: true, value: rewritten });
    } catch (_) {
      // Preserve the original response if the endpoint changes shape.
    }
  }

  function replaceXhrJson(xhr, body) {
    const text = JSON.stringify(body);
    try { Object.defineProperty(xhr, "responseText", { configurable: true, value: text }); } catch (_) {}
    try { Object.defineProperty(xhr, "response", { configurable: true, value: text }); } catch (_) {}
  }

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const normalizedUrl = String(url);
    this.__biliWebAndroidStreamAccountRequest = normalizedUrl.includes("/x/player/wbi/v2");
    this.__biliWebAndroidStreamPlayRequest = normalizedUrl.includes("/x/player/wbi/playurl");
    this.__biliWebAndroidStreamRequestUrl = normalizedUrl;
    this.__biliWebAndroidStreamRequestMethod = method;
    return nativeXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__biliWebAndroidStreamPlayRequest) {
      const xhr = this;
      const onLoadEnd = xhr.onloadend;
      let nativeDone = false;
      let helperDone = false;
      let helperAnswer;
      let nativeEvent;
      const finish = () => {
        if (!nativeDone || !helperDone) return;
        let officialBody = null;
        try { officialBody = JSON.parse(xhr.responseText); } catch (_) {}
        if (helperAnswer?.ok && helperAnswer.android) {
          const merged = mergeAndroidIntoOfficial(officialBody, helperAnswer.android, helperAnswer.requestedQuality);
          console.log('[BiliWAS] xhr merge answer.ok', helperAnswer.ok, 'code', helperAnswer.code || '', 'merged', merged ? merged.data.quality : 'null');
          if (merged) replaceXhrJson(xhr, merged);
        } else {
          hintMissingLogin(officialBody, helperAnswer, requestedQualityOf(xhr.__biliWebAndroidStreamRequestUrl, body));
        }
        if (typeof onLoadEnd === "function") onLoadEnd.call(xhr, nativeEvent);
      };
      xhr.onloadend = (event) => {
        nativeDone = true;
        nativeEvent = event;
        finish();
      };
      askHelper(xhr.__biliWebAndroidStreamRequestUrl, xhr.__biliWebAndroidStreamRequestMethod, body)
        .then((answer) => { helperAnswer = answer; helperDone = true; finish(); })
        .catch(() => { helperDone = true; finish(); });
      return nativeXhrSend.call(xhr, body);
    }
    if (!this.__biliWebAndroidStreamAccountRequest) {
      return nativeXhrSend.call(this, body);
    }
    const onLoadEnd = this.onloadend;
    const onReadyStateChange = this.onreadystatechange;
    this.onloadend = (event) => {
      rewriteXhrResponse(this);
      if (typeof onLoadEnd === "function") onLoadEnd.call(this, event);
    };
    this.onreadystatechange = (event) => {
      if (this.readyState === 4) rewriteXhrResponse(this);
      if (typeof onReadyStateChange === "function") onReadyStateChange.call(this, event);
    };
    return nativeXhrSend.call(this, body);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== "biliwebandroidstream-content") return;
    if (message.type !== "bili-playurl-response") return;
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    resolver(message.response);
  });

  // The player's DashBilibiliParser only accepts playinfo bodies whose dash
  // representations carry MP4 segment_base ranges. The Android response has
  // them (hydrated by the native helper), but the rest of its shape differs
  // from the web playinfo the player expects, so instead of building a body
  // from scratch we splice the Android streams into the official web response
  // captured from the same request. That keeps every field the parser reads
  // (sar, start_with_sap, timelength, support_formats, ...) intact.
  function mergeAndroidIntoOfficial(officialBody, android, requestedQuality) {
    const streamToRep = (stream) => ({
      id: stream.quality,
      baseUrl: stream.base_url,
      base_url: stream.base_url,
      backupUrl: stream.backup_urls || [],
      backup_url: stream.backup_urls || [],
      mimeType: stream.mime_type,
      mime_type: stream.mime_type,
      codecs: stream.codecs || "",
      codecid: stream.codecid,
      width: stream.width,
      height: stream.height,
      frameRate: stream.frame_rate || "",
      frame_rate: stream.frame_rate || "",
      bandwidth: stream.bandwidth,
      sar: "1:1",
      startWithSap: 1,
      start_with_sap: 1,
      segment_base: stream.segment_base || null,
      SegmentBase: stream.segment_base ? {
        Initialization: stream.segment_base.initialization,
        indexRange: stream.segment_base.index_range
      } : null
    });
    const audioToRep = (item) => ({
      id: item.id,
      baseUrl: item.base_url,
      base_url: item.base_url,
      backupUrl: item.backup_urls || [],
      backup_url: item.backup_urls || [],
      mimeType: item.mime_type,
      mime_type: item.mime_type,
      codecs: item.codecs || "mp4a.40.2",
      codecid: 0,
      bandwidth: item.bandwidth,
      sar: "1:1",
      startWithSap: 1,
      start_with_sap: 1,
      segment_base: item.segment_base || null,
      SegmentBase: item.segment_base ? {
        Initialization: item.segment_base.initialization,
        indexRange: item.segment_base.index_range
      } : null
    });
    const availableVideos = (android.streams || []).filter((stream) => stream.segment_base).map(streamToRep);
    const audio = (android.audio || []).filter((item) => item.segment_base).map(audioToRep);
    if (!availableVideos.length || !audio.length) return null;
    const target = requestedQuality
      ? availableVideos.find((video) => video.id === requestedQuality)
        || availableVideos.filter((video) => video.id <= requestedQuality).sort((a, b) => b.id - a.id)[0]
      : availableVideos.find((video) => video.id === android.quality) || availableVideos[0];
    if (!target) return null;
    // If hydration failed for the requested representation, delivering a much
    // lower Android quality would silently degrade playback; fall back to the
    // official response instead (e.g. PCDN hosts that the background cannot
    // reach yield only low-qin streams).
    if (requestedQuality && target.id < requestedQuality) return null;
    // The quality menu must come from the official response, not from the
    // Android stream list: the Android playurl only includes representations
    // at or below the requested qn (8K appears solely when qn=127 is asked
    // for), and the official list carries the full descriptions
    // ("8K 超高清", "720P 准高清", ...) plus VIP badges. Selecting a menu
    // entry the current Android response lacks simply issues a new playurl
    // request at that qn, which the helper fulfills.
    const official = officialBody.data;
    const officialQualities = Array.isArray(official.accept_quality) ? official.accept_quality : [];
    const officialDescriptions = Array.isArray(official.accept_description) ? official.accept_description : [];
    const officialFormats = Array.isArray(official.support_formats) ? official.support_formats : [];
    const androidOnly = availableVideos
      .map((video) => video.id)
      .filter((quality) => !officialQualities.includes(quality));
    const qualities = [...officialQualities, ...androidOnly];
    const descriptionFor = (quality) =>
      officialDescriptions[officialQualities.indexOf(quality)] || qualityLabel(quality);
    const formatFor = (quality) =>
      officialFormats.find((format) => format.quality === quality) || {
        quality,
        format: "hdflv2",
        new_description: qualityLabel(quality),
        display_desc: qualityLabel(quality),
        superscript: "",
        codecs: []
      };
    const body = JSON.parse(JSON.stringify(officialBody));
    body.data.from = "local_android_grpc";
    body.data.quality = target.id;
    // A single representation keeps the player's device ABR probe from
    // capping the manual quality request back down to 1080P.
    body.data.dash.video = [target];
    body.data.dash.audio = audio;
    body.data.dash.dolby = { type: 0, audio: [] };
    body.data.dash.flac = null;
    body.data.accept_quality = qualities;
    body.data.accept_description = qualities.map(descriptionFor);
    body.data.support_formats = qualities.map(formatFor);
    return body;
  }

  // A manual quality switch fails when the official web response cannot reach
  // the requested quality and the Android helper has no token to fill it in.
  // The player is about to report that terse failure on its own, so say what is
  // actually missing first: a phone QR login. This is only the "no token at
  // all" case — a token that merely lacks a privilege (大会员) is not a login
  // problem — and a request the official response satisfies never reaches here,
  // so switches the page can serve on its own stay quiet.
  function hintMissingLogin(officialBody, answer, requestedQuality) {
    if (!requestedQuality) return;
    if (answer && answer.ok && answer.android) return;
    if (!answer || answer.code !== "missing_token") return;
    const official = officialBody && officialBody.data;
    const delivered = official ? official.quality : null;
    if (typeof delivered !== "number" || requestedQuality <= delivered) return;
    const qualities = Array.isArray(official.accept_quality) ? official.accept_quality : [];
    const descriptions = Array.isArray(official.accept_description) ? official.accept_description : [];
    const index = qualities.indexOf(requestedQuality);
    const label = (index >= 0 && descriptions[index]) || qualityLabel(requestedQuality);
    console.log('[BiliWAS] login hint qn', requestedQuality, 'official quality', delivered, 'web login', answer.web_login);
    window.postMessage({
      source: "biliwebandroidstream-page",
      type: "bili-login-hint",
      quality: requestedQuality,
      label,
      // Logged out on the website, the user has one step to take first; logged
      // in, the missing piece is the phone QR login specifically.
      webLogin: answer.web_login === true
    }, "*");
  }

  // The playurl request carries its parameters in the query string, the body,
  // or both; the helper is asked about the union of the two.
  function requestParams(url, body) {
    const params = new URL(url, window.location.href).searchParams;
    if (typeof body === "string" && body) {
      try {
        for (const [key, value] of new URLSearchParams(body)) {
          if (!params.has(key)) params.set(key, value);
        }
      } catch (_) {}
    }
    return params;
  }

  function requestedQualityOf(url, body) {
    const qn = requestParams(url, body).get("qn");
    return qn ? Number(qn) : null;
  }

  function askHelper(url, method, body) {
    const id = nextId++;
    const params = requestParams(url, body);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      window.postMessage({
        source: "biliwebandroidstream-page",
        type: "bili-playurl-request",
        id,
        url,
        method,
        bvid: params.get("bvid") || "",
        aid: params.get("avid") ? Number(params.get("avid")) : (params.get("aid") ? Number(params.get("aid")) : (window.__INITIAL_STATE__?.aid || null)),
        cid: params.get("cid") ? Number(params.get("cid")) : 0,
        qn: params.get("qn") ? Number(params.get("qn")) : null,
        fnval: params.get("fnval") ? Number(params.get("fnval")) : null,
        fourk: params.get("fourk") === "1"
      }, "*");
      // MP4 range hydration runs in the native helper before the DASH body
      // can be handed to the player. Keep a bounded escape hatch, but allow
      // slow CDNs enough time so a valid quality switch is not silently
      // replaced with the official low-quality response.
      window.setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        resolve({ ok: false, code: "bridge_timeout" });
      }, 10000);
    });
  }

  window.fetch = async function(input, init) {
    const request = new Request(input, init);
    const url = request.url;
    if (url.includes("/x/player/wbi/v2")) {
      const response = await nativeFetch(input, init);
      try {
        const body = rewriteAccountBody(await response.clone().json());
        return new Response(JSON.stringify(body), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (_) {
        return response;
      }
    }
    if (!url.includes("/x/player/wbi/playurl")) {
      return nativeFetch(input, init);
    }

    // The helper is only allowed to replace a response when it can be merged
    // into the official web response; otherwise preserve the official one.
    const requestBody = request.method === "GET" || request.method === "HEAD"
      ? null
      : await request.clone().text();
    const [answer, officialResponse] = await Promise.all([
      askHelper(url, request.method, requestBody),
      nativeFetch(input, init).catch(() => null)
    ]);
    let officialBody = null;
    if (officialResponse) {
      try { officialBody = await officialResponse.clone().json(); } catch (_) {}
    }
    if (answer?.ok && answer.android && officialBody) {
      const merged = mergeAndroidIntoOfficial(officialBody, answer.android, answer.requestedQuality);
      console.log('[BiliWAS] fetch merge answer.ok', answer.ok, 'code', answer.code || '', 'merged', merged ? merged.data.quality : 'null');
      if (merged) {
        return new Response(JSON.stringify(merged), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }
    } else {
      hintMissingLogin(officialBody, answer, requestedQualityOf(url, requestBody));
    }
    if (officialResponse) return officialResponse;
    return nativeFetch(input, init);
  };

  const accountReloadTimer = window.setInterval(() => {
    if (!window.player || typeof window.player.reloadAccess !== "function") return;
    window.clearInterval(accountReloadTimer);
    try { window.player.reloadAccess(); } catch (_) { /* page may not be ready */ }
  }, 500);
})();
