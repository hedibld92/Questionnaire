'use strict';
// Lists or restores the daily backups kept in Upstash Redis (Vercel hosting).
//   vercel env pull .env.local                                          (fetches the Redis credentials)
//   node --env-file=.env.local scripts/restore-backup.js                lists the backups
//   node --env-file=.env.local scripts/restore-backup.js 2026-10-04     restores that day
// Before restoring, the current responses are saved as the backup "avant-restauration".
const redisStore = require('../lib/store-redis');

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
if (!url || !token) { console.error('Identifiants Redis absents : lancez d’abord « vercel env pull .env.local ».'); process.exit(1); }
const store = redisStore({ url, token, backupKeep: Math.max(1, Number(process.env.BACKUP_KEEP) || 30) });

(async () => {
  const date = process.argv[2];
  if (!date) {
    const list = await store.backups();
    console.log(list.length ? 'Sauvegardes disponibles :\n  ' + list.join('\n  ') : 'Aucune sauvegarde pour le moment.');
    return;
  }
  const n = await store.restore(date);
  console.log(n + ' réponse(s) restaurée(s) depuis la sauvegarde ' + date + '.');
})().catch(e => { console.error(e.message); process.exit(1); });
