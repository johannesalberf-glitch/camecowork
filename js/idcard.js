/* ============================================================================
 * js/idcard.js — renders the verified Digital ID Card and exports it as PNG.
 *
 * Export strategy (mobile-first, webview-safe):
 *   1. Make the candidate photo self-contained (data URI) when the host sends
 *      CORS headers; otherwise fall back to a generated avatar so the canvas
 *      is never tainted.
 *   2. html2canvas at 2–3x device scale → PNG blob.
 *   3. Deliver via Web Share API (iOS/Android share sheet) → <a download> →
 *      new-tab fallback (iOS Safari ignores `download`).
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = CCO.U;
  var CFG = window.CCO_CONFIG || {};

  var state = { candidate: null, otp: '', exporting: false };

  /* --------------------------------------------------------- barcode bars */
  /* Deterministic pseudo-barcode derived from the employee id: purely
   * decorative, but stable for a given card so reprints match. */
  function barcodeHtml(seed) {
    var hash = 2166136261, s = String(seed || 'CCO');
    for (var i = 0; i < s.length; i++) { hash ^= s.charCodeAt(i); hash = (hash * 16777619) >>> 0; }
    var bars = '';
    for (var b = 0; b < 68; b++) {
      hash ^= hash << 13; hash >>>= 0;
      hash ^= hash >> 17;
      hash ^= hash << 5; hash >>>= 0;
      var w = (hash % 3 === 0) ? 3 : (hash % 3 === 1 ? 2 : 1);
      var gap = (hash % 7 === 0) ? '6px' : '2px';
      bars += '<i style="width:' + w + 'px;margin-right:' + gap + '"></i>';
    }
    return '<div class="barcode" aria-hidden="true">' + bars + '</div>';
  }

  /* ------------------------------------------------------------ QR (real) */
  /* Encodes the candidate's own verification link so a scanner lands on the
   * live verification page. Falls back to hiding the block when the tiny
   * qrcode-generator CDN lib is unavailable. */
  function qrHtml(otp) {
    try {
      if (typeof window.qrcode !== 'function') return '';
      var qr = window.qrcode(0, 'M');
      qr.addData(U.buildVerifyLink(otp));
      qr.make();
      return qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
    } catch (e) { return ''; }
  }

  /* --------------------------------------------------------- card template */
  function cardHtml(c, otp) {
    var A = CFG.AGENCY;
    var expired = !!c.expired;
    var photo = U.validImageSrc(c.photo_url) ? c.photo_url : '';
    var verifyUrl = U.buildVerifyLink(otp).replace(/^https?:\/\//, '');
    var statusPill = expired
      ? '<span class="inline-flex items-center gap-1.5 rounded-full bg-slate-700 px-3 py-1 text-[10px] font-bold tracking-widest text-white uppercase">● Expired credential</span>'
      : '<span class="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-[10px] font-bold tracking-widest text-white uppercase">● Active work authorization</span>';

    return '' +
      '<article id="id-card" class="id-card relative mx-auto w-full overflow-hidden rounded-2xl bg-white text-slate-800">' +

      /* -- header -------------------------------------------------------- */
      '<header class="relative flex items-center gap-3 bg-[#C8102E] px-4 py-3.5 text-white sm:px-5">' +
        '<span class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/30">' + U.leafSvg(20, '#ffffff') + '</span>' +
        '<div class="min-w-0 flex-1">' +
          '<p class="truncate text-[15px] font-bold leading-tight tracking-tight">' + U.escapeHtml(A.NAME) + '</p>' +
          '<p class="truncate text-[10px] uppercase tracking-[0.18em] text-red-100">Toronto, ON · Canada · Since ' + U.escapeHtml(A.EST_YEAR) + '</p>' +
        '</div>' +
        '<div class="hidden shrink-0 text-right sm:block">' +
          '<p class="text-[9px] font-semibold uppercase tracking-[0.22em] text-red-100">Digital Credential</p>' +
          '<p class="text-[11px] font-bold tracking-widest">' + U.escapeHtml(c.employee_id || '') + '</p>' +
        '</div>' +
      '</header>' +

      /* -- faint corner-to-corner watermark (img data URI keeps html2canvas happy) */
      '<img src="' + U.leafDataUri('#C8102E') + '" alt="" aria-hidden="true" class="pointer-events-none absolute right-[-28px] top-[56px] h-48 w-48 opacity-[0.05]">' +

      /* -- body ---------------------------------------------------------- */
      '<div class="relative grid grid-cols-[92px_1fr] gap-4 p-4 sm:grid-cols-[112px_1fr] sm:gap-5 sm:p-5">' +
        '<div>' +
          '<img id="id-card-photo" alt="Candidate photo" class="h-[116px] w-[92px] rounded-lg border border-slate-200 bg-slate-100 object-cover sm:h-[140px] sm:w-[112px]"' +
            ' src="' + U.escapeHtml(photo || U.avatarDataUri(c.name)) + '">' +
          '<p class="mt-2 text-center text-[9px] font-semibold uppercase tracking-widest text-slate-400">Card holder</p>' +
        '</div>' +
        '<div class="min-w-0">' +
          '<p class="text-[9px] font-bold uppercase tracking-[0.2em] text-cameco-700">Candidate</p>' +
          '<h3 class="mt-0.5 truncate text-lg font-bold leading-tight text-slate-900 sm:text-xl">' + U.escapeHtml(c.name) + '</h3>' +
          '<p class="mt-0.5 truncate text-[13px] font-medium text-slate-600">' + U.escapeHtml(c.role) + '</p>' +
          '<dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">' +
            field('Passport No.', '<span class="font-mono tracking-wider">' + U.escapeHtml(c.passport) + '</span>') +
            field('Employee ID', '<span class="font-mono tracking-wider">' + U.escapeHtml(c.employee_id || '') + '</span>') +
            field('Work name', U.escapeHtml(c.work_name || c.role)) +
            field('Work type', U.escapeHtml(c.work_type || '—')) +
            field('Sex', U.escapeHtml(c.sex || '—')) +
            field('Phone', U.escapeHtml(c.phone || '—')) +
            field('Issued', U.escapeHtml(U.fmtDate(c.issue_date))) +
            field('Expires', U.escapeHtml(U.fmtDate(c.expiry_date))) +
          '</dl>' +
        '</div>' +
      '</div>' +

      /* -- badges -------------------------------------------------------- */
      '<div class="relative flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">' + statusPill +
        '<span class="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-800">' +
          U.leafSvg(10, '#B45309') + ' Verified agency</span>' +
      '</div>' +

      /* -- barcode / QR / signature strip -------------------------------- */
      '<div class="relative border-t border-slate-100 px-4 py-3 sm:px-5">' +
        '<div class="flex items-end justify-between gap-4">' +
          '<div class="min-w-0 flex-1">' +
            barcodeHtml(c.employee_id) +
            '<p class="mt-1 font-mono text-[10px] tracking-[0.28em] text-slate-500">' + U.escapeHtml(c.employee_id || '') + '</p>' +
          '</div>' +
          '<div id="id-card-qr" class="hidden h-[74px] w-[74px] shrink-0 rounded-md border border-slate-200 bg-white p-1 sm:block"></div>' +
          '<div class="shrink-0 text-right">' +
            '<div class="ml-auto w-[118px]">' + U.signatureSvg() + '</div>' +
            '<p class="mt-0.5 border-t border-slate-300 pt-1 text-[10px] font-semibold text-slate-700">' + U.escapeHtml(A.SIGNER_NAME) + '</p>' +
            '<p class="text-[9px] uppercase tracking-wider text-slate-400">' + U.escapeHtml(A.SIGNER_TITLE) + '</p>' +
            '<div class="stamp mt-2 ml-auto inline-block select-none">AUTHENTICATED · TORONTO</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      /* -- footer -------------------------------------------------------- */
      '<footer class="relative border-t border-slate-100 bg-slate-50 px-4 py-2.5 text-[9px] leading-relaxed text-slate-500 sm:px-5">' +
        '<p>Issued by ' + U.escapeHtml(A.NAME) + ' · Reg. ' + U.escapeHtml(A.REG_NUMBER) + ' · ' + U.escapeHtml(A.ADDRESS_LINE1) + ', ' + U.escapeHtml(A.ADDRESS_LINE2) + '</p>' +
        '<p class="mt-0.5">Verify this credential at <span class="font-mono text-slate-600">' + U.escapeHtml(verifyUrl) + '</span> · Verified ' + U.escapeHtml(U.fmtDate((c.verified_at || '').slice(0, 10))) + '</p>' +
        (CFG.CARD.SHOW_LEGAL_DISCLAIMER
          ? '<p class="mt-1 font-semibold text-slate-400">Private credential issued by ' + U.escapeHtml(A.NAME) + '. Not a Government of Canada document. Always confirm work authorization with IRCC.</p>'
          : '') +
      '</footer>' +
      '</article>';
  }

  function field(label, value) {
    return '<div><dt class="text-[9px] font-bold uppercase tracking-widest text-slate-400">' + label + '</dt>' +
      '<dd class="mt-0.5 font-semibold text-slate-800">' + value + '</dd></div>';
  }

  /* -------------------------------------------------------------- mounting */
  function mount(candidate, otp) {
    state.candidate = candidate;
    state.otp = otp;
    var host = U.$('#card-mount');
    if (!host) return;

    host.innerHTML = cardHtml(candidate, otp);

    /* QR block (generated after DOM insert so it can use the card's link) */
    var qrHost = U.$('#id-card-qr');
    if (qrHost) {
      var svg = qrHtml(otp);
      if (svg) { qrHost.innerHTML = svg; U.show(qrHost); } else { U.hide(qrHost); }
    }

    /* Photo resilience: whatever the source (URL or data URI), a load failure
     * swaps in the initials avatar so the card never shows a broken frame. */
    var photo = U.$('#id-card-photo');
    if (photo) {
      photo.onerror = function () { photo.onerror = null; photo.src = U.avatarDataUri(candidate.name); };
      photo.referrerPolicy = 'no-referrer';
      /* Force a re-attempt when the browser cached a failed load. */
      if (photo.complete && photo.naturalWidth === 0) photo.src = U.avatarDataUri(candidate.name);
    }

    U.show(U.$('#card-section'));
    var section = U.$('#card-section');
    setTimeout(function () {
      try { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { section.scrollIntoView(); }
    }, 120);
  }

  function unmount() {
    state.candidate = null; state.otp = '';
    U.hide(U.$('#card-section'));
    U.setHtml(U.$('#card-mount'), '');
  }

  /* ---------------------------------------------------------------- export */
  function waitForImages(root) {
    var imgs = U.$$('img', root);
    return Promise.all(imgs.map(function (img) {
      if (img.complete && img.naturalWidth > 0) return Promise.resolve();
      return new Promise(function (resolve) {
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        img.addEventListener('load', finish);
        img.addEventListener('error', finish);
        setTimeout(finish, 4000);
      });
    }));
  }

  /* Ensure the photo is CORS-clean before capture. Returns the src actually
   * used (may be the avatar fallback) so the UI can warn accurately. */
  function makePhotoCanvasSafe() {
    var photo = U.$('#id-card-photo');
    if (!photo) return Promise.resolve(true);
    if (photo.src.indexOf('data:') === 0) return Promise.resolve(true);
    return U.fetchImageAsDataUri(photo.src, 720, 0.88).then(function (dataUri) {
      if (dataUri) { photo.src = dataUri; return true; }
      photo.src = U.avatarDataUri((state.candidate && state.candidate.name) || '');
      return false;
    });
  }

  /* Fixed 3x scale → ~1260px wide PNG (crisp on every screen; the card is
   * only ~420 CSS px wide so memory stays modest even on old phones). */
  function exportScale() {
    return 3;
  }

  function capture() {
    var card = U.$('#id-card');
    if (!card) return Promise.reject(U.appError('no_card', 'Nothing to export yet.'));
    return new Promise(function (resolve, reject) {
      if (typeof window.html2canvas !== 'function') {
        return reject(U.appError('no_html2canvas', 'Image export library is unavailable. Check your connection and reload.'));
      }
      var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready.catch(function () {}) : Promise.resolve();
      fontsReady.then(function () { return waitForImages(card); }).then(function () {
        return window.html2canvas(card, {
          scale: exportScale(),
          useCORS: true,
          allowTaint: false,
          backgroundColor: '#ffffff',
          logging: false,
          imageTimeout: 8000,
          windowWidth: document.documentElement.clientWidth
        });
      }).then(resolve, function (err) {
        /* One retry with a guaranteed-safe photo; the most common canvas
         * failure is a tainted cross-origin image. */
        var photo = U.$('#id-card-photo');
        if (photo && photo.src.indexOf('data:') !== 0) {
          photo.src = U.avatarDataUri((state.candidate && state.candidate.name) || '');
          window.html2canvas(card, { scale: exportScale(), useCORS: true, allowTaint: false, backgroundColor: '#ffffff', logging: false, imageTimeout: 8000 })
            .then(resolve, function (e2) { reject(U.appError('capture_failed', (e2 && e2.message) || 'Could not render the card image.')); });
        } else {
          reject(U.appError('capture_failed', (err && err.message) || 'Could not render the card image.'));
        }
      });
    });
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(U.appError('blob_failed', 'Could not encode the image.')); }, 'image/png');
      } else {
        try {
          var data = canvas.toDataURL('image/png');
          var bin = atob(data.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: 'image/png' }));
        } catch (e) { reject(U.appError('blob_failed', 'Could not encode the image.')); }
      }
    });
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function deliver(blob, filename) {
    var file = null;
    try { file = new File([blob], filename, { type: 'image/png' }); } catch (e) { file = null; }
    var objUrl = URL.createObjectURL(blob);
    var cleanup = function () { setTimeout(function () { URL.revokeObjectURL(objUrl); }, 60000); };

    /* 1. Native share sheet (best on iOS/Android + Telegram) */
    var canShareFiles = !!(navigator.canShare && file && navigator.canShare({ files: [file] }));
    if (canShareFiles) {
      return navigator.share({
        files: [file],
        title: 'Cameco Careers — Digital ID Card',
        text: 'Digital ID card for ' + ((state.candidate && state.candidate.name) || 'candidate')
      }).then(function () { cleanup(); return 'shared'; }, function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
          /* User cancelled or activation was lost → silent download fallback. */
          return downloadOrOpen(objUrl, filename, cleanup);
        }
        return downloadOrOpen(objUrl, filename, cleanup);
      });
    }
    return Promise.resolve(downloadOrOpen(objUrl, filename, cleanup));
  }

  function downloadOrOpen(objUrl, filename, cleanup) {
    if (isIOS()) {
      /* iOS Safari ignores <a download> for blob URLs → open in a new tab and
       * let the user long-press / share from there. */
      var w = window.open(objUrl, '_blank');
      if (w) {
        U.toast('Image opened — long-press (or use Share) to save it to Photos.', 'info', 6000);
        cleanup();
        return 'opened';
      }
    }
    try {
      var a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      U.toast('ID card saved to your downloads.', 'success');
      cleanup();
      return 'downloaded';
    } catch (e) {
      var fallback = window.open(objUrl, '_blank');
      cleanup();
      if (fallback) { U.toast('Image opened — use the share menu to save it.', 'info', 6000); return 'opened'; }
      U.toast('Could not save the image on this browser.', 'error', 5000);
      return 'failed';
    }
  }

  function downloadCurrent(btn) {
    if (state.exporting) return;
    state.exporting = true;
    var original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = spinner() + ' Preparing image…'; }

    makePhotoCanvasSafe()
      .then(capture)
      .then(canvasToBlob)
      .then(function (blob) {
        var c = state.candidate || {};
        var name = 'Cameco-ID-' + (c.employee_id || 'card') + '.png';
        return deliver(blob, name);
      })
      .then(function (how) {
        if (CFG.DEBUG) console.log('[idcard] export:', how);
      })
      .catch(function (err) {
        console.warn('[idcard] export failed:', err);
        U.toast((err && err.message) || 'Could not export the card image.', 'error', 5200);
      })
      .then(function () {
        state.exporting = false;
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
      });
  }

  function spinner() {
    return '<svg class="mr-2 inline h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
      '<path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"></path></svg>';
  }

  CCO.idcard = { mount: mount, unmount: unmount, downloadCurrent: downloadCurrent, _capture: capture };
})();
