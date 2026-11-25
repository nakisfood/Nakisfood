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
      const u = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = u; a.download = filename || 'download'; a.setAttribute('data-np-native', '1'); a.style.display = 'none';
      document.body.appendChild(a); HTMLAnchorElement.prototype.__npRawClick ? HTMLAnchorElement.prototype.__npRawClick.call(a) : a.dispatchEvent(new MouseEvent('click'));
      setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 4000);
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

/* Sürüm: yeni sürüm yayına girince üstte uyarı + sağ altta sürüm saati */
(function () {
  'use strict';
  const de = () => { try { return (window.LANG || localStorage.getItem('np_lang') || document.documentElement.lang) === 'de'; } catch (e) { return false; } };
  let cur = null, shown = false;
  const fmt = iso => { try { return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  function badge(at) {
    let b = document.getElementById('npVer');
    if (!b) { b = document.createElement('div'); b.id = 'npVer'; b.style.cssText = 'position:fixed;right:8px;bottom:6px;z-index:30;font:11px system-ui,sans-serif;color:#8a94a3;background:rgba(255,255,255,.85);padding:2px 7px;border-radius:6px;pointer-events:none'; document.body.appendChild(b); }
    b.textContent = (de() ? 'Version: ' : 'Sürüm: ') + fmt(at);
  }
  function banner() {
    if (shown) return; shown = true;
    const d = document.createElement('div'); d.id = 'npNewVer';
    d.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483001;background:#1f6feb;color:#fff;font:600 14px system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center';
    d.innerHTML = '<span>🔄 ' + (de() ? 'Neue Version ist bereit' : 'Yeni sürüm hazır') + '</span><button style="background:#fff;color:#1f6feb;border:0;border-radius:7px;padding:6px 12px;font-weight:700;cursor:pointer">' + (de() ? 'Neu laden' : 'Yenile') + '</button><button title="x" style="background:transparent;color:#fff;border:0;font-size:16px;cursor:pointer">✕</button>';
    const [ok, x] = d.querySelectorAll('button');
    ok.onclick = async () => { try { if (window.npSyncState) { for (let i = 0; i < 40 && (window.npSyncState().dirty.length || window.npSyncState().pushing); i++) await new Promise(r => setTimeout(r, 250)); } } catch (e) { } location.reload(); };
    x.onclick = () => d.remove();
    document.body.appendChild(d);
  }
  async function check() {
    try {
      const r = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) return;
      const j = await r.json();
      if (cur == null) { cur = j.v; badge(j.at); } else if (j.v !== cur) banner();
    } catch (e) { }
  }
  const start = () => { check(); setInterval(() => { if (!document.hidden) check(); }, 30000); document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
