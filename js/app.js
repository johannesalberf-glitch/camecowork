/* ============================================================================
 * js/app.js — bootstrap, routing and global chrome (banners, toasts).
 * Loaded last; assumes every other module is already registered on CCO.
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = CCO.U;
  var CFG = window.CCO_CONFIG || {};

  var tapCount = 0, tapTimer = null;

  function showView(name) {
    var verify = U.$('#view-verify');
    var admin = U.$('#view-admin');
    if (name === 'admin') {
      U.hide(verify); U.show(admin);
      document.title = 'Admin Portal — ' + CFG.AGENCY.NAME;
      CCO.admin.open();
    } else {
      U.hide(admin); U.show(verify);
      document.title = 'Credential Verification — ' + CFG.AGENCY.NAME;
      /* A deep link may have arrived after first load (in-app tab switches). */
      CCO.verify.retryFromUrl();
    }
  }

  function currentRoute() { return U.getRoute(); }

  function applyRoute() {
    showView(currentRoute());
  }

  /* --------------------------------------------------- connection banners */
  function bindNetworkBanner() {
    var bar = U.$('#net-banner');
    if (!bar) return;
    function update() {
      if (navigator.onLine) U.hide(bar);
      else U.show(bar);
    }
    U.on(window, 'online', function () { update(); U.toast('Back online.', 'success', 1800); });
    U.on(window, 'offline', update);
    update();
  }

  function showConfigBanner() {
    var bar = U.$('#cfg-banner');
    if (!bar) return;
    if (CCO.DB.mode === 'misconfigured') {
      bar.innerHTML = '<strong>Backend not configured.</strong> ' + U.escapeHtml(CCO.DB.reason || '') +
        ' Add your Supabase URL and anon key in <span class="font-mono">js/config.js</span>.';
      U.show(bar);
    } else {
      U.hide(bar);
    }
  }

  function probeBackend() {
    if (CCO.DB.mode !== 'cloud') return;
    CCO.DB.healthCheck().then(function (ok) {
      if (ok) return;
      var bar = U.$('#cfg-banner');
      if (!bar) return;
      bar.innerHTML = '<strong>Verification service unreachable.</strong> We could not reach Supabase (' +
        U.escapeHtml(CCO.DB.backend.health.detail || 'network error') +
        '). Check your connection — the page will keep working once the service responds.' +
        ' If this persists, confirm supabase/schema.sql was run and the keys in js/config.js are correct.';
      U.show(bar);
    });
  }

  /* -------------------------------------------------- discreet admin entry */
  /* Five quick taps on the brand mark open the portal — useful when the host
   * cannot serve a /admin route. The footer link does the same. */
  function bindAdminToggle() {
    U.on(U.$('#brand-logo'), 'click', function () {
      tapCount++;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(function () { tapCount = 0; }, 1400);
      if (tapCount >= 5) {
        tapCount = 0;
        U.toast('Opening staff portal…', 'info', 1500);
        showView('admin');
        try { history.replaceState(null, '', U.verificationBaseUrl() + '?admin=1'); } catch (e) {}
      }
    });

    U.on(U.$('#footer-admin-link'), 'click', function (ev) {
      ev.preventDefault();
      showView('admin');
      try { history.replaceState(null, '', U.verificationBaseUrl() + '?admin=1'); } catch (e) {}
    });

    U.on(window, 'hashchange', applyRoute);
  }

  /* ------------------------------------------------------------ site copy */
  function fillAgencyCopy() {
    var A = CFG.AGENCY;
    U.$$('[data-agency]').forEach(function (node) {
      var key = node.getAttribute('data-agency');
      if (A[key] != null) node.textContent = A[key];
    });
    var year = U.$('[data-agency-year]');
    if (year) year.textContent = A.EST_YEAR;
    var current = U.$('[data-current-year]');
    if (current) current.textContent = new Date().getFullYear();
  }

  /* --------------------------------------------------------------- init */
  function init() {
    U.initViewport();
    CCO.DB.init();

    fillAgencyCopy();
    bindNetworkBanner();
    bindAdminToggle();
    showConfigBanner();
    probeBackend();

    CCO.verify.init();
    CCO.admin.init();

    applyRoute();

    /* Restore the canonical route for /admin paths that static hosts may
     * resolve via rewrite (Netlify/Vercel) or query toggles. */
    if (/(^|\/)admin/i.test(window.location.pathname) === false && U.getLinkParams().admin) {
      try { history.replaceState(null, '', U.verificationBaseUrl() + '?admin=1'); } catch (e) {}
    }

    if (CFG.DEBUG) console.log('[app] ready — backend:', CCO.DB.mode, '| route:', currentRoute(), '| config:', CFG);
  }

  var api = {
    init: init,
    showView: showView,
    baseUrl: U.verificationBaseUrl
  };

  CCO.app = api;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
