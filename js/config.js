/* ============================================================================
 * Cameco Careers Inc. — Verification Portal
 * js/config.js — single place where deployments are configured.
 *
 * 1. Fill in SUPABASE_URL and SUPABASE_ANON_KEY from
 *    Supabase Dashboard → Project Settings → API.
 * 2. Run supabase/schema.sql once in the Supabase SQL editor.
 * 3. Change the master passkey (default: admin2026) from the Admin → Settings.
 *
 * DEMO_MODE:
 *   'auto'  → demo backend when Supabase keys are still placeholders or the
 *             supabase-js CDN failed to load. Never used when keys are real.
 *   true    → force the in-memory demo backend (for UI previews only).
 *   false   → force the cloud backend even if keys look like placeholders
 *             (a clear configuration error banner will be shown instead).
 * ==========================================================================*/
(function () {
  'use strict';

  window.CCO_CONFIG = {
    /* ---------- Backend credentials (REQUIRED for production) ---------- */
    /* Only PUBLIC keys belong in this file — everything here is visible to
     * every visitor. The legacy anon JWT ("eyJ…") and the newer
     * sb_publishable_… key are both accepted; the publishable key keeps
     * working even after the JWT secret is rotated, so it is preferred. */
    SUPABASE_URL: 'https://pogghetoiofixfflxcvd.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_AlMzpheVXfQv_nm_uePBVA_lV-fDbdZ',

    /* ---------- Demo behaviour ---------- */
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
      // Example corporate registration numbers — replace with your own.
      REG_NUMBER: 'ON-2421887',
      EST_YEAR: '2012',
      // Signature block rendered on the ID card.
      SIGNER_NAME: 'M. Tremblay',
      SIGNER_TITLE: 'Director of Placement'
    },

    /* ---------- ID card behaviour ---------- */
    CARD: {
      // Validity default applied to newly created candidates (years).
      DEFAULT_VALIDITY_YEARS: 1,
      // Show "not a Government of Canada document" line on the card footer.
      // Recommended: keep enabled (avoids implying government-issued ID).
      SHOW_LEGAL_DISCLAIMER: true,
      // Max photo upload size after client-side downscaling (bytes, approx).
      MAX_EMBEDDED_PHOTO_BYTES: 400 * 1024
    },

    /* ---------- Realtime admin sync ---------- */
    REALTIME: {
      // Broadcast channel used to notify other admin tabs of changes.
      CHANNEL: 'cco-admin-sync',
      // Safety-net polling interval (ms) in case realtime is unavailable.
      POLL_MS: 45000
    },

    /* ---------- UX ---------- */
    AUTO_VERIFY_ON_LINK: true,   // ?code= / ?otp= deep links verify on load
    OTP_AUTOSUBMIT_MS: 350,      // debounce before auto-submit at 6 digits
    REQUEST_TIMEOUT_MS: 15000,   // per network request
    DEBUG: false                 // verbose console logging
  };
})();
