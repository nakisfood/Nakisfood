/* NakisPanel · Railway köprüsü
   Program Claude'da çalışırken kullandığı window.claude.use('db' | 'assets' | 'downloads')
   arayüzünü burada kendi sunucumuza (PostgreSQL + volume) bağlarız. Programın geri kalanı değişmez. */
(function () {
  'use strict';
  const err = (code, message) => { const e = new Error(message || code); e.code = code; return e; };
  async function req(method, url, body, headers) {
    let r;
    try { r = await fetch(url, { method, credentials: 'same-origin', headers: headers || (body !== undefined ? { 'Content-Type': 'application/json' } : {}), body: body === undefined ? undefined : (headers ? body : JSON.stringify(body)) }); }
    catch (e) { throw err('unavailable', 'Sunucuya ulaşılamadı / Server nicht erreichbar'); }
    if (r.status === 401) { location.href = '/login'; throw err('unauthenticated'); }
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!r.ok) {
      const code = (j && j.code) || (r.status === 403 ? 'permission_denied' : r.status === 413 ? 'too_large' : r.status === 415 ? 'unsupported_type' : r.status >= 500 ? 'unavailable' : 'invalid_argument');
      throw err(code, (j && j.message) || code);
    }
    return j;
  }
  const P = p => encodeURIComponent(p);
  const snap = (id, data) => ({ id, exists: data !== undefined, data: () => data });

  /* Hız 1: açılışta tüm veri tek istekte gelir; ilk yükleme bitene kadar okumalar buradan yapılır */
  let cache = null, cacheP = null;
  const kids = new Map();
  function loadDump() {
    if (!cacheP) cacheP = req('GET', '/api/dump').then(r => { cache = new Map(r.docs);
      r.docs.forEach(([p]) => { const par = p.split('/').slice(0, -1).join('/'); if (!kids.has(par)) kids.set(par, []); kids.get(par).push(p); });
      return cache; }).catch(() => { cache = null; return null; });
    return cacheP;
  }
  const dropCache = () => { cache = null; kids.clear(); cacheP = Promise.resolve(null); };

  /* Hız 2: yazmalar biriktirilip tek istekte gönderilir */
  let queue = [], qTimer = null;
  function enqueue(op) { return new Promise((res, rej) => { queue.push(Object.assign(op, { res, rej })); if (cache) dropCache();
      const big = queue.length >= 400; clearTimeout(qTimer); qTimer = setTimeout(flushQ, big ? 0 : 30); }); }
  async function flushQ() {
    const all = queue; queue = [];
    while (all.length) { const part = []; let size = 0;
      while (all.length && part.length < 400 && size < 8e6) { const o = all.shift(); part.push(o); size += o.data ? JSON.stringify(o.data).length : 50; }
      try { await req('POST', '/api/batch', { ops: part.map(o => ({ op: o.op, path: o.path, data: o.data })) }); part.forEach(o => o.res()); }
      catch (e) { part.forEach(o => o.rej(e)); } }
  }

  function doc(path) {
    return {
      id: path.split('/').pop(),
      async get() {
        if (cache) return snap(path.split('/').pop(), cache.get(path));
        const r = await req('GET', '/api/doc?path=' + P(path)); return snap(path.split('/').pop(), r.exists ? r.data : undefined); },
      set(data) { return enqueue({ op: 'set', path, data }); },
      delete() { return enqueue({ op: 'del', path }); },
    };
  }
  function collection(path) {
    return {
      async get() {
        if (path === 'kv' && !cacheP) await loadDump();
        if (cache) { const docs = (kids.get(path) || []).map(p => snap(p.split('/').pop(), cache.get(p))); return { docs, size: docs.length, empty: !docs.length }; }
        const r = await req('GET', '/api/col?path=' + P(path)); const docs = r.docs.map(d => snap(d.id, d.data)); return { docs, size: docs.length, empty: !docs.length }; },
      doc: id => doc(path + '/' + id),
      onSnapshot(cb, onErr) { // diğer kullanıcıların değişiklikleri: birkaç saniyede bir sorulur
        dropCache(); // ilk yükleme bitti: bundan sonra her okuma sunucudan
        let since = 0, stop = false, t = null;
        const tick = async () => {
          if (stop) return;
          try {
            const r = await req('GET', '/api/changes?path=' + P(path) + '&since=' + since);
            if (since && r.docs.length) cb({ docChanges: () => r.docs.map(d => ({ type: 'modified', doc: snap(d.id, d.data) })), docs: [] });
            since = r.rev || since;
          } catch (e) { if (onErr && e.code !== 'unavailable') onErr(e); }
          t = setTimeout(tick, document.hidden ? 15000 : 4000);
        };
        tick(); return () => { stop = true; clearTimeout(t); };
      },
    };
  }
  const db = { collection, doc };

  const assets = {
    async upload(file, opt) {
      const type = (opt && opt.type) || file.type || 'application/octet-stream';
      return req('POST', '/api/assets', file, { 'Content-Type': type });
    },
    async delete(aid) { await req('DELETE', '/api/assets/' + encodeURIComponent(aid)); },
  };

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data == null ? '' : data], { type: 'application/octet-stream' });
      // 1) Chrome / Edge: «Farklı kaydet» penceresi (nereye kaydedileceğini sorar)
      if (window.showSaveFilePicker) {
        try {
          const h = await window.showSaveFilePicker({ suggestedName: filename || 'download' });
          const w = await h.createWritable(); await w.write(blob); await w.close();
          return { status: 'saved' };
        } catch (e) { if (e && e.name === 'AbortError') throw err('declined'); /* izin yoksa normal indirmeye geç */ }
      }
      // 2) normal indirme
      const u = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = u; a.download = filename || 'download'; a.setAttribute('data-np-native', '1'); a.style.display = 'none';
      document.body.appendChild(a); (HTMLAnchorElement.prototype.__npRawClick || HTMLAnchorElement.prototype.click).call(a);
      setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 60000);
      return { status: 'saved' };
    },
  };

  // Programın link.click() yakalamasından önce gerçek click'i sakla
  HTMLAnchorElement.prototype.__npRawClick = HTMLAnchorElement.prototype.click;

  const NS = { db, assets, downloads };
  window.claude = { use: async name => { if (NS[name]) return NS[name]; throw err('unsupported', name); } };
  window.NP_RAILWAY = true;

  // Çıkış: sunucu oturumunu da kapat
  let tries = 0; const hook = setInterval(() => {
    if (typeof window.logout === 'function' && !window.logout.__np) {
      const f = () => { try { sessionStorage.removeItem('nakis_oturum_v1'); } catch (e) { } location.href = '/logout'; }; f.__np = true; window.logout = f; clearInterval(hook);
    } else if (++tries > 600) clearInterval(hook);
  }, 500);
})();

