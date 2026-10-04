/* Mountain Way Job Log — iPhone / desktop app
 * Works offline: entries and receipt photos are saved on the device first,
 * then sent to the Google back end (Apps Script) whenever there is signal.
 * No business data lives in this file; it all comes from the Google Sheet.
 */
(function () {
  'use strict';

  var APP_VERSION = '1.0.1';

  /* ---------------- tiny IndexedDB wrapper ---------------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open('mw-joblog', 1);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' });
      };
      req.onsuccess = function () {
        var d = req.result;
        // iPhones can close storage while the app is in the background; reopen next time.
        d.onclose = function () { dbp = null; };
        d.onversionchange = function () { try { d.close(); } catch (e) { /* already closed */ } dbp = null; };
        resolve(d);
      };
      req.onerror = function () { dbp = null; reject(req.error); };
    });
    return dbp;
  }
  function isClosedDbError(err) {
    return !!err && (err.name === 'InvalidStateError' || /clos(ing|ed)/i.test(String(err.message || '')));
  }
  function tx(store, mode, fn, retried) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t;
        try { t = d.transaction(store, mode); } catch (err) { reject(err); return; }
        var s = t.objectStore(store);
        var out = fn(s);
        t.oncomplete = function () { resolve(out instanceof IDBRequest ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    }).catch(function (err) {
      if (!retried && isClosedDbError(err)) { dbp = null; return tx(store, mode, fn, true); }
      throw err;
    });
  }
  var kvGet = function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); };
  var kvSet = function (k, v) { return tx('kv', 'readwrite', function (s) { s.put(v, k); }); };
  var kvDel = function (k) { return tx('kv', 'readwrite', function (s) { s.delete(k); }); };
  var qAll = function () { return tx('queue', 'readonly', function (s) { return s.getAll(); }); };
  var qPut = function (e) { return tx('queue', 'readwrite', function (s) { s.put(e); }); };
  var qDel = function (id) { return tx('queue', 'readwrite', function (s) { s.delete(id); }); };

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    var neg = n < 0;
    return (neg ? '−$' : '$') + Math.abs(Math.round(n * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function rate(n) { return Math.round(n) === n ? '$' + n : money(n); }
  function hrs(n) { return String(Math.round(n * 100) / 100) + ' h'; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function thisMonth() { return today().slice(0, 7); }
  function shortDate(s) { var p = String(s).split('-'); return p.length === 3 ? (+p[1]) + '/' + (+p[2]) : s; }
  function longDate(s) {
    var p = s.split('-'); var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var isToday = s === today();
    var label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return isToday ? 'Today · ' + label : label;
  }
  function monthName(m) {
    var p = m.split('-'); return new Date(+p[0], +p[1] - 1, 15).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }
  function compressImage(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600, w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.72);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  var ICON = {
    clock: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    receipt: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/></svg>',
    user: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
    back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    camera: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
    warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v8M12 18v.5"/></svg>',
    grid: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>',
    sync: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/></svg>'
  };

  /* ---------------- state ---------------- */
  var S = {
    ready: false,
    conn: null,        // { url, passcode }
    config: null,      // from the Sheet
    queue: [],         // waiting entries (with photo blobs)
    screen: 'setup',
    prop: null,
    form: null,
    syncing: false,
    online: navigator.onLine,
    lastError: '',
    lastSyncAt: null,
    toast: '',
    month: { owner: null, month: thisMonth(), data: null, loading: false, error: '', cachedAt: null },
    setup: { url: '', passcode: '', busy: false, error: '' }
  };
  var toastTimer = null;
  var app = document.getElementById('app');
  var photoInput = document.getElementById('photo-input');

  function flash(msg) {
    S.toast = msg; render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { S.toast = ''; render(); }, 3000);
  }

  function propBy(code) {
    var ps = (S.config && S.config.properties) || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].code === code) return ps[i];
    return null;
  }

  /* ---------------- network ---------------- */
  function call(payload, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 30000) : null;
    var body = JSON.stringify(Object.assign({ passcode: S.conn.passcode }, payload));
    return fetch(S.conn.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body,
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (err) {
      if (timer) clearTimeout(timer);
      var e = new Error('offline'); e.offline = true; e.cause = err; throw e;
    });
  }

  function refreshConfig() {
    return call({ action: 'config' }, 30000).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'config_failed');
      S.config = res;
      return kvSet('config', res);
    });
  }

  var syncPromise = null;
  function syncNow(opts) {
    opts = opts || {};
    if (!S.conn) return Promise.resolve();
    if (syncPromise) return syncPromise;
    S.syncing = true; S.lastError = ''; render();
    syncPromise = qAll().then(function (items) {
      items.sort(function (a, b) { return a.seq - b.seq; });
      var chain = Promise.resolve();
      var stop = false;
      items.forEach(function (item) {
        chain = chain.then(function () {
          if (stop || item.failed) return;
          var send = {
            id: item.id, date: item.date, prop: item.prop, kind: item.kind, desc: item.desc,
            hours: item.hours, amount: item.amount, paidBy: item.paidBy, helper: item.helper,
            billable: item.billable, loggedAt: item.loggedAt, receiptOf: item.receiptOf || null
          };
          var prep = item.photo
            ? blobToBase64(item.photo).then(function (b64) { send.photo = { base64: b64, mime: item.photo.type || 'image/jpeg' }; })
            : Promise.resolve();
          return prep.then(function () {
            return call({ action: 'sync', entries: [send] }, item.photo ? 60000 : 30000);
          }).then(function (res) {
            if (res && res.ok && res.accepted && res.accepted.indexOf(item.id) >= 0) {
              return qDel(item.id);
            }
            if (res && res.ok && res.rejected && res.rejected.length) {
              item.failed = res.rejected[0].error || 'rejected';
              return qPut(item);
            }
            if (res && res.error === 'bad_passcode') { stop = true; S.lastError = 'The passcode was not accepted. Check it under Status.'; return; }
            stop = true; S.lastError = (res && res.error) || 'Could not send';
          }, function (err) {
            stop = true;
            S.lastError = err.offline ? '' : String(err.message || err);
            if (err.offline) S.online = false;
          });
        });
      });
      return chain.then(function () {
        if (!stop) {
          S.online = true;
          S.lastSyncAt = Date.now();
          kvSet('lastSyncAt', S.lastSyncAt);
          return refreshConfig().catch(function () { /* keep cached config */ });
        }
      });
    }).then(loadQueue).finally(function () {
      S.syncing = false; syncPromise = null; render();
      if (opts.announce) {
        if (!S.queue.filter(function (q) { return !q.failed; }).length) flash('Everything is sent');
        else if (!S.online) flash('No signal — entries are safe on this phone');
      }
    });
    return syncPromise;
  }

  function loadQueue() {
    return qAll().then(function (items) {
      items.sort(function (a, b) { return a.seq - b.seq; });
      S.queue = items;
    });
  }

  /* ---------------- actions ---------------- */
  var actions = {
    goHome: function () { S.screen = 'home'; render(); window.scrollTo(0, 0); },
    goMonth: function () {
      S.screen = 'month'; render(); window.scrollTo(0, 0);
      var owners = (S.config && S.config.owners) || [];
      if (!S.month.owner && owners.length) S.month.owner = owners[0].key;
      loadMonth();
    },
    goStatus: function () { S.screen = 'status'; render(); window.scrollTo(0, 0); },
    openProp: function (el) { S.prop = el.getAttribute('data-code'); S.screen = 'prop'; render(); window.scrollTo(0, 0); },
    backToProp: function () { S.screen = 'prop'; render(); window.scrollTo(0, 0); },
    openForm: function (el) {
      var kind = el.getAttribute('data-kind');
      var p = propBy(S.prop);
      var helpers = (S.config && S.config.helpers) || [];
      S.form = {
        kind: kind, date: today(), hours: null, hoursOther: '', amount: '', note: '',
        paidBy: p && p.ownerKey ? 'owner' : 'mine',
        billable: kind === 'help' ? true : !!(p && p.hourly),
        helper: helpers.length ? helpers[0].name : '', helperOther: '',
        split: [], photo: null, photoUrl: '', error: ''
      };
      S.screen = 'form'; render(); window.scrollTo(0, 0);
    },
    pickHours: function (el) { S.form.hours = parseFloat(el.getAttribute('data-h')); S.form.hoursOther = ''; S.form.error = ''; render(); },
    pickHelper: function (el) { S.form.helper = el.getAttribute('data-name'); render(); },
    pickPaid: function (el) { S.form.paidBy = el.getAttribute('data-paid'); render(); },
    addTag: function (el) {
      var t = el.getAttribute('data-tag');
      var cur = (S.form.note || '').trim();
      S.form.note = (cur ? cur + '; ' : '') + t;
      render();
    },
    toggleBillable: function () { S.form.billable = !S.form.billable; render(); },
    toggleSplit: function (el) {
      var c = el.getAttribute('data-code');
      var i = S.form.split.indexOf(c);
      if (i >= 0) S.form.split.splice(i, 1); else S.form.split.push(c);
      render();
    },
    takePhoto: function () { photoInput.value = ''; photoInput.click(); },
    removePhoto: function () {
      if (S.form.photoUrl) URL.revokeObjectURL(S.form.photoUrl);
      S.form.photo = null; S.form.photoUrl = ''; render();
    },
    save: function () { saveEntry(); },
    syncNow: function () { syncNow({ announce: true }); },
    pickOwner: function (el) { S.month.owner = el.getAttribute('data-key'); S.month.data = null; render(); loadMonth(); },
    pickMonth: function (el) { S.month.month = el.getAttribute('data-month'); S.month.data = null; render(); loadMonth(); },
    reloadMonth: function () { loadMonth(true); },
    connect: function () { connect(); },
    changeConnection: function () {
      S.setup.url = S.conn ? S.conn.url : ''; S.setup.passcode = ''; S.setup.error = '';
      S.screen = 'setup'; render();
    },
    retryFailed: function (el) {
      var id = el.getAttribute('data-id');
      var item = S.queue.filter(function (q) { return q.id === id; })[0];
      if (!item) return;
      delete item.failed;
      qPut(item).then(function () { return syncNow({ announce: true }); });
    },
    discardFailed: function (el) {
      var id = el.getAttribute('data-id');
      qDel(id).then(loadQueue).then(function () { render(); flash('Entry removed from this phone'); });
    }
  };

  app.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]');
    if (!el || el.disabled) return;
    var fn = actions[el.getAttribute('data-action')];
    if (fn) { ev.preventDefault(); fn(el); }
  });
  app.addEventListener('input', function (ev) {
    var f = ev.target.getAttribute('data-field');
    if (!f) return;
    if (f === 'setup.url') S.setup.url = ev.target.value;
    else if (f === 'setup.passcode') S.setup.passcode = ev.target.value;
    else if (S.form) {
      S.form[f] = ev.target.value;
      if (f === 'hoursOther' && ev.target.value) { S.form.hours = null; markHourChips(); }
      S.form.error = '';
    }
  });
  app.addEventListener('change', function (ev) {
    if (ev.target.getAttribute('data-field') === 'date' && S.form) { S.form.date = ev.target.value || today(); render(); }
  });
  function markHourChips() {
    Array.prototype.forEach.call(app.querySelectorAll('[data-h]'), function (b) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
  }

  photoInput.addEventListener('change', function () {
    var file = photoInput.files && photoInput.files[0];
    if (!file || !S.form) return;
    compressImage(file).then(function (blob) {
      if (S.form.photoUrl) URL.revokeObjectURL(S.form.photoUrl);
      S.form.photo = blob;
      S.form.photoUrl = URL.createObjectURL(blob);
      render();
    });
  });

  function saveEntry() {
    var f = S.form, p = propBy(S.prop);
    if (!f || !p) return;
    var hours = f.hours;
    if (f.hoursOther) hours = parseFloat(String(f.hoursOther).replace(',', '.'));
    if ((f.kind === 'hours' || f.kind === 'help') && !(hours > 0)) { f.error = 'Pick how many hours.'; render(); return; }
    var amt = parseFloat(String(f.amount).replace(/[^0-9.]/g, ''));
    if (f.kind === 'purchase' && !(amt > 0)) { f.error = 'Enter the amount.'; render(); return; }
    var helper = f.helper === '__other' ? (f.helperOther || '').trim() : f.helper;
    if (f.kind === 'help' && !helper) { f.error = 'Who worked? Pick or type a name.'; render(); return; }

    var targets = [p.code].concat(f.split);
    var n = targets.length;
    var base = (f.note || '').trim() || (f.kind === 'purchase' ? 'Purchase' : f.kind === 'help' ? 'Hired help' : 'Work');
    var desc = base + (n > 1 ? ' (split ' + n + ' ways)' : '');
    var now = Date.now();
    var firstId = null;
    var recs = targets.map(function (code, i) {
      var tp = propBy(code) || {};
      var r = {
        id: uid(), seq: now + i, prop: code, kind: f.kind, date: f.date || today(), desc: desc,
        loggedAt: new Date(now).toISOString()
      };
      if (f.kind === 'purchase') {
        r.amount = Math.round(amt / n * 100) / 100;
        r.paidBy = (code === p.code && tp.ownerKey) ? f.paidBy : 'mine';
        if (i === 0 && f.photo) r.photo = f.photo;
      } else {
        r.hours = Math.round(hours / n * 100) / 100;
        r.billable = f.kind === 'help' ? true : (code === p.code ? f.billable : !!tp.hourly);
        if (f.kind === 'help') r.helper = helper;
      }
      if (i === 0) firstId = r.id; else if (f.kind === 'purchase' && f.photo) r.receiptOf = firstId;
      return r;
    });
    var chain = Promise.resolve();
    recs.forEach(function (r) { chain = chain.then(function () { return qPut(r); }); });
    chain.then(loadQueue).then(function () {
      var what = f.kind === 'purchase' ? money(amt) : hrs(hours);
      if (f.photoUrl) URL.revokeObjectURL(f.photoUrl);
      S.form = null; S.screen = 'prop'; render(); window.scrollTo(0, 0);
      flash('Saved to ' + p.name + (n > 1 ? ' + ' + (n - 1) + ' more' : '') + ' · ' + what);
      syncNow();
    }).catch(function (err) {
      f.error = 'Could not save on this phone: ' + (err && err.message ? err.message : err); render();
    });
  }

  function loadMonth(force) {
    var m = S.month;
    if (!m.owner) return;
    var key = 'month:' + m.owner + ':' + m.month;
    kvGet(key).then(function (cached) {
      if (cached && (!m.data || force)) { m.data = cached.data; m.cachedAt = cached.at; render(); }
      m.loading = true; m.error = ''; render();
      return call({ action: 'month', owner: m.owner, month: m.month }, 30000).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
        if (S.month.owner !== m.owner || S.month.month !== m.month) return;
        m.data = res; m.cachedAt = Date.now();
        return kvSet(key, { data: res, at: m.cachedAt });
      }).catch(function (err) {
        m.error = err.offline ? 'No signal. Month-end needs a connection.' : 'Could not load: ' + (err.message || err);
      }).finally(function () { m.loading = false; render(); });
    });
  }

  function connect() {
    var url = (S.setup.url || '').trim();
    var pass = (S.setup.passcode || '').trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { S.setup.error = 'Paste the app address from the Sheet (it starts with https://script.google.com/).'; render(); return; }
    if (pass.length < 8) { S.setup.error = 'Enter the passcode (at least 8 characters).'; render(); return; }
    S.setup.busy = true; S.setup.error = ''; render();
    var prev = S.conn;
    S.conn = { url: url, passcode: pass };
    call({ action: 'config' }, 30000).then(function (res) {
      if (!res || !res.ok) throw new Error(res && res.error === 'bad_passcode' ? 'That passcode was not accepted.' : 'The Sheet answered with an error: ' + ((res && res.error) || 'unknown'));
      S.config = res;
      return kvSet('conn', S.conn).then(function () { return kvSet('config', res); });
    }).then(function () {
      S.setup.busy = false; S.screen = 'home'; render();
      flash('Connected to ' + (S.config.business || 'your Sheet'));
      syncNow();
    }).catch(function (err) {
      S.conn = prev;
      S.setup.busy = false;
      S.setup.error = err.offline ? 'No connection. Setup needs signal once.' : String(err.message || err);
      render();
    });
  }

  /* ---------------- rendering ---------------- */
  function syncPill() {
    var waiting = S.queue.filter(function (q) { return !q.failed; }).length;
    var failed = S.queue.filter(function (q) { return q.failed; }).length;
    if (S.syncing) return '<button class="pill" data-action="syncNow"><span class="spin"></span>Sending…</button>';
    if (failed) return '<button class="pill error" data-action="goStatus"><span class="dot"></span>' + failed + ' need attention</button>';
    if (waiting) return '<button class="pill waiting" data-action="syncNow"><span class="dot"></span>' + waiting + ' waiting to send</button>';
    if (S.lastError) return '<button class="pill error" data-action="goStatus"><span class="dot"></span>Sync problem</button>';
    return '<button class="pill ok" data-action="syncNow"><span class="dot"></span>All sent</button>';
  }

  function tabs(active) {
    return '<nav class="tabs" aria-label="Main">' +
      '<button class="' + (active === 'home' ? 'on' : '') + '" data-action="goHome">' + ICON.grid + '<span>Properties</span></button>' +
      '<button class="' + (active === 'month' ? 'on' : '') + '" data-action="goMonth">' + ICON.doc + '<span>Month-end</span></button>' +
      '<button class="' + (active === 'status' ? 'on' : '') + '" data-action="goStatus">' + ICON.sync + '<span>Status</span></button>' +
      '</nav>';
  }

  function entriesFor(code) {
    var month = thisMonth();
    var recent = ((S.config && S.config.recent) || []).filter(function (e) { return e.prop === code && e.date.slice(0, 7) === month; })
      .map(function (e) {
        var kind = e.type === 'Purchase' ? 'purchase' : e.type === 'Hired help' ? 'help' : 'hours';
        return { id: e.id, kind: kind, date: e.date, desc: e.desc, hours: e.hours, amount: e.amount,
          paidBy: e.paidWith === 'Owner card' ? 'owner' : 'mine', helper: e.helper, billable: e.billable, receipt: e.hasReceipt, state: 'sent', seq: 0 };
      });
    var queued = S.queue.filter(function (q) { return q.prop === code; }).map(function (q) {
      return { id: q.id, kind: q.kind, date: q.date, desc: q.desc, hours: q.hours, amount: q.amount, paidBy: q.paidBy,
        helper: q.helper, billable: q.billable, receipt: !!(q.photo || q.receiptOf), state: q.failed ? 'failed' : 'queued', seq: q.seq };
    });
    var queuedIds = {};
    queued.forEach(function (q) { queuedIds[q.id] = 1; });
    return queued.concat(recent.filter(function (r) { return !queuedIds[r.id]; }))
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.seq - a.seq; });
  }

  function renderSetup() {
    var s = S.setup;
    return '<main class="screen no-tabs"><div class="pad">' +
      '<div class="stack"><div class="eyebrow">Mountain Way · Job log</div><h1>Connect to your Sheet</h1>' +
      '<p class="sub">One-time setup. Both items come from the Sheet: Mountain Way menu › Show app connection info.</p></div>' +
      '<div class="field"><label class="label" for="su">App address</label><input id="su" class="input" data-field="setup.url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(s.url) + '"></div>' +
      '<div class="field"><label class="label" for="sp">Passcode</label><input id="sp" class="input" type="password" data-field="setup.passcode" autocomplete="current-password" value="' + esc(s.passcode) + '"></div>' +
      (s.error ? '<div class="error" role="alert">' + esc(s.error) + '</div>' : '') +
      '<p class="small">The passcode is stored only on this device. Your entries and receipts go straight to your own Google Sheet and Drive.</p>' +
      '</div></main>' +
      '<div class="savebar"><div class="savebar-inner"><button class="primary" data-action="connect"' + (s.busy ? ' disabled' : '') + '>' + (s.busy ? 'Connecting…' : 'Connect') + '</button></div></div>';
  }

  function renderHome() {
    var ps = (S.config && S.config.properties) || [];
    var tiles = ps.map(function (p) {
      var n = entriesFor(p.code).length;
      return '<button class="tile" data-action="openProp" data-code="' + esc(p.code) + '">' +
        '<span class="row"><span class="code">' + esc(p.code) + '</span><span class="small">' + n + (n === 1 ? ' entry' : ' entries') + '</span></span>' +
        '<span class="name">' + esc(p.name) + '</span>' +
        '<span class="small">' + esc(p.ownerKey ? p.ownerName : 'Your property') + '</span>' +
        (p.hourly && p.ownerKey ? '<span class="tag-hourly">Hourly extras · ' + rate(S.config.hourlyRate) + '/h</span>' : '') +
        '</button>';
    }).join('');
    tiles += '<button class="tile dark" data-action="goMonth">' + ICON.doc +
      '<span class="stack"><span class="name">Month-end</span><span class="small">Owner statements</span></span></button>';
    return '<main class="screen"><div class="pad">' +
      '<div class="topline"><div class="eyebrow">' + esc((S.config && S.config.business) || 'Mountain Way') + '</div>' + syncPill() + '</div>' +
      '<div class="stack"><h1>Where are you working?</h1><p class="sub">Tap a property, then log hours, a purchase, or hired help.</p></div>' +
      (ps.length ? '<div class="tiles">' + tiles + '</div>' : '<div class="empty">No properties yet. Add them in the Sheet’s Properties tab, then tap the status pill to refresh.</div>') +
      '</div></main>' + tabs('home');
  }

  function entryRow(e, p) {
    var ico = e.kind === 'purchase' ? ICON.receipt : e.kind === 'help' ? ICON.user : ICON.clock;
    var meta = shortDate(e.date), right = '', title = e.desc;
    var hourly = (S.config && S.config.hourlyRate) || 0;
    if (e.kind === 'hours') { meta += ' · ' + (p.ownerKey ? (e.billable ? 'billable at ' + rate(hourly) + '/h' : 'covered by fee') : 'your property'); right = hrs(e.hours); }
    if (e.kind === 'purchase') { meta += ' · ' + (e.paidBy === 'owner' ? p.code + ' owner card' : 'my card') + (e.receipt ? ' · receipt attached' : ' · no receipt'); right = money(e.amount); }
    if (e.kind === 'help') { title = (e.helper || 'Helper') + ': ' + e.desc; meta += ' · ' + hrs(e.hours); right = hrs(e.hours); }
    if (e.state === 'queued') meta += ' · waiting to send';
    if (e.state === 'failed') meta += ' · not accepted, see Status';
    return '<div class="entry ' + (e.state === 'sent' ? '' : e.state) + '"><span class="ico">' + ico.replace(/width="24" height="24"/, 'width="18" height="18"') + '</span>' +
      '<div class="txt"><div class="title">' + esc(title) + '</div><div class="meta">' + esc(meta) + '</div></div>' +
      '<div class="right">' + esc(right) + '</div></div>';
  }

  function renderProp() {
    var p = propBy(S.prop);
    if (!p) { S.screen = 'home'; return renderHome(); }
    var es = entriesFor(p.code);
    var h = 0, b = 0, hp = 0;
    es.forEach(function (e) { if (e.kind === 'hours') h += e.hours || 0; if (e.kind === 'purchase') b += e.amount || 0; if (e.kind === 'help') hp += e.hours || 0; });
    var ownerLine = p.ownerKey
      ? 'Owner: ' + p.ownerName + (p.hourly ? ' · extras billed at ' + rate(S.config.hourlyRate) + '/h' : ' · extras covered by fee')
      : 'Your property · logged for your records and taxes';
    var act = function (kind, ico, t, s) {
      return '<button class="action" data-action="openForm" data-kind="' + kind + '"><span class="ico">' + ico + '</span><span><b>' + t + '</b><span class="small">' + s + '</span></span></button>';
    };
    return '<main class="screen">' +
      '<div class="hero"><div class="topline"><button class="back" data-action="goHome">' + ICON.back + '<span>Properties</span></button>' + syncPill() + '</div>' +
      '<div class="topline" style="justify-content:flex-start"><span class="code on-dark">' + esc(p.code) + '</span><h1 style="font-size:28px">' + esc(p.name) + '</h1></div>' +
      '<p class="sub">' + esc(ownerLine) + '</p></div>' +
      '<div class="pad" style="padding-top:20px">' +
      '<div class="stack-lg">' +
      act('hours', ICON.clock, 'Log hours', 'What you did and how long it took') +
      act('purchase', ICON.receipt, 'Log purchase', 'Receipt photo, amount, which card') +
      act('help', ICON.user, 'Log hired help', 'A helper’s hours, passed through') +
      '</div>' +
      '<div class="stack-lg"><div class="stack" style="gap:2px"><h2>' + esc(monthName(thisMonth())) + ' so far</h2>' +
      '<div class="small">' + hrs(h) + ' logged · ' + money(b) + ' purchases · ' + hrs(hp) + ' hired help</div></div>' +
      (es.length ? es.map(function (e) { return entryRow(e, p); }).join('') : '<div class="empty">Nothing logged here this month yet.</div>') +
      '</div></div></main>' + tabs('home');
  }

  function chip(on, label, attrs, cls) {
    return '<button class="chip ' + (cls || '') + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" ' + attrs + '>' + esc(label) + '</button>';
  }

  function renderForm() {
    var f = S.form, p = propBy(S.prop);
    if (!f || !p) { S.screen = 'home'; return renderHome(); }
    var cfg = S.config || {};
    var title = f.kind === 'hours' ? 'Log hours' : f.kind === 'purchase' ? 'Log purchase' : 'Log hired help';
    var ownerFirst = p.ownerKey ? (p.ownerLabel || p.ownerName.split(' ')[0]) : '';
    var h = [];
    h.push('<main class="screen no-tabs"><div class="pad" style="padding-top:calc(8px + var(--safe-top))">');
    h.push('<div class="stack"><button class="back light" data-action="backToProp">' + ICON.back + '<span>' + esc(p.name) + '</span></button>' +
      '<div class="topline" style="justify-content:flex-start"><h1 style="font-size:28px">' + title + '</h1><span class="code">' + esc(p.code) + '</span></div></div>');

    h.push('<div class="field"><label class="label" for="fd">Date</label><input id="fd" class="input" type="date" data-field="date" value="' + esc(f.date) + '" max="' + today() + '"><span class="small">' + esc(longDate(f.date)) + '</span></div>');

    if (f.kind === 'help') {
      var helpers = cfg.helpers || [];
      h.push('<div class="field"><div class="label">Who worked</div><div class="grid2">' +
        helpers.map(function (x) { return chip(f.helper === x.name, x.name, 'data-action="pickHelper" data-name="' + esc(x.name) + '"'); }).join('') +
        chip(f.helper === '__other', 'Someone else', 'data-action="pickHelper" data-name="__other"') + '</div>' +
        (f.helper === '__other' ? '<input class="input" data-field="helperOther" placeholder="Their name" value="' + esc(f.helperOther) + '" aria-label="Helper name">' : '') +
        '</div>');
    }

    if (f.kind === 'hours' || f.kind === 'help') {
      var hs = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
      h.push('<div class="field"><div class="label">' + (f.kind === 'help' ? 'Their hours' : 'Hours') + '</div><div class="grid4">' +
        hs.map(function (x) { return chip(f.hours === x && !f.hoursOther, String(x), 'data-action="pickHours" data-h="' + x + '"'); }).join('') +
        '</div><input class="input" data-field="hoursOther" inputmode="decimal" placeholder="Other amount, e.g. 5.5" value="' + esc(f.hoursOther) + '" aria-label="Other hours"></div>');
    }

    if (f.kind === 'purchase') {
      h.push('<div class="field">' + (f.photo
        ? '<div class="card"><span style="display:flex;align-items:center;gap:12px"><img class="thumb" src="' + f.photoUrl + '" alt="Receipt photo"><span><b>Receipt attached</b><br><span class="small">Saved on this phone until sent</span></span></span><button class="toggle" data-action="takePhoto">Retake</button></div>'
        : '<button class="photo-btn" data-action="takePhoto">' + ICON.camera + '<span>Take receipt photo</span></button>') + '</div>');
      h.push('<div class="field"><label class="label" for="fa">Amount</label><div class="money"><span>$</span><input id="fa" data-field="amount" inputmode="decimal" placeholder="0.00" value="' + esc(f.amount) + '"></div></div>');
      if (p.ownerKey) {
        h.push('<div class="field"><div class="label">Paid with</div><div class="grid2">' +
          chip(f.paidBy === 'owner', p.code + ' owner card', 'data-action="pickPaid" data-paid="owner"') +
          chip(f.paidBy === 'mine', 'My card', 'data-action="pickPaid" data-paid="mine"') + '</div></div>');
      }
    }

    var tags = cfg.tags || [];
    h.push('<div class="field"><label class="label" for="fn">What was done</label>' +
      (tags.length ? '<div class="wrap">' + tags.map(function (t) { return '<button class="tagchip" data-action="addTag" data-tag="' + esc(t) + '">+ ' + esc(t) + '</button>'; }).join('') + '</div>' : '') +
      '<textarea id="fn" rows="3" data-field="note" placeholder="Type, or tap the mic on the keyboard to dictate">' + esc(f.note) + '</textarea></div>');

    var billText = '', toggle = false;
    if (!p.ownerKey) billText = f.kind === 'hours' ? 'Your property. Kept for your own records and taxes.' : 'Your expense. Kept for your records and taxes.';
    else if (f.kind === 'hours') { toggle = true; billText = f.billable ? 'Billed to ' + ownerFirst + ' at ' + rate(cfg.hourlyRate) + '/h' : (p.hourly ? 'Not billed this time' : 'Covered by management fee'); }
    else if (f.kind === 'purchase') billText = f.paidBy === 'owner' ? 'Already paid on ' + ownerFirst + '’s card. Listed on the statement for reference.' : 'Reimbursed to you on ' + ownerFirst + '’s invoice.';
    else billText = cfg.billHelp ? 'Passed through to ' + ownerFirst + ' on the invoice.' : 'Listed for ' + ownerFirst + '; not added to the total (see Settings in the Sheet).';
    h.push('<div class="field"><div class="label">Billing</div><div class="card"><span style="font-size:14px;line-height:1.4">' + esc(billText) + '</span>' +
      (toggle ? '<button class="toggle' + (f.billable ? ' on' : '') + '" aria-pressed="' + (f.billable ? 'true' : 'false') + '" data-action="toggleBillable">' + (f.billable ? 'Billable' : 'Not billed') + '</button>' : '') +
      '</div></div>');

    var others = ((cfg.properties) || []).filter(function (x) { return x.code !== p.code; });
    if (others.length) {
      h.push('<div class="field"><div class="label">Covers more than one property?</div><div class="small">Tap the others to split this entry evenly.</div><div class="wrap">' +
        others.map(function (x) { return chip(f.split.indexOf(x.code) >= 0, x.code, 'data-action="toggleSplit" data-code="' + esc(x.code) + '" aria-label="Split with ' + esc(x.name) + '"', 'sm'); }).join('') +
        '</div></div>');
    }
    if (f.error) h.push('<div class="error" role="alert">' + esc(f.error) + '</div>');
    h.push('</div></main>');
    var label = f.split.length ? 'Save · split across ' + (f.split.length + 1) + ' properties' : 'Save to ' + p.name;
    h.push('<div class="savebar"><div class="savebar-inner"><button class="primary" data-action="save">' + esc(label) + '</button></div></div>');
    return h.join('');
  }

  function renderMonth() {
    var cfg = S.config || {};
    var owners = cfg.owners || [];
    var m = S.month, d = m.data;
    var months = [cfg.thisMonth || thisMonth(), cfg.lastMonth].filter(Boolean);
    var h = [];
    h.push('<main class="screen"><div class="pad">');
    h.push('<div class="stack"><div class="eyebrow">Month-end</div><h1>' + esc(monthName(m.month)) + '</h1><p class="sub">One statement per owner, built from what you logged.</p></div>');
    h.push('<div class="grid2">' + months.map(function (mm) { return chip(m.month === mm, monthName(mm), 'data-action="pickMonth" data-month="' + mm + '"'); }).join('') + '</div>');
    if (!owners.length) {
      h.push('<div class="empty">No owners yet. Add them in the Sheet’s Owners tab.</div></div></main>' + tabs('month'));
      return h.join('');
    }
    h.push('<div class="grid' + (owners.length === 3 ? '2" style="grid-template-columns:repeat(3,minmax(0,1fr))' : '2') + '">' +
      owners.map(function (o) { return '<button class="chip' + (m.owner === o.key ? ' on' : '') + '" aria-pressed="' + (m.owner === o.key) + '" data-action="pickOwner" data-key="' + esc(o.key) + '" style="min-height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px"><span>' + esc(o.label) + '</span><span style="font-size:12px;letter-spacing:.06em">' + esc(o.prop) + '</span></button>'; }).join('') + '</div>');

    var waitingHere = S.queue.length;
    if (waitingHere) h.push('<div class="error" style="background:var(--warn-bg);color:var(--warn-ink)">' + waitingHere + ' entr' + (waitingHere === 1 ? 'y is' : 'ies are') + ' still on this phone and not in these totals yet.</div>');
    if (m.loading && !d) h.push('<div class="empty"><span class="spin" style="display:inline-block;vertical-align:middle"></span> Loading…</div>');
    if (m.error) h.push('<div class="error" role="alert">' + esc(m.error) + (d ? ' Showing the version loaded ' + new Date(m.cachedAt).toLocaleString() + '.' : '') + '</div>');

    if (d) {
      var line = function (l, r) { return '<div class="line"><span>' + l + '</span><span class="amt">' + r + '</span></div>'; };
      var s = [];
      s.push('<div class="stack" style="gap:2px"><div class="label">Bill to</div><div style="font-family:var(--display);font-size:20px;font-weight:600">' + esc(d.owner.full) + '</div><div class="small">' + esc((d.owner.company ? d.owner.company + ' · ' : '') + d.property.name) + '</div></div>');
      s.push('<div class="sect"><h3>Hired help' + (d.billHelp ? '' : ' (listed, not billed)') + '</h3>' + (d.help.length ? d.help.map(function (x) {
        return '<div class="line"><span>' + esc(x.helper) + ' · ' + hrs(x.hours) + ' × ' + money(x.rate) + '<br><span class="small">' + esc(x.desc) + '</span></span><span class="amt">' + money(x.total) + '</span></div>';
      }).join('') : '<div class="small">None this month</div>') + '</div>');
      s.push('<div class="sect"><h3>Reimbursements</h3>' + (d.reimb.length ? d.reimb.map(function (x) { return line(esc(shortDate(x.date) + ' · ' + x.desc), money(x.amount)); }).join('') : '<div class="small">None this month</div>') + '</div>');
      s.push('<div class="sect">' + line('<b style="font-size:13px">Additional tasks</b><br>' + hrs(d.extrasHours) + ' × ' + money(d.hourlyRate), money(d.extrasTotal)) +
        (d.notBilledHours ? '<div class="small">' + hrs(d.notBilledHours) + ' more logged, covered by fee (not billed)</div>' : '') + '</div>');
      s.push('<div class="sect">' +
        line('<b style="font-size:13px">Management fee</b><br><span class="small">' + (d.fee !== null ? Math.round(d.feePct * 10000) / 100 + '% × ' + money(d.revenue) : 'Enter revenue in the Sheet’s Monthly tab') + '</span>', d.fee !== null ? money(d.fee) : '—') +
        line('<b style="font-size:13px">Cleaning</b><br><span class="small">' + (d.cleaning !== null ? d.cleans + ' × ' + money(d.cleaningRate) + (d.prepaid ? ' − ' + money(d.prepaid) + ' prepaid' : '') : 'Enter cleans in the Monthly tab') + '</span>', d.cleaning !== null ? money(d.cleaning) : '—') + '</div>');
      s.push('<div class="total"><span><b style="font-size:15px">Total due</b>' + (d.fee === null || d.cleaning === null ? '<br><span class="small">so far</span>' : '') + '</span><span class="big">' + money(d.total) + '</span></div>');
      s.push('<div class="refbox"><b style="font-size:13px">On ' + esc(d.owner.label) + '’s card (already paid, for reference)</b>' +
        (d.ownerCard.length ? d.ownerCard.map(function (x) { return line(esc(shortDate(x.date) + ' · ' + x.desc), money(x.amount)); }).join('') : '<div class="small">Nothing this month</div>') + '</div>');
      h.push('<div class="statement">' + s.join('') + '</div>');
      h.push('<div class="stack-lg"><div class="label">Before you send</div>' + d.checks.map(function (c) {
        return '<div class="check"><span class="mark' + (c.ok ? '' : ' warn') + '">' + (c.ok ? ICON.check : ICON.warn) + '</span><span>' + esc(c.text) + '</span></div>';
      }).join('') + '</div>');
      h.push('<p class="small">To make the PDFs: open the Sheet on the laptop, then Mountain Way menu › Build invoices.</p>');
      h.push('<button class="secondary" data-action="reloadMonth">' + (m.loading ? 'Refreshing…' : 'Refresh') + '</button>');
    }
    h.push('</div></main>' + tabs('month'));
    return h.join('');
  }

  function renderStatus() {
    var waiting = S.queue.filter(function (q) { return !q.failed; });
    var failed = S.queue.filter(function (q) { return q.failed; });
    var h = [];
    h.push('<main class="screen"><div class="pad">');
    h.push('<div class="stack"><div class="eyebrow">Status</div><h1>Sync and connection</h1></div>');
    h.push('<div class="card"><span><b>' + (waiting.length ? waiting.length + ' waiting to send' : 'Nothing waiting') + '</b><br><span class="small">' +
      (S.lastSyncAt ? 'Last sent ' + new Date(S.lastSyncAt).toLocaleString() : 'Not sent yet') + '</span></span>' + syncPill() + '</div>');
    if (!S.online) h.push('<div class="note-ok">No signal right now. Keep logging; entries are saved on this phone and will send the next time the app is open with signal.</div>');
    if (S.lastError) h.push('<div class="error" role="alert">' + esc(S.lastError) + '</div>');
    if (failed.length) {
      h.push('<div class="stack-lg"><div class="label">Not accepted by the Sheet</div>');
      failed.forEach(function (q) {
        h.push('<div class="entry failed"><div class="txt"><div class="title">' + esc(q.prop + ' · ' + q.desc) + '</div><div class="meta">' + esc(shortDate(q.date) + ' · reason: ' + q.failed) + '</div>' +
          '<div class="wrap" style="margin-top:6px"><button class="toggle" data-action="retryFailed" data-id="' + esc(q.id) + '">Try again</button><button class="toggle" data-action="discardFailed" data-id="' + esc(q.id) + '">Remove</button></div></div></div>');
      });
      h.push('<p class="small">"unknown_property" usually means the property code was changed in the Sheet. Fix the code there, then Try again.</p></div>');
    }
    h.push('<div class="stack-lg"><div class="label">Connection</div><div class="card"><span><b>' + esc((S.config && S.config.business) || 'Your Sheet') + '</b><br><span class="small">Connected · app ' + APP_VERSION + '</span></span>' +
      '<button class="toggle" data-action="changeConnection">Change</button></div></div>');
    h.push('<p class="small">Fix or remove a sent entry in the Sheet’s Entries tab: correct the cells, or type Void in its Status column.</p>');
    h.push('</div></main>' + tabs('status'));
    return h.join('');
  }

  function render() {
    if (!S.ready) { app.innerHTML = ''; return; }
    var active = document.activeElement;
    var activeField = active && active.getAttribute && active.getAttribute('data-field');
    var selStart = activeField && active.selectionStart;
    var html;
    if (S.screen === 'setup' || !S.conn) html = renderSetup();
    else if (S.screen === 'prop') html = renderProp();
    else if (S.screen === 'form') html = renderForm();
    else if (S.screen === 'month') html = renderMonth();
    else if (S.screen === 'status') html = renderStatus();
    else html = renderHome();
    if (S.toast) html += '<div class="toast" role="status">' + ICON.check + '<span>' + esc(S.toast) + '</span></div>';
    app.innerHTML = html;
    if (activeField) {
      var again = app.querySelector('[data-field="' + activeField + '"]');
      if (again) { again.focus(); try { if (selStart !== null && again.setSelectionRange) again.setSelectionRange(selStart, selStart); } catch (e) { /* date inputs */ } }
    }
  }

  /* ---------------- start ---------------- */
  function start() {
    Promise.all([kvGet('conn'), kvGet('config'), kvGet('lastSyncAt'), loadQueue()]).then(function (r) {
      S.conn = r[0] || null;
      S.config = r[1] || null;
      S.lastSyncAt = r[2] || null;
      var m = /[#&]url=([^&]+)/.exec(location.hash || '');
      if (m) { S.setup.url = decodeURIComponent(m[1]); history.replaceState(null, '', location.pathname); }
      S.screen = S.conn ? 'home' : 'setup';
      S.ready = true;
      render();
      if (S.conn) syncNow();
    }).catch(function (err) {
      app.innerHTML = '<div class="pad"><div class="error">This browser blocked local storage, so offline logging can’t work here. (' + esc(err && err.message) + ')</div></div>';
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }

  window.addEventListener('online', function () { S.online = true; syncNow(); });
  window.addEventListener('offline', function () { S.online = false; render(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && S.conn) syncNow(); });
  setInterval(function () { if (document.visibilityState === 'visible' && S.conn && S.queue.some(function (q) { return !q.failed; })) syncNow(); }, 60000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  // test hook (harmless in production)
  window.__mw = { state: S, syncNow: syncNow, render: render, closeDb: function () { return dbp ? dbp.then(function (d) { d.close(); }) : Promise.resolve(); } };

  start();
})();
