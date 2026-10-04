# Questionnaire de fin de stage HGE

Application web du questionnaire de fin de stage du service d'hépato-gastro-entérologie (Louis-Mourier).

- `/` : le questionnaire, public et anonyme (toutes les questions du formulaire papier)
- `/admin` : les résultats, protégés par mot de passe (synthèse, graphiques par question, analyses croisées, verbatims, réponses individuelles, export CSV et JSON)

Aucune dépendance npm : Node 18 ou plus suffit.

## Mettre en ligne sur Vercel

Sur Vercel il n'y a pas de disque permanent : les réponses sont stockées dans une base **Upstash Redis**, ajoutée au projet depuis Vercel (offre gratuite suffisante).

1. **Importer le projet** : sur vercel.com, *Add New… → Project*, choisir le dépôt GitHub `Questionnaire`, puis *Deploy*. Aucun réglage à changer, tout est dans `vercel.json`.
2. **Ajouter la base** : dans le projet, onglet *Storage → Create Database → Upstash for Redis*. Choisir une région **en Europe** (Francfort ou Irlande), puis la connecter au projet. Vercel ajoute seul les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN`.
3. **Variables d'environnement** (*Settings → Environment Variables*) :
   - `ADMIN_PASSWORD` : le mot de passe de l'espace résultats (**obligatoire**)
   - `CRON_SECRET` : une longue chaîne aléatoire, qui protège la sauvegarde quotidienne
   - `ACCESS_CODE` : facultatif, voir plus bas
4. **Redéployer** (*Deployments → … → Redeploy*) : les variables ne s'appliquent qu'aux nouveaux déploiements.
5. **Vérifier** : `https://<votre-projet>.vercel.app/api/health` doit afficher `{"ok":true,...}`. Envoyer un questionnaire de test, le retrouver dans `/admin`, puis le supprimer.

Tant que la base n'est pas connectée, le questionnaire s'affiche mais refuse l'envoi avec un message clair : aucune réponse ne peut être perdue en silence.

Ensuite, chaque push sur `main` redéploie automatiquement.

Les fonctions tournent à Paris (`cdg1`, réglé dans `vercel.json`).

### Comment c'est organisé

| Fichier | Rôle |
|---|---|
| `src/app.html` | la page (questionnaire + espace résultats) |
| `build.js` | génère `public/index.html`, servi tel quel par Vercel |
| `api/*.js` | les fonctions Vercel, qui appellent toutes `lib/api.js` |
| `lib/api.js` | les routes `/api/*` (envoi, connexion, résultats, sauvegarde) |
| `lib/store-redis.js` | stockage Upstash Redis (Vercel) |
| `lib/store-file.js` | stockage dans un fichier (serveur local, Docker) |
| `lib/fields.js` | les champs du questionnaire et leur validation |
| `server.js` | serveur local, inutilisé sur Vercel |

## Lancer en local

```bash
ADMIN_PASSWORD="un-mot-de-passe-solide" node server.js
```

Puis ouvrir http://localhost:3000 (questionnaire) et http://localhost:3000/admin (résultats). Les réponses vont dans `data/responses.jsonl`.

Sans `ADMIN_PASSWORD`, un mot de passe aléatoire est généré et affiché dans la console au démarrage. Si les variables `KV_REST_API_URL` et `KV_REST_API_TOKEN` (ou `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`) sont définies, le serveur local utilise la base Redis à la place du fichier.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_PASSWORD` | mot de passe de l'espace résultats | généré au démarrage (en local seulement) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | base Upstash Redis, ajoutées par Vercel | stockage fichier en local |
| `CRON_SECRET` | protège `/api/cron` (sauvegarde) ; Vercel l'envoie à son cron | aucun |
| `ACCESS_CODE` | code d'accès exigé pour répondre (voir plus bas) | aucun code |
| `SESSION_SECRET` | secret de signature des sessions admin | généré puis conservé (base ou `DATA_DIR`) |
| `BACKUP_KEEP` | nombre de sauvegardes quotidiennes conservées | `30` |
| `PORT` | port d'écoute (serveur local) | `3000` |
| `DATA_DIR` | dossier des données (serveur local) | `./data` |
| `BACKUP_DIR` | dossier des sauvegardes (serveur local) | `DATA_DIR/backups` |
| `TRUST_PROXY` | mettre `1` derrière un reverse proxy (serveur local ; automatique sur Vercel) | non défini |

## Code d'accès (optionnel)

Sans code, toute personne qui connaît l'adresse peut répondre. Avec `ACCESS_CODE="HGE2026"`, le serveur refuse les réponses sans ce code. Le plus pratique est de le mettre dans le lien du QR code affiché dans le service : `https://adresse-du-questionnaire/?code=HGE2026`. Le stagiaire n'a rien à saisir, et un champ « Code d'accès » s'affiche seulement s'il arrive sans le code. Le code n'est jamais enregistré avec la réponse. Changer le code (et le QR code) de temps en temps suffit à couper les liens qui auraient circulé.

