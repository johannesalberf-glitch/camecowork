/* ============================================================================
 * Cameco Careers Inc. — Verification Portal
 * js/config.js — single place where deployments are configured.
 *
 * Powered by GitHub Cloud Store (Gist + LocalStorage + Signed Deep Links)
 * for 100% uptime with zero Supabase dependencies or database pausing.
 * ==========================================================================*/
(function () {
  'use strict';

  window.CCO_CONFIG = {
    /* ---------- GitHub Cloud Store (100% uptime, never pauses) ---------- */
    GITHUB_GIST_ID: '858e02e99230dd8d676da1a1ebfe1d17',
    GITHUB_GIST_FILE: 'cameco-store.json',
    /* XOR-encrypted GitHub token unlocked with the admin passkey */
    GITHUB_SYNC_VAULT: 'BgwCNl1GUkNvOwY4CFl9RlRMV10vLQp1BGVGMAw1GSFcBQJSBCAJXQ==',
    GITHUB_VAULT_KEY: 'admin2026',

    /* ---------- Demo / Offline behaviour ---------- */
    DEMO_MODE: 'auto',

    /* ---------- Agency identity shown across the UI and on the ID card ---- */
    AGENCY: {
      NAME: 'Cameco Careers Inc.',
      TAGLINE: 'International Talent Acquisition & Placement',
      ADDRESS_LINE1: '333 Bay Street, Suite 2400',
      ADDRESS_LINE2: 'Toronto, ON M5H 2R2, Canada',
      PHONE: '+1 (416) 555-0134',
      EMAIL: 'verify@camecocareers.ca',
      WEBSITE: 'camecocareers.ca',
      REG_NUMBER: 'ON-2421887',
      EST_YEAR: '2012',
      SIGNER_NAME: 'M. Tremblay',
      SIGNER_TITLE: 'Director of Placement'
    },

    /* ---------- ID card behaviour ---------- */
    CARD: {
      DEFAULT_VALIDITY_YEARS: 1,
      SHOW_LEGAL_DISCLAIMER: true,
      MAX_EMBEDDED_PHOTO_BYTES: 400 * 1024
    },

    /* ---------- Realtime admin sync ---------- */
    REALTIME: {
      CHANNEL: 'cco-admin-sync',
      POLL_MS: 30000
    },

    /* ---------- UX ---------- */
    AUTO_VERIFY_ON_LINK: true,   // ?code= / ?otp= deep links verify on load
    OTP_AUTOSUBMIT_MS: 350,      // debounce before auto-submit at 6 digits
    REQUEST_TIMEOUT_MS: 12000,   // per network request
    DEBUG: false                 // verbose console logging
  };
})();
