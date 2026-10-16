/* ============================================================================
 * js/admin.js — passkey-gated admin portal.
 *
 * • Login via admin_check RPC (bcrypt-verified server-side, lockout-protected)
 * • Candidate CRUD via admin_* RPCs with optimistic UI + error rollback
 * • Search, stats, copy/share verification links, photo upload (embedded data
 *   URI) or URL, unique OTP generation, passkey change
 * • Realtime: Supabase broadcast channel with 45 s polling fallback, plus
 *   refetch on tab focus — works even when webviews throttle sockets
 * ==========================================================================*/
(function () {
  'use strict';

  var CCO = window.CCO = window.CCO || {};
  var U = CCO.U;
  var CFG = window.CCO_CONFIG || {};

  var el = {};
  var S = {
    pass: '',
    usingDefaultPass: false,
    candidates: [],
    search: '',
    sheetOpen: false,
    editingId: null,
    photoValue: '',
    unsubscribe: null,
    pollTimer: null,
    refreshTimer: null,
    live: 'offline',
    booted: false
  };
  var REMEMBER_KEY = 'cco_admin_pass';

  /* ------------------------------------------------------------- helpers */
  function rowStatus(c) {
    if (c.status === 'revoked') return { label: 'Revoked', order: 3, cls: 'bg-slate-200 text-slate-600' };
    var d = U.daysUntil(c.expiry_date);
    if (d < 0) return { label: 'Expired', order: 2, cls: 'bg-rose-100 text-rose-700' };
    if (d <= 30) return { label: 'Expiring soon', order: 1, cls: 'bg-amber-100 text-amber-800' };
    return { label: 'Active', order: 0, cls: 'bg-emerald-100 text-emerald-700' };
  }

  function filtered() {
    var q = S.search.trim().toLowerCase();
    var list = S.candidates.slice().sort(function (a, b) {
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
    if (!q) return list;
    return list.filter(function (c) {
      return [c.name, c.passport, c.role, c.work_name, c.work_type, c.otp, c.employee_id].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  function rememberPass(val) {
    try {
      if (val) window.sessionStorage.setItem(REMEMBER_KEY, val);
      else window.sessionStorage.removeItem(REMEMBER_KEY);
    } catch (e) { /* storage blocked — in-memory pass still works */ }
  }
  function recallPass() {
    try { return window.sessionStorage.getItem(REMEMBER_KEY) || ''; } catch (e) { return ''; }
  }

  /* --------------------------------------------------------------- alerts */
  function gateAlert(type, msg) {
    var box = U.$('#admin-gate-alert');
    if (!box) return;
    if (!msg) { box.innerHTML = ''; U.hide(box); return; }
    box.className = 'mt-3 rounded-xl border px-3 py-2 text-sm ' +
      (type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-sky-200 bg-sky-50 text-sky-800');
    box.textContent = msg;
    U.show(box);
  }

  function sheetError(msg) {
    var box = U.$('#admin-sheet-error');
    if (!box) return;
    if (!msg) { box.textContent = ''; U.hide(box); return; }
    box.textContent = msg;
    U.show(box);
  }

  function fieldError(id, msg) {
    var p = U.$('#err-' + id);
    if (!p) return;
    p.textContent = msg || '';
    if (msg) U.show(p); else U.hide(p);
  }
  function clearFieldErrors() {
    ['name', 'passport', 'role', 'otp', 'expiry', 'photo'].forEach(function (id) { fieldError(id, ''); });
  }

  /* ---------------------------------------------------------------- live */
  function setLive(state) {
    S.live = state;
    var dot = U.$('#admin-live-dot'), txt = U.$('#admin-live-text');
    if (!dot || !txt) return;
    dot.className = 'inline-block h-2.5 w-2.5 rounded-full ' +
      (state === 'live' ? 'bg-emerald-500' : state === 'polling' ? 'bg-amber-400' : 'bg-slate-300');
    txt.textContent = state === 'live' ? 'Live sync' : state === 'polling' ? 'Auto-refresh' : 'Offline';
  }

  function startSync() {
    stopSync();
    setLive('polling');
    S.unsubscribe = CCO.DB.subscribe({
      onChange: function () { scheduleRefresh(); },
      onStatus: function (st) { setLive(st === 'live' ? 'live' : 'polling'); }
    });
    S.pollTimer = setInterval(function () {
      if (document.visibilityState === 'visible') refresh({ silent: true });
    }, CFG.REALTIME.POLL_MS);
  }
  function stopSync() {
    if (S.unsubscribe) { try { S.unsubscribe(); } catch (e) {} S.unsubscribe = null; }
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    if (S.refreshTimer) { clearTimeout(S.refreshTimer); S.refreshTimer = null; }
  }
  function scheduleRefresh() {
    if (S.refreshTimer) clearTimeout(S.refreshTimer);
    S.refreshTimer = setTimeout(function () { refresh({ silent: true }); }, 350);
  }

  /* --------------------------------------------------------------- login */
  function showGate() {
    U.show(U.$('#admin-gate'));
    U.hide(U.$('#admin-dashboard'));
    var input = U.$('#admin-pass');
    if (input) { input.value = ''; setTimeout(function () { try { input.focus(); } catch (e) {} }, 150); }
  }

  function login(pass, opts) {
    opts = opts || {};
    var btn = U.$('#admin-gate-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    gateAlert('', '');
    return CCO.DB.adminCheck(pass).then(function (res) {
      if (!res || !res.ok) throw U.appError('invalid_passkey', 'Incorrect master passkey.');
      S.pass = pass;
      S.usingDefaultPass = !!res.using_default_passkey;
      if (U.$('#admin-remember') && U.$('#admin-remember').checked) rememberPass(pass); else rememberPass('');
      enterDashboard();
    }).catch(function (err) {
      if (err && err.code === 'rate_limited') gateAlert('error', err.message || 'Too many attempts. Try again shortly.');
      else if (err && (U.isNetworkLike(err) || err.code === 'timeout')) gateAlert('error', 'Connection problem — check your network and try again.');
      else if (err && err.code === 'not_configured') gateAlert('error', err.message || 'Database not configured.');
      else gateAlert('error', (err && err.message) || 'Login failed. Try again.');
      if (CFG.DEBUG) console.warn('[admin] login failed:', err);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Unlock portal'; }
    });
  }

  function enterDashboard() {
    U.hide(U.$('#admin-gate'));
    U.show(U.$('#admin-dashboard'));
    updateWarnBanner();
    setLive('polling');
    S.booted = true;
    return refresh({}).then(function () { startSync(); });
  }

  function updateWarnBanner() {
    var warn = U.$('#admin-warn');
    if (!warn) return;
    if (S.usingDefaultPass) {
      warn.innerHTML = '<strong>Security:</strong> you are still using the default passkey (<span class="font-mono">admin2026</span>). ' +
        'Change it under <em>Portal settings</em> below before sharing this deployment.';
      U.show(warn);
    } else U.hide(warn);
  }

  function logout(msg) {
    stopSync();
    S.pass = ''; S.booted = false; S.candidates = []; S.usingDefaultPass = false;
    rememberPass('');
    U.setHtml(U.$('#admin-tbody'), '');
    U.setHtml(U.$('#admin-cards'), '');
    closeSheet();
    showGate();
    if (msg) gateAlert('info', msg);
  }

  /* ------------------------------------------------------------- refresh */
  function refresh(opts) {
    opts = opts || {};
    if (!S.pass) return Promise.resolve();
    return CCO.DB.adminList(S.pass).then(function (list) {
      S.candidates = Array.isArray(list) ? list : [];
      render();
    }).catch(function (err) {
      if (err && err.code === 'invalid_passkey') {
        logout('Your session was reset. Please sign in again.');
        return;
      }
      if (opts.silent) { if (CFG.DEBUG) console.warn('[admin] silent refresh failed:', err); return; }
      U.toast('Could not load candidates: ' + ((err && err.message) || 'network error'), 'error', 5000);
    });
  }

  /* -------------------------------------------------------------- render */
  function render() {
    var list = filtered();
    renderStats();
    U.setText(U.$('#admin-count'), S.candidates.length + ' total');

    var tbody = U.$('#admin-tbody');
    var cards = U.$('#admin-cards');
    if (!list.length) {
      U.setHtml(tbody, '');
      U.setHtml(cards, '');
      var empty = U.$('#admin-empty');
      if (empty) {
        empty.textContent = S.search ? 'No candidates match your search.' : 'No candidates yet — add your first registered candidate.';
        U.show(empty);
      }
      return;
    }
    U.hide(U.$('#admin-empty'));
    U.setHtml(tbody, list.map(desktopRow).join(''));
    U.setHtml(cards, list.map(mobileCard).join(''));
  }

  function renderStats() {
    var total = S.candidates.length, active = 0, soon = 0, bad = 0;
    S.candidates.forEach(function (c) {
      var st = rowStatus(c);
      if (st.label === 'Active') active++;
      else if (st.label === 'Expiring soon') soon++;
      else bad++;
    });
    U.setText(U.$('#stat-total'), total);
    U.setText(U.$('#stat-active'), active);
    U.setText(U.$('#stat-soon'), soon);
    U.setText(U.$('#stat-bad'), bad);
  }

  function actionButtons(c, compact) {
    var size = compact ? 'p-1.5' : 'px-2.5 py-1.5';
    return '' +
      btn('edit', c.id, 'Edit', 'text-slate-600 hover:bg-slate-100', size, iconPencil()) +
      btn('copy', c.id, 'Copy link', 'text-slate-600 hover:bg-slate-100', size, iconCopy()) +
      btn('share', c.id, 'Share', 'text-slate-600 hover:bg-slate-100', size, iconShare()) +
      btn('del', c.id, 'Delete', 'text-rose-600 hover:bg-rose-50', size, iconTrash());
  }

  function btn(act, id, label, cls, size, icon) {
    return '<button type="button" data-act="' + act + '" data-id="' + U.escapeHtml(id) + '" title="' + label + '" aria-label="' + label + '" ' +
      'class="inline-flex items-center justify-center rounded-lg border border-transparent transition ' + size + ' ' + cls + '">' + icon + '</button>';
  }

  /* Inline SVG icons (no icon-font dependency). */
  function svgWrap(paths) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  function iconPencil() { return svgWrap('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'); }
  function iconCopy() { return svgWrap('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'); }
  function iconShare() { return svgWrap('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>'); }
  function iconTrash() { return svgWrap('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>'); }

  function desktopRow(c) {
    var st = rowStatus(c);
    var photo = U.validImageSrc(c.photo_url) ? c.photo_url : U.avatarDataUri(c.name);
    return '<tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">' +
      '<td class="px-4 py-3"><div class="flex items-center gap-3">' +
        '<img src="' + U.escapeHtml(photo) + '" alt="" loading="lazy" class="h-10 w-10 rounded-full border border-slate-200 object-cover" onerror="this.onerror=null;this.src=\'' + U.avatarDataUri(c.name).replace(/'/g, '%27') + '\'">' +
        '<div class="min-w-0"><p class="truncate text-sm font-semibold text-slate-800">' + U.escapeHtml(c.name) + '</p>' +
        '<p class="truncate text-xs text-slate-500">' + U.escapeHtml(c.role) + (c.work_type ? ' · ' + U.escapeHtml(c.work_type) : '') + '</p></div>' +
      '</div></td>' +
      '<td class="px-4 py-3 font-mono text-xs text-slate-600">' + U.escapeHtml(c.passport) +
        (c.phone ? '<br><span class="font-sans text-[10px] text-slate-400">' + U.escapeHtml(c.phone) + '</span>' : '') + '</td>' +
      '<td class="px-4 py-3"><span class="font-mono text-sm font-semibold tracking-widest text-slate-800">' + U.escapeHtml(c.otp) + '</span></td>' +
      '<td class="px-4 py-3 font-mono text-xs text-slate-600">' + U.escapeHtml(c.employee_id || '—') + '</td>' +
      '<td class="px-4 py-3 text-xs text-slate-600">' + U.escapeHtml(U.fmtDate(c.issue_date)) + ' → ' + U.escapeHtml(U.fmtDate(c.expiry_date)) + '</td>' +
      '<td class="px-4 py-3"><span class="inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ' + st.cls + '">' + st.label + '</span></td>' +
      '<td class="px-4 py-3"><div class="flex items-center justify-end gap-1">' + actionButtons(c, true) + '</div></td>' +
    '</tr>';
  }

  function mobileCard(c) {
    var st = rowStatus(c);
    var photo = U.validImageSrc(c.photo_url) ? c.photo_url : U.avatarDataUri(c.name);
    return '<div class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">' +
      '<div class="flex items-start gap-3">' +
        '<img src="' + U.escapeHtml(photo) + '" alt="" loading="lazy" class="h-12 w-12 rounded-full border border-slate-200 object-cover" onerror="this.onerror=null;this.src=\'' + U.avatarDataUri(c.name).replace(/'/g, '%27') + '\'">' +
        '<div class="min-w-0 flex-1"><p class="truncate text-sm font-bold text-slate-800">' + U.escapeHtml(c.name) + '</p>' +
        '<p class="truncate text-xs text-slate-500">' + U.escapeHtml(c.role) + '</p>' +
        (c.work_name && c.work_name !== c.role ? '<p class="truncate text-[11px] text-slate-400">' + U.escapeHtml(c.work_name) + '</p>' : '') +
        '<p class="mt-1 font-mono text-xs text-slate-500">' + U.escapeHtml(c.passport) + ' · ' + U.escapeHtml(c.employee_id || '') + '</p>' +
        (c.phone ? '<p class="truncate text-xs text-slate-500">' + U.escapeHtml(c.phone) + '</p>' : '') + '</div>' +
        '<span class="inline-flex shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ' + st.cls + '">' + st.label + '</span>' +
      '</div>' +
      '<div class="mt-3 flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">' +
        '<div class="min-w-0"><p class="text-[10px] font-bold uppercase tracking-widest text-slate-400">Verification code</p>' +
        '<p class="font-mono text-base font-bold tracking-[0.3em] text-slate-800">' + U.escapeHtml(c.otp) + '</p></div>' +
        '<div class="min-w-0 text-right text-[11px] text-slate-500"><p>Issued ' + U.escapeHtml(U.fmtDate(c.issue_date)) + '</p>' +
        '<p>Expires ' + U.escapeHtml(U.fmtDate(c.expiry_date)) + '</p></div>' +
      '</div>' +
      '<div class="mt-3 grid grid-cols-4 gap-2">' + actionButtons(c, false).replace(/inline-flex items-center justify-center/g, 'inline-flex w-full items-center justify-center') + '</div>' +
    '</div>';
  }

  /* -------------------------------------------------------- row actions */
  function findCandidate(id) {
    for (var i = 0; i < S.candidates.length; i++) if (String(S.candidates[i].id) === String(id)) return S.candidates[i];
    return null;
  }

  function onRowAction(ev) {
    var trigger = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!trigger) return;
    var act = trigger.getAttribute('data-act');
    var c = findCandidate(trigger.getAttribute('data-id'));
    if (!c) return;
    if (act === 'edit') openSheet(c);
    else if (act === 'copy') copyLink(c);
    else if (act === 'share') shareLink(c);
    else if (act === 'del') confirmDelete(c);
  }

  function copyLink(c) {
    var link = U.buildVerifyLink(c.otp);
    U.copyText(link).then(function (ok) {
      if (ok) U.toast('Verification link copied — send it to ' + c.name + '.', 'success');
      else window.prompt('Copy this verification link:', link);
    });
  }

  function shareLink(c) {
    var link = U.buildVerifyLink(c.otp);
    if (navigator.share) {
      navigator.share({
        title: 'Cameco Careers — credential verification',
        text: 'Verify the credential for ' + c.name + ' (' + c.role + '):',
        url: link
      }).catch(function () { copyLink(c); });
    } else copyLink(c);
  }

  /* ------------------------------------------------------------- delete */
  var pendingDelete = null;
  function confirmDelete(c) {
    pendingDelete = c;
    U.setText(U.$('#confirm-title'), 'Delete candidate?');
    U.setText(U.$('#confirm-body'), c.name + ' (' + c.employee_id + ') will be removed and their code ' + c.otp + ' will stop working immediately.');
    U.show(U.$('#confirm-modal'));
  }
  function closeConfirm() {
    pendingDelete = null;
    U.hide(U.$('#confirm-modal'));
  }
  function doDelete() {
    var c = pendingDelete;
    if (!c) return;
    closeConfirm();

    /* Optimistic: remove immediately, roll back if the server refuses. */
    var backup = S.candidates.slice();
    S.candidates = S.candidates.filter(function (r) { return r.id !== c.id; });
    render();

    CCO.DB.adminDelete(S.pass, c.id).then(function () {
      U.toast('Candidate deleted.', 'success');
      CCO.DB.publishChange();
    }).catch(function (err) {
      S.candidates = backup;
      render();
      if (err && err.code === 'invalid_passkey') return logout('Your session was reset. Please sign in again.');
      U.toast('Delete failed: ' + ((err && err.message) || 'network error') + ' — restored.', 'error', 5200);
    });
  }

  /* ---------------------------------------------------------------- sheet */
  /* Selects a value on a <select>, injecting a temporary option when the saved
     value is not one of the presets (e.g. records created with custom text). */
  function setSelectValue(sel, value) {
    if (!sel) return;
    Array.prototype.slice.call(sel.querySelectorAll('option[data-custom]')).forEach(function (o) { o.remove(); });
    if (value && !Array.prototype.some.call(sel.options, function (o) { return o.value === value; })) {
      var opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value + ' (current)';
      opt.setAttribute('data-custom', '1');
      sel.appendChild(opt);
    }
    sel.value = value;
  }

  function openSheet(c) {
    S.editingId = c ? c.id : null;
    S.photoValue = c && c.photo_url ? c.photo_url : '';
    clearFieldErrors();
    sheetError('');
    U.setText(U.$('#admin-sheet-title'), c ? 'Edit candidate' : 'Register candidate');
    U.setText(U.$('#admin-save-btn'), c ? 'Save changes' : 'Register candidate');

    U.$('#f-name').value = c ? c.name : '';
    U.$('#f-passport').value = c ? c.passport : '';
    U.$('#f-role').value = c ? c.role : '';
    U.$('#f-wname').value = c ? (c.work_name || '') : '';
    setSelectValue(U.$('#f-wtype'), c ? (c.work_type || '') : '');
    setSelectValue(U.$('#f-sex'), c ? (c.sex || '') : '');
    U.$('#f-phone').value = c ? (c.phone || '') : '';
    U.$('#f-status').value = c ? (c.status || 'active') : 'active';
    U.$('#f-otp').value = c ? c.otp : '';
    U.$('#f-issue').value = c ? c.issue_date : U.isoToday();
    U.$('#f-expiry').value = c ? c.expiry_date : U.addYearsIso(U.isoToday(), CFG.CARD.DEFAULT_VALIDITY_YEARS);
    U.$('#f-empid').value = c ? (c.employee_id || '') : '(auto-generated on save)';
    U.$('#f-photo').value = S.photoValue.indexOf('data:') === 0 ? '' : S.photoValue;
    updatePhotoPreview();

    U.show(U.$('#admin-sheet'));
    S.sheetOpen = true;
    document.documentElement.classList.add('overflow-hidden');
    setTimeout(function () {
      try { U.$('#f-name').focus({ preventScroll: true }); } catch (e) {}
    }, 180);
  }

  function closeSheet() {
    U.hide(U.$('#admin-sheet'));
    S.sheetOpen = false;
    S.editingId = null;
    document.documentElement.classList.remove('overflow-hidden');
  }

  function updatePhotoPreview() {
    var img = U.$('#f-photo-preview');
    var note = U.$('#f-photo-status');
    var has = U.validImageSrc(S.photoValue);
    if (img) {
      img.onerror = function () { img.onerror = null; img.src = U.avatarDataUri(U.$('#f-name').value || '?'); };
      img.src = has ? S.photoValue : U.avatarDataUri(U.$('#f-name').value || '?');
    }
    if (note) {
      if (!S.photoValue) note.textContent = 'No photo — an initials avatar will be used.';
      else if (S.photoValue.indexOf('data:') === 0) {
        var kb = Math.round(S.photoValue.length * 0.75 / 1024);
        note.textContent = 'Embedded image attached (' + kb + ' KB) — works offline and exports without CORS issues.';
      } else note.textContent = 'Photo URL set. Tip: use Upload to embed the image instead.';
    }
  }

  function collectForm() {
    return {
      id: S.editingId,
      name: U.$('#f-name').value.trim(),
      passport: U.$('#f-passport').value.trim().toUpperCase(),
      role: U.$('#f-role').value.trim(),
      work_name: U.$('#f-wname').value.trim(),
      work_type: U.$('#f-wtype').value.trim(),
      sex: U.$('#f-sex').value.trim(),
      phone: U.$('#f-phone').value.trim(),
      otp: U.digitsOnly(U.$('#f-otp').value).slice(0, 6),
      photo_url: S.photoValue || U.$('#f-photo').value.trim() || '',
      issue_date: U.$('#f-issue').value || U.isoToday(),
      expiry_date: U.$('#f-expiry').value || U.addYearsIso(U.isoToday(), 1),
      status: U.$('#f-status').value
    };
  }

  function validateForm(p) {
    var ok = true;
    clearFieldErrors();
    function bad(field, msg) { fieldError(field, msg); ok = false; }
    if (p.name.length < 2) bad('name', 'Enter the candidate’s full name.');
    if (!/^[A-Z0-9][A-Z0-9 -]{3,19}$/.test(p.passport)) bad('passport', 'Passport number looks invalid (4–20 letters/digits).');
    if (p.role.length < 2) bad('role', 'Enter a job title or specialization.');
    if (p.phone && !/^\+?[0-9][0-9 /().-]{5,19}$/.test(p.phone)) bad('phone', 'Enter a valid phone number, e.g. +1 416 555 0134.');
    if (p.otp.length !== 6) bad('otp', 'The verification code must be exactly 6 digits.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.issue_date)) bad('expiry', 'Enter a valid issue date.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.expiry_date) || U.daysUntil(p.expiry_date) <= U.daysUntil(p.issue_date)) bad('expiry', 'Expiry must be after the issue date.');
    if (p.photo_url && !U.validImageSrc(p.photo_url)) bad('photo', 'Photo must be an https:// URL or an embedded image.');
    return ok;
  }

  function saveForm() {
    var p = collectForm();
    if (!validateForm(p)) { sheetError('Please fix the highlighted fields.'); return; }

    var btn = U.$('#admin-save-btn');
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = S.editingId ? 'Saving…' : 'Registering…';
    sheetError('');

    /* Optimistic insert for *new* candidates (id resolved on the server).
     * For edits we update the row in place once the server confirms. */
    CCO.DB.adminSave(S.pass, p).then(function (saved) {
      if (!saved) throw U.appError('server', 'The server did not return the saved record.');
      var idx = -1;
      for (var i = 0; i < S.candidates.length; i++) if (String(S.candidates[i].id) === String(saved.id)) { idx = i; break; }
      if (idx >= 0) S.candidates[idx] = saved; else S.candidates.unshift(saved);
      render();
      closeSheet();
      U.toast(S.editingId ? 'Candidate updated.' : 'Candidate registered — verification link is ready.', 'success');
      CCO.DB.publishChange();
    }).catch(function (err) {
      if (err && err.code === 'duplicate_otp') { fieldError('otp', err.message); sheetError('That code is already taken. Tap “Generate” for a fresh one.'); }
      else if (err && err.code === 'validation') { sheetError(err.message); }
      else if (err && err.code === 'invalid_passkey') { closeSheet(); logout('Your session was reset. Please sign in again.'); return; }
      else if (err && err.code === 'not_configured') { sheetError(err.message); }
      else sheetError('Could not save: ' + ((err && err.message) || 'network error') + '. Your entries are kept — try again.');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  /* ------------------------------------------------------------- photo UI */
  function bindPhoto() {
    var file = U.$('#f-photo-file');
    var upload = U.$('#f-photo-upload');
    var clear = U.$('#f-photo-clear');
    var importBtn = U.$('#f-photo-import');
    var urlInput = U.$('#f-photo');

    U.on(upload, 'click', function () { if (file) file.click(); });

    U.on(file, 'change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      updatePhotoStatusText('Processing image…');
      U.fileToDataUri(f, 640, 0.86).then(function (dataUri) {
        var approx = dataUri.length * 0.75;
        if (approx > CFG.CARD.MAX_EMBEDDED_PHOTO_BYTES) {
          return U.fileToDataUri(f, 420, 0.78).then(function (smaller) {
            S.photoValue = smaller;
            urlInput.value = '';
            updatePhotoPreview();
            U.toast('Photo attached (compressed to keep the card lightweight).', 'info');
          });
        }
        S.photoValue = dataUri;
        urlInput.value = '';
        updatePhotoPreview();
        U.toast('Photo attached to the card.', 'success');
      }).catch(function (err) {
        U.toast((err && err.message) || 'Could not read that image.', 'error');
        updatePhotoPreview();
      }).then(function () { file.value = ''; });
    });

    U.on(importBtn, 'click', function () {
      var url = urlInput.value.trim();
      if (!U.validImageSrc(url)) { U.toast('Paste an https:// image URL first.', 'error'); return; }
      updatePhotoStatusText('Importing image…');
      U.fetchImageAsDataUri(url, 640, 0.86).then(function (dataUri) {
        if (dataUri) {
          S.photoValue = dataUri;
          urlInput.value = '';
          updatePhotoPreview();
          U.toast('Image imported and embedded.', 'success');
        } else {
          S.photoValue = url;
          updatePhotoPreview();
          U.toast('Could not embed (the host blocks cross-origin access) — the URL will be used directly.', 'info', 5000);
        }
      });
    });

    U.on(clear, 'click', function () {
      S.photoValue = '';
      if (urlInput) urlInput.value = '';
      updatePhotoPreview();
    });

    U.on(urlInput, 'input', function () { S.photoValue = urlInput.value.trim(); updatePhotoPreview(); });
  }

  function updatePhotoStatusText(txt) {
    var note = U.$('#f-photo-status');
    if (note) note.textContent = txt;
  }

  /* ------------------------------------------------------------ settings */
  function bindSettings() {
    var btn = U.$('#settings-btn');
    if (!btn) return;
    U.on(btn, 'click', function () {
      var cur = U.$('#settings-current').value;
      var nw = U.$('#settings-new').value;
      var cf = U.$('#settings-confirm').value;
      var msg = U.$('#settings-msg');
      function fail(text) { if (msg) { msg.textContent = text; msg.className = 'mt-3 text-sm text-rose-700'; } }
      function pass(text) { if (msg) { msg.textContent = text; msg.className = 'mt-3 text-sm text-emerald-700'; } }

      if (!cur) return fail('Enter your current passkey.');
      if (!nw || nw.length < 8) return fail('The new passkey must be at least 8 characters.');
      if (nw !== cf) return fail('The new passkey and confirmation do not match.');

      btn.disabled = true;
      CCO.DB.adminChangePasskey(cur, nw).then(function () {
        S.pass = nw;
        S.usingDefaultPass = false;
        rememberPass(nw);
        updateWarnBanner();
        U.$('#settings-current').value = '';
        U.$('#settings-new').value = '';
        U.$('#settings-confirm').value = '';
        pass('Passkey updated. Use it the next time you sign in.');
        U.toast('Master passkey changed.', 'success');
      }).catch(function (err) {
        if (err && err.code === 'invalid_passkey') {
          S.pass = '';
          rememberPass('');
          logout('Your session was reset — the current passkey you entered was wrong.');
          return;
        }
        fail((err && err.message) || 'Could not change the passkey.');
      }).then(function () { btn.disabled = false; });
    });
  }

  /* -------------------------------------------------------------- events */
  function bindEvents() {
    U.on(U.$('#admin-gate-form'), 'submit', function (ev) {
      ev.preventDefault();
      var pass = U.$('#admin-pass').value;
      if (!pass) { gateAlert('error', 'Enter the master passkey.'); return; }
      login(pass);
    });

    U.on(U.$('#admin-pass-toggle'), 'click', function () {
      var input = U.$('#admin-pass');
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
      input.focus();
    });

    U.on(U.$('#admin-logout'), 'click', function () { logout(); });

    U.on(U.$('#admin-search'), 'input', U.debounce(function (ev) {
      S.search = ev.target.value || '';
      render();
    }, 120));

    U.on(U.$('#admin-add-btn'), 'click', function () { openSheet(null); });
    U.on(U.$('#admin-refresh'), 'click', function () {
      U.toast('Refreshing…', 'info', 1200);
      refresh({});
    });

    U.on(U.$('#admin-tbody'), 'click', onRowAction);
    U.on(U.$('#admin-cards'), 'click', onRowAction);

    U.on(U.$('#admin-form'), 'submit', function (ev) { ev.preventDefault(); saveForm(); });
    U.on(U.$('#admin-cancel-btn'), 'click', function (ev) { ev.preventDefault(); closeSheet(); });
    U.on(U.$('#admin-sheet-close'), 'click', closeSheet);

    U.on(U.$('#f-otp-generate'), 'click', function () {
      var b = U.$('#f-otp-generate');
      b.disabled = true; b.textContent = '…';
      CCO.DB.adminGenerateOtp(S.pass).then(function (otp) {
        if (otp) { U.$('#f-otp').value = otp; fieldError('otp', ''); }
      }).catch(function (err) {
        if (err && err.code === 'invalid_passkey') { closeSheet(); logout('Your session was reset. Please sign in again.'); return; }
        sheetError((err && err.message) || 'Could not generate a code.');
      }).then(function () { b.disabled = false; b.textContent = 'Generate'; });
    });

    ['f-name', 'f-passport', 'f-role', 'f-otp'].forEach(function (id) {
      U.on(U.$('#' + id), 'input', function () {
        if (id === 'f-otp') { var v = U.digitsOnly(U.$('#f-otp').value).slice(0, 6); U.$('#f-otp').value = v; }
        fieldError(id.slice(2), '');
      });
    });
    ['f-issue', 'f-expiry'].forEach(function (id) {
      U.on(U.$('#' + id), 'change', function () { fieldError('expiry', ''); });
    });

    U.on(U.$('#confirm-cancel'), 'click', closeConfirm);
    U.on(U.$('#confirm-ok'), 'click', doDelete);
    U.on(U.$('#confirm-modal'), 'click', function (ev) { if (ev.target === U.$('#confirm-modal')) closeConfirm(); });

    U.on(U.$('#admin-sheet'), 'click', function (ev) { if (ev.target === U.$('#admin-sheet')) closeSheet(); });

    U.on(document, 'keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!U.$('#confirm-modal').classList.contains('hidden')) return closeConfirm();
      if (S.sheetOpen) return closeSheet();
    });

    U.on(document, 'visibilitychange', function () {
      if (document.visibilityState === 'visible' && S.booted) refresh({ silent: true });
    });

    U.on(window, 'offline', function () { setLive('offline'); });
    U.on(window, 'online', function () { if (S.booted) { setLive('polling'); refresh({ silent: true }); } });
  }

  /* ------------------------------------------------------------------ api */
  var api = {};

  api.init = function () {
    el.gate = U.$('#admin-gate');
    bindEvents();
    bindPhoto();
    bindSettings();

    var remembered = recallPass();
    if (remembered) {
      var box = U.$('#admin-remember');
      login(remembered).catch(function () { /* silent — gate shows error */ });
    } else {
      showGate();
    }
  };

  api.open = function () {
    if (S.booted && S.pass) {
      U.hide(U.$('#admin-gate'));
      U.show(U.$('#admin-dashboard'));
      updateWarnBanner();
      refresh({ silent: true });
    } else {
      showGate();
    }
  };

  api.close = function () { /* state intentionally kept until logout */ };

  CCO.admin = api;
})();
