'use strict';
// Storage on the local disk (node server.js, Docker): one JSON document per line in responses.jsonl.
// Rate limiting is kept in memory only; revoked sessions and the signing secret are files next to the data.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = function fileStore({ dir, backupDir, backupKeep }) {
  const FILE = path.join(dir, 'responses.jsonl');
  const REVOKED_FILE = path.join(dir, '.revoked.json');
  const SECRET_FILE = path.join(dir, '.secret');
  fs.mkdirSync(dir, { recursive: true });

  let queue = Promise.resolve();
  const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  async function list() {
    let txt = '';
    try { txt = await fsp.readFile(FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const rows = [];
    for (const line of txt.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch {} }
    return rows;
  }

  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

  const revoked = new Map(); // token nonce -> expiry
  try { for (const [n, exp] of Object.entries(JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8')))) if (exp > Date.now()) revoked.set(n, exp); } catch {}

  return {
    kind: 'file',
    list,
    add: row => serial(() => fsp.appendFile(FILE, JSON.stringify(row) + '\n')),
    remove: id => serial(async () => {
      const rows = await list(), kept = rows.filter(r => r.id !== id);
      if (kept.length === rows.length) return false;
      const tmp = FILE + '.tmp';
      await fsp.writeFile(tmp, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
      await fsp.rename(tmp, FILE);
      return true;
    }),
    async limited(key, max, windowMs) {
      const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < windowMs);
      if (list.length >= max) { hits.set(key, list); return true; }
      list.push(now); hits.set(key, list);
      return false;
    },
    revoke: (nonce, exp) => serial(async () => {
      const now = Date.now();
      revoked.set(nonce, exp);
      for (const [n, e] of revoked) if (e < now) revoked.delete(n);
      await fsp.writeFile(REVOKED_FILE, JSON.stringify(Object.fromEntries(revoked)));
    }),
    async isRevoked(nonce) { return revoked.has(nonce); },
    // The signing secret survives restarts so that an open admin session stays valid.
    async secret() {
      let s = '';
      try { s = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch {}
      if (!s) { s = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); }
      return s;
    },
    // One dated copy per day, the backupKeep most recent are kept.
    backup: () => serial(async () => {
      try { await fsp.access(FILE); } catch { return null; }
      await fsp.mkdir(backupDir, { recursive: true });
      const dest = path.join(backupDir, 'responses-' + new Date().toISOString().slice(0, 10) + '.jsonl');
      await fsp.copyFile(FILE, dest);
      const old = (await fsp.readdir(backupDir)).filter(f => /^responses-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(0, -backupKeep);
      for (const f of old) await fsp.unlink(path.join(backupDir, f)).catch(() => {});
      return dest;
    }),
    flush: () => queue,
  };
};
