'use strict';
/*
 * Questionnaire de fin de stage HGE - serveur autonome, sans dépendance (Node 18+).
 *
 *   GET    /                    le questionnaire (public, anonyme)
 *   GET    /admin               les résultats (mot de passe)
 *   GET    /api/health          { ok, code } (code : un code d'accès est exigé pour répondre)
 *   POST   /api/responses       enregistre une réponse (public, + code d'accès si ACCESS_CODE)
 *   POST   /api/login           { password } -> { token }
 *   POST   /api/logout          révoque le jeton de la session (admin)
 *   GET    /api/responses       toutes les réponses (admin)
 *   DELETE /api/responses/:id   supprime une réponse (admin)
 *
 * Anonymat : ni adresse IP, ni navigateur, ni jour ne sont écrits sur disque.
 * Une réponse ne porte qu'un identifiant aléatoire et le mois d'envoi.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'responses.jsonl');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 30);
const REVOKED_FILE = path.join(DATA_DIR, '.revoked.json');
const INDEX = path.join(__dirname, 'public', 'index.html');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
let SECRET = process.env.SESSION_SECRET;
let SIGN_KEY = null; // SECRET + password: changing ADMIN_PASSWORD closes every open admin session

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    console.log('\n  ADMIN_PASSWORD non défini. Mot de passe admin pour cette session : ' + ADMIN_PASSWORD + '\n');
  }
  // The signing secret survives restarts so that an open admin session stays valid.
  if (!SECRET) {
    const secretFile = path.join(DATA_DIR, '.secret');
    try { SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch {}
    if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, SECRET, { mode: 0o600 }); }
  }
  SIGN_KEY = SECRET + ':' + sha(ADMIN_PASSWORD).toString('hex');
  try { for (const [n, exp] of Object.entries(JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8')))) if (exp > Date.now()) revoked.set(n, exp); } catch {}
}

/* ---------- questionnaire fields (checked against src/app.html by build.js and the tests) ---------- */
const YN_FIELDS = ['accueil', 'info_etablissement', 'info_fonctionnement', 'info_specificite', 'info_soins', 'info_outils', 'info_equipe', 'info_planning', 'info_badge', 'tuteur', 'objectifs', 'bilan', 'objectifs_atteints', 'difficultes'];
const SAT_FIELDS = ['acquis_base', 'acquis_techniques', 'acquis_relationnels', 'acquis_educatifs'];
const TEXT_FIELDS = ['accueil_par_qui', 'objectifs_presentes', 'bilan_par_qui', 'competences', 'objectifs_pourquoi', 'difficultes_lesquelles', 'suggestions', 'plus_apprecie', 'moins_apprecie'];
const PRESENCE = ['cadre', 'tuteur', 'equipe', 'etudiant'];

const cleanText = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '';

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Format invalide.' };
  const out = {};
  out.formation = cleanText(body.formation, 80);
  out.annee = cleanText(body.annee, 40);
  const note = Number(body.note);
  if (!out.formation) return { error: 'La formation est obligatoire.' };
  if (!out.annee) return { error: 'L’année d’étude est obligatoire.' };
  if (!Number.isInteger(note) || note < 1 || note > 10) return { error: 'La note globale doit être comprise entre 1 et 10.' };
  out.note = note;
  for (const f of YN_FIELDS) out[f] = body[f] === 'oui' || body[f] === 'non' ? body[f] : null;
  for (const f of SAT_FIELDS) out[f] = ['tres', 'sat', 'peu'].includes(body[f]) ? body[f] : null;
  for (const f of TEXT_FIELDS) { const t = cleanText(body[f], 1500); if (t) out[f] = t; }
  out.eval_presence = Array.isArray(body.eval_presence) ? PRESENCE.filter(p => body.eval_presence.includes(p)) : [];
  return { value: out };
}

/* ---------- storage: one JSON document per line ---------- */
// To host on a platform without a persistent disk, replace these three functions with calls to a database.
let queue = Promise.resolve();
const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

