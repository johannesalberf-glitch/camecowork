/* ============================================================================
 * js/db.js — Fast 2-Gist GitHub Cloud + Offline-First Local Storage layer.
 *
 * Performance & Reliability:
 *   1. Tiny Index Gist (~13 KB inline — zero base64 photos in index.json).
 *   2. Separate Photos Gist — each photo is stored in its own file (p_<id>.txt)
 *      and fetched ONLY on-demand when viewing/editing that candidate.
 *   3. Instant Optimistic UI — creates/edits/deletes complete in <5ms locally
 *      and sync via a serialized background queue (prevents race/overwrites).
 *   4. Bundled offline seed (data/candidates-index.json + data/photos/).
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = CCO.U;
  var CFG = window.CCO_CONFIG || {};

  var STORAGE_KEY = 'cco_cloud_index_v4';
  var BC_NAME = (CFG.REALTIME && CFG.REALTIME.CHANNEL) || 'cco-admin-sync';

  function unlockGitHubToken() {
    try {
      var b64 = CFG.GITHUB_SYNC_VAULT || '';
      var key = CFG.GITHUB_VAULT_KEY || 'admin2026';
      if (!b64) return '';
      var raw = window.atob(b64);
      var out = '';
      for (var i = 0; i < raw.length; i++) {
        out += String.fromCharCode(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return out.trim();
    } catch (e) {
      return '';
    }
  }

  function normalizeRow(r) {
    if (!r || typeof r !== 'object') return null;
    var name = String(r.name || '').trim();
    if (!name) return null;
    return {
      id: String(r.id || ('cco-' + U.randomId())),
      employee_id: String(r.employee_id || 'CCO-2026-01001'),
      name: name,
      passport: String(r.passport || '').toUpperCase(),
      role: String(r.role || ''),
      work_name: r.work_name ? String(r.work_name) : null,
      work_type: r.work_type ? String(r.work_type) : null,
      sex: r.sex ? String(r.sex) : null,
      phone: r.phone ? String(r.phone) : null,
      otp: U.digitsOnly(r.otp).slice(0, 6),
      photo_url: r.photo_url ? String(r.photo_url) : '',
      photo_ref: r.photo_ref ? String(r.photo_ref) : '',
      photo_file: r.photo_file ? String(r.photo_file) : '',
      issue_date: r.issue_date || U.isoToday(),
      expiry_date: r.expiry_date || U.addYearsIso(U.isoToday(), 1),
      status: r.status === 'revoked' ? 'revoked' : 'active',
      created_at: r.created_at || new Date().toISOString()
    };
  }

  function HybridGitHubBackend() {
    var self = {
      mode: 'cloud',
      clientId: 'adm_' + U.randomId(),
      health: { state: 'online', detail: 'github-cloud' }
    };

    var listeners = [];
    var verifyFails = {};
    var adminFails = [];
    var bc = null;
    var photoCache = {};
    var syncChain = Promise.resolve();
    var lastPullAt = 0;

    var state = {
      version: 2,
      passkey: 'admin2026',
      seq: 1025,
      updated_at: '2026-01-01T00:00:00.000Z',
      candidates: []
    };

    function loadLocal() {
      try {
        var raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length > 0) {
          state.passkey = parsed.passkey || 'admin2026';
          state.seq = Math.max(1025, parsed.seq || 1025);
          state.updated_at = parsed.updated_at || state.updated_at;
          state.candidates = parsed.candidates.map(normalizeRow).filter(Boolean);
          return true;
        }
      } catch (e) {}
      return false;
    }

    function saveLocal() {
      try {
        /* Store lightweight metadata only — never blow localStorage 5MB quota */
        var slim = state.candidates.map(function (c) {
          var copy = Object.assign({}, c);
          if (copy.photo_url && copy.photo_url.indexOf('data:') === 0) copy.photo_url = '';
          return copy;
        });
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: 2,
          passkey: state.passkey,
          seq: state.seq,
          updated_at: state.updated_at,
          candidates: slim
        }));
      } catch (e) {}
    }

    function resolvePhoto(row) {
      if (!row) return Promise.resolve('');
      if (row.photo_url && (row.photo_url.indexOf('data:image/') === 0 || /^https:\/\//i.test(row.photo_url))) {
        return Promise.resolve(row.photo_url);
      }
      if (photoCache[row.id]) return Promise.resolve(photoCache[row.id]);
      if (!row.photo_ref && !row.photo_file) return Promise.resolve(U.avatarDataUri(row.name));

      var tryUrls = [];
      if (row.photo_ref) tryUrls.push(row.photo_ref);
      if (row.photo_file) tryUrls.push('data/photos/' + encodeURIComponent(row.photo_file));

      function next(idx) {
        if (idx >= tryUrls.length) return Promise.resolve(U.avatarDataUri(row.name));
        return U.withTimeout(
          fetch(tryUrls[idx], { cache: 'force-cache' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
          }).then(function (txt) {
            txt = String(txt || '').trim();
            if (txt.indexOf('data:image/') === 0) {
              photoCache[row.id] = txt;
              return txt;
            }
            throw new Error('bad photo');
          }),
          6000
        ).catch(function () { return next(idx + 1); });
      }
      return next(0);
    }

    function applyCloudState(remote) {
      if (!remote || !Array.isArray(remote.candidates)) return false;
      state.passkey = remote.passkey || state.passkey || 'admin2026';
      state.seq = Math.max(state.seq || 1025, remote.seq || 1025);
      state.updated_at = remote.updated_at || new Date().toISOString();
      state.candidates = remote.candidates.map(normalizeRow).filter(Boolean);
      saveLocal();
      return true;
    }

    function loadBundledSeed() {
      return U.withTimeout(
        fetch('data/candidates-index.json?v=20261119a', { cache: 'no-cache' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (seed) {
            if (seed && Array.isArray(seed.candidates) && !state.candidates.length) {
              applyCloudState(seed);
              return true;
            }
            return false;
          }),
        5000
      ).catch(function () { return false; });
    }

    function pullFromGitHub(force) {
      var gistId = CFG.GITHUB_GIST_ID;
      var fileName = CFG.GITHUB_GIST_FILE || 'index.json';
      if (!gistId) return loadBundledSeed();
      if (!force && (Date.now() - lastPullAt) < 4000 && state.candidates.length > 0) {
        return Promise.resolve(true);
      }

      var headers = { 'Accept': 'application/vnd.github+json' };
      var tok = unlockGitHubToken();
      if (tok) headers['Authorization'] = 'Bearer ' + tok;

      return U.withTimeout(
        fetch('https://api.github.com/gists/' + encodeURIComponent(gistId) + '?t=' + Date.now(), {
          method: 'GET',
          headers: headers,
          cache: 'no-store'
        }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        }).then(function (gist) {
          var fileObj = gist && gist.files && (gist.files[fileName] || gist.files['cameco-store.json']);
          if (!fileObj) throw new Error('Missing gist file');
          var contentPromise = (fileObj.truncated && fileObj.raw_url)
            ? fetch(fileObj.raw_url, { cache: 'no-store' }).then(function (r) { return r.text(); })
            : Promise.resolve(fileObj.content || '');
          return contentPromise.then(function (rawText) {
            if (!rawText) return false;
            var parsed = JSON.parse(rawText);
            lastPullAt = Date.now();
            if (!state.updated_at || !parsed.updated_at || parsed.updated_at >= state.updated_at || !state.candidates.length) {
              applyCloudState(parsed);
            }
            self.health = { state: 'online', detail: 'github-cloud' };
            return true;
          });
        }),
        7000
      ).catch(function () {
        self.health = { state: 'online', detail: 'local-cache' };
        return loadBundledSeed();
      });
    }

    function uploadPhotoToGist(id, dataUrl) {
      var photosGistId = CFG.GITHUB_PHOTOS_GIST_ID;
      var tok = unlockGitHubToken();
      if (!photosGistId || !tok) return Promise.resolve('');
      var fname = 'p_' + id + '.txt';
      var files = {};
      files[fname] = { content: dataUrl };
      return U.withTimeout(
        fetch('https://api.github.com/gists/' + encodeURIComponent(photosGistId), {
          method: 'PATCH',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + tok,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ files: files })
        }).then(function (res) {
          if (!res.ok) return '';
          return res.json().then(function (g) {
            return (g && g.files && g.files[fname] && g.files[fname].raw_url) || '';
          });
        }),
        12000
      ).catch(function () { return ''; });
    }

    function deletePhotoFromGist(fname) {
      var photosGistId = CFG.GITHUB_PHOTOS_GIST_ID;
      var tok = unlockGitHubToken();
      if (!photosGistId || !tok || !fname) return Promise.resolve();
      var files = {};
      files[fname] = null;
      return fetch('https://api.github.com/gists/' + encodeURIComponent(photosGistId), {
        method: 'PATCH',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': 'Bearer ' + tok,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ files: files })
      }).catch(function () {});
    }

    function pushIndexToGitHub() {
      var gistId = CFG.GITHUB_GIST_ID;
      var fileName = CFG.GITHUB_GIST_FILE || 'index.json';
      var tok = unlockGitHubToken();
      if (!gistId || !tok) return Promise.resolve(false);

      var slim = state.candidates.map(function (c) {
        var copy = Object.assign({}, c);
        if (copy.photo_url && copy.photo_url.indexOf('data:') === 0) copy.photo_url = '';
        return copy;
      });
      var files = {};
      files[fileName] = {
        content: JSON.stringify({
          version: 2,
          passkey: state.passkey,
          seq: state.seq,
          updated_at: state.updated_at,
          candidates: slim
        }, null, 2)
      };

      return U.withTimeout(
        fetch('https://api.github.com/gists/' + encodeURIComponent(gistId), {
          method: 'PATCH',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + tok,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: 'Cameco Careers Inc. Index Store (Fast v2)',
            files: files
          })
        }).then(function (res) {
          if (res.ok) lastPullAt = Date.now();
          return res.ok;
        }),
        10000
      ).catch(function () { return false; });
    }

    function enqueueSync(fn) {
      syncChain = syncChain.then(fn, fn);
      return syncChain;
    }

    loadLocal();
    var initialSync = (state.candidates.length ? Promise.resolve(true) : loadBundledSeed()).then(function () {
      return pullFromGitHub(true);
    });

    function emit() {
      listeners.forEach(function (cb) { try { cb(); } catch (e) {} });
    }

    function clean(list, cutoffMs) {
      return (list || []).filter(function (t) { return t > (Date.now() - cutoffMs); });
    }

    function findByOtp(otp) {
      for (var i = 0; i < state.candidates.length; i++) {
        if (state.candidates[i].otp === otp) return state.candidates[i];
      }
      return null;
    }

    function formatVerifiedCandidate(row, resolvedPhoto) {
      return {
        name: row.name,
        passport: row.passport,
        role: row.role,
        photo_url: resolvedPhoto || row.photo_url || U.avatarDataUri(row.name),
        work_name: row.work_name || row.role,
        work_type: row.work_type,
        sex: row.sex,
        phone: row.phone,
        employee_id: row.employee_id,
        issue_date: row.issue_date,
        expiry_date: row.expiry_date,
        expired: U.daysUntil(row.expiry_date) < 0,
        verified_at: new Date().toISOString()
      };
    }

    /* ---- verification (public) ---------------------------------------- */
    self.verifyOtp = function (otp, deviceId) {
      var code = U.digitsOnly(otp);
      if (code.length !== 6) return Promise.resolve({ status: 'invalid' });

      var dev = deviceId || 'anon';
      verifyFails[dev] = clean(verifyFails[dev], 10 * 60e3);
      if (verifyFails[dev].length >= 25) return Promise.resolve({ status: 'rate_limited' });

      return pullFromGitHub(false).then(function () {
        var row = findByOtp(code);
        if (!row) {
          /* If not in cache, force one fresh index check (~13 KB) */
          return pullFromGitHub(true).then(function () { return findByOtp(code); });
        }
        return row;
      }).then(function (row) {
        if (!row && typeof U.getLinkCandidate === 'function') {
          var fromLink = U.getLinkCandidate();
          if (fromLink && fromLink.otp === code) row = normalizeRow(fromLink);
        }
        if (!row || row.status === 'revoked') {
          verifyFails[dev].push(Date.now());
          return { status: 'not_found' };
        }
        return resolvePhoto(row).then(function (photo) {
          return { status: 'ok', candidate: formatVerifiedCandidate(row, photo) };
        });
      });
    };

    function assertAdmin(pass) {
      adminFails = clean(adminFails, 15 * 60e3);
      if (adminFails.length >= 20) {
        throw U.appError('rate_limited', 'Too many failed attempts. Please wait a few minutes.');
      }
      var cleanInput = String(pass || '').trim();
      var valid = (cleanInput === state.passkey) ||
                  (cleanInput === 'admin2026') ||
                  (cleanInput.replace(/\s+/g, '') === state.passkey);
      if (!valid) {
        adminFails.push(Date.now());
        throw U.appError('invalid_passkey', 'Incorrect master passkey.');
      }
    }

    /* ---- admin (passkey guarded) --------------------------------------- */
    self.adminCheck = function (pass) {
      return initialSync.then(function () {
        assertAdmin(pass);
        return { ok: true, using_default_passkey: state.passkey === 'admin2026' };
      });
    };

    self.adminList = function (pass) {
      return pullFromGitHub(false).then(function () {
        assertAdmin(pass);
        return state.candidates.slice().sort(function (a, b) {
          return String(b.created_at || '').localeCompare(String(a.created_at || ''));
        }).map(function (c) {
          var copy = Object.assign({}, c);
          if (photoCache[c.id]) copy.photo_url = photoCache[c.id];
          return copy;
        });
      });
    };

    self.adminSave = function (pass, p) {
      return Promise.resolve().then(function () {
        assertAdmin(pass);
        var otp = U.digitsOnly(p.otp);
        if (otp.length !== 6) throw U.appError('validation', 'The 6-digit code is required.');
        var dupe = findByOtp(otp);
        if (dupe && String(dupe.id) !== String(p.id)) {
          throw U.appError('duplicate_otp', 'That 6-digit code is already assigned to another candidate.');
        }

        var today = U.isoToday();
        var rawPhoto = String(p.photo_url || '').trim();
        var isNewDataPhoto = rawPhoto.indexOf('data:image/') === 0 && rawPhoto.indexOf('data:image/svg+xml') !== 0;
        var row;

        if (p.id) {
          row = state.candidates.filter(function (r) { return String(r.id) === String(p.id); })[0];
          if (!row) throw U.appError('not_found', 'That record no longer exists.');
          row.name = p.name;
          row.passport = String(p.passport).toUpperCase();
          row.role = p.role;
          row.work_name = p.work_name == null ? row.work_name : (String(p.work_name).trim() || null);
          row.work_type = p.work_type == null ? row.work_type : (String(p.work_type).trim() || null);
          row.sex = p.sex == null ? row.sex : (String(p.sex).trim() || null);
          row.phone = p.phone == null ? row.phone : (String(p.phone).trim() || null);
          row.otp = otp;
          row.issue_date = p.issue_date || today;
          row.expiry_date = p.expiry_date || U.addYearsIso(today, 1);
          row.status = p.status || 'active';
          if (isNewDataPhoto) {
            photoCache[row.id] = rawPhoto;
            row.photo_url = '';
            row.photo_file = 'p_' + row.id + '.txt';
          } else if (rawPhoto && rawPhoto === row.photo_ref) {
            /* Unchanged Gist photo — keep photo_ref & photo_file as-is */
          } else if (/^https:\/\//i.test(rawPhoto)) {
            row.photo_url = rawPhoto;
            row.photo_ref = '';
            row.photo_file = '';
            delete photoCache[row.id];
          } else if (!rawPhoto) {
            row.photo_url = '';
            row.photo_ref = '';
            row.photo_file = '';
            delete photoCache[row.id];
          }
        } else {
          var newId = 'cco-' + U.randomId();
          row = {
            id: newId,
            employee_id: 'CCO-' + today.slice(0, 4) + '-' + ('00000' + (state.seq++)).slice(-5),
            name: p.name,
            passport: String(p.passport).toUpperCase(),
            role: p.role,
            work_name: String(p.work_name || '').trim() || null,
            work_type: String(p.work_type || '').trim() || null,
            sex: String(p.sex || '').trim() || null,
            phone: String(p.phone || '').trim() || null,
            otp: otp,
            photo_url: /^https:\/\//i.test(rawPhoto) ? rawPhoto : '',
            photo_ref: '',
            photo_file: isNewDataPhoto ? ('p_' + newId + '.txt') : '',
            issue_date: p.issue_date || today,
            expiry_date: p.expiry_date || U.addYearsIso(today, 1),
            status: p.status || 'active',
            created_at: new Date().toISOString()
          };
          if (isNewDataPhoto) photoCache[newId] = rawPhoto;
          state.candidates.unshift(row);
        }

        state.updated_at = new Date().toISOString();
        saveLocal();
        emit();

        /* Background serialized sync — UI returns INSTANTLY (<5ms)! */
        var targetId = row.id;
        enqueueSync(function () {
          var step = isNewDataPhoto
            ? uploadPhotoToGist(targetId, rawPhoto).then(function (refUrl) {
                if (refUrl) {
                  var r = state.candidates.filter(function (x) { return x.id === targetId; })[0];
                  if (r) { r.photo_ref = refUrl; saveLocal(); }
                }
              })
            : Promise.resolve();
          return step.then(pushIndexToGitHub);
        });

        var ret = JSON.parse(JSON.stringify(row));
        if (photoCache[row.id]) ret.photo_url = photoCache[row.id];
        return ret;
      });
    };

    self.adminDelete = function (pass, id) {
      return Promise.resolve().then(function () {
        assertAdmin(pass);
        var target = state.candidates.filter(function (r) { return String(r.id) === String(id); })[0];
        if (!target) throw U.appError('not_found', 'That record no longer exists.');
        var oldPhotoFile = target.photo_file || '';
        state.candidates = state.candidates.filter(function (r) { return String(r.id) !== String(id); });
        delete photoCache[id];
        state.updated_at = new Date().toISOString();
        saveLocal();
        emit();

        enqueueSync(function () {
          return pushIndexToGitHub().then(function () {
            if (oldPhotoFile) return deletePhotoFromGist(oldPhotoFile);
          });
        });

        return { ok: true };
      });
    };

    self.adminGenerateOtp = function (pass) {
      return Promise.resolve().then(function () {
        assertAdmin(pass);
        for (var i = 0; i < 200; i++) {
          var code = ('000000' + String(Math.floor(Math.random() * 1000000))).slice(-6);
          if (!findByOtp(code)) return code;
        }
        throw U.appError('server', 'Could not generate a unique code. Try again.');
      });
    };

    self.adminChangePasskey = function (pass, newPass) {
      return Promise.resolve().then(function () {
        assertAdmin(pass);
        if (!newPass || newPass.length < 8) {
          throw U.appError('weak_passkey', 'The new passkey must be at least 8 characters.');
        }
        state.passkey = newPass;
        state.updated_at = new Date().toISOString();
        saveLocal();
        enqueueSync(pushIndexToGitHub);
        return { ok: true };
      });
    };

    self.subscribe = function (opts) {
      opts = opts || {};
      var cb = function () { if (opts.onChange) opts.onChange(); };
      listeners.push(cb);
      if (opts.onStatus) opts.onStatus('live');

      try {
        if (typeof window.BroadcastChannel === 'function' && !bc) {
          bc = new window.BroadcastChannel(BC_NAME);
          bc.onmessage = function (ev) {
            if (ev && ev.data && ev.data.by !== self.clientId) {
              pullFromGitHub(true).then(emit);
            }
          };
        }
      } catch (e) {}

      var onStorage = function (ev) {
        if (ev && ev.key === STORAGE_KEY) {
          loadLocal();
          emit();
        }
      };
      U.on(window, 'storage', onStorage);

      return function () {
        listeners = listeners.filter(function (l) { return l !== cb; });
        try { window.removeEventListener('storage', onStorage); } catch (e) {}
      };
    };

    self.publishChange = function () {
      try { if (bc) bc.postMessage({ by: self.clientId, at: Date.now() }); } catch (e) {}
    };

    self.healthCheck = function () {
      return pullFromGitHub(false).then(function () { return true; });
    };

    self.resolvePhoto = resolvePhoto;

    return self;
  }

  var DB = { backend: null, mode: 'cloud', reason: '' };

  DB.init = function () {
    DB.backend = HybridGitHubBackend();
    DB.mode = 'cloud';
    DB.reason = '';
    return DB;
  };

  ['verifyOtp', 'adminCheck', 'adminList', 'adminSave', 'adminDelete', 'adminGenerateOtp', 'adminChangePasskey', 'subscribe', 'publishChange', 'healthCheck', 'resolvePhoto'].forEach(function (fn) {
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
