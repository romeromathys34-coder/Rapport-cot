# Site web COT Sync

Le projet principal est maintenant le site web dans `cot-cftc-clean-app`.

## Objectif

- Ouvrir une adresse web.
- Cliquer sur `Synchroniser`.
- Le site récupère le dernier rapport COT officiel CFTC.
- Chercher un actif dans la barre de recherche.

## Important

Pour ne plus utiliser le CMD, le site doit être publié en ligne avec son serveur.
En local, un serveur doit toujours tourner quelque part, mais une fois publié sur Render ou un autre hébergeur, tu n'as plus besoin de lancer de commande sur ton PC.

## Déploiement

Le fichier `render.yaml` est déjà prêt pour Render.
Le service lance `cot-cftc-clean-app/server.js`, sert le site web, et expose les routes :

- `/` : interface du site
- `/api/reports` : données COT actuelles
- `/api/sync` : synchronisation CFTC
- `/api/health` : vérification du serveur

Après publication, tu utiliseras uniquement l'URL du site.
