'use strict';
// Starts the real server on a temporary data folder and calls its API.
//   npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFields } = require('../build.js');
const { validate } = require('../server.js');

const ROOT = path.join(__dirname, '..');
const children = [], dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-test-')); dirs.push(d); return d; };

async function startServer(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(port), DATA_DIR: tmpDir(), ADMIN_PASSWORD: 'secret', ACCESS_CODE: '', SESSION_SECRET: '', ...env } });
  children.push(child);
  const s = { child, base: 'http://localhost:' + port };
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(s.base + '/api/health')).ok) return s; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('le serveur ne démarre pas');
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

let srv;
before(async () => { srv = await startServer(); });
after(async () => {
  for (const c of children) if (c.exitCode == null && c.signalCode == null) c.kill();
  await new Promise(r => setTimeout(r, 200));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('les champs de server.js correspondent au questionnaire de src/app.html', () => {
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

test('la page est servie sur / et /admin, /admin/ redirige', async () => {
  assert.equal((await fetch(srv.base + '/')).status, 200);
  assert.equal((await fetch(srv.base + '/admin')).status, 200);
  const r = await call(srv, 'GET', '/admin/');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/admin');
});

test('une réponse est enregistrée sans donnée identifiante et lisible par l’admin', async () => {
  assert.equal((await call(srv, 'POST', '/api/responses', OK)).status, 201);
  assert.equal((await call(srv, 'POST', '/api/responses', { ...OK, note: 0 })).status, 400);
  assert.equal((await call(srv, 'GET', '/api/responses')).status, 401);
  const rows = (await call(srv, 'GET', '/api/responses', null, await login(srv))).body.responses;
  assert.equal(rows.length, 1);
  assert.match(rows[0].mois, /^\d{4}-\d{2}$/);
  const { YN_FIELDS, SAT_FIELDS, TEXT_FIELDS } = require('../server.js');
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

test('après un redémarrage : sessions et déconnexions conservées, fermées si le mot de passe change', async () => {
  const dir = tmpDir();
  const a = await startServer({ DATA_DIR: dir });
  const kept = await login(a), closed = await login(a);
  await call(a, 'POST', '/api/logout', null, closed);
  await stopServer(a);
  const b = await startServer({ DATA_DIR: dir });
  assert.equal((await call(b, 'GET', '/api/responses', null, kept)).status, 200, 'la session reste ouverte');
  assert.equal((await call(b, 'GET', '/api/responses', null, closed)).status, 401, 'la déconnexion est conservée');
  await stopServer(b);
  const c = await startServer({ DATA_DIR: dir, ADMIN_PASSWORD: 'nouveau' });
  assert.equal((await call(c, 'GET', '/api/responses', null, kept)).status, 401, 'un nouveau mot de passe ferme les sessions');
  await stopServer(c);
});

test('code d’accès exigé quand ACCESS_CODE est défini, jamais stocké', async () => {
  const s = await startServer({ ACCESS_CODE: 'HGE2026' });
  assert.equal((await call(s, 'GET', '/api/health')).body.code, true);
  assert.equal((await call(s, 'POST', '/api/responses', OK)).status, 403);
  assert.equal((await call(s, 'POST', '/api/responses', { ...OK, code: 'mauvais' })).status, 403);
  assert.equal((await call(s, 'POST', '/api/responses', { ...OK, code: ' HGE2026 ' })).status, 201);
  const rows = (await call(s, 'GET', '/api/responses', null, await login(s))).body.responses;
  assert.equal('code' in rows[0], false);
  await stopServer(s);
});

test('une sauvegarde datée est faite au démarrage, les plus anciennes sont supprimées', async () => {
  const dir = tmpDir(), bak = path.join(dir, 'backups');
  fs.writeFileSync(path.join(dir, 'responses.jsonl'), '{"id":"ab12cd34"}\n');
  fs.mkdirSync(bak);
  for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.writeFileSync(path.join(bak, 'responses-' + d + '.jsonl'), '');
  const s = await startServer({ DATA_DIR: dir, BACKUP_KEEP: '2' });
  const today = 'responses-' + new Date().toISOString().slice(0, 10) + '.jsonl';
  let files = [];
  for (let i = 0; i < 30; i++) { files = fs.readdirSync(bak).sort(); if (files.length === 2 && files.includes(today)) break; await new Promise(r => setTimeout(r, 100)); }
  assert.deepEqual(files, ['responses-2020-01-03.jsonl', today]);
  assert.equal(fs.readFileSync(path.join(bak, today), 'utf8'), '{"id":"ab12cd34"}\n');
  await stopServer(s);
});
