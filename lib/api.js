'use strict';
/*
 * The /api/* routes, shared by the Vercel functions (api/*.js) and the local server (server.js).
 *
 *   GET    /api/health          { ok, code } (code : un code d'accès est exigé pour répondre)
 *   POST   /api/responses       enregistre une réponse (public, + code d'accès si ACCESS_CODE)
 *   POST   /api/login           { password } -> { token }
 *   POST   /api/logout          révoque le jeton de la session (admin)
 *   GET    /api/responses       toutes les réponses (admin)
 *   DELETE /api/responses/:id   supprime une réponse (admin)
 *   GET    /api/cron            sauvegarde quotidienne (cron Vercel, protégé par CRON_SECRET)
 *
 * Anonymat : ni adresse IP, ni navigateur, ni jour ne sont enregistrés avec une réponse.
 * Une réponse ne porte qu'un identifiant aléatoire et le mois d'envoi.
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { validate } = require('./fields');
const fileStore = require('./store-file');
const redisStore = require('./store-redis');

const env = process.env;
const IS_VERCEL = !!env.VERCEL;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/* ---------- storage: Upstash Redis when configured, else the local disk (never on Vercel) ---------- */
let store; // undefined = not chosen yet, null = no storage available
function getStore() {
  if (store !== undefined) return store;
  const backupKeep = Math.max(1, Number(env.BACKUP_KEEP) || 30);
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL, token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) store = redisStore({ url, token, backupKeep });
  else if (IS_VERCEL) store = null;
  else {
    const dir = env.DATA_DIR || path.join(__dirname, '..', 'data');
    store = fileStore({ dir, backupDir: env.BACKUP_DIR || path.join(dir, 'backups'), backupKeep });
  }
  return store;
}
const NO_STORE = 'Stockage non configuré : ajoutez une base Upstash Redis au projet Vercel (voir le README).';

/* ---------- auth ---------- */
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
let auth = null;
function getAuth() {
  return auth || (auth = (async () => {
    let password = env.ADMIN_PASSWORD || '';
    if (!password && !IS_VERCEL) {
      password = crypto.randomBytes(9).toString('base64url');
      console.log('\n  ADMIN_PASSWORD non défini. Mot de passe admin pour cette session : ' + password + '\n');
    }
    const secret = env.SESSION_SECRET || await getStore().secret();
    // the password is part of the signing key: changing ADMIN_PASSWORD closes every open admin session
    return { password, secret, key: secret + ':' + sha(password).toString('hex') };
  })().catch(e => { auth = null; throw e; }));
}
const sign = (a, payload) => crypto.createHmac('sha256', a.key).update(payload).digest('base64url');
function makeToken(a) { const p = Date.now() + TOKEN_TTL_MS + '.' + crypto.randomBytes(8).toString('hex'); return p + '.' + sign(a, p); }
async function tokenOf(req, a) {
  const m = /^Bearer (\d+)\.([0-9a-f]{16})\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (!m || Number(m[1]) < Date.now()) return null;
  const x = Buffer.from(m[3]), y = Buffer.from(sign(a, m[1] + '.' + m[2]));
  if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return null;
  return (await getStore().isRevoked(m[2])) ? null : { exp: Number(m[1]), nonce: m[2] };
}

/* ---------- rate limiting: the IP is only used hashed, and only for the length of the window ---------- */
function limited(req, a, bucket, max, windowMs) {
  const fwd = (IS_VERCEL || env.TRUST_PROXY === '1') && req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0].trim() : req.socket && req.socket.remoteAddress) || '?';
  return getStore().limited(bucket + ':' + crypto.createHmac('sha256', a.secret).update(ip).digest('base64url').slice(0, 22), max, windowMs);
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
const httpError = (status, msg) => Object.assign(new Error(msg), { status });
function readJson(req, limit = 32 * 1024) {
  // On Vercel the body has already been read and is exposed as req.body.
  if ('body' in req) {
    let b;
    try { b = req.body; } catch { throw httpError(400, 'bad json'); }
    if (Buffer.isBuffer(b)) b = b.toString('utf8');
    if (typeof b === 'string') {
      if (b.length > limit) throw httpError(413, 'too large');
      try { return Promise.resolve(JSON.parse(b || 'null')); } catch { throw httpError(400, 'bad json'); }
    }
    if (JSON.stringify(b ?? null).length > limit) throw httpError(413, 'too large');
    return Promise.resolve(b ?? null);
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(httpError(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { reject(httpError(400, 'bad json')); } });
    req.on('error', reject);
  });
}
const monthNow = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

async function handle(req, res) {
  try {
    const p = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
    const accessCode = (env.ACCESS_CODE || '').trim();

    if (!getStore()) return send(res, 503, { ok: false, error: NO_STORE });
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, code: !!accessCode });
    const a = await getAuth();

    if (p === '/api/responses' && req.method === 'POST') {
      if (await limited(req, a, 'submit', 60, 3600e3)) return send(res, 429, { error: 'Trop d’envois depuis ce réseau, réessayez dans une heure.' });
      const body = await readJson(req);
      if (accessCode && !(body && typeof body.code === 'string' && sameText(body.code.trim(), accessCode))) {
        return send(res, 403, { error: 'Code d’accès incorrect.', code: true });
      }
      const v = validate(body);
      if (v.error) return send(res, 400, { error: v.error });
      await getStore().add({ id: crypto.randomBytes(12).toString('hex'), v: 1, mois: monthNow(), ...v.value });
      return send(res, 201, { ok: true });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (!a.password) return send(res, 503, { error: 'ADMIN_PASSWORD n’est pas configuré sur le serveur.' });
      if (await limited(req, a, 'login', 10, 900e3)) return send(res, 429, { error: 'Trop de tentatives, réessayez dans 15 minutes.' });
      const body = await readJson(req, 2048);
      if (!body || typeof body.password !== 'string' || !sameText(body.password, a.password)) return send(res, 401, { error: 'Mot de passe incorrect.' });
      return send(res, 200, { token: makeToken(a) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = await tokenOf(req, a);
      if (t) await getStore().revoke(t.nonce, t.exp);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/responses' && req.method === 'GET') {
      if (!await tokenOf(req, a)) return send(res, 401, { error: 'Session expirée, reconnectez-vous.' });
      return send(res, 200, { responses: await getStore().list() });
    }
    const del = /^\/api\/responses\/([0-9a-f]{8,64})$/.exec(p);
    if (del && req.method === 'DELETE') {
      if (!await tokenOf(req, a)) return send(res, 401, { error: 'Session expirée, reconnectez-vous.' });
      return (await getStore().remove(del[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Réponse introuvable.' });
    }
    if (p === '/api/cron' && req.method === 'GET') {
      // Vercel sends "Authorization: Bearer <CRON_SECRET>" to its cron jobs when CRON_SECRET is set.
      if (env.CRON_SECRET && !sameText(req.headers.authorization || '', 'Bearer ' + env.CRON_SECRET)) return send(res, 401, { error: 'Non autorisé.' });
      return send(res, 200, { ok: true, backup: await getStore().backup() });
    }
    return send(res, 404, { error: 'Introuvable.' });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status === 413 ? 'Réponse trop volumineuse.' : e.status === 400 ? 'Requête invalide.' : 'Erreur du serveur.' });
  }
}

module.exports = { handle, send, getStore, getAuth };
