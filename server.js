// NakisPanel – Railway sunucusu (Node + PostgreSQL + kalıcı volume)
'use strict';
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const findFile = (sub, name) => { const a = path.join(__dirname, sub, name); return fs.existsSync(a) ? a : path.join(__dirname, name); };
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const IMG_DIR = path.join(DATA_DIR, 'img');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const SECRET = process.env.SESSION_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL eksik'); process.exit(1); }
if (SECRET.length < 16) { console.error('SESSION_SECRET en az 16 karakter olmalı'); process.exit(1); }
[IMG_DIR, ASSET_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=require/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

async function initDb() {
  await pool.query(`
    CREATE SEQUENCE IF NOT EXISTS docs_rev;
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY,
      parent TEXT NOT NULL,
      data TEXT NOT NULL,
      rev BIGINT NOT NULL DEFAULT nextval('docs_rev'),
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS docs_parent_idx ON docs(parent);
    CREATE INDEX IF NOT EXISTS docs_parent_rev_idx ON docs(parent, rev);
    CREATE TABLE IF NOT EXISTS assets (
      aid TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      size BIGINT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
}

/* ---------- yardımcılar ---------- */
const SEG = /^[A-Za-z0-9_\-.:@+~]+$/;
function cleanPath(p) {
  const parts = String(p || '').split('/');
  if (!parts.length || parts.some(s => !SEG.test(s))) return null;
  return parts.join('/');
}
const parentOf = p => p.split('/').slice(0, -1).join('/');
const uKey = u => String(u || '').trim().toLocaleLowerCase('tr');
function pwHash(u, pw) { // programdaki ile birebir aynı
  let h1 = 0x811c9dc5, h2 = 0x1b873593; const s = 'nakis|' + uKey(u) + '|' + pw;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; h2 = (h2 << 13 | h2 >>> 19) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(u, ro) { const body = Buffer.from(JSON.stringify({ u, ro: !!ro, x: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url'); return body + '.' + sign(body); }
function readToken(t) {
  if (!t || typeof t !== 'string') return null; const [b, s] = t.split('.');
  if (!b || !s) return null; const exp = sign(b);
  if (s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.x > Date.now() ? o : null; } catch (e) { return null; }
}
function cookies(req) { const o = {}; String(req.headers.cookie || '').split(';').forEach(c => { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); }); return o; }
const secure = () => process.env.NODE_ENV === 'production';
function setSession(res, tok) { res.setHeader('Set-Cookie', `np_s=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure() ? '; Secure' : ''}`); }

/* kullanıcı listesi: programın kendi verisinden (kv/nakis_kullanicilar_v1) */
async function loadUsers() {
  const m = await pool.query('SELECT data FROM docs WHERE path=$1', ['kv/nakis_kullanicilar_v1']);
  if (!m.rows.length) return [];
  const meta = JSON.parse(m.rows[0].data); if (meta.nul) return [];
  let raw = '';
  if (meta.mode === 'items') {
    const q = await pool.query("SELECT data FROM docs WHERE parent LIKE 'kv/nakis_kullanicilar_v1/b%'");
    raw = '[' + q.rows.map(r => JSON.parse(r.data).j).join(',') + ']';
  } else {
    const q = await pool.query("SELECT path, data FROM docs WHERE parent='kv/nakis_kullanicilar_v1/c'");
    const parts = []; q.rows.forEach(r => { parts[Number(r.path.split('/').pop())] = JSON.parse(r.data).s || ''; });
    raw = parts.join('');
  }
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

/* ürün resimleri: base64 yerine volume'daki dosya */
const IMG_RE = /data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]{3000,})/g;
function extractImages(j) {
  if (typeof j !== 'string' || j.indexOf('data:image/') < 0) return j;
  return j.replace(IMG_RE, (all, ext, b64) => {
    const buf = Buffer.from(b64, 'base64'); const e = ext === 'jpeg' ? 'jpg' : ext;
    const name = crypto.createHash('sha1').update(buf).digest('hex') + '.' + e; const fp = path.join(IMG_DIR, name);
    if (!fs.existsSync(fp)) { fs.writeFileSync(fp + '.tmp', buf); fs.renameSync(fp + '.tmp', fp); }
    return '/img/' + name;
  });
}

async function putDoc(client, p, data, user) {
  if (data && typeof data.j === 'string') data = Object.assign({}, data, { j: extractImages(data.j) });
  await client.query(`INSERT INTO docs(path,parent,data,updated_by) VALUES($1,$2,$3,$4)
    ON CONFLICT(path) DO UPDATE SET data=EXCLUDED.data, rev=nextval('docs_rev'), updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [p, parentOf(p), JSON.stringify(data), user || null]);
  return data;
}

