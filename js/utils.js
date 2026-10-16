/* ============================================================================
 * js/utils.js — dependency-free helpers shared by every module.
 * Exposed as window.CCO.U. No storage is required for app state.
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = {};

  /* ------------------------------------------------------------------ DOM */
  U.$ = function (sel, root) { return (root || document).querySelector(sel); };
  U.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  U.on = function (el, ev, fn, opts) { if (el) el.addEventListener(ev, fn, opts); return el; };
  U.hide = function (el) { if (el) el.classList.add('hidden'); };
  U.show = function (el) { if (el) el.classList.remove('hidden'); };

  U.setHtml = function (el, html) { if (el) el.innerHTML = html; };
  U.setText = function (el, text) { if (el) el.textContent = text == null ? '' : String(text); };

  /* --------------------------------------------------------------- errors */
  U.appError = function (code, message, extra) {
    var err = new Error(message || code);
    err.code = code;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) err[k] = extra[k];
    return err;
  };

  U.isNetworkLike = function (err) {
    if (!err) return false;
    if (err.code === 'timeout') return true;
    if (err.name === 'TypeError') return true;                     // fetch() network failure
    if (err.name === 'AbortError') return true;
    if (typeof err.status === 'number' && err.status >= 500) return true;
    if (/fetch|network|load failed|connection/i.test(err.message || '')) return true;
    return false;
  };

  /* ------------------------------------------------------- async plumbing */
  /* Reject if `promise` does not settle within `ms`. The underlying request
   * keeps running but the UI never hangs forever (critical on flaky mobile
   * networks / in-app webviews). */
  U.withTimeout = function (promise, ms, label) {
    ms = ms || 15000;
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(U.appError('timeout', (label || 'Request') + ' timed out.'));
      }, ms);
      Promise.resolve(promise).then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  };

  /* Retry only transient failures (network / timeout / 5xx) with backoff. */
  U.withRetry = function (fn, opts) {
    opts = opts || {};
    var attempts = opts.attempts || 3;
    var base = opts.base || 400;
    var retryable = opts.retryable || U.isNetworkLike;
    function run(n) {
      return Promise.resolve().then(fn).catch(function (err) {
        if (n >= attempts || !retryable(err)) throw err;
        var delay = base * Math.pow(2, n - 1) + Math.random() * 120;
        return new Promise(function (r) { setTimeout(r, delay); }).then(function () { return run(n + 1); });
      });
    }
    return run(1);
  };

  /* --------------------------------------------------------- formatting */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Deterministic formatting (no Intl dependency → identical output in every
   * webview, which matters because the same card is rendered on capture). */
  U.fmtDate = function (iso) {
    if (!iso) return '—';
    var s = String(iso).slice(0, 10).split('-');
    if (s.length !== 3) return '—';
    var y = parseInt(s[0], 10), m = parseInt(s[1], 10), d = parseInt(s[2], 10);
    if (!y || !m || !d || m < 1 || m > 12) return '—';
    return MONTHS[m - 1] + ' ' + d + ', ' + y;
  };

  U.isoToday = function () {
    var d = new Date();
    return [d.getFullYear(), ('0' + (d.getMonth() + 1)).slice(-2), ('0' + d.getDate()).slice(-2)].join('-');
  };

  U.addYearsIso = function (iso, years) {
    var parts = String(iso).split('-');
    var y = parseInt(parts[0], 10) + (years || 0);
    return [y, parts[1] || '01', parts[2] || '01'].join('-');
  };

  /* Negative when `iso` is before today → used for expiry checks. */
  U.daysUntil = function (iso) {
    var target = new Date(String(iso).slice(0, 10) + 'T00:00:00');
    var today = new Date(U.isoToday() + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  };

  U.digitsOnly = function (s) { return String(s == null ? '' : s).replace(/\D+/g, ''); };
  U.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  U.titleCase = function (s) {
    return String(s || '').toLowerCase().replace(/(^|\s|[-'])([a-zà-ÿ])/g, function (m, p, c) { return p + c.toUpperCase(); });
  };

  /* --------------------------------------------------------- identifiers */
  U.randomId = function () {
    try {
      var a = new Uint32Array(2);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return ('00000000' + a[0].toString(16)).slice(-8) + ('00000000' + a[1].toString(16)).slice(-8);
    } catch (e) {
      return (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 16);
    }
  };

  /* Ephemeral per-session id, used ONLY as a server-side rate-limit bucket.
   * It is never used to store candidate data. sessionStorage is wrapped in
   * try/catch because Telegram/Safari may block it entirely. */
  var memoryDeviceId = null;
  U.deviceId = function () {
    var key = 'cco_device_id';
    try {
      var v = window.sessionStorage.getItem(key);
      if (!v) { v = 'dev_' + U.randomId(); window.sessionStorage.setItem(key, v); }
      return v;
    } catch (e) {
      if (!memoryDeviceId) memoryDeviceId = 'dev_' + U.randomId();
      return memoryDeviceId;
    }
  };

  /* ----------------------------------------------------------- clipboard */
  /* navigator.clipboard is unavailable in several in-app webviews and on
   * plain-HTTP origins → fall back to the legacy execCommand path. */
  U.copyText = function (text) {
    return new Promise(function (resolve) {
      function legacy() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          resolve(!!ok);
        } catch (e) { resolve(false); }
      }
      try {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(function () { resolve(true); }, legacy);
          return;
        }
      } catch (e) { /* fall through */ }
      legacy();
    });
  };

  /* --------------------------------------------------------------- toast */
  var toastTimer = null;
  U.toast = function (message, type, ms) {
    var host = U.$('#toast-host');
    if (!host) return;
    var colors = {
      info: 'bg-slate-900 text-white',
      success: 'bg-emerald-600 text-white',
      error: 'bg-rose-700 text-white'
    };
    host.innerHTML = '<div class="pointer-events-auto max-w-[92vw] rounded-xl px-4 py-3 text-sm font-medium shadow-lg transition duration-200 ' +
      (colors[type] || colors.info) + '">' + U.escapeHtml(message) + '</div>';
    host.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { host.classList.add('hidden'); }, ms || 3200);
  };

  /* -------------------------------------------------------------- events */
  U.debounce = function (fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  };

  /* --------------------------------------------------------- viewport fix */
  /* Telegram / Instagram webviews report a wrong, static innerHeight and get
   * stuck with `100vh`. We publish a live --vh CSS variable and the CSS uses
   * `calc(var(--vh) * 100)` with dvh where supported. */
  U.initViewport = function () {
    function set() {
      var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight || document.documentElement.clientHeight || 0;
      if (h > 0) document.documentElement.style.setProperty('--vh', (h * 0.01) + 'px');
    }
    set();
    var deb = U.debounce(set, 80);
    U.on(window, 'resize', deb);
    U.on(window, 'orientationchange', deb);
    U.on(window, 'load', set);
    if (window.visualViewport) U.on(window.visualViewport, 'resize', deb);
    /* Keyboard opening/closing in webviews fires late resize events. */
    setTimeout(set, 300);
    setTimeout(set, 1200);
  };

  /* Keep a focused input visible when the soft keyboard opens (webview bug). */
  U.revealInput = function (el) {
    setTimeout(function () {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      catch (e) { try { el.scrollIntoView(); } catch (e2) { /* noop */ } }
    }, 280);
  };

  /* ------------------------------------------------------------ deep links */
  /* Collects query / hash params from every shape a shared link may arrive
   * in: "?code=123456", "#code=123456", "#/code=123456" and Telegram Mini App
   * payloads (tgWebAppStartParam / startapp). First source wins. */
  U.getLinkParams = function () {
    var out = {};
    function absorb(str) {
      if (!str) return;
      try {
        var sp = new URLSearchParams(String(str).replace(/^\?/, ''));
        sp.forEach(function (v, k) { if (!(k in out)) out[k] = v; });
      } catch (e) { /* ignore malformed */ }
    }
    absorb(window.location.search);
    var h = (window.location.hash || '').replace(/^#/, '');
    if (h.indexOf('=') !== -1) absorb(h.charAt(0) === '/' ? h.slice(1) : h);
    return out;
  };

  /* Extracts the OTP a link may carry: ?code / ?otp / Telegram start params. */
  U.getLinkOtp = function () {
    var p = U.getLinkParams();
    var raw = p.code || p.otp || p.tgWebAppStartParam || p.startapp || '';
    return U.digitsOnly(raw).slice(0, 6);
  };

  U.getRoute = function () {
    var p = U.getLinkParams();
    var hash = (window.location.hash || '').toLowerCase().replace(/[#?/]/g, '');
    if (/(^|\/)admin(\/|$)/i.test(window.location.pathname) || p.admin === '1' || p.admin === 'true' || hash === 'admin') return 'admin';
    return 'verify';
  };

  /* Base URL used for candidate verification links ("...?code=XXXXXX").
   * Strips /admin and index.html so the link always lands on the verify view. */
  U.verificationBaseUrl = function () {
    var origin = window.location.origin;
    var path = window.location.pathname || '/';
    if (/\/index\.html?$/i.test(path)) path = path.replace(/\/index\.html?$/i, '/');
    if (/\/admin\/?$/i.test(path)) path = path.replace(/\/admin\/?$/i, '/');
    if (path.charAt(path.length - 1) !== '/') path = path.replace(/[^/]*$/, '');
    if (path.charAt(0) !== '/') path = '/' + path;
    return origin + path;
  };

  U.buildVerifyLink = function (otp) {
    return U.verificationBaseUrl() + '?code=' + encodeURIComponent(otp);
  };

  /* ---------------------------------------------------------------- images */
  U.validImageSrc = function (src) {
    return typeof src === 'string' && (/^https:\/\//i.test(src) || /^data:image\//i.test(src));
  };

  /* Round initials avatar (data URI SVG) — used as photo fallback so the card
   * never shows a broken image and canvas export never hits a CORS wall. */
  U.avatarDataUri = function (name) {
    var parts = String(name || '?').trim().split(/\s+/);
    var initials = ((parts[0] || '?').charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="288" viewBox="0 0 240 288">' +
      '<rect width="240" height="288" fill="#e2e8f0"/>' +
      '<rect y="200" width="240" height="88" fill="#cbd5e1"/>' +
      '<circle cx="120" cy="108" r="52" fill="#94a3b8"/>' +
      '<path d="M120 76a30 30 0 1 1 0 60 30 30 0 0 1 0-60z" fill="#e2e8f0"/>' +
      '<path d="M64 288c0-44 26-72 56-72s56 28 56 72z" fill="#e2e8f0"/>' +
      '<text x="120" y="266" font-family="Arial,Helvetica,sans-serif" font-size="26" font-weight="700" fill="#334155" text-anchor="middle">' +
      initials.replace(/[^A-Z0-9]/g, '') + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };

  /* Downscale a bitmap to a JPEG data-URI. Keeps embedded photos small enough
   * for a Supabase text column while staying crisp when card scale is 3x. */
  U.bitmapToDataUri = function (source, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      try {
        var w = source.naturalWidth || source.width;
        var h = source.naturalHeight || source.height;
        if (!w || !h) return reject(U.appError('image', 'Image has no dimensions.'));
        var scale = Math.min(1, (maxDim || 640) / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale));
        var ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(source, 0, 0, cw, ch);
        resolve(canvas.toDataURL('image/jpeg', quality || 0.85));
      } catch (e) { reject(e); }
    });
  };

  /* Best-effort: import a remote photo as an embedded data URI. Fails (and
   * resolves null) when the host does not send CORS headers — the caller then
   * simply keeps the plain URL. */
  U.fetchImageAsDataUri = function (url, maxDim, quality, timeoutMs) {
    var timeout = timeoutMs || 6000;
    return U.withTimeout(
      fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw U.appError('image_http', 'HTTP ' + res.status);
          var type = (res.headers.get('content-type') || '').toLowerCase();
          if (type.indexOf('image/') !== 0) throw U.appError('image_type', 'Not an image.');
          return res.blob();
        })
        .then(function (blob) {
          return new Promise(function (resolve, reject) {
            var img = new Image();
            var objUrl = URL.createObjectURL(blob);
            img.onload = function () {
              URL.revokeObjectURL(objUrl);
              U.bitmapToDataUri(img, maxDim, quality).then(resolve, reject);
            };
            img.onerror = function () { URL.revokeObjectURL(objUrl); reject(U.appError('image_decode', 'Could not decode image.')); };
            img.src = objUrl;
          });
        }),
      timeout, 'Photo import'
    ).catch(function () { return null; });
  };

  U.fileToDataUri = function (file, maxDim, quality) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) return reject(U.appError('file_type', 'Please choose an image file.'));
      var objUrl = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(objUrl);
        U.bitmapToDataUri(img, maxDim, quality).then(resolve, reject);
      };
      img.onerror = function () { URL.revokeObjectURL(objUrl); reject(U.appError('file_decode', 'Could not read that image.')); };
      img.src = objUrl;
    });
  };

  /* -------------------------------------------------------- brand artwork */
  /* Stylized maple leaf (single path, no external assets). */
  U.LEAF_PATH = 'M50 4 L56 22 L74 16 L68 34 L90 38 L74 52 L84 74 L60 66 L56 80 L53 96 L47 96 L44 80 L40 66 L16 74 L26 52 L10 38 L32 34 L26 16 L44 22 Z';

  U.leafSvg = function (size, fill, className) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="' + (size || 24) + '" height="' + (size || 24) + '"' +
      (className ? ' class="' + className + '"' : '') + ' aria-hidden="true"><path d="' + U.LEAF_PATH + '" fill="' + (fill || '#C8102E') + '"/></svg>';
  };

  U.leafDataUri = function (fill) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="' + U.LEAF_PATH + '" fill="' + (fill || '#C8102E') + '"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };

  /* Hand-drawn signature squiggle for the card's authorization block. */
  U.signatureSvg = function () {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 60" width="150" height="41" aria-hidden="true">' +
      '<path d="M8 44 C 26 8, 40 6, 44 26 C 47 42, 34 52, 30 44 C 26 36, 44 22, 60 26 C 76 30, 70 46, 84 40 C 98 34, 96 16, 108 18 C 120 20, 112 42, 126 38 C 140 34, 142 14, 156 18 C 168 21, 162 40, 178 34 C 190 29, 196 22, 210 24" ' +
      'fill="none" stroke="#1e293b" stroke-width="2.6" stroke-linecap="round"/></svg>';
  };

  CCO.U = U;
})();
