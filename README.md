# Questionnaire de fin de stage HGE

Application web du questionnaire de fin de stage du service d'hépato-gastro-entérologie (Louis-Mourier).

- `/` : le questionnaire, public et anonyme (toutes les questions du formulaire papier)
- `/admin` : les résultats, protégés par mot de passe (synthèse, graphiques par question, analyses croisées, verbatims, réponses individuelles, export CSV et JSON)

Aucune dépendance : Node 18 ou plus suffit.

## Lancer en local

```bash
ADMIN_PASSWORD="un-mot-de-passe-solide" node server.js
```

Puis ouvrir http://localhost:3000 (questionnaire) et http://localhost:3000/admin (résultats).

Sans `ADMIN_PASSWORD`, un mot de passe aléatoire est généré et affiché dans la console au démarrage.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_PASSWORD` | mot de passe de l'espace résultats | généré au démarrage |
| `PORT` | port d'écoute | `3000` |
| `DATA_DIR` | dossier des données (`responses.jsonl`) | `./data` |
| `SESSION_SECRET` | secret de signature des sessions admin | généré puis conservé dans `DATA_DIR` |
| `ACCESS_CODE` | code d'accès exigé pour répondre (voir plus bas) | aucun code |
| `BACKUP_DIR` | dossier des sauvegardes quotidiennes | `DATA_DIR/backups` |
| `BACKUP_KEEP` | nombre de sauvegardes quotidiennes conservées | `30` |
| `TRUST_PROXY` | mettre `1` derrière un reverse proxy (lecture de `X-Forwarded-For` pour la limite d'envois) | non défini |

## Mettre en ligne

Il faut un hébergement Node avec un **disque persistant** : VPS, Render (avec un Disk), Railway (avec un Volume), Fly.io (avec un volume), ou un poste du service.

Avec Docker :

```bash
docker build -t fin-de-stage .
docker run -d -p 3000:3000 -e ADMIN_PASSWORD="..." -v fin-de-stage-data:/data fin-de-stage
```

À servir en HTTPS (reverse proxy Caddy, Nginx, ou le HTTPS fourni par l'hébergeur).

Vercel et les plateformes serverless n'ont pas de disque persistant : il faut alors remplacer les trois fonctions de stockage de `server.js` (`readAll`, `addResponse`, `removeResponse`) par des appels à une base (Postgres, KV).

Pour les stagiaires, le plus simple est d'afficher dans le service un QR code qui pointe vers l'adresse du questionnaire.

### Code d'accès (optionnel)

Sans code, toute personne qui connaît l'adresse peut répondre. Avec `ACCESS_CODE="HGE2026"`, le serveur refuse les réponses sans ce code. Le plus pratique est de le mettre dans le lien du QR code : `https://adresse-du-questionnaire/?code=HGE2026`. Le stagiaire n'a rien à saisir, et un champ « Code d'accès » s'affiche seulement s'il arrive sans le code. Le code n'est jamais enregistré avec la réponse. Changer le code (et le QR code) de temps en temps suffit à couper les liens qui auraient circulé.

## Anonymat

- aucun nom, e-mail ni compte n'est demandé
- le serveur n'écrit sur disque ni adresse IP, ni navigateur, ni jour : chaque réponse porte un identifiant aléatoire et le **mois** d'envoi
- les adresses IP ne servent qu'en mémoire vive, à limiter les envois abusifs (60 par heure et par réseau) et les essais de mot de passe (10 par quart d'heure)
- avec de petits effectifs, la combinaison formation + année + mois peut permettre de deviner l'auteur d'une réponse : à garder en tête pour la lecture des verbatims

## Données

Tout est dans `data/responses.jsonl`, une réponse JSON par ligne. Sauvegarder ce fichier suffit.

Le serveur en fait une copie datée au démarrage puis chaque jour (`backups/responses-AAAA-MM-JJ.jsonl`) et garde les 30 dernières. Ces copies sont sur le même disque : elles protègent d'une suppression par erreur, pas d'une panne du disque. Pour cela, faire pointer `BACKUP_DIR` vers un autre disque ou un partage réseau, ou copier régulièrement le dossier ailleurs.

Pour restaurer : arrêter le serveur, remplacer `responses.jsonl` par la sauvegarde choisie, relancer. L'export CSV de l'espace résultats s'ouvre directement dans Excel (séparateur point-virgule, UTF-8).

## Modifier le questionnaire

Les questions sont décrites dans le tableau `SECTIONS` de `src/app.html`. Après modification :

```bash
node build.js   # régénère public/index.html
```

Si des champs sont ajoutés ou renommés, mettre à jour les listes de champs en tête de `server.js` (`YN_FIELDS`, `SAT_FIELDS`, `TEXT_FIELDS`). `node build.js` refuse de générer la page tant que ces listes ne correspondent pas au questionnaire, et indique ce qui manque (sinon, les réponses à un nouveau champ seraient perdues sans erreur). L'image Docker refait cette vérification.

## Tests

```bash
npm test
```

Les tests lancent le vrai serveur sur un dossier temporaire : envoi et validation des réponses, connexion, suppression, déconnexion, code d'accès, sauvegardes, et concordance des champs entre `server.js` et `src/app.html`.

## Sessions admin

Une session dure 12 heures. « Se déconnecter » la ferme aussi côté serveur. Changer `ADMIN_PASSWORD` puis redémarrer ferme toutes les sessions ouvertes.

`src/app.html` est aussi la page publiée comme aperçu sur Claude : là, les réponses sont stockées dans la base de la page et seul son propriétaire peut en enregistrer.