/* ---------- uygulama ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.get('/health', async (req, res) => { try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false }); } });

/* giriş */
app.get('/login', (req, res) => res.type('html').send(LOGIN_HTML));
app.post('/login', express.json({ limit: '10kb' }), async (req, res) => {
  const un = String(req.body && req.body.u || ''), pw = String(req.body && req.body.p || '');
  try {
    let ok = null;
    if (ADMIN_PASSWORD && uKey(un) === 'admin' && pw === ADMIN_PASSWORD) ok = { u: 'admin', ro: false };
    if (!ok) {
      const users = await loadUsers(); const u = users.find(x => uKey(x.u) === uKey(un));
      if (u && (u.h === pwHash(u.u, pw) || (u.np && uKey(u.u) === 'admin' && !pw))) ok = { u: u.u, ro: !!u.ro };
    }
    if (!ok) { await new Promise(r => setTimeout(r, 600)); return res.status(401).json({ ok: false }); }
    setSession(res, makeToken(ok.u, ok.ro)); res.json({ ok: true, u: uKey(ok.u) });
  } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});
app.get('/logout', (req, res) => { res.setHeader('Set-Cookie', `np_s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? '; Secure' : ''}`); res.redirect('/login'); });

/* buradan sonrası giriş ister */
app.use((req, res, next) => {
  const s = readToken(cookies(req).np_s);
  if (!s) { if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(401).json({ code: 'unauthenticated' }); return res.redirect('/login'); }
  req.user = s; next();
});
const canWrite = (req, res) => { if (req.user.ro) { res.status(403).json({ code: 'permission_denied' }); return false; } return true; };

// sürüm: index.html + shim.js içeriğinden; aynı kod yeniden başlarsa değişmez
const APP_VER = (() => { try { const h = crypto.createHash('sha1'); ['index.html', 'shim.js'].forEach(f => h.update(fs.readFileSync(findFile('public', f)))); return h.digest('hex').slice(0, 12); } catch (e) { return String(Date.now()); } })();
const APP_AT = new Date().toISOString();
app.get('/api/version', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ v: APP_VER, at: APP_AT }); });
app.get('/api/me', (req, res) => res.json({ u: req.user.u, ro: req.user.ro }));

