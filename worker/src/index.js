const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1h
const RATE_LIMIT_MAX = 500;
const QUEUE_WINDOW_MS = 30 * 1000;
const LLM_CACHE_TTL_MS = 15 * 60 * 1000;

// In-memory, best-effort stores (per isolate).
const rateLimitStore = new Map();
const queueTimestamps = [];
const llmCache = new Map();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), request, env);
  }

  if (!isAllowedOrigin(request, env)) {
    return withCors(new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403 }), request, env);
  }

  // Track queue for a soft loader.
  queueTimestamps.push(Date.now());
  pruneQueue();

  try {
    if (url.pathname === '/api/queue' && request.method === 'GET') {
      return withCors(jsonResponse({ waiting: estimateQueue() }), request, env);
    }

    if (url.pathname === '/api/ratelimit/check' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const userId = (body.userId || '').toString();
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limited = checkRateLimit(userId, ip, { consume: false });
      return withCors(jsonResponse({ limited, remaining: Math.max(0, RATE_LIMIT_MAX - getRequestCount(userId, ip)) }), request, env);
    }

    if (url.pathname === '/api/steam/owned' && request.method === 'GET') {
      const steamid = url.searchParams.get('steamid');
      if (!steamid) {
        return withCors(jsonResponse({ error: 'Missing steamid' }, 400), request, env);
      }
      const owned = await fetchOwnedGames(steamid, env);
      return withCors(jsonResponse({ data: owned }), request, env);
    }

    if (url.pathname === '/api/steam/achievements' && request.method === 'GET') {
      const steamid = url.searchParams.get('steamid');
      const appid = url.searchParams.get('appid');
      if (!steamid || !appid) {
        return withCors(jsonResponse({ error: 'Missing steamid/appid' }, 400), request, env);
      }
      const achievements = await fetchAchievements(steamid, appid, env);
      return withCors(jsonResponse({ data: achievements }), request, env);
    }

    if (url.pathname === '/api/llm/explain' && request.method === 'POST') {
      const userId = request.headers.get('x-user-id') || 'anon';
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (checkRateLimit(userId, ip, { consume: true })) {
        return withCors(jsonResponse({ error: 'Rate limited' }, 429), request, env);
      }
      const body = await request.json().catch(() => ({}));
      const { summary, picks } = body;
      if (!summary || !Array.isArray(picks)) {
        return withCors(jsonResponse({ error: 'Invalid payload' }, 400), request, env);
      }
      const cacheKey = await hashPayload({ summary, picks });
      const cached = llmCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        return withCors(jsonResponse({ explanation: cached.data, cached: true }), request, env);
      }
      const explanation = await callOpenRouterExplain(summary, picks, env);
      llmCache.set(cacheKey, { data: explanation, expires: Date.now() + LLM_CACHE_TTL_MS });
      return withCors(jsonResponse({ explanation, cached: false }), request, env);
    }

    if (url.pathname === '/api/llm/rank' && request.method === 'POST') {
      const userId = request.headers.get('x-user-id') || 'anon';
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (checkRateLimit(userId, ip, { consume: true })) {
        return withCors(jsonResponse({ error: 'Rate limited' }, 429), request, env);
      }
      const body = await request.json().catch(() => ({}));
      const { userProfile, candidates } = body;
      if (!userProfile || !Array.isArray(candidates) || candidates.length === 0) {
        return withCors(jsonResponse({ error: 'Invalid payload' }, 400), request, env);
      }
      const trimmedCandidates = candidates.slice(0, 60); // limite la taille du prompt
      const picks = await callOpenRouterRank(userProfile, trimmedCandidates, env);
      return withCors(jsonResponse({ picks }), request, env);
    }

    return withCors(jsonResponse({ error: 'Not found' }, 404), request, env);
  } catch (err) {
    console.error(err);
    return withCors(jsonResponse({ error: 'Internal error' }, 500), request, env);
  }
}

