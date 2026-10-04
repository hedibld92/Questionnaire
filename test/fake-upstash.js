'use strict';
// A small in-memory imitation of the Upstash Redis REST API, limited to the commands used by lib/store-redis.js.
const http = require('node:http');

function startFakeUpstash(token = 'test-token') {
  const data = new Map(); // key -> { v: string | Map, exp: ms timestamp | 0 }
  const live = k => { const e = data.get(k); if (e && e.exp && e.exp <= Date.now()) { data.delete(k); return null; } return e || null; };
  const hash = k => { const e = live(k); if (!e) { const n = { v: new Map(), exp: 0 }; data.set(k, n); return n.v; } return e.v; };

  function run([name, ...a]) {
    switch (String(name).toUpperCase()) {
      case 'HSET': { const h = hash(a[0]); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], String(a[i + 1])); } return n; }
      case 'HGETALL': { const e = live(a[0]); return e ? [...e.v].flat() : []; }
      case 'HDEL': { const e = live(a[0]); if (!e) return 0; let n = 0; for (const f of a.slice(1)) if (e.v.delete(f)) n++; return n; }
      case 'SET': {
        const opts = a.slice(2).map(String); const up = opts.map(o => o.toUpperCase());
        if (up.includes('NX') && live(a[0])) return null;
        let exp = 0;
        const px = up.indexOf('PX'), ex = up.indexOf('EX');
        if (px >= 0) exp = Date.now() + Number(opts[px + 1]);
        if (ex >= 0) exp = Date.now() + Number(opts[ex + 1]) * 1000;
        data.set(a[0], { v: String(a[1]), exp });
        return 'OK';
      }
      case 'GET': { const e = live(a[0]); return e ? e.v : null; }
      case 'INCR': { const e = live(a[0]); const n = (e ? Number(e.v) : 0) + 1; data.set(a[0], { v: String(n), exp: e ? e.exp : 0 }); return n; }
      case 'EXISTS': return a.filter(k => live(k)).length;
      case 'DEL': { let n = 0; for (const k of a) if (live(k)) { data.delete(k); n++; } return n; }
      case 'PEXPIRE': { const e = live(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]); return 1; }
      case 'SCAN': {
        const m = a.map(String), i = m.findIndex(x => x.toUpperCase() === 'MATCH');
        const re = new RegExp('^' + (i >= 0 ? m[i + 1] : '*').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        return ['0', [...data.keys()].filter(k => live(k) && re.test(k))];
      }
      default: throw new Error('ERR unknown command ' + name);
    }
  }
  const safe = c => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const reply = (s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.headers.authorization !== 'Bearer ' + token) return reply(401, { error: 'Unauthorized' });
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return reply(400, { error: 'bad json' }); }
      if (req.url === '/pipeline') return reply(200, body.map(safe));
      const r = safe(body);
      reply(r.error ? 400 : 200, r);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port, token, data,
    close: () => new Promise(r => server.close(r)),
  })));
}

module.exports = { startFakeUpstash };