/* Sürüm: her güncellemede sorar ve ne değiştiğini kısa notla gösterir; sağ altta sürüm saati */
(function () {
  'use strict';
  const de = () => { try { return (window.LANG || localStorage.getItem('np_lang') || document.documentElement.lang) === 'de'; } catch (e) { return false; } };
  const SEEN = 'np_seen_ver', SEEN_ID = 'np_seen_note';
  const lsG = k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, lsS = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let cur = null, open = false, later = 0;
  const fmt = iso => { try { return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  function badge(at) {
    let b = document.getElementById('npVer');
    if (!b) { b = document.createElement('div'); b.id = 'npVer'; b.style.cssText = 'position:fixed;right:8px;bottom:6px;z-index:30;font:11px system-ui,sans-serif;color:#8a94a3;background:rgba(255,255,255,.85);padding:2px 7px;border-radius:6px;pointer-events:none'; document.body.appendChild(b); }
    b.textContent = (de() ? 'Version: ' : 'Sürüm: ') + fmt(at);
    const adm = () => { try { return typeof me !== 'undefined' && !!me && String(me.u || '').trim().toLowerCase() === 'admin'; } catch (e) { return false; } };
    const vis = () => { b.style.display = adm() ? '' : 'none'; }; vis(); if (!b.__t) b.__t = setInterval(vis, 1000);
  }
  const newNotes = notes => { const s = lsG(SEEN_ID) || ''; const n = (notes || []).filter(x => x && x.id && (!s || String(x.id) > s)); return n.length ? n.slice(0, 6) : (s ? [] : (notes || []).slice(0, 1)); };
  function card(title, notes, btns) {
    if (open) return; open = true;
    const d = document.createElement('div'); d.id = 'npNewVer';
    d.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483001;background:#fff;color:#1d2733;font:14px system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.28);border-top:4px solid #1f6feb;width:min(520px,92vw)';
    const L = de() ? 'de' : 'tr';
    d.innerHTML = `<div style="font-weight:700;font-size:15px;margin-bottom:6px">${title}</div>`
      + (notes.length ? `<ul style="margin:4px 0 10px 18px;padding:0;color:#374151">${notes.map(n => `<li style="margin:3px 0">${esc(n[L] || n.tr)} <span style="color:#9aa3ae;font-size:11px">${esc(n.id)}</span></li>`).join('')}</ul>` : '')
      + `<div style="display:flex;gap:8px;justify-content:flex-end">${btns.map((b, i) => `<button data-i="${i}" style="border:0;border-radius:8px;padding:7px 14px;font-weight:700;cursor:pointer;${b.main ? 'background:#1f6feb;color:#fff' : 'background:#eef2f7;color:#1d2733'}">${esc(b.t)}</button>`).join('')}</div>`;
    d.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; const f = btns[+b.dataset.i].f; d.remove(); open = false; f && f(); });
    document.body.appendChild(d);
  }
  async function waitSaved() { try { if (window.npSyncState) for (let i = 0; i < 40 && (window.npSyncState().dirty.length || window.npSyncState().pushing); i++) await new Promise(r => setTimeout(r, 250)); } catch (e) { } }
  function markSeen(j) { lsS(SEEN, j.v); if (j.notes && j.notes[0]) lsS(SEEN_ID, String(j.notes[0].id)); }
  async function check() {
    try {
      const r = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) return;
      const j = await r.json();
      if (cur == null) { // sayfa açılışı
        cur = j.v; badge(j.at);
        if (lsG(SEEN) !== j.v) { const n = newNotes(j.notes);
          if (lsG(SEEN) == null && !n.length) { markSeen(j); return; }
          card('✅ ' + (de() ? 'Programm wurde aktualisiert' : 'Program güncellendi'), n, [{ t: de() ? 'OK' : 'Tamam', main: true, f: () => markSeen(j) }]); }
        return;
      }
      if (j.v !== cur && Date.now() > later) card('🔄 ' + (de() ? 'Neue Version ist bereit – jetzt neu laden?' : 'Yeni sürüm hazır – şimdi yenilensin mi?'), newNotes(j.notes),
        [{ t: de() ? 'Später (10 Min.)' : 'Sonra (10 dk)', f: () => { later = Date.now() + 600000; } },
         { t: de() ? 'Neu laden' : 'Yenile', main: true, f: async () => { markSeen(j); await waitSaved(); location.reload(); } }]);
    } catch (e) { }
  }
  const start = () => { check(); setInterval(() => { if (!document.hidden && !open) check(); }, 30000); document.addEventListener('visibilitychange', () => { if (!document.hidden && !open) check(); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();


/* Hata göstergesi: bir işlem hata verirse ekranın altında kısa bir kırmızı not çıkar (sessizce bozulmasın) */
(function () {
  let last = '', t = null;
  function show(msg) {
    msg = String(msg || '').slice(0, 220); if (!msg || msg === last) return; last = msg;
    let d = document.getElementById('npErr');
    if (!d) { d = document.createElement('div'); d.id = 'npErr'; d.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:2147483003;background:#c62828;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:9px;box-shadow:0 8px 20px rgba(0,0,0,.25);max-width:90vw;cursor:pointer'; d.onclick = () => { d.remove(); last = ''; }; document.body.appendChild(d); }
    d.textContent = '⚠ ' + msg; clearTimeout(t); t = setTimeout(() => { d.remove(); last = ''; }, 12000);
  }
  const ok = m => m && !/ResizeObserver|Script error|NpDialogPending|unauthenticated|declined/i.test(m);
  window.addEventListener('error', e => { const m = e && (e.message || (e.error && e.error.message)); if (ok(m)) show(m); });
  window.addEventListener('unhandledrejection', e => { const r = e && e.reason, m = r && (r.message || r.code || String(r)); if (ok(m)) show(m); });
})();
