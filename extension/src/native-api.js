// Pure-JS port of the former Rust native helper: Bilibili Android passport
// (QR login, token refresh, web-cookie exchange) and the PlayViewUnite gRPC
// playback resolver. Everything runs inside the extension background page.
//
// Protocol notes (verified against the 云视听小电视 client and live testing):
//  - app parameter signing is md5(sorted-urlencoded-query + appsec) with
//    RFC 3986 percent encoding;
//  - the refresh endpoint requires client metadata matching the appkey
//    profile plus a `ts` parameter (the app's native signer injects it), and
//    does not carry the access_key;
//  - the PlayViewUnite gRPC call needs base64 protobuf metadata headers and
//    a 5-byte (flag + uint32 BE length) grpc frame.
//
// The bilibili CDN (upos-*, cn-*-cm, mountaintoys PCDN) only serves
// platform=android stream URLs when the request carries the Android app
// User-Agent: desktop UAs get 403 regardless of Referer (the mcdn hosts
// tolerate any UA). The hydration fetches below must send it, and
// background.js rewrites the page's segment requests to it via
// DNR/webRequest. This file loads before background.js in both the Firefox
// manifest script list and the Chrome bundle, so the const is defined by the
// time the header rewriting code runs.
const BILI_APP_UA =
  "Mozilla/5.0 BiliDroid/7.76.0 (bbcall@bilibili.com; 11) os/android model/XQ-AT72 " +
  "mobi_app/android build/7760700 osVer/30 network/2";

