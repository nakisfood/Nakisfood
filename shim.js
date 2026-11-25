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

  function doc(path) {
    return {
      id: path.split('/').pop(),
      async get() { const r = await req('GET', '/api/doc?path=' + P(path)); return snap(path.split('/').pop(), r.exists ? r.data : undefined); },
      async set(data) { await req('PUT', '/api/doc?path=' + P(path), data); },
      async delete() { await req('DELETE', '/api/doc?path=' + P(path)); },
    };
  }
  function collection(path) {
    return {
      async get() { const r = await req('GET', '/api/col?path=' + P(path)); const docs = r.docs.map(d => snap(d.id, d.data)); return { docs, size: docs.length, empty: !docs.length }; },
      doc: id => doc(path + '/' + id),
      onSnapshot(cb, onErr) { // diğer kullanıcıların değişiklikleri: birkaç saniyede bir sorulur
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
