'use strict';
// Storage in Upstash Redis through its REST API (used on Vercel, where there is no persistent disk).
// No dependency: plain fetch calls. Keys:
//   fds:responses          hash  id -> response JSON
//   fds:secret             string, the session signing secret
//   fds:revoked:<nonce>    closed admin sessions, expire with the token
//   fds:rl:<bucket>:<ip>   rate limit counters (the IP is hashed), expire with the window
//   fds:backup:<date>      daily copies of fds:responses, kept backupKeep days
const crypto = require('node:crypto');

module.exports = function redisStore({ url, token, backupKeep, prefix = 'fds:' }) {
  const base = url.replace(/\/+$/, '');
  async function post(p, body) {
    const r = await fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error('Redis : ' + ((j && j.error) || 'HTTP ' + r.status));
    return j;
  }
  const cmd = async (...args) => { const j = await post('', args); if (j.error) throw new Error('Redis : ' + j.error); return j.result; };
  const pipe = async cmds => (await post('/pipeline', cmds)).map(x => { if (x.error) throw new Error('Redis : ' + x.error); return x.result; });

  const RESPONSES = prefix + 'responses', SECRET = prefix + 'secret';
  const backupKey = date => prefix + 'backup:' + date;
  const parseRows = flat => {
    const rows = [];
    for (let i = 1; i < (flat || []).length; i += 2) { try { rows.push(JSON.parse(flat[i])); } catch {} }
    return rows.sort((a, b) => String(a.mois || '').localeCompare(String(b.mois || '')));
  };

  return {
    kind: 'redis',
    list: async () => parseRows(await cmd('HGETALL', RESPONSES)),
    add: row => cmd('HSET', RESPONSES, row.id, JSON.stringify(row)),
    remove: async id => (await cmd('HDEL', RESPONSES, id)) === 1,
    async limited(key, max, windowMs) {
      const k = prefix + 'rl:' + key;
      const [, n] = await pipe([['SET', k, '0', 'PX', String(windowMs), 'NX'], ['INCR', k]]);
      return n > max;
    },
    revoke: (nonce, exp) => cmd('SET', prefix + 'revoked:' + nonce, '1', 'PX', String(Math.max(1000, exp - Date.now()))),
    isRevoked: async nonce => (await cmd('EXISTS', prefix + 'revoked:' + nonce)) === 1,
    async secret() {
      await cmd('SET', SECRET, crypto.randomBytes(32).toString('hex'), 'NX');
      return cmd('GET', SECRET);
    },
    async backup() {
      const flat = await cmd('HGETALL', RESPONSES);
      if (!flat || !flat.length) return null;
      const key = backupKey(new Date().toISOString().slice(0, 10));
      await pipe([['DEL', key], ['HSET', key, ...flat], ['PEXPIRE', key, String(backupKeep * 86400e3)]]);
      return key;
    },
    async backups() {
      const keys = []; let cursor = '0';
      do { const [next, found] = await cmd('SCAN', cursor, 'MATCH', prefix + 'backup:*', 'COUNT', '200'); cursor = String(next); keys.push(...found); } while (cursor !== '0');
      return keys.map(k => k.slice((prefix + 'backup:').length)).sort();
    },
    // Replaces every response by those of a backup; the current responses are first saved as backup "avant-restauration".
    async restore(date) {
      const flat = await cmd('HGETALL', backupKey(date));
      if (!flat || !flat.length) throw new Error('Sauvegarde introuvable ou vide : ' + date);
      const current = await cmd('HGETALL', RESPONSES);
      const safe = backupKey('avant-restauration');
      await pipe([
        ['DEL', safe], ...(current && current.length ? [['HSET', safe, ...current], ['PEXPIRE', safe, String(backupKeep * 86400e3)]] : []),
        ['DEL', RESPONSES], ['HSET', RESPONSES, ...flat],
      ]);
      return flat.length / 2;
    },
    flush: async () => {},
  };
};
