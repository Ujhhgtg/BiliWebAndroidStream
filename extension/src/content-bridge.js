(() => {
  // Firefox's chrome.runtime.sendMessage does not carry promise responses;
  // route messaging through browser when available (Chrome falls back).
  const messaging = globalThis.browser || globalThis.chrome;
  const source = document.createElement("script");
  source.src = chrome.runtime.getURL("src/page-bridge.js");
  source.dataset.biliWebAndroidStream = "1";
  (document.documentElement || document.head).appendChild(source);
  source.remove();

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== "biliwebandroidstream-page") return;
    if (message.type !== "bili-playurl-request") return;

    const response = await messaging.runtime.sendMessage({
      type: "bili-playurl-request",
      url: message.url,
      method: message.method,
      bvid: message.bvid,
      aid: message.aid,
      cid: message.cid,
      qn: message.qn,
      fnval: message.fnval,
      fourk: message.fourk
    }).catch((error) => ({ ok: false, code: "content_bridge_error", message: String(error) }));
    window.postMessage({
      source: "biliwebandroidstream-content",
      type: "bili-playurl-response",
      id: message.id,
      response
    }, "*");
  });

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.source !== "biliwebandroidstream-page") return;
    if (event.data.type !== "bili-playback-auth-request") return;
    const response = await messaging.runtime.sendMessage({ type: "playback-auth" })
      .catch((error) => ({ ok: false, code: "content_bridge_error", message: String(error) }));
    window.postMessage({
      source: "biliwebandroidstream-content",
      type: "bili-playback-auth-response",
      id: event.data.id,
      response
    }, "*");
  });

  // The player reports a failed manual switch with its own toast — a row of
  // `.bpx-player-toast-row > .bpx-player-toast-item > .bpx-player-toast-text`
  // holding "切换失败". That toast is the right place for the message: it
  // already has the player's look, position and timing, so keep it and put the
  // reason inside it. The page bridge says why (no phone QR login yet) and how
  // the copy should read; the rewrite happens the moment the toast appears.
  const TOAST_WATCH_MS = 20000;
  const TOAST_FAILURE = /切换失败/;
  // "已经切换至<画质>画质" — the wording follows the player's own quality names,
  // which differ from the API's descriptions, so match the shape, not the name.
  const TOAST_SETTLED = /^已经切换至.+画质$/;
  const TOAST_ROW = '.bpx-player-toast-row, [class*="bpx-player-toast"]';
  const TOAST_ITEM = ".bpx-player-toast-item";
  const TOAST_TEXT = ".bpx-player-toast-text";
  // The player's own toast affordances: `-confirm` is the pink text link, and
  // `-confirm-login` the pink filled button the player uses for "登录" actions.
  // Taking the class means the button inherits the toast's native look.
  const TOAST_CONFIRM = "bpx-player-toast-confirm-login";
  const ACTION_LABEL = "去登录";
  // One rewrite per click: the player fires several playurl requests around a
  // single switch, hence several hints, and they must not keep re-arming the
  // rewrite for toasts that belong to the next thing the user does.
  const REWRITE_LATCH_MS = 6000;
  let toastMessage = null;
  let toastObserver = null;
  let toastWatchTimer = null;
  let lastRewriteAt = 0;

  function hintCopy(message) {
    const label = message.label;
    if (!label) return "需要手机扫码登录才能切换高清画质";
    return message.webLogin
      ? `需要手机扫码登录才能切换到「${label}」`
      : `请先登录才能切换到「${label}」`;
  }

  // The player reports one failed switch in two ways: a flat "切换失败", or by
  // settling for what it got ("已经切换至1080P 高清画质"). The second hides the
  // reason just as well, so both are replaced — the descriptive one only until
  // the first rewrite, so a switch the user makes on their own afterwards keeps
  // its own wording.
  function matchesFailure(text) {
    return TOAST_FAILURE.test(text) || TOAST_SETTLED.test(text);
  }

  function openLoginOptions() {
    messaging.runtime.sendMessage({ type: "open-options" }).catch(() => {});
  }

  // Only the cursor is ours: the player's rule styles everything else but
  // leaves pointer feedback out.
  function addLoginAction(item) {
    if (!item || item.querySelector(`.${TOAST_CONFIRM}`)) return;
    const action = document.createElement("span");
    action.className = TOAST_CONFIRM;
    action.textContent = ACTION_LABEL;
    action.setAttribute("role", "button");
    action.setAttribute("tabindex", "0");
    action.style.cursor = "pointer";
    const activate = (event) => {
      event.stopPropagation();
      event.preventDefault();
      openLoginOptions();
    };
    action.addEventListener("click", activate);
    action.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
    item.appendChild(action);
  }

  // The player reuses a toast row for whatever it says next, so this both
  // rewrites the failure wording and keeps our action honest: it follows our
  // text and is taken back down as soon as the row carries something else.
  function syncToasts() {
    if (!toastMessage) return;
    for (const row of document.querySelectorAll(TOAST_ROW)) {
      const item = row.querySelector(TOAST_ITEM);
      if (!item) continue;
      const text = (item.querySelector(TOAST_TEXT) || item).textContent.trim();
      const action = item.querySelector(`.${TOAST_CONFIRM}`);
      if (action) {
        if (text !== toastMessage) action.remove();
        continue;
      }
      if (text === toastMessage) {
        addLoginAction(item);
        continue;
      }
      if (Date.now() - lastRewriteAt < REWRITE_LATCH_MS) continue;
      if (!matchesFailure(row.textContent.trim())) continue;
      // Only the words change: the row, its item wrapper and their styles stay
      // the player's, and the row reflows to the new text on its own.
      (item.querySelector(TOAST_TEXT) || item).textContent = toastMessage;
      addLoginAction(item);
      lastRewriteAt = Date.now();
    }
  }

  function stopWatchingFailureToasts() {
    if (toastObserver) {
      toastObserver.disconnect();
      toastObserver = null;
    }
    if (toastWatchTimer !== null) {
      window.clearTimeout(toastWatchTimer);
      toastWatchTimer = null;
    }
    toastMessage = null;
  }

  function watchFailureToasts(message) {
    stopWatchingFailureToasts();
    toastMessage = hintCopy(message);
    syncToasts();
    const root = document.body || document.documentElement;
    if (!root) return;
    toastObserver = new MutationObserver(syncToasts);
    toastObserver.observe(root, { childList: true, subtree: true, characterData: true });
    // The toast lands a few seconds after the failure, so watch well past it.
    toastWatchTimer = window.setTimeout(stopWatchingFailureToasts, TOAST_WATCH_MS);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== "biliwebandroidstream-page") return;
    if (message.type !== "bili-login-hint") return;
    watchFailureToasts(message);
  });
})();