function withCors(response, request, env) {
  const origin = request.headers.get('Origin');
  if (isAllowedOrigin(request, env)) {
    response.headers.set('Access-Control-Allow-Origin', origin || env.ALLOWED_ORIGIN || '*');
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type,x-user-id');
  response.headers.set('Access-Control-Max-Age', '86400');
  return response;
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
  const dev = (env.DEV_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
  const list = [...allowed, ...dev];
  if (list.length === 0) return true;
  return list.includes(origin);
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function checkRateLimit(userId, ip, { consume } = { consume: true }) {
  const key = `${userId}:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key) || [];
  const recent = entry.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (consume) {
    recent.push(now);
    rateLimitStore.set(key, recent);
  }
  return recent.length > RATE_LIMIT_MAX;
}

function getRequestCount(userId, ip) {
  const key = `${userId}:${ip}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key) || [];
  return entry.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS).length;
}

function pruneQueue() {
  const now = Date.now();
  while (queueTimestamps.length && now - queueTimestamps[0] > QUEUE_WINDOW_MS) {
    queueTimestamps.shift();
  }
}

function estimateQueue() {
  pruneQueue();
  return Math.min(5, queueTimestamps.length); // max 5
}

async function fetchOwnedGames(steamid, env) {
  if (!env.STEAM_API_KEY) throw new Error('STEAM_API_KEY missing');
  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${env.STEAM_API_KEY}&steamid=${steamid}&include_appinfo=1&include_played_free_games=1`;
  const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 3600 } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Steam owned games failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data?.response || {};
}

async function fetchAchievements(steamid, appid, env) {
  if (!env.STEAM_API_KEY) throw new Error('STEAM_API_KEY missing');
  const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=${env.STEAM_API_KEY}&steamid=${steamid}&appid=${appid}`;
  const res = await fetch(url, { cf: { cacheEverything: true, cacheTtl: 3600 } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Steam achievements failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data?.playerstats || {};
}

async function callOpenRouterExplain(summary, picks, env) {
  const prompt = buildExplainPrompt(summary, picks);
  const messages = [
    { role: 'system', content: 'You write concise, neutral game recommendation explanations in French. Keep it under 120 words. Do not invent data. No dataset dumps.' },
    { role: 'user', content: prompt },
  ];
  return callOpenRouterChat(messages, env, { max_tokens: 220, temperature: 0.4 });
}

// Classement IA du TOP 3 à partir de la shortlist.
async function callOpenRouterRank(userProfile, candidates, env) {
  const prompt = buildRankPrompt(userProfile, candidates);
  const messages = [
    {
      role: 'system',
      content:
        'Tu es un moteur de recommandation de jeux Steam. Tu reçois un profil joueur et une liste de candidats et tu renvoies uniquement un JSON valide avec les 3 meilleurs jeux classés par compatibilité (0-100). Respecte les filtres et le budget. N’invente aucun appid qui n’est pas dans la liste.',
    },
    { role: 'user', content: prompt },
  ];
  const raw = await callOpenRouterChat(messages, env, { max_tokens: 260, temperature: 0.3 });
  const parsed = parseJsonFromText(raw);
  const appidSet = new Set(candidates.map((c) => Number(c.appid)));
  const picks = Array.isArray(parsed?.picks) ? parsed.picks : [];
  const cleaned = picks
    .map((p) => ({
      appid: Number(p.appid),
      compatibility: Math.max(0, Math.min(100, Math.round(Number(p.compatibility) || 0))),
    }))
    .filter((p) => appidSet.has(p.appid))
    .slice(0, 3);
  if (!cleaned.length) throw new Error('LLM ranking returned no picks');
  return cleaned;
}

async function callOpenRouterChat(messages, env, { max_tokens = 220, temperature = 0.4 } = {}) {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');
  const freeModel = 'tngtech/deepseek-r1t2-chimera:free';
  const paidModel = 'deepseek/deepseek-r1';

  const attempt = async (model) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://github.com/<your-gh-username>/steam-ai-reco',
        'X-Title': 'Steam AI Reco',
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens,
        temperature,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`LLM error ${res.status}: ${text}`);
      error.status = res.status;
      throw error;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM empty response');
    return content.trim();
  };

  try {
    return await attempt(freeModel);
  } catch (err) {
    console.warn('Free model failed, retrying paid', err?.message);
    if (err?.status === 429 || err?.status === 403 || err?.status === 402) {
      return await attempt(paidModel);
    }
    throw err;
  }
}

function buildExplainPrompt(summary, picks) {
  const lines = picks
    .slice(0, 3)
    .map(
      (p, idx) =>
        `#${idx + 1} ${p.title} — compatibilité ${p.compatibility}% — tags clés: ${(p.tags || []).slice(0, 5).join(', ') || 'n/a'}`
    );
  return `${summary}\nExplique le TOP 3 en restant factuel, positif mais sobre. Structure en 3 puces courtes.\n${lines.join('\n')}`;
}

function buildRankPrompt(userProfile, candidates) {
  const tagLine = (userProfile?.fav_tags || []).join(', ') || 'n/a';
  const filterLine = JSON.stringify(userProfile?.filters || {});
  const budgetLine = userProfile?.budget_max ? `${userProfile.budget_max}€` : 'non précisé';
  const playLines = (userProfile?.playtime_top || [])
    .slice(0, 8)
    .map((g) => `- ${g.name} (${g.hours}h) tags: ${(g.tags || []).join(', ') || 'n/a'} ach:${g.achievement_ratio ?? 'n/a'}%`)
    .join('\n');
  const candidateLines = candidates
    .map(
      (c, idx) =>
        `${idx + 1}. ${c.name} (appid ${c.appid}) | tags: ${(c.tags || []).join(', ') || 'n/a'} | genres: ${(c.genres || []).join(', ') || 'n/a'} | prix: ${c.price ?? 0} | avis: ${c.review_ratio ?? 'n/a'} (${c.total_reviews || 0} reviews) | compat_hint: ${c.compatibility_hint ?? 'n/a'}`
    )
    .join('\n');
  return `Profil joueur : tags dominants ${tagLine}. Filtres: ${filterLine}. Budget max: ${budgetLine}.
Jeux les plus joués:
${playLines}
Candidats (ne choisis que parmi ces appids):
${candidateLines}
Retourne uniquement un JSON valide: {"picks":[{"appid":123,"compatibility":96},{"appid":456,"compatibility":90},{"appid":789,"compatibility":84}]}`;
}

function parseJsonFromText(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e) {
        // fallthrough
      }
    }
  }
  throw new Error('LLM JSON parse failed');
}

async function hashPayload(payload) {
  const json = JSON.stringify(payload);
  const buffer = new TextEncoder().encode(json);
  const hashArrayBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashArrayBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