async function readAll() {
  let txt = '';
  try { txt = await fsp.readFile(FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const rows = [];
  for (const line of txt.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch {} }
  return rows;
}
const addResponse = row => serial(() => fsp.appendFile(FILE, JSON.stringify(row) + '\n'));
const removeResponse = id => serial(async () => {
  const rows = await readAll(), kept = rows.filter(r => r.id !== id);
  if (kept.length === rows.length) return false;
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  await fsp.rename(tmp, FILE);
  return true;
});

/* ---------- backups: one copy per day, the BACKUP_KEEP most recent are kept ---------- */
const backup = () => serial(async () => {
  try { await fsp.access(FILE); } catch { return null; }
  await fsp.mkdir(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, 'responses-' + new Date().toISOString().slice(0, 10) + '.jsonl');
  await fsp.copyFile(FILE, dest);
  const old = (await fsp.readdir(BACKUP_DIR)).filter(f => /^responses-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(0, -BACKUP_KEEP);
  for (const f of old) await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
  return dest;
});

/* ---------- auth ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = payload => crypto.createHmac('sha256', SIGN_KEY).update(payload).digest('base64url');
const makeToken = () => { const p = Date.now() + TOKEN_TTL_MS + '.' + crypto.randomBytes(8).toString('hex'); return p + '.' + sign(p); };
const revoked = new Map(); // token nonce -> expiry, so that "Se déconnecter" really closes the session
function tokenOf(req) {
  const m = /^Bearer (\d+)\.([0-9a-f]{16})\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (!m || Number(m[1]) < Date.now() || revoked.has(m[2])) return null;
  const a = Buffer.from(m[3]), b = Buffer.from(sign(m[1] + '.' + m[2]));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { exp: Number(m[1]), nonce: m[2] } : null;
}
const revoke = t => serial(async () => {
  const now = Date.now();
  revoked.set(t.nonce, t.exp);
  for (const [n, exp] of revoked) if (exp < now) revoked.delete(n);
  await fsp.writeFile(REVOKED_FILE, JSON.stringify(Object.fromEntries(revoked)));
});

/* ---------- rate limiting (in memory only, nothing is written to disk) ---------- */
const hits = new Map();
function limited(req, bucket, max, windowMs) {
  const fwd = TRUST_PROXY && req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : req.socket.remoteAddress) || '?';
  const key = bucket + '|' + ip, now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now); hits.set(key, list);
  return false;
}

/* ---------- http ---------- */
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = json ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SECURITY, 'Content-Type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const monthNow = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // /admin/ -> /admin, so that the page's relative "api/..." calls resolve to /api/...
    if (req.method === 'GET' && url.pathname.length > 1 && url.pathname.endsWith('/')) {
      return send(res, 301, '', { Location: url.pathname.replace(/\/+$/, '') + url.search });
    }
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/admin')) {
      return send(res, 200, await fsp.readFile(INDEX));
    }
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, code: !!ACCESS_CODE });

    if (p === '/api/responses' && req.method === 'POST') {
      if (limited(req, 'submit', 60, 3600e3)) return send(res, 429, { error: 'Trop d’envois depuis ce réseau, réessayez dans une heure.' });
      const body = await readJson(req);
      if (ACCESS_CODE && !(body && typeof body.code === 'string' && sameText(body.code.trim(), ACCESS_CODE))) {
        return send(res, 403, { error: 'Code d’accès incorrect.', code: true });
      }
      const v = validate(body);
      if (v.error) return send(res, 400, { error: v.error });
      await addResponse({ id: crypto.randomBytes(12).toString('hex'), v: 1, mois: monthNow(), ...v.value });
      return send(res, 201, { ok: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (limited(req, 'login', 10, 900e3)) return send(res, 429, { error: 'Trop de tentatives, réessayez dans 15 minutes.' });
      const body = await readJson(req, 2048);
      if (!body || typeof body.password !== 'string' || !sameText(body.password, ADMIN_PASSWORD)) return send(res, 401, { error: 'Mot de passe incorrect.' });
      return send(res, 200, { token: makeToken() });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = tokenOf(req);
      if (t) await revoke(t);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/responses' && req.method === 'GET') {
      if (!tokenOf(req)) return send(res, 401, { error: 'Session expirée, reconnectez-vous.' });
      return send(res, 200, { responses: await readAll() });
    }
    const del = /^\/api\/responses\/([0-9a-f]{8,64})$/.exec(p);
    if (del && req.method === 'DELETE') {
      if (!tokenOf(req)) return send(res, 401, { error: 'Session expirée, reconnectez-vous.' });
      return (await removeResponse(del[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Réponse introuvable.' });
    }
    return send(res, 404, { error: 'Introuvable.' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? 'Réponse trop volumineuse.' : e.status === 400 ? 'Requête invalide.' : 'Erreur du serveur.' });
  }
});

function start() {
  init();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
  const runBackup = () => backup().catch(e => console.error('Sauvegarde impossible :', e.message));
  runBackup();
  setInterval(runBackup, 24 * 3600e3).unref();

  // Clean stop (docker stop, Ctrl+C): stop accepting requests, let pending writes finish, then exit.
  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true;
    console.log(sig + ' reçu, arrêt du serveur…');
    server.close(() => queue.then(() => process.exit(0)));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  server.listen(PORT, () => {
    console.log('Questionnaire : http://localhost:' + PORT + '/' + (ACCESS_CODE ? '?code=' + encodeURIComponent(ACCESS_CODE) : ''));
    console.log('Résultats     : http://localhost:' + PORT + '/admin');
  });
}

if (require.main === module) start();
module.exports = { YN_FIELDS, SAT_FIELDS, TEXT_FIELDS, PRESENCE, validate };
