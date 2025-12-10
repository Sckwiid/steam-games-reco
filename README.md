## Steam Scout — recommandations Steam 70% pertinence / 30% découverte

Frontend 100% statique (GitHub Pages) + micro-proxy Cloudflare Worker (Steam API, DeepSeek R1 via OpenRouter, rate limit, queue). Dataset Steam chargé côté client (mock fourni).

### Arborescence
```
public/
  index.html
  history.html
  indie.html
  assets/
    styles.css
    app.js
    recommender.js
    steamClient.js
    ui.js
    storage.js
    supabaseClient.js
    workerClient.js
    utils.js
    config.example.js
  data/
    games.mock.json
  workers/
    scoringWorker.js (optionnel)
worker/
  src/index.js
  wrangler.toml
```

### Frontend (GitHub Pages)
- Pages : `index.html` (flux principal + filtre chips + budget + bouton "Me surprendre"), `history.html` (localStorage + Supabase optionnel), `indie.html` (sélection indé plus permissive).
- Modules clés :
  - `recommender.js` : algo client (heures + achievements top N + tags/genres + budget + découverte contrôlée).
  - `steamClient.js` : appel Worker pour Steam owned games + achievements (Top N).
  - `workerClient.js` : proxy Worker (Steam, LLM, rate limit, queue).
  - `storage.js` : cache 24h profil/reco + historique local + fingerprint.
  - `supabaseClient.js` : envoi facultatif dans tables `recommendations` et `feedback`.
- Dataset : place un `public/data/games.min.json` (ou `.json.gz`) structuré `{ appid, name, price, tags[], genres[], categories[], review_ratio (0-1), total_reviews }`. Fallback mock : `games.mock.json`.
- Config optionnelle : copie `assets/config.example.js` en `assets/config.js` et renseigne `__WORKER_BASE` + Supabase si besoin. Ajoute le script après les autres dans tes pages si tu le crées.
- Dev local : `npx serve public` ou `python -m http.server 4173` depuis `public/`.
- Déploiement GH Pages : pousse le dossier `public` (ou branche `gh-pages`) et configure Pages pour servir la racine `/public`.

### Cloudflare Worker
- Endpoints :
  - `GET /api/steam/owned?steamid=...`
  - `GET /api/steam/achievements?steamid=...&appid=...`
  - `POST /api/llm/explain` (DeepSeek R1 via OpenRouter, fallback free -> paid, cache court)
  - `GET /api/queue` (compteur approx pour le loader)
  - `POST /api/ratelimit/check` (3 req/h/user best-effort)
- CORS : `ALLOWED_ORIGIN` (GitHub Pages) + `DEV_ORIGIN` facultatif.
- Env nécessaires : `STEAM_API_KEY`, `OPENROUTER_API_KEY`, `ALLOWED_ORIGIN`, optionnel `DEV_ORIGIN`.
- Déploiement :
  1) Installer Wrangler : `npm install -g wrangler`
  2) `cd worker`
  3) `wrangler login`
  4) `wrangler secret put STEAM_API_KEY` puis `wrangler secret put OPENROUTER_API_KEY`
  5) Ajuster `wrangler.toml` (nom, ALLOWED_ORIGIN, compat date si besoin)
  6) `wrangler deploy`
- Notes :
  - Rate limit best-effort in-memory (3 requêtes/h par userId + IP).
  - Cache LLM TTL court (15 min) avec hash du prompt.
  - Queue = estimation légère pour l’UI loader.

### Supabase (optionnel)
- Crée les tables :
  - `recommendations` : `id uuid default uuid_generate_v4()`, `user_id text`, `steamid text`, `appid_primary int`, `appid_alt1 int`, `appid_alt2 int`, `score_primary int`, `score_alt1 int`, `score_alt2 int`, `filters_json jsonb`, `created_at timestamptz default now()`
  - `feedback` : `id uuid default uuid_generate_v4()`, `user_id text`, `recommendation_id uuid`, `appid int`, `value int`, `created_at timestamptz default now()`
- Policies : autoriser insert pour clé `anon` si besoin.
- Renseigne `window.__SUPABASE` dans `assets/config.js`.

### Règles produit implémentées (MVP)
- Pertinence 70% (tags/genres/categories pondérés par playtime + boost achievements >=70%).
- Découverte 30% max (bonus nouveauté contrôlé, plus haut sur "Me surprendre").
- Filtres chips (FPS, F2P, Coop, Horror, Rogue-lite, Indé, Aventure, RPG, Simulator), modes (online/local/solo), budget (gratuit/<10/<20 + slider max).
- Qualité : exclut jeux <50% avis positifs si `total_reviews >= 10`. Les indés peu évalués restent visibles.
- Achievements : récup seulement Top N jeux les plus joués (config dans `app.js`), boost si ratio >=70%.
- Compatibilité 0-100% via normalisation des meilleurs candidats.
- Historique : localStorage + feedback like/dislike + envoi Supabase facultatif.
- Loader file d’attente : `GET /api/queue`.

### À faire ensuite
- Brancher un vrai dataset compressé `.json.gz` et tester la décompression native (ou ajouter pako).
- Relier un scoring Web Worker si le dataset devient lourd.
- Ajouter des tests UI légers ou un mock Steam pour le dev offline.
