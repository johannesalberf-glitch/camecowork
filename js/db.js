/* ============================================================================
 * js/db.js — data layer.
 *
 * Every read/write goes through Postgres RPC functions (see supabase/schema.sql):
 *   • verify_candidate_otp(otp, device_id) → public verification, minimal data
 *   • admin_* (passkey-guarded)            → list / save / delete / otp / passkey
 *
 * The candidates table itself has Row Level Security with NO policies, so the
 * anonymous key cannot read passport numbers or dump records; only these
 * SECURITY DEFINER functions can. No localStorage session state is used.
 *
 * When Supabase keys are still placeholders (or the CDN failed to load) the
 * module transparently runs the in-memory DEMO backend so the UI is fully
 * testable. Demo data lives for the tab's lifetime only.
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = CCO.U;
  var CFG = window.CCO_CONFIG || {};

  function keysLookReal() {
    return typeof CFG.SUPABASE_URL === 'string' &&
      /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(CFG.SUPABASE_URL) &&
      typeof CFG.SUPABASE_ANON_KEY === 'string' &&
      CFG.SUPABASE_ANON_KEY.length > 30 &&
      CFG.SUPABASE_ANON_KEY.indexOf('YOUR-') === -1;
  }

  /* The in-memory fallback exists so the UI can be reviewed without a
   * database. It is silently used ONLY on local previews (localhost / LAN /
   * file://); on a real domain the app shows a configuration error instead of
   * ever presenting sample data as if it were live. */
  function isLocalPreview() {
    if (window.location.protocol === 'file:') return true;
    var h = (window.location.hostname || '').toLowerCase();
    return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ||
      h === '0.0.0.0' || /^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\./.test(h) || /\.local$|\.localhost$/.test(h);
  }

  /* ======================================================================
   * Cloud backend — Supabase
   * ====================================================================*/
  function CloudBackend(client) {
    var self = { mode: 'cloud', client: client, health: { state: 'connecting', detail: '' } };

    function rpc(fn, args) {
      var call = function () {
        return client.rpc(fn, args || {}).then(function (res) {
          if (res.error) throw mapPgError(res.error);
          return res.data;
        }, function (e) {
          /* Transport-level rejection (offline, DNS, CSP…) */
          throw U.appError('network', (e && e.message) || 'Network request failed.');
        });
      };
      return U.withRetry(call, { attempts: 3 }).catch(function (err) {
        if (CFG.DEBUG) console.warn('[db]', fn, 'failed:', err && err.message);
        throw err;
      });
    }

    function mapPgError(error) {
      var msg = (error && error.message) || '';
      var hint = (error && error.hint) || '';
      if (/INVALID_PASSKEY/.test(msg)) return U.appError('invalid_passkey', hint || 'Incorrect master passkey.');
      if (/RATE_LIMITED/.test(msg)) return U.appError('rate_limited', hint || 'Too many failed attempts. Please wait a few minutes.');
      if (/DUPLICATE_OTP/.test(msg)) return U.appError('duplicate_otp', 'That 6-digit code is already assigned to another candidate.');
      if (/WEAK_PASSKEY/.test(msg)) return U.appError('weak_passkey', hint || 'The new passkey must be at least 8 characters.');
      if (/NOT_FOUND/.test(msg)) return U.appError('not_found', 'That record no longer exists.');
      if (/check constraint|VALIDATION/i.test(msg)) return U.appError('validation', 'Some fields are invalid. Please review the form.');
      if (/permission denied|does not exist|Could not find the function|schema cache/i.test(msg)) {
        return U.appError('not_configured', 'The database is not fully configured. Run supabase/schema.sql in your Supabase project.');
      }
      return U.appError('server', msg || 'The server rejected the request.');
    }

    /* ---- verification (public) ---------------------------------------- */
    self.verifyOtp = function (otp, deviceId) {
      return rpc('verify_candidate_otp', { p_otp: otp, p_device_id: deviceId })
        .then(function (data) { return data || { status: 'not_found' }; });
    };

    /* ---- admin (passkey guarded) --------------------------------------- */
    self.adminCheck = function (pass) {
      return rpc('admin_check', { p_passkey: pass });
    };
    self.adminList = function (pass) {
      return rpc('admin_list_candidates', { p_passkey: pass }).then(function (d) {
        if (Array.isArray(d)) return d;
        return (d && d.candidates) || [];
      });
    };
    self.adminSave = function (pass, payload) {
      var args = {
        p_passkey: pass,
        p_id: payload.id || null,
        p_name: payload.name,
        p_passport: payload.passport,
        p_role: payload.role,
        p_otp: payload.otp,
        p_photo_url: payload.photo_url || null,
        p_issue_date: payload.issue_date || null,
        p_expiry_date: payload.expiry_date || null,
        p_status: payload.status || 'active',
        /* Pass through as-is ('' clears the field, null keeps the old value). */
        p_work_name: payload.work_name == null ? null : String(payload.work_name),
        p_work_type: payload.work_type == null ? null : String(payload.work_type),
        p_sex: payload.sex == null ? null : String(payload.sex),
        p_phone: payload.phone == null ? null : String(payload.phone)
      };
      return rpc('admin_save_candidate', args).then(function (d) { return (d && d.candidate) || null; });
    };
    self.adminDelete = function (pass, id) {
      return rpc('admin_delete_candidate', { p_passkey: pass, p_id: id });
    };
    self.adminGenerateOtp = function (pass) {
      return rpc('admin_generate_otp', { p_passkey: pass }).then(function (d) { return d && d.otp; });
    };
    self.adminChangePasskey = function (pass, newPass) {
      return rpc('admin_change_passkey', { p_passkey: pass, p_new_passkey: newPass });
    };

    /* ---- realtime: broadcast channel + polling fallback ----------------- */
    self.subscribe = function (opts) {
      opts = opts || {};
      var onChange = opts.onChange || function () {};
      var onStatus = opts.onStatus || function () {};
      var channel = null;
      try {
        channel = client.channel(CFG.REALTIME.CHANNEL, { config: { broadcast: { self: false } } });
        channel.on('broadcast', { event: 'candidates-changed' }, function (msg) {
          var by = msg && msg.payload && msg.payload.by;
          if (by && by === self.clientId) return; /* don't react to our own echo */
          onChange();
        });
        channel.subscribe(function (status) {
          onStatus(status === 'SUBSCRIBED' ? 'live' : (status === 'CLOSED' ? 'offline' : 'polling'));
        });
      } catch (e) {
        onStatus('polling');
      }
      self._channel = channel;
      return function () { try { if (channel) client.removeChannel(channel); } catch (e) {} };
    };
    self.publishChange = function () {
      try {
        if (self._channel) self._channel.send({ type: 'broadcast', event: 'candidates-changed', payload: { by: self.clientId, at: Date.now() } });
      } catch (e) { /* other admins still get data via polling */ }
    };

    self.healthCheck = function () {
      return U.withTimeout(client.rpc('health', {}), 9000).then(function (res) {
        if (res.error) throw mapPgError(res.error);
        self.health = { state: 'online', detail: (res.data && res.data.version) || 'ok' };
        return true;
      }).catch(function (err) {
        self.health = { state: 'error', detail: (err && err.message) || 'unreachable' };
        return false;
      });
    };

    self.clientId = 'adm_' + U.randomId();
    return self;
  }

  /* ======================================================================
   * Demo backend — in-memory. Mirrors the cloud contract 1:1 so switching
   * backends changes nothing else in the app.
   * ====================================================================*/
  function DemoBackend() {
    var self = { mode: 'demo', clientId: 'adm_' + U.randomId(), health: { state: 'online', detail: 'demo' } };
    var passkey = 'admin2026';
    var seq = 1003;
    var today = U.isoToday();
    var listeners = [];
    var verifyFails = {};    /* deviceId → [timestamp,…] */
    var adminFails = [];

    var store = [
      {
        id: 'demo-1', employee_id: 'CCO-2026-01001', name: 'Amara N. Okafor',
        passport: 'A20943771', role: 'Registered Nurse (ICU)', otp: '482913',
        work_name: 'Registered Nurse — ICU Placement', work_type: 'Permanent Full-Time',
        sex: 'Female', phone: '+1 416 555 0134',
        photo_url: U.avatarDataUri('Amara Okafor'), issue_date: '2026-02-10',
        expiry_date: U.addYearsIso(today, 1), status: 'active', created_at: new Date(Date.now() - 864e5 * 40).toISOString()
      },
      {
        id: 'demo-2', employee_id: 'CCO-2025-00842', name: 'Daniel F. Moreau',
        passport: 'J8841207', role: 'Journeyman Welder (CWB)', otp: '619204',
        work_name: 'Journeyman Welder — CWB Certified', work_type: 'Fixed-Term (12 months)',
        sex: 'Male', phone: '+1 647 555 0188',
        photo_url: U.avatarDataUri('Daniel Moreau'), issue_date: '2025-06-30',
        expiry_date: '2026-06-29', status: 'active', created_at: new Date(Date.now() - 864e5 * 210).toISOString()
      },
      {
        id: 'demo-3', employee_id: 'CCO-2026-01002', name: 'Sofia P. Reyes',
        passport: 'P7743118', role: 'Red Seal Line Cook', otp: '377915',
        work_name: 'Red Seal Line Cook', work_type: 'Seasonal',
        sex: 'Female', phone: '+1 437 555 0102',
        photo_url: U.avatarDataUri('Sofia Reyes'), issue_date: '2026-08-01',
        expiry_date: U.addYearsIso(today, 1), status: 'active', created_at: new Date(Date.now() - 864e5 * 8).toISOString()
      }
    ];

    function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }
    function clean(list, cutoffMs) { return (list || []).filter(function (t) { return t > (Date.now() - cutoffMs); }); }
    function delay(v, ms) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); }
    function findByOtp(otp) {
      for (var i = 0; i < store.length; i++) if (store[i].otp === otp) return store[i];
      return null;
    }

    self.verifyOtp = function (otp, deviceId) {
      return delay(null, 420).then(function () {
        var code = U.digitsOnly(otp);
        if (code.length !== 6) return { status: 'invalid' };
        var dev = deviceId || 'anon';
        verifyFails[dev] = clean(verifyFails[dev], 10 * 60e3);
        if (verifyFails[dev].length >= 25) return { status: 'rate_limited' };
        var row = findByOtp(code);
        if (!row || row.status === 'revoked') {
          verifyFails[dev].push(Date.now());
          return { status: 'not_found' };
        }
        return {
          status: 'ok',
          candidate: {
            name: row.name, passport: row.passport, role: row.role, photo_url: row.photo_url,
            work_name: row.work_name, work_type: row.work_type, sex: row.sex, phone: row.phone,
            employee_id: row.employee_id, issue_date: row.issue_date, expiry_date: row.expiry_date,
            expired: U.daysUntil(row.expiry_date) < 0, verified_at: new Date().toISOString()
          }
        };
      });
    };

    function assertAdmin(pass) {
      adminFails = clean(adminFails, 15 * 60e3);
      if (adminFails.length >= 20) throw U.appError('rate_limited', 'Too many failed attempts. Please wait a few minutes.');
      if (pass !== passkey) {
        adminFails.push(Date.now());
        throw U.appError('invalid_passkey', 'Incorrect master passkey.');
      }
    }

    self.adminCheck = function (pass) {
      return delay(null, 380).then(function () {
        assertAdmin(pass);
        return { ok: true, using_default_passkey: passkey === 'admin2026' };
      });
    };
    self.adminList = function (pass) {
      return delay(null, 250).then(function () {
        assertAdmin(pass);
        return store.slice().sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
      });
    };
    self.adminSave = function (pass, p) {
      return delay(null, 320).then(function () {
        assertAdmin(pass);
        var otp = U.digitsOnly(p.otp);
        if (otp.length !== 6) throw U.appError('validation', 'The 6-digit code is required.');
        var dupe = findByOtp(otp);
        if (dupe && dupe.id !== p.id) throw U.appError('duplicate_otp', 'That 6-digit code is already assigned to another candidate.');
        var row;
        if (p.id) {
          row = store.filter(function (r) { return r.id === p.id; })[0];
          if (!row) throw U.appError('not_found', 'That record no longer exists.');
          row.name = p.name; row.passport = String(p.passport).toUpperCase(); row.role = p.role;
          row.work_name = p.work_name == null ? row.work_name : (String(p.work_name).trim() || null);
          row.work_type = p.work_type == null ? row.work_type : (String(p.work_type).trim() || null);
          row.sex = p.sex == null ? row.sex : (String(p.sex).trim() || null);
          row.phone = p.phone == null ? row.phone : (String(p.phone).trim() || null);
          row.otp = otp; row.photo_url = p.photo_url || null;
          row.issue_date = p.issue_date; row.expiry_date = p.expiry_date; row.status = p.status || 'active';
        } else {
          row = {
            id: 'demo-' + U.randomId(), employee_id: 'CCO-' + today.slice(0, 4) + '-' + ('00000' + (seq++)).slice(-5),
            name: p.name, passport: String(p.passport).toUpperCase(), role: p.role,
            work_name: String(p.work_name || '').trim() || null,
            work_type: String(p.work_type || '').trim() || null,
            sex: String(p.sex || '').trim() || null,
            phone: String(p.phone || '').trim() || null,
            otp: otp, photo_url: p.photo_url || null, issue_date: p.issue_date, expiry_date: p.expiry_date,
            status: p.status || 'active', created_at: new Date().toISOString()
          };
          store.push(row);
        }
        emit();
        return JSON.parse(JSON.stringify(row));
      });
    };
    self.adminDelete = function (pass, id) {
      return delay(null, 260).then(function () {
        assertAdmin(pass);
        var before = store.length;
        store = store.filter(function (r) { return r.id !== id; });
        if (store.length === before) throw U.appError('not_found', 'That record no longer exists.');
        emit();
        return { ok: true };
      });
    };
    self.adminGenerateOtp = function (pass) {
      return delay(null, 200).then(function () {
        assertAdmin(pass);
        for (var i = 0; i < 200; i++) {
          var code = String(Math.floor(Math.random() * 1000000));
          code = ('000000' + code).slice(-6);
          if (!findByOtp(code)) return code;   /* same contract as the cloud RPC: a string */
        }
        throw U.appError('server', 'Could not generate a unique code. Try again.');
      });
    };
    self.adminChangePasskey = function (pass, newPass) {
      return delay(null, 300).then(function () {
        assertAdmin(pass);
        if (!newPass || newPass.length < 8) throw U.appError('weak_passkey', 'The new passkey must be at least 8 characters.');
        passkey = newPass;
        return { ok: true };
      });
    };

    self.subscribe = function (opts) {
      opts = opts || {};
      var cb = function () { if (opts.onChange) opts.onChange(); };
      listeners.push(cb);
      if (opts.onStatus) opts.onStatus('live');
      return function () { listeners = listeners.filter(function (l) { return l !== cb; }); };
    };
    self.publishChange = function () {};
    self.healthCheck = function () { return Promise.resolve(true); };
    return self;
  }

  /* ======================================================================
   * Module surface
   * ====================================================================*/
  var DB = {
    backend: null,
    mode: 'demo',
    reason: ''

    /* init() picks the backend synchronously; the health probe runs after. */
  };

  DB.init = function () {
    var forcedDemo = CFG.DEMO_MODE === true;
    var forcedCloud = CFG.DEMO_MODE === false;
    var libOk = !!(window.supabase && window.supabase.createClient);
    var local = isLocalPreview();

    if (forcedDemo) {
      DB.reason = 'DEMO_MODE forced in js/config.js';
    } else if (!keysLookReal()) {
      if (forcedCloud || !local) {
        DB.reason = 'SUPABASE_URL / SUPABASE_ANON_KEY are still placeholders in js/config.js';
        DB.mode = 'misconfigured';
        return DB;
      }
      DB.reason = 'local preview fallback (no Supabase keys configured)';
    } else if (!libOk) {
      if (forcedCloud || !local) {
        DB.reason = 'The supabase-js CDN script failed to load.';
        DB.mode = 'misconfigured';
        return DB;
      }
      DB.reason = 'local preview fallback (supabase-js CDN unavailable)';
    }

    if (!DB.reason) {
      try {
        DB.backend = CloudBackend(window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          global: { headers: { 'x-application-name': 'cco-verification-portal' } }
        }));
        DB.mode = 'cloud';
        DB.reason = '';
      } catch (e) {
        DB.mode = 'misconfigured';
        DB.reason = 'Supabase client could not be created: ' + (e && e.message);
      }
      return DB;
    }

    DB.backend = DemoBackend();
    DB.mode = 'demo';
    return DB;
  };

  /* Thin pass-through API so UI modules never touch the backend directly. */
  ['verifyOtp', 'adminCheck', 'adminList', 'adminSave', 'adminDelete', 'adminGenerateOtp', 'adminChangePasskey', 'subscribe', 'publishChange', 'healthCheck'].forEach(function (fn) {
    DB[fn] = function () {
      if (!DB.backend || typeof DB.backend[fn] !== 'function') {
        return Promise.reject(U.appError('not_configured', 'Backend is not configured.'));
      }
      return DB.backend[fn].apply(DB.backend, arguments);
    };
  });

  Object.defineProperty(DB, 'clientId', { get: function () { return DB.backend && DB.backend.clientId; } });

  CCO.DB = DB;
})();