app.get('/api/col', async (req, res) => {
  const p = cleanPath(req.query.path); if (!p) return res.status(400).json({ code: 'invalid_argument' });
  const q = await pool.query('SELECT path, data FROM docs WHERE parent=$1', [p]);
  res.json({ docs: q.rows.map(r => ({ id: r.path.split('/').pop(), data: JSON.parse(r.data) })) });
});
app.get('/api/changes', async (req, res) => { // onSnapshot yerine: belirli bir koleksiyonda değişenler
  const p = cleanPath(req.query.path); if (!p) return res.status(400).json({ code: 'invalid_argument' });
  const since = Number(req.query.since || 0);
  if (!since) { const r = await pool.query('SELECT COALESCE(MAX(rev),0)::text AS m FROM docs'); return res.json({ rev: Number(r.rows[0].m), docs: [] }); }
  const q = await pool.query('SELECT path, data, rev::text AS rev FROM docs WHERE parent=$1 AND rev>$2 ORDER BY rev', [p, since]);
  const r = await pool.query('SELECT COALESCE(MAX(rev),0)::text AS m FROM docs');
  res.json({ rev: Number(r.rows[0].m), docs: q.rows.map(x => ({ id: x.path.split('/').pop(), data: JSON.parse(x.data) })) });
});
app.get('/api/dump', async (req, res) => { // açılışta tüm veriyi tek seferde (resimler dosyada olduğu için küçük)
  const q = await pool.query("SELECT path, data FROM docs WHERE path LIKE 'kv/%'");
  res.json({ docs: q.rows.map(r => [r.path, JSON.parse(r.data)]) });
});
app.post('/api/batch', express.json({ limit: '60mb' }), async (req, res) => { // çok sayıda kayıt tek istekte
  if (!canWrite(req, res)) return;
  const ops = req.body && req.body.ops; if (!Array.isArray(ops) || ops.length > 2000) return res.status(400).json({ code: 'invalid_argument' });
  for (const o of ops) { o.path = cleanPath(o.path); if (!o.path || (o.op === 'set' && (!o.data || typeof o.data !== 'object'))) return res.status(400).json({ code: 'invalid_argument' }); }
  const client = await pool.connect();
  try { await client.query('BEGIN');
    for (const o of ops) { if (o.op === 'del') await client.query('DELETE FROM docs WHERE path=$1', [o.path]); else await putDoc(client, o.path, o.data, req.user.u); }
    await client.query('COMMIT'); res.json({ ok: true, n: ops.length });
  } catch (e) { await client.query('ROLLBACK').catch(() => { }); console.error(e); res.status(500).json({ code: 'unavailable' }); }
  finally { client.release(); }
});
app.get('/api/doc', async (req, res) => {
  const p = cleanPath(req.query.path); if (!p) return res.status(400).json({ code: 'invalid_argument' });
  const q = await pool.query('SELECT data FROM docs WHERE path=$1', [p]);
  res.json(q.rows.length ? { exists: true, data: JSON.parse(q.rows[0].data) } : { exists: false });
});
app.put('/api/doc', express.json({ limit: '30mb' }), async (req, res) => {
  if (!canWrite(req, res)) return;
  const p = cleanPath(req.query.path); if (!p || !req.body || typeof req.body !== 'object') return res.status(400).json({ code: 'invalid_argument' });
  try { await putDoc(pool, p, req.body, req.user.u); res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ code: 'unavailable' }); }
});
app.delete('/api/doc', async (req, res) => {
  if (!canWrite(req, res)) return;
  const p = cleanPath(req.query.path); if (!p) return res.status(400).json({ code: 'invalid_argument' });
  await pool.query('DELETE FROM docs WHERE path=$1', [p]); res.json({ ok: true });
});

/* afiş / PDF dosyaları (volume) */
const ASSET_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'video/mp4', 'video/webm'];
const MAX_ASSET = Number(process.env.MAX_UPLOAD_MB || 50) * 1048576;
async function saveAsset(req, res, aid) {
  if (!canWrite(req, res)) return;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!ASSET_TYPES.includes(type)) return res.status(415).json({ code: 'unsupported_type' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ code: 'invalid_argument' });
  const fp = path.join(ASSET_DIR, aid); fs.writeFileSync(fp + '.tmp', req.body); fs.renameSync(fp + '.tmp', fp);
  await pool.query(`INSERT INTO assets(aid,type,size,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(aid) DO UPDATE SET type=EXCLUDED.type, size=EXCLUDED.size`, [aid, type, req.body.length, req.user.u]);
  res.json({ id: aid, contentType: type, sizeBytes: req.body.length });
}
const rawBody = express.raw({ type: () => true, limit: MAX_ASSET });
app.post('/api/assets', rawBody, (req, res) => saveAsset(req, res, crypto.randomUUID()));
app.put('/api/assets/:aid', rawBody, (req, res) => { const a = String(req.params.aid); if (!SEG.test(a)) return res.status(400).json({ code: 'invalid_argument' }); saveAsset(req, res, a); });
app.delete('/api/assets/:aid', async (req, res) => {
  if (!canWrite(req, res)) return; const a = String(req.params.aid); if (!SEG.test(a)) return res.status(400).end();
  await pool.query('DELETE FROM assets WHERE aid=$1', [a]); try { fs.unlinkSync(path.join(ASSET_DIR, a)); } catch (e) { }
  res.json({ ok: true });
});
app.get('/_blob/:aid', async (req, res) => {
  const a = String(req.params.aid); if (!SEG.test(a)) return res.status(400).end();
  const q = await pool.query('SELECT type FROM assets WHERE aid=$1', [a]); const fp = path.join(ASSET_DIR, a);
  if (!q.rows.length || !fs.existsSync(fp)) return res.status(404).end();
  res.setHeader('Content-Type', q.rows[0].type); res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); res.sendFile(fp);
});
app.use('/img', express.static(IMG_DIR, { maxAge: '365d', immutable: true, fallthrough: false }));

