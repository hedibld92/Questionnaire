'use strict';
/*
 * Questionnaire de fin de stage HGE - serveur local autonome, sans dépendance (Node 18+).
 * Sur Vercel, ce fichier n'est pas utilisé : la page est servie depuis public/ et l'API par api/*.js.
 *
 *   GET  /        le questionnaire (public, anonyme)
 *   GET  /admin   les résultats (mot de passe)
 *   /api/*        voir lib/api.js
 */
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { handle, send, getStore, getAuth } = require('./lib/api');

const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000; // 0 = any free port (tests)
const INDEX = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // /admin/ -> /admin, so that the page's relative "api/..." calls resolve to /api/...
    if (req.method === 'GET' && url.pathname.length > 1 && url.pathname.endsWith('/')) {
      return send(res, 301, '', { Location: url.pathname.replace(/\/+$/, '') + url.search });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) return send(res, 200, await fsp.readFile(INDEX));
    return handle(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Erreur du serveur.' });
  }
});

function start() {
  const store = getStore();
  if (store) {
    getAuth().catch(e => console.error('Initialisation impossible :', e.message)); // shows the generated password at startup
    const runBackup = () => store.backup().catch(e => console.error('Sauvegarde impossible :', e.message));
    runBackup();
    setInterval(runBackup, 24 * 3600e3).unref();
  }

  // Clean stop (docker stop, Ctrl+C): stop accepting requests, let pending writes finish, then exit.
  let stopping = false;
  const stop = sig => {
    if (stopping) return; stopping = true;
    console.log(sig + ' reçu, arrêt du serveur…');
    server.close(() => (store ? store.flush() : Promise.resolve()).then(() => process.exit(0)));
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  server.listen(PORT, () => {
    const port = server.address().port, code = (process.env.ACCESS_CODE || '').trim();
    console.log('Stockage      : ' + (!store ? 'AUCUN (VERCEL défini sans base Redis)' : store.kind === 'redis' ? 'Upstash Redis' : 'fichier local'));
    console.log('Questionnaire : http://localhost:' + port + '/' + (code ? '?code=' + encodeURIComponent(code) : ''));
    console.log('Résultats     : http://localhost:' + port + '/admin');
  });
}

start();