const BiliNative = (() => {
  'use strict';

  // Firefox's chrome.storage.local silently drops writes (set succeeds, the
  // value never comes back through get), so storage goes through `browser`,
  // which Firefox defines natively and Chrome can alias from chrome.
  const storageApi = globalThis.browser || globalThis.chrome;

  const APP_KEY = '4409e2ce8ffd12b8';
  const APP_SECRET = '59b43e04ad6965f34319062b478f83dd';
  const WEB_EXCHANGE_APP_KEY = '783bbb7264451d82';
  const WEB_EXCHANGE_APP_SECRET = '2653583c8873dea268ab9386918b1d65';
  const LOCAL_ID = '0';
  const DEVICE_PLATFORM = 'android';

  const TV_MOBI_APP = 'android_tv_yst';
  const TV_BUILD = '108200';
  const TV_CHANNEL = 'master';
  const APP_BUILD = 7760700;
  const APP_VERSION_NAME = '7.76.0';

  const QR_AUTH_ENDPOINT =
    'https://passport.bilibili.com/x/passport-tv-login/qrcode/auth_code';
  const QR_POLL_ENDPOINT =
    'https://passport.bilibili.com/x/passport-tv-login/qrcode/poll';
  const REFRESH_ENDPOINT =
    'https://passport.bilibili.com/x/passport-login/oauth2/refresh_token';
  const TIMESTAMP_ENDPOINT =
    'https://passport.bilibili.com/x/passport-login/timestamp';
  const GRPC_ENDPOINT = 'https://grpc.biliapi.net';
  const GRPC_PATH = '/bilibili.app.playerunite.v1.Player/PlayViewUnite';
  const DEFAULT_FNVAL = 4048;

  const STORAGE_KEY = 'android_token';

  // --------------------------------------------------------------- errors

  function errorBody(code, message) {
    console.log('[BiliWAS] error', code, message);
    return { type: 'error', code, message };
  }

  // --------------------------------------------------------------- storage
  // The token lives in storage.local and is read on every use.

  async function loadToken() {
    const stored = await storageApi.storage.local.get(STORAGE_KEY);
    const value = stored && stored[STORAGE_KEY];
    return value && value.access_token ? value : null;
  }

  async function saveToken(token) {
    await storageApi.storage.local.set({ [STORAGE_KEY]: token });
  }

  async function clearToken() {
    await storageApi.storage.local.remove(STORAGE_KEY).catch(() => {});
    return { type: 'token_cleared' };
  }

  function fallbackBuvid() {
    // Stable local fallback for tokens without a web buvid; an empty buvid
    // makes the gRPC response CDN URLs unusable.
    const hex = md5('bili-web-android-stream');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}infoc`;
  }

  // ------------------------------------------------------------------ info

  function info() {
    return {
      type: 'info',
      name: 'biliwebandroidstream.pure-js',
      version: chrome.runtime.getManifest().version,
      protocol_version: 1,
      target: 'webextension',
      capabilities: ['token', 'qr', 'playback', 'refresh']
    };
  }

  // -------------------------------------------------------------- signing

  function nowTs() {
    return Math.floor(Date.now() / 1000);
  }

  function percentEncode(value) {
    const HEX = '0123456789ABCDEF';
    const bytes = new TextEncoder().encode(String(value));
    let out = '';
    for (const byte of bytes) {
      const isUnreserved =
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
      if (isUnreserved) {
        out += String.fromCharCode(byte);
      } else {
        out += '%' + HEX[(byte >> 4) & 15] + HEX[byte & 15];
      }
    }
    return out;
  }

  function signedParams(pairs, secret) {
    const sorted = pairs
      .map(([k, v]) => [String(k), String(v)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonical = sorted
      .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
      .join('&');
    const search = new URLSearchParams();
    for (const [k, v] of sorted) search.append(k, v);
    search.append('sign', md5(canonical + secret));
    return search;
  }

  async function postJson(url, search, extraHeaders) {
    const response = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'content-type': 'application/x-www-form-urlencoded' },
        extraHeaders || {}
      ),
      body: search.toString()
    });
    return response.json();
  }

  // ----------------------------------------------------------- token import

  function normalizeTokenPayload(raw, appKey) {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('token JSON 必须是对象');
    }
    const nested = value.token_info || (value.data && value.data.token_info) || null;
    const pick = (...candidates) => {
      for (const source of [value, nested]) {
        for (const key of candidates) {
          if (source && source[key] != null && source[key] !== '') return source[key];
        }
      }
      return null;
    };
    const accessToken = pick('access_token', 'access_key');
    if (!accessToken) throw new Error('token 缺少 access_key/access_token');
    const expires = pick('expires', 'expires_at', 'expires_in');
    const expiresAt = expires == null ? null
      : Number(expires) > 1e12 ? Math.floor(Number(expires) / 1000)
      : Number(expires) < 1e11 ? nowTs() + Number(expires)
      : Number(expires);
    return {
      access_token: String(accessToken),
      refresh_token: pick('refresh_token') || null,
      fast_login_token: pick('fast_login_token') || null,
      mid: pick('mid') != null ? String(pick('mid')) : null,
      expires_at: expiresAt,
      app_key: appKey || pick('app_key') || APP_KEY,
      buvid: pick('buvid') || null
    };
  }

  async function importTokenJson(json, appKey) {
    const token = normalizeTokenPayload(json, appKey);
    await saveToken(token);
    return tokenStatus();
  }

  async function tokenStatus() {
    const token = await loadToken();
    return {
      type: 'status',
      configured: Boolean(token),
      has_refresh_token: Boolean(token && token.refresh_token),
      expires_at: token ? token.expires_at : null
    };
  }

  async function setBuvid(buvid) {
    const token = await loadToken();
    if (token) {
      token.buvid = buvid;
      await saveToken(token);
    }
    return { type: 'buvid_set' };
  }

  // -------------------------------------------------------------- qr login

  let qrSession = null;

  async function qrStart() {
    const ts = nowTs();
    const search = signedParams(
      [['appkey', APP_KEY], ['local_id', LOCAL_ID], ['mobi_app', 'android'], ['ts', String(ts)]],
      APP_SECRET
    );
    const body = await postJson(QR_AUTH_ENDPOINT, search);
    if (body.code !== 0) {
      throw new Error(`QR generate failed: ${body.code} ${body.message}`);
    }
    const data = body.data;
    if (!data || !data.url || !data.auth_code) {
      throw new Error('QR response has no data');
    }
    const qr = qrcode(0, 'M');
    qr.addData(data.url);
    qr.make();
    qrSession = {
      auth_code: data.auth_code,
      url: data.url,
      app_key: APP_KEY,
      app_secret: APP_SECRET
    };
    return {
      type: 'qr_started',
      url: data.url,
      auth_code: data.auth_code,
      qr_svg: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
    };
  }

  async function qrPoll() {
    const session = qrSession;
    if (!session) throw new Error('no QR session');
    const ts = nowTs();
    const search = signedParams(
      [
        ['appkey', session.app_key],
        ['auth_code', session.auth_code],
        ['local_id', LOCAL_ID],
        ['ts', String(ts)]
      ],
      session.app_secret
    );
    const body = await postJson(QR_POLL_ENDPOINT, search);
    if (body.code === 0) {
      const status = await importTokenJson(body.data, session.app_key);
      qrSession = null;
      return { type: 'qr_polled', state: 'authorized', message: body.message || '', status };
    }
    if (body.code === 86038) {
      qrSession = null;
      return { type: 'qr_polled', state: 'expired', message: body.message, status: null };
    }
    if (body.code === 86039 || body.code === 86090 || body.code === 86101) {
      return { type: 'qr_polled', state: 'pending', message: body.message, status: null };
    }
    throw new Error(`QR poll failed: ${body.code} ${body.message}`);
  }

  async function refresh() {
    const token = await loadToken();
    if (!token) throw new Error('no token to refresh');
    if (!token.refresh_token) throw new Error('stored token has no refresh_token');
    const appKey = token.app_key || APP_KEY;
    const secret = appKey === WEB_EXCHANGE_APP_KEY ? WEB_EXCHANGE_APP_SECRET : APP_SECRET;
    let params;
    if (appKey === APP_KEY) {
      // TV profile: the endpoint rejects mismatched client metadata (-400)
      // and requires the locally injected `ts`; no access_key is sent.
      params = [
        ['refresh_token', token.refresh_token],
        ['appkey', appKey],
        ['build', TV_BUILD],
        ['channel', TV_CHANNEL],
        ['mobi_app', TV_MOBI_APP],
        ['platform', DEVICE_PLATFORM],
        ['ts', String(nowTs())]
      ];
    } else {
      const sts = await serverTimestamp(appKey, secret).catch(() => -1);
      params = [
        ['access_key', token.access_token],
        ['refresh_token', token.refresh_token],
        ['sts', String(sts)],
        ['appkey', appKey],
        ['local_id', LOCAL_ID],
        ['mobi_app', 'android'],
        ['build', String(APP_BUILD)],
        ['platform', DEVICE_PLATFORM],
        ['device', 'phone']
      ];
    }
    const body = await postJson(REFRESH_ENDPOINT, signedParams(params, secret));
    if (body.code !== 0) {
      throw new Error(`token refresh failed: ${body.code} ${body.message}`);
    }
    const updated = normalizeTokenPayload(body.data, appKey);
    updated.buvid = token.buvid || updated.buvid;
    await saveToken(updated);
    return tokenStatus();
  }

  async function serverTimestamp(appKey, secret) {
    const search = signedParams(
      [['appkey', appKey], ['local_id', LOCAL_ID], ['mobi_app', 'android'], ['ts', String(nowTs())]],
      secret
    );
    const response = await fetch(`${TIMESTAMP_ENDPOINT}?${search.toString()}`);
    const body = await response.json();
    if (body.code !== 0 || !body.data) {
      throw new Error(`server timestamp failed: ${body.code} ${body.message}`);
    }
    return body.data.timestamp;
  }

  // -------------------------------------------------------------- playback

  // ---- protobuf encoding ----
  function pbVarintBytes(value) {
    let v = BigInt(value);
    const out = [];
    do {
      let byte = Number(v & 0x7fn);
      v >>= 7n;
      if (v) byte |= 0x80;
      out.push(byte);
    } while (v);
    return out;
  }
  function pbTag(field, wireType) {
    return pbVarintBytes((field << 3) | wireType);
  }
  function pbVarint(field, value) {
    return [...pbTag(field, 0), ...pbVarintBytes(value)];
  }
  function pbBytes(field, bytes) {
    return [...pbTag(field, 2), ...pbVarintBytes(bytes.length), ...bytes];
  }
  function pbStr(field, str) {
    return pbBytes(field, [...new TextEncoder().encode(str)]);
  }
  function pbMsg(field, inner) {
    return pbBytes(field, inner);
  }
  function b64(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }

  // ---- protobuf decoding (flat field walker) ----
  function pbDecode(buf) {
    const fields = [];
    let i = 0;
    const readVarint = () => {
      let result = 0n, shift = 0n;
      while (true) {
        const byte = buf[i++];
        result |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) break;
        shift += 7n;
      }
      return result;
    };
    while (i < buf.length) {
      const key = Number(readVarint());
      const field = key >> 3, wireType = key & 7;
      if (wireType === 0) {
        fields.push({ field, wireType, value: readVarint() });
      } else if (wireType === 2) {
        const length = Number(readVarint());
        fields.push({ field, wireType, bytes: buf.slice(i, i + length) });
        i += length;
      } else if (wireType === 5) {
        fields.push({ field, wireType, bytes: buf.slice(i, i + 4) });
        i += 4;
      } else if (wireType === 1) {
        fields.push({ field, wireType, bytes: buf.slice(i, i + 8) });
        i += 8;
      } else {
        break;
      }
    }
    return fields;
  }
  const pbDecodeStr = (bytes) => new TextDecoder().decode(bytes);

  // The playback gRPC call uses the plain android profile (mobi_app=android,
  // build 7760700). The TV profile is only for the oauth2 refresh endpoint:
  // the server echoes mobi_app into the CDN URLs' platform parameter, and
  // android_tv_yst URLs hit the page's header rules unstripped (Referer 403).
  function metadataProto(accessToken, buvid) {
    return [
      ...pbStr(1, accessToken), ...pbStr(2, 'android'), ...pbStr(3, ''),
      ...pbVarint(4, APP_BUILD), ...pbStr(5, 'master'),
      ...pbStr(6, buvid), ...pbStr(7, 'android')
    ];
  }
  function deviceProto(buvid) {
    return [
      ...pbVarint(1, 1), ...pbVarint(2, APP_BUILD), ...pbStr(3, buvid),
      ...pbStr(4, 'android'), ...pbStr(5, 'android'), ...pbStr(6, ''),
      ...pbStr(7, 'master'), ...pbStr(8, 'unknown'), ...pbStr(9, 'unknown'),
      ...pbStr(10, 'unknown'), ...pbStr(13, APP_VERSION_NAME)
    ];
  }
  function vodProto(request) {
    const fnval = (request.fnval || DEFAULT_FNVAL) | 0x400;
    const qn = request.qn || 112;
    return [
      ...pbVarint(1, BigInt(request.aid || 0)), ...pbVarint(2, BigInt(request.cid)),
      ...pbVarint(3, qn),
      ...pbVarint(5, fnval), ...pbVarint(7, 2), ...pbVarint(8, 1),
      ...pbVarint(11, 1),
      ...(qn >= 127 ? [...pbVarint(9, 2)] : [])
    ];
  }
  function requestProto(request) {
    return [
      ...pbMsg(1, vodProto(request)),
      ...pbStr(2, 'united.player-video-detail.0.0'),
      ...pbStr(3, '0.0.0.0'),
      ...(request.bvid ? [...pbStr(5, request.bvid)] : []),
      ...pbStr(8, 'normal')
    ];
  }

  function webCodec(codecid, width, height, frameRate) {
    const fps = String(frameRate || '').includes('/')
      ? Number(frameRate.split('/')[0]) / (Number(frameRate.split('/')[1]) || 1)
      : Number(frameRate) || 0;
    if (codecid === 7) {
      if ((width >= 1920 || height >= 1080) && fps >= 50) return 'avc1.640032';
      if (width >= 1920 || height >= 1080) return 'avc1.640028';
      if ((width >= 1280 || height >= 720) && fps >= 50) return 'avc1.64002a';
      if (width >= 1280 || height >= 720) return 'avc1.64001f';
      if (width >= 854 || height >= 480) return 'avc1.4d401f';
      return 'avc1.4d401e';
    }
    if (codecid === 12) return 'hev1.1.6.L120.90';
    if (codecid === 13) return 'av01.0.08M.08';
    return 'avc1.640028';
  }

  // Probes the head of an fMP4 object to find the initialization (ftyp..moov)
  // and index (sidx) byte ranges the web player's DASH parser requires.
  function parseSegmentBase(bytes) {
    const boxType = (offset) =>
      String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let offset = 0;
    let initializationEnd = null;
    let indexRange = null;
    while (offset + 8 <= bytes.length) {
      const start = offset;
      const size32 = Number(new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset));
      const type = boxType(offset);
      let headerSize = 8, size;
      if (size32 === 1) {
        if (offset + 16 > bytes.length) return null;
        headerSize = 16;
        size = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(offset + 8));
      } else if (size32 === 0) {
        size = bytes.length - offset;
      } else {
        size = size32;
      }
      if (size < headerSize) return null;
      const end = offset + size;
      if (end > bytes.length) break;
      if (type === 'moov') initializationEnd = end - 1;
      if (type === 'sidx') indexRange = `${start}-${end - 1}`;
      offset = end;
    }
    if (initializationEnd == null || !indexRange) return null;
    return { initialization: `0-${initializationEnd}`, index_range: indexRange };
  }

  async function hydrateSegmentBase(baseUrl) {
    try {
      const response = await fetch(baseUrl, { headers: { Range: 'bytes=0-65535', 'User-Agent': BILI_APP_UA } });
      if (response.status !== 200 && response.status !== 206) {
        console.log('[BiliWAS] hydrate HTTP', response.status, baseUrl.slice(0, 90));
        return null;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      return parseSegmentBase(buffer);
    } catch (e) {
      console.log('[BiliWAS] hydrate fetch failed', String(e), baseUrl.slice(0, 90));
      return null;
    }
  }

  function decodeStreams(vodInfoFields) {
    const out = { quality: null, timelength: null, streams: [], audio: [] };
    for (const entry of vodInfoFields) {
      if (entry.field === 1 && entry.wireType === 0 && out.quality == null) {
        out.quality = Number(entry.value);
      } else if (entry.field === 3 && entry.wireType === 0 && out.timelength == null) {
        out.timelength = Number(entry.value);
      } else if (entry.field === 5 && entry.wireType === 2) {
        const stream = { quality: null, mime_type: 'video/mp4', codecs: '', codecid: 7,
          frame_rate: '', width: 0, height: 0, bandwidth: 0,
          base_url: '', backup_urls: [] };
        let hasVideo = false;
        for (const f of pbDecode(entry.bytes)) {
          if (f.field === 1 && f.wireType === 2) {
            for (const si of pbDecode(f.bytes)) {
              if (si.field === 1 && si.wireType === 0) stream.quality = Number(si.value);
            }
          } else if (f.field === 2 && f.wireType === 2) {
            hasVideo = true;
            for (const dv of pbDecode(f.bytes)) {
              if (dv.field === 1 && dv.wireType === 2) stream.base_url = pbDecodeStr(dv.bytes);
              else if (dv.field === 2 && dv.wireType === 2) stream.backup_urls.push(pbDecodeStr(dv.bytes));
              else if (dv.field === 3 && dv.wireType === 0) stream.bandwidth = Number(dv.value);
              else if (dv.field === 4 && dv.wireType === 0) stream.codecid = Number(dv.value);
              else if (dv.field === 9 && dv.wireType === 2) stream.frame_rate = pbDecodeStr(dv.bytes);
              else if (dv.field === 10 && dv.wireType === 0) stream.width = Number(dv.value);
              else if (dv.field === 11 && dv.wireType === 0) stream.height = Number(dv.value);
            }
          }
        }
        if (hasVideo && stream.base_url) out.streams.push(stream);
      } else if (entry.field === 6 && entry.wireType === 2) {
        const audio = { id: null, mime_type: 'audio/mp4', codecs: 'mp4a.40.2',
          bandwidth: 0, base_url: '', backup_urls: [] };
        let hasUrl = false;
        for (const f of pbDecode(entry.bytes)) {
          if (f.field === 1 && f.wireType === 0) audio.id = Number(f.value);
          else if (f.field === 2 && f.wireType === 2) { audio.base_url = pbDecodeStr(f.bytes); hasUrl = true; }
          else if (f.field === 3 && f.wireType === 2) audio.backup_urls.push(pbDecodeStr(f.bytes));
          else if (f.field === 4 && f.wireType === 0) audio.bandwidth = Number(f.value);
        }
        if (hasUrl && audio.id != null) out.audio.push(audio);
      }
    }
    return out;
  }

  async function resolvePlayUrl(request) {
    console.log('[BiliWAS] resolvePlayUrl qn', request.qn, 'fnval', request.fnval, 'cid', request.cid, 'bvid', request.bvid, 'aid', request.aid);
    const token = await loadToken();
    if (!token) {
      return errorBody('missing_token', 'a token is required before requesting playback');
    }
    if (
      token.expires_at &&
      token.refresh_token &&
      token.expires_at - nowTs() < 60
    ) {
      try { await refresh(); } catch (_) { /* keep current */ }
    }
    const buvid = token.buvid || fallbackBuvid();
    const message = requestProto(request);
    const body = new Uint8Array([
      0,
      (message.length >>> 24) & 255, (message.length >>> 16) & 255,
      (message.length >>> 8) & 255, message.length & 255,
      ...message
    ]);
    const response = await fetch(GRPC_ENDPOINT + GRPC_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/grpc',
        'grpc-encoding': 'identity',
        'authorization': `identify_v1 ${token.access_token}`,
        'x-bili-metadata-bin': b64(metadataProto(token.access_token, buvid)),
        'x-bili-device-bin': b64(deviceProto(buvid)),
        'x-bili-network-bin': b64(pbVarint(1, 1))
      },
      body
    });
    const buf = new Uint8Array(await response.arrayBuffer());
    console.log('[BiliWAS] gRPC status', response.status, 'bytes', buf.length, 'qn', request.qn);
    if (response.status !== 200 || buf.length <= 5) {
      console.log('[BiliWAS] gRPC empty reply', response.status);
      return errorBody('playback_response_error', `gRPC response empty (HTTP ${response.status})`);
    }
    // The reply wraps vod_info in field 1; its fields (quality, stream_list,
    // dash_audio) are what decodeStreams expects.
    let vodInfoFields = null;
    for (const entry of pbDecode(buf.slice(5))) {
      if (entry.field === 1 && entry.wireType === 2) {
        vodInfoFields = pbDecode(entry.bytes);
        break;
      }
    }
    if (!vodInfoFields) {
      return errorBody('playback_response_error', 'gRPC reply has no vod_info');
    }
    const reply = decodeStreams(vodInfoFields);
    console.log('[BiliWAS] decoded quality', reply.quality, 'streams', reply.streams.map((s) => s.quality), 'audio', reply.audio.length);
    if (!reply.streams.length || !reply.audio.length) {
      return errorBody('playback_response_error', 'gRPC response has no usable DASH streams');
    }
    // Hydrate the MP4 init/sidx ranges the player's DASH parser requires.
    const hydrations = reply.streams.map((stream) => hydrateSegmentBase(stream.base_url));
    const audioHydrations = reply.audio.map((item) => hydrateSegmentBase(item.base_url));
    const streamRanges = await Promise.all(hydrations);
    const audioRanges = await Promise.all(audioHydrations);
    reply.streams.forEach((stream, index) => { stream.segment_base = streamRanges[index]; });
    reply.audio.forEach((item, index) => { item.segment_base = audioRanges[index]; });
    console.log('[BiliWAS] hydration video', reply.streams.map((s, i) => `${s.quality}:${JSON.stringify(streamRanges[i])}`), 'audio', reply.audio.map((a, i) => `${a.id}:${JSON.stringify(audioRanges[i])}`));
    for (const stream of reply.streams) {
      stream.codecs = webCodec(stream.codecid, stream.width, stream.height, stream.frame_rate);
    }
    return {
      type: 'play_url',
      response: {
        bvid: request.bvid || '',
        cid: request.cid,
        quality: reply.quality,
        duration_ms: reply.timelength,
        streams: reply.streams,
        audio: reply.audio
      }
    };
  }

  async function playbackAuth() {
    const token = await loadToken();
    if (!token) {
      return errorBody('missing_token', 'a token is required before requesting playback');
    }
    return { type: 'playback_auth', authorization: `identify_v1 ${token.access_token}` };
  }

  return {
    info,
    tokenStatus,
    importTokenJson,
    clearToken,
    setBuvid,
    refresh,
    qrStart,
    qrPoll,
    resolvePlayUrl,
    playbackAuth
  };
})();