/* Claude'dan alınan tam yedeği içe aktarma (sadece admin) */
const VALID_KEY = /^nakis_[A-Za-z0-9_]+$/;
function enc(s) { return String(s).replace(/[^A-Za-z0-9_\-.:@+]/g, c => '~' + c.charCodeAt(0).toString(16).padStart(4, '0')); }
function bk(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 8; }
function itemsOf(raw) {
  try { const v = JSON.parse(raw); if (!Array.isArray(v) || !v.length) return null;
    if (!v.every(o => o && typeof o === 'object' && !Array.isArray(o) && (typeof o.id === 'string' || typeof o.id === 'number') && String(o.id))) return null;
    if (new Set(v.map(o => String(o.id))).size !== v.length) return null;
    const js = v.map(o => JSON.stringify(o)); if (js.some(j => j.length > 90000 * 4)) return null; return v.map((o, i) => [String(o.id), js[i]]); } catch (e) { return null; }
}
async function writeKey(client, key, raw, user) {
  const did = enc(key), base = 'kv/' + did;
  await client.query("DELETE FROM docs WHERE path=$1 OR parent LIKE $2", [base, base + '/%']);
  const v = Date.now(); const it = raw == null ? null : itemsOf(raw);
  if (it) {
    for (const [id, j] of it) await putDoc(client, `${base}/b${bk(id)}/${enc(id)}`, { id_: id, j }, user);
    await putDoc(client, base, { key, mode: 'items', order: it.map(a => a[0]), v, by: 'import', u: user }, user); return;
  }
  const s = raw == null ? '' : raw, parts = []; for (let i = 0; i < s.length; i += 90000) parts.push(s.slice(i, i + 90000)); if (!parts.length) parts.push('');
  for (let i = 0; i < parts.length; i++) await putDoc(client, `${base}/c/${i}`, { s: parts[i] }, user);
  await putDoc(client, base, { key, mode: 'blob', n: parts.length, nul: raw == null, v, by: 'import', u: user }, user);
}
app.get('/import', (req, res) => { if (uKey(req.user.u) !== 'admin') return res.status(403).send('Sadece admin / Nur Admin'); res.type('html').send(IMPORT_HTML); });
app.post('/api/import', express.json({ limit: '300mb' }), async (req, res) => {
  if (uKey(req.user.u) !== 'admin') return res.status(403).json({ code: 'permission_denied' });
  const keys = req.body && req.body.keys; if (!keys || typeof keys !== 'object') return res.status(400).json({ code: 'invalid_argument' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); let n = 0;
    for (const [k, raw] of Object.entries(keys)) { if (!VALID_KEY.test(k)) continue; await writeKey(client, k, raw == null ? null : String(raw), req.user.u); n++; }
    await client.query('COMMIT'); res.json({ ok: true, keys: n });
  } catch (e) { await client.query('ROLLBACK').catch(() => { }); console.error(e); res.status(500).json({ code: 'unavailable', message: e.message }); }
  finally { client.release(); }
});

/* program */
// dosyalar alt klasörde (public/, views/) ya da hepsi ana klasörde olabilir
app.get(['/', '/index.html'], (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(findFile('public', 'index.html')); });
app.get('/shim.js', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('application/javascript').sendFile(findFile('public', 'shim.js')); });

const LOGIN_HTML = fs.readFileSync(findFile('views', 'login.html'), 'utf8');
const IMPORT_HTML = fs.readFileSync(findFile('views', 'import.html'), 'utf8');

initDb().then(() => app.listen(PORT, () => console.log(`NakisPanel :${PORT} · veri klasörü ${DATA_DIR}`)))
  .catch(e => { console.error('DB başlatılamadı', e); process.exit(1); });
