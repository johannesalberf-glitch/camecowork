/* ============================================================================
 * js/verify.js — public verification view.
 *
 * Handles: 6-digit OTP input (numeric keypad, autofocus, auto-submit),
 * deep links (?code / ?otp / Telegram start params) with auto-verification,
 * clear error states, and offline retry.
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = CCO.U;
  var CFG = window.CCO_CONFIG || {};

  var el = {};
  var state = { busy: false, autoTimer: null, lastOtp: '', networkError: false, handledLink: null };

  function cacheDom() {
    el.form = U.$('#verify-form');
    el.input = U.$('#otp-input');
    el.button = U.$('#verify-btn');
    el.alert = U.$('#verify-alert');
    el.hint = U.$('#verify-hint');
  }

  function alertBox(type, title, body, retryable) {
    if (!el.alert) return;
    var palette = {
      error: 'border-rose-200 bg-rose-50 text-rose-900',
      warn: 'border-amber-200 bg-amber-50 text-amber-900',
      info: 'border-sky-200 bg-sky-50 text-sky-900'
    };
    el.alert.className = 'mt-4 rounded-xl border px-4 py-3 text-sm ' + (palette[type] || palette.info);
    el.alert.innerHTML =
      '<p class="font-semibold">' + U.escapeHtml(title) + '</p>' +
      (body ? '<p class="mt-1 leading-relaxed">' + U.escapeHtml(body) + '</p>' : '') +
      (retryable ? '<button type="button" id="verify-retry" class="mt-2 rounded-lg border border-current/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider">Retry</button>' : '');
    U.show(el.alert);
    var retry = U.$('#verify-retry');
    if (retry) U.on(retry, 'click', function () { verify(state.lastOtp || el.input.value, { source: 'retry' }); });
  }

  function clearAlert() { if (el.alert) { el.alert.innerHTML = ''; U.hide(el.alert); } }

  function busy(on) {
    state.busy = on;
    if (!el.button) return;
    el.button.disabled = on;
    el.button.innerHTML = on
      ? '<svg class="mr-2 inline h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-80" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"></path></svg>Verifying…'
      : 'Verify credential';
    if (el.input) el.input.disabled = on;
  }

  /* --------------------------------------------------------------- verify */
  function verify(rawOtp, opts) {
    opts = opts || {};
    if (state.busy) return Promise.resolve();
    var otp = U.digitsOnly(rawOtp).slice(0, 6);
    if (el.input && U.digitsOnly(el.input.value) !== otp) el.input.value = otp;

    if (otp.length !== 6) {
      CCO.idcard.unmount();
      alertBox('warn', 'Enter all 6 digits', 'Verification codes are exactly six digits — check the code and try again.');
      return Promise.resolve();
    }

    state.lastOtp = otp;
    state.networkError = false;
    clearAlert();
    busy(true);
    CCO.idcard.unmount();

    return CCO.DB.verifyOtp(otp, U.deviceId()).then(function (res) {
      busy(false);
      var status = (res && res.status) || 'not_found';

      if (status === 'ok' && res.candidate) {
        clearAlert();
        CCO.idcard.mount(res.candidate, otp);
        if (opts.source === 'link') U.toast('Credential verified from link.', 'success');
        return;
      }
      if (status === 'invalid') {
        alertBox('warn', 'That code is incomplete', 'Double-check every digit of the 6-digit code.');
      } else if (status === 'rate_limited') {
        alertBox('error', 'Too many attempts', 'For security, verification is paused for this device. Please wait about 10 minutes and try again.');
      } else if (status === 'not_found') {
        alertBox('error', 'No matching credential',
          'We could not match that code to an active credential. Codes expire and can be reissued — ask the agency contact who sent you the code to confirm it, then try again.');
      } else {
        alertBox('error', 'Unexpected response', 'The verification service returned an unexpected result. Please try again.');
      }
    }).catch(function (err) {
      busy(false);
      var code = err && err.code;
      if (code === 'not_configured') {
        alertBox('error', 'Verification service unavailable', 'This deployment is not connected to its database yet. Please contact the agency.');
      } else if (code === 'invalid_passkey' || code === 'server') {
        alertBox('error', 'Verification temporarily unavailable', (err && err.message) || 'Please try again in a moment.', true);
      } else if (U.isNetworkLike(err) || code === 'rate_limited') {
        state.networkError = code !== 'rate_limited';
        alertBox('error', 'Connection problem',
          'We could not reach the verification service. Check your internet connection — Telegram and in-app browsers sometimes need a moment — then tap Retry.', true);
      } else {
        alertBox('error', 'Something went wrong', (err && err.message) || 'Please try again.', true);
      }
    });
  }

  /* ------------------------------------------------------------ OTP input */
  function bindInput() {
    if (!el.input) return;

    U.on(el.input, 'input', function () {
      var clean = U.digitsOnly(el.input.value).slice(0, 6);
      if (el.input.value !== clean) el.input.value = clean;
      clearAlert();
      if (state.autoTimer) clearTimeout(state.autoTimer);
      /* Auto-submit once the sixth digit lands (small debounce so the last
       * keystroke renders and IMEs finish). */
      if (clean.length === 6) {
        state.autoTimer = setTimeout(function () { verify(clean, { source: 'auto' }); }, CFG.OTP_AUTOSUBMIT_MS);
      }
    });

    U.on(el.input, 'keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); if (state.autoTimer) clearTimeout(state.autoTimer); verify(el.input.value, { source: 'enter' }); }
    });

    /* Paste of "123-456" / "123 456" — sanitize before the input event. */
    U.on(el.input, 'paste', function (ev) {
      try {
        var text = (ev.clipboardData || window.clipboardData).getData('text');
        if (text) {
          ev.preventDefault();
          el.input.value = U.digitsOnly(text).slice(0, 6);
          el.input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } catch (e) { /* let the browser handle it */ }
    });

    U.on(el.input, 'focus', function () { U.revealInput(el.input); });
  }

  function bindForm() {
    if (!el.form) return;
    U.on(el.form, 'submit', function (ev) {
      ev.preventDefault();
      if (state.autoTimer) clearTimeout(state.autoTimer);
      U.revealInput(el.input);
      verify(el.input.value, { source: 'submit' });
    });
  }

  /* --------------------------------------------------------- deep linking */
  function handleDeepLink() {
    var otp = U.getLinkOtp();
    if (!otp) return false;
    /* Guard against double handling: init() and the router both call this. */
    if (state.handledLink === otp) return true;
    state.handledLink = otp;
    if (el.input) el.input.value = otp;

    if (otp.length < 6) {
      alertBox('warn', 'Link code looks incomplete', 'The link you followed carried a partial code. Enter the remaining digits or ask for a fresh link.');
      if (el.input) el.input.focus();
      return true;
    }
    if (!CFG.AUTO_VERIFY_ON_LINK) {
      if (el.input) el.input.focus();
      return true;
    }
    alertBox('info', 'Code detected in link', 'Verifying automatically…');
    verify(otp, { source: 'link' });
    return true;
  }

  /* Card output buttons: save as image, print, verify another code. */
  function bindCardActions() {
    var dl = U.$('#card-download');
    if (dl) U.on(dl, 'click', function () { CCO.idcard.downloadCurrent(dl); });

    var printBtn = U.$('#card-print');
    if (printBtn) U.on(printBtn, 'click', function () {
      try { window.print(); } catch (e) { U.toast('Printing is not available in this browser.', 'error'); }
    });

    var again = U.$('#card-verify-another');
    if (again) U.on(again, 'click', function () { api.reset(); });
  }

  /* Auto-retry a network-blocked verification once the device reconnects. */
  function bindReconnect() {
    U.on(window, 'online', function () {
      if (state.networkError && state.lastOtp) {
        state.networkError = false;
        verify(state.lastOtp, { source: 'reconnect' });
      }
    });
  }

  var api = {};

  api.init = function () {
    cacheDom();
    bindInput();
    bindForm();
    bindCardActions();
    bindReconnect();
    var fromLink = handleDeepLink();
    if (!fromLink && el.input) {
      /* Autofocus is unreliable inside Telegram/Instagram webviews unless it
       * follows a user gesture; try softly and never scroll-jump. */
      setTimeout(function () { try { el.input.focus({ preventScroll: true }); } catch (e) { el.input.focus(); } }, 420);
    }
  };

  api.verify = verify;
  api.reset = function () {
    CCO.idcard.unmount();
    clearAlert();
    state.handledLink = null;
    if (el.input) { el.input.value = ''; el.input.disabled = false; el.input.focus(); }
    if (state.autoTimer) clearTimeout(state.autoTimer);
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  };

  /* Called by app.js when the user re-enters the verify view, so a deep link
   * opened later (e.g. tabs) still verifies. */
  api.retryFromUrl = handleDeepLink;

  CCO.verify = api;
})();
