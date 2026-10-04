'use strict';
// Starts the real server and calls its API, once with the local file storage and once with
// Upstash Redis (the Vercel storage), imitated by test/fake-upstash.js.
//   npm test
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFields } = require('../build.js');
const { validate, YN_FIELDS, SAT_FIELDS, TEXT_FIELDS } = require('../lib/fields');
const { startFakeUpstash } = require('./fake-upstash');

const ROOT = path.join(__dirname, '..');
const children = [], dirs = [], fakes = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-test-')); dirs.push(d); return d; };
const today = () => new Date().toISOString().slice(0, 10);

const CLEAN_ENV = { ACCESS_CODE: '', SESSION_SECRET: '', CRON_SECRET: '', VERCEL: '', TRUST_PROXY: '', BACKUP_DIR: '', BACKUP_KEEP: '',
  UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', KV_REST_API_URL: '', KV_REST_API_TOKEN: '' };

// The server picks a free port (PORT=0) and prints it: "Questionnaire : http://localhost:<port>/".
function startServer(env = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...CLEAN_ENV, PORT: '0', DATA_DIR: tmpDir(), ADMIN_PASSWORD: 'secret', ...env } });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('le serveur ne démarre pas :\n' + out)), 10000);
    child.stderr.on('data', d => { out += d; });
    child.stdout.on('data', d => {
      out += d;
      const m = /Questionnaire : http:\/\/localhost:(\d+)\//.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, base: 'http://127.0.0.1:' + m[1] }); }
    });
    child.once('exit', c => { clearTimeout(timer); reject(new Error('le serveur s’est arrêté (' + c + ') :\n' + out)); });
  });
}
async function stopServer(s) {
  if (s.child.exitCode != null || s.child.signalCode != null) return;
  const done = new Promise(r => s.child.once('exit', r));
  s.child.kill('SIGTERM');
  await done;
}
async function call(s, method, p, body, token) {
  const r = await fetch(s.base + p, { method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body == null ? undefined : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json, headers: r.headers };
}
const login = async s => (await call(s, 'POST', '/api/login', { password: 'secret' })).body.token;
const OK = { formation: 'Infirmier(e) (IFSI)', annee: '2e année', note: 8, accueil: 'oui', eval_presence: ['tuteur', 'pirate'] };

after(async () => {
  for (const c of children) if (c.exitCode == null && c.signalCode == null) c.kill();
  for (const f of fakes) await f.close();
  await new Promise(r => setTimeout(r, 200));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('les champs de lib/fields.js correspondent au questionnaire de src/app.html', () => {
  assert.deepEqual(checkFields(), []);
});

test('validate garde les champs connus et rejette les réponses incomplètes', () => {
  assert.equal(validate({ ...OK, note: 11 }).error, 'La note globale doit être comprise entre 1 et 10.');
  assert.match(validate({ ...OK, formation: '  ' }).error, /formation/);
  const v = validate({ ...OK, tuteur: 'peut-être', suggestions: '  merci\u0007 ', inconnu: 'x' }).value;
  assert.equal(v.tuteur, null);
  assert.equal(v.suggestions, 'merci');
  assert.deepEqual(v.eval_presence, ['tuteur']);
  assert.equal('inconnu' in v, false);
});

test('chaque fonction Vercel de api/ exporte le gestionnaire commun', () => {
  const { handle } = require('../lib/api');
  for (const f of ['health', 'login', 'logout', 'responses', 'cron', 'responses/[id]']) assert.equal(require('../api/' + f), handle, f);
});

test('sur Vercel sans base Redis, l’API le signale au lieu de perdre les réponses', async () => {
  const s = await startServer({ VERCEL: '1' });
  const h = await call(s, 'GET', '/api/health');
  assert.equal(h.status, 503);
  assert.match(h.body.error, /Upstash Redis/);
  assert.equal((await call(s, 'POST', '/api/responses', OK)).status, 503);
  await stopServer(s);
});

for (const mode of ['fichier', 'redis']) describe('stockage ' + mode, () => {
  // in redis mode every server gets its own fake Upstash, unless one is given (restart test)
  const start = async (env = {}, fake) => {
    if (mode === 'redis') {
      if (!fake) { fake = await startFakeUpstash(); fakes.push(fake); }
      env = { UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, ...env };
    }
    return Object.assign(await startServer(env), { fake });
  };
  let srv;
  before(async () => { srv = await start(); });

  test('/admin/ redirige vers /admin', async () => {
    assert.equal((await fetch(srv.base + '/')).status, 200);
    const r = await call(srv, 'GET', '/admin/');
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/admin');
  });

  test('une réponse est enregistrée sans donnée identifiante et lisible par l’admin', async () => {
    assert.equal((await call(srv, 'GET', '/api/health')).body.ok, true);
    assert.equal((await call(srv, 'POST', '/api/responses', OK)).status, 201);
    assert.equal((await call(srv, 'POST', '/api/responses', { ...OK, note: 0 })).status, 400);
    assert.equal((await call(srv, 'GET', '/api/responses')).status, 401);
    const rows = (await call(srv, 'GET', '/api/responses', null, await login(srv))).body.responses;
    assert.equal(rows.length, 1);
    assert.match(rows[0].mois, /^\d{4}-\d{2}$/);
    const allowed = ['id', 'v', 'mois', 'formation', 'annee', 'note', 'eval_presence', ...YN_FIELDS, ...SAT_FIELDS, ...TEXT_FIELDS];
    assert.deepEqual(Object.keys(rows[0]).filter(k => !allowed.includes(k)), [], 'aucun champ en dehors du questionnaire');
  });

  test('connexion, suppression et déconnexion', async () => {
    assert.equal((await call(srv, 'POST', '/api/login', { password: 'faux' })).status, 401);
    const token = await login(srv);
    await call(srv, 'POST', '/api/responses', OK);
    const rows = (await call(srv, 'GET', '/api/responses', null, token)).body.responses;
    const id = rows[rows.length - 1].id;
    assert.equal((await call(srv, 'DELETE', '/api/responses/' + id, null, token)).status, 200);
    assert.equal((await call(srv, 'DELETE', '/api/responses/' + id, null, token)).status, 404);
    assert.equal((await call(srv, 'POST', '/api/logout', null, token)).status, 200);
    assert.equal((await call(srv, 'GET', '/api/responses', null, token)).status, 401, 'le jeton doit être révoqué');
  });

  test('trop d’essais de mot de passe sont bloqués', async () => {
    const s = await start();
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await call(s, 'POST', '/api/login', { password: 'faux' })).status);
    assert.deepEqual(codes, [...Array(10).fill(401), 429]);
    await stopServer(s);
  });

  test('après un redémarrage : sessions et déconnexions conservées, fermées si le mot de passe change', async () => {
    const dir = tmpDir();
    const a = await start({ DATA_DIR: dir });
    const kept = await login(a), closed = await login(a);
    await call(a, 'POST', '/api/logout', null, closed);
    await stopServer(a);
    const b = await start({ DATA_DIR: dir }, a.fake);
    assert.equal((await call(b, 'GET', '/api/responses', null, kept)).status, 200, 'la session reste ouverte');
    assert.equal((await call(b, 'GET', '/api/responses', null, closed)).status, 401, 'la déconnexion est conservée');
    await stopServer(b);
    const c = await start({ DATA_DIR: dir, ADMIN_PASSWORD: 'nouveau' }, a.fake);
    assert.equal((await call(c, 'GET', '/api/responses', null, kept)).status, 401, 'un nouveau mot de passe ferme les sessions');
    await stopServer(c);
  });

  test('code d’accès exigé quand ACCESS_CODE est défini, jamais stocké', async () => {
    const s = await start({ ACCESS_CODE: 'HGE2026' });
    assert.equal((await call(s, 'GET', '/api/health')).body.code, true);
    assert.equal((await call(s, 'POST', '/api/responses', OK)).status, 403);
    assert.equal((await call(s, 'POST', '/api/responses', { ...OK, code: 'mauvais' })).status, 403);
    assert.equal((await call(s, 'POST', '/api/responses', { ...OK, code: ' HGE2026 ' })).status, 201);
    const rows = (await call(s, 'GET', '/api/responses', null, await login(s))).body.responses;
    assert.equal('code' in rows[0], false);
    await stopServer(s);
  });

  test('la sauvegarde quotidienne (/api/cron) copie les réponses', async () => {
    const s = await start({ CRON_SECRET: 'cron-secret', BACKUP_KEEP: '2' });
    await call(s, 'POST', '/api/responses', OK);
    assert.equal((await call(s, 'GET', '/api/cron')).status, 401, 'sans le secret du cron');
    const r = await call(s, 'GET', '/api/cron', null, 'cron-secret');
    assert.equal(r.status, 200);
    assert.ok(r.body.backup);
    if (mode === 'redis') assert.equal(s.fake.data.get('fds:backup:' + today()).v.size, 1);
    else assert.equal(fs.readFileSync(r.body.backup, 'utf8').trim().split('\n').length, 1);
    await stopServer(s);
  });

  if (mode === 'fichier') test('une sauvegarde est faite au démarrage, les plus anciennes sont supprimées', async () => {
    const dir = tmpDir(), bak = path.join(dir, 'backups');
    fs.writeFileSync(path.join(dir, 'responses.jsonl'), '{"id":"ab12cd34"}\n');
    fs.mkdirSync(bak);
    for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.writeFileSync(path.join(bak, 'responses-' + d + '.jsonl'), '');
    const s = await start({ DATA_DIR: dir, BACKUP_KEEP: '2' });
    const name = 'responses-' + today() + '.jsonl';
    let files = [];
    for (let i = 0; i < 30; i++) { files = fs.readdirSync(bak).sort(); if (files.length === 2 && files.includes(name)) break; await new Promise(r => setTimeout(r, 100)); }
    assert.deepEqual(files, ['responses-2020-01-03.jsonl', name]);
    await stopServer(s);
  });

  if (mode === 'redis') test('restauration d’une sauvegarde Redis', async () => {
    const fake = await startFakeUpstash(); fakes.push(fake);
    const store = require('../lib/store-redis')({ url: fake.url, token: fake.token, backupKeep: 30 });
    await store.add({ id: 'aaaa1111', mois: '2026-01' });
    await store.backup();
    await store.add({ id: 'bbbb2222', mois: '2026-02' });
    assert.deepEqual(await store.backups(), [today()]);
    assert.equal(await store.restore(today()), 1);
    assert.deepEqual((await store.list()).map(r => r.id), ['aaaa1111']);
    assert.equal(fake.data.get('fds:backup:avant-restauration').v.size, 2, 'l’état d’avant est gardé');
  });
});

test('corps de requête déjà lu par Vercel (req.body)', async () => {
  const fake = await startFakeUpstash(); fakes.push(fake);
  Object.assign(process.env, CLEAN_ENV, { UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: fake.token, ADMIN_PASSWORD: 'secret' });
  const { handle } = require('../lib/api');
  const invoke = (method, url, body) => new Promise(resolve => {
    const req = { method, url, headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} };
    Object.defineProperty(req, 'body', { get() { if (body instanceof Error) throw body; return body; } });
    const res = { headersSent: false, writeHead(s) { this.status = s; this.headersSent = true; }, end(d) { resolve({ status: this.status, body: JSON.parse(d) }); } };
    handle(req, res);
  });
  assert.equal((await invoke('POST', '/api/responses', OK)).status, 201, 'objet déjà analysé');
  assert.equal((await invoke('POST', '/api/responses', JSON.stringify(OK))).status, 201, 'texte brut');
  assert.equal((await invoke('POST', '/api/responses', new Error('Invalid JSON'))).status, 400, 'JSON invalide');
  assert.equal((await invoke('POST', '/api/login', { password: 'secret' })).status, 200);
  assert.equal(fake.data.get('fds:responses').v.size, 2);
});