## Anonymat

- aucun nom, e-mail ni compte n'est demandé
- une réponse ne porte qu'un identifiant aléatoire et le **mois** d'envoi : ni adresse IP, ni navigateur, ni jour
- pour limiter les envois abusifs (60 par heure et par réseau) et les essais de mot de passe (10 par quart d'heure), l'adresse IP est utilisée sous forme hachée avec un secret, et uniquement le temps de la fenêtre de limitation (une heure au plus)
- avec de petits effectifs, la combinaison formation + année + mois peut permettre de deviner l'auteur d'une réponse : à garder en tête pour la lecture des verbatims

## Sauvegardes et restauration

L'export CSV de l'espace résultats s'ouvre directement dans Excel (séparateur point-virgule, UTF-8). L'export JSON contient toutes les données.

**Sur Vercel** : un cron (`vercel.json`) appelle `/api/cron` chaque nuit, qui copie les réponses dans la base sous `fds:backup:AAAA-MM-JJ`. Chaque copie est gardée 30 jours. Ces copies protègent d'une suppression par erreur, pas de la perte de la base : exporter régulièrement le JSON depuis `/admin` reste conseillé. Pour lister ou restaurer une sauvegarde depuis un poste (Node 20.6 ou plus) :

```bash
npx vercel link                 # une fois, pour relier le dossier au projet
npx vercel env pull .env.local  # récupère les identifiants de la base
node --env-file=.env.local scripts/restore-backup.js              # liste les sauvegardes
node --env-file=.env.local scripts/restore-backup.js 2026-10-04   # restaure ce jour-là
```

Avant de restaurer, les réponses actuelles sont gardées sous la sauvegarde `avant-restauration`.

**En local ou avec Docker** : le serveur copie `data/responses.jsonl` au démarrage puis chaque jour dans `backups/responses-AAAA-MM-JJ.jsonl`, et garde les 30 dernières. Faire pointer `BACKUP_DIR` vers un autre disque pour se protéger d'une panne. Pour restaurer : arrêter le serveur, remplacer `responses.jsonl` par la sauvegarde choisie, relancer.

## Autre hébergement : Docker

Tout hébergement Node avec un disque persistant convient aussi (VPS, Render avec un Disk, Railway avec un Volume, un poste du service) :

```bash
docker build -t fin-de-stage .
docker run -d -p 3000:3000 -e ADMIN_PASSWORD="..." -v fin-de-stage-data:/data fin-de-stage
```

À servir en HTTPS (reverse proxy Caddy, Nginx, ou le HTTPS fourni par l'hébergeur).

## Modifier le questionnaire

Les questions sont décrites dans le tableau `SECTIONS` de `src/app.html`. Après modification :

```bash
node build.js   # régénère public/index.html
```

Si des champs sont ajoutés ou renommés, mettre à jour les listes de `lib/fields.js` (`YN_FIELDS`, `SAT_FIELDS`, `TEXT_FIELDS`). `node build.js` refuse de générer la page tant que ces listes ne correspondent pas au questionnaire, et indique ce qui manque (sinon, les réponses à un nouveau champ seraient perdues sans erreur). Vercel et l'image Docker refont cette vérification à chaque déploiement.

## Tests

```bash
npm test
```

Les tests lancent le vrai serveur deux fois : avec le stockage fichier, et avec le stockage Redis (contre une imitation de l'API Upstash, `test/fake-upstash.js`). Ils couvrent l'envoi et la validation des réponses, la connexion, la limitation des essais, la suppression, la déconnexion, le code d'accès, les sauvegardes et leur restauration, la lecture du corps de requête façon Vercel, et la concordance des champs entre `lib/fields.js` et `src/app.html`. La CI GitHub les lance à chaque push.

## Sessions admin

Une session dure 12 heures. « Se déconnecter » la ferme aussi côté serveur. Changer `ADMIN_PASSWORD` (puis redéployer ou redémarrer) ferme toutes les sessions ouvertes.

`src/app.html` est aussi la page publiée comme aperçu sur Claude : là, les réponses sont stockées dans la base de la page et seul son propriétaire peut en enregistrer.
