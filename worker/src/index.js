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

      console.log('[/api/llm/explain] incoming', { userId, ip });

      if (checkRateLimit(userId, ip, { consume: true })) {
        console.warn('[/api/llm/explain] rate-limited', { userId, ip });
        return withCors(jsonResponse({ error: 'Rate limited' }, 429), request, env);
      }

      const body = await request.json().catch(() => ({}));
      const { summary, picks } = body || {};
      console.log('[/api/llm/explain] payload snapshot', {
        hasSummary: !!summary,
        picksCount: Array.isArray(picks) ? picks.length : -1,
      });

      if (!summary || !Array.isArray(picks)) {
        console.error('[/api/llm/explain] Invalid payload', { body });
        return withCors(jsonResponse({ error: 'Invalid payload' }, 400), request, env);
      }

      const cacheKey = await hashPayload({ summary, picks });
      const cached = llmCache.get(cacheKey);
      if (cached && cached.expires > Date.now()) {
        console.log('[/api/llm/explain] cache hit');
        return withCors(jsonResponse({ explanation: cached.data, cached: true }), request, env);
      }

      try {
        const explanation = await callOpenRouterExplain(summary, picks, env);
        console.log('[/api/llm/explain] explanation length', explanation?.length || 0);
        llmCache.set(cacheKey, { data: explanation, expires: Date.now() + LLM_CACHE_TTL_MS });
        return withCors(jsonResponse({ explanation, cached: false }), request, env);
      } catch (err) {
        console.error('[/api/llm/explain] ERROR from callOpenRouterExplain', {
          message: err?.message,
          stack: err?.stack,
        });
        throw err;
      }
    }

    if (url.pathname === '/api/llm/rank' && request.method === 'POST') {
      const userId = request.headers.get('x-user-id') || 'anon';
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

      console.log('[/api/llm/rank] incoming', { userId, ip });

      if (checkRateLimit(userId, ip, { consume: true })) {
        console.warn('[/api/llm/rank] rate-limited', { userId, ip });
        return withCors(jsonResponse({ error: 'Rate limited' }, 429), request, env);
      }

      const body = await request.json().catch(() => ({}));
      const { userProfile, mode = 'standard', filtersSummary = '', bannedTitles = [], isSurprise = false } = body || {};

      const topGames = Array.isArray(userProfile?.playtime_top)
        ? userProfile.playtime_top.slice(0, 10)
        : [];

      console.log('[/api/llm/rank] payload snapshot', {
        hasProfile: !!userProfile,
        topGamesCount: topGames.length,
        mode,
        filtersSummaryLen: (filtersSummary || '').length,
        banned: Array.isArray(bannedTitles) ? bannedTitles.length : 0,
      });

      if (!topGames.length) {
        console.error('[/api/llm/rank] Invalid payload (no top games)', { body });
        return withCors(jsonResponse({ error: 'Invalid payload' }, 400), request, env);
      }

      try {
        const picks = await callOpenRouterRank(topGames, env, mode, { filtersSummary, bannedTitles, isSurprise });
        console.log('[/api/llm/rank] LLM picks (titles)', picks);
        return withCors(jsonResponse({ picks }), request, env);
      } catch (err) {
        console.error('[/api/llm/rank] ERROR from callOpenRouterRank', {
          message: err?.message,
          stack: err?.stack,
        });
        throw err; // catched by le catch global
      }
    }

    return withCors(jsonResponse({ error: 'Not found' }, 404), request, env);
  } catch (err) {
    console.error('Unhandled error in worker', {
      path: url.pathname,
      message: err?.message,
      stack: err?.stack,
    });
    return withCors(
      jsonResponse({ error: 'Internal error', reason: err?.message || 'unknown' }, 500),
      request,
      env
    );
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

// IA : à partir du TOP 10 des jeux les plus joués, propose 3 nouveaux jeux (par titre).
async function callOpenRouterRank(topGames, env, mode = 'standard', { filtersSummary = '', bannedTitles = [], isSurprise = false } = {}) {
  const prompt = mode === 'surprise' || isSurprise
    ? buildSurprisePrompt(topGames, filtersSummary, bannedTitles)
    : buildRankPrompt(topGames, filtersSummary, bannedTitles);

  console.log('[/api/llm/rank] PROMPT ===');
  console.log(prompt.slice(0, 2000));

  const messages = [
    {
      role: 'system',
      content:
        "Tu es un expert en recommandations de jeux vidéo STEAM. " +
        "On te donne la liste des jeux les plus joués par un joueur (titre, heures, succès, tags). " +
        "Tu dois proposer exactement 3 AUTRES jeux Steam (pas déjà dans la liste) qui ont de fortes chances de lui plaire.",
    },
    { role: 'user', content: prompt },
  ];

  let raw;
  try {
    raw = await callOpenRouterChat(messages, env, { max_tokens: 220, temperature: 0.4 });
    console.log('[/api/llm/rank] RAW OUTPUT FULL ===');
    console.log(raw);  
  } catch (err) {
    console.error('[/api/llm/rank] error from callOpenRouterChat', {
      message: err?.message,
      stack: err?.stack,
    });
    throw err;
  }

  let parsed;
  try {
    parsed = parseJsonFromText(raw);
    console.log('[/api/llm/rank] PARSED JSON ===');
    console.log(JSON.stringify(parsed).slice(0, 2000));
  } catch (err) {
    console.error('[/api/llm/rank] parseJsonFromText failed', {
      message: err?.message,
      stack: err?.stack,
      rawPreview: raw.slice(0, 2000),
    });
    throw err;
  }

  const picks = Array.isArray(parsed?.picks) ? parsed.picks : [];

  const cleaned = picks
    .slice(0, 3)
    .map((p) => ({
      title: String(p.title || '').trim(),
      reason: String(p.reason || '').trim(),
    }))
    .filter((p) => p.title.length > 0);

  console.log('[/api/llm/rank] CLEANED PICKS ===', JSON.stringify(cleaned));

  if (!cleaned.length) {
    throw new Error('LLM ranking returned no picks');
  }

  return cleaned;
}

// Petit helper pour extraire du texte quelle que soit la forme de la réponse OpenRouter
function extractTextFromOpenRouter(json) {
  const choice = json?.choices?.[0];
  if (!choice) return null;

  const message = choice.message || choice.delta || choice;

  // 1) Cas classique : content est une string non vide
  if (typeof message?.content === 'string' && message.content.trim().length > 0) {
    return message.content;
  }

  // 2) Cas "multi-part" : content est un tableau de morceaux
  if (Array.isArray(message?.content)) {
    const parts = message.content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p.text === 'string') return p.text;
        if (typeof p.content === 'string') return p.content;
        return '';
      })
      .filter((s) => typeof s === 'string' && s.trim().length > 0);

    if (parts.length) {
      return parts.join('\n');
    }
  }

  // 3) Spécifique DeepSeek R1 + OpenRouter :
  //    la vraie réponse se retrouve parfois dans `reasoning`
  if (typeof message?.reasoning === 'string' && message.reasoning.trim().length > 0) {
    return message.reasoning;
  }

  // 4) Fallbacks ultra-safe
  if (typeof message === 'string' && message.trim().length > 0) {
    return message;
  }
  if (typeof choice.text === 'string' && choice.text.trim().length > 0) {
    return choice.text;
  }
  if (typeof json.output_text === 'string' && json.output_text.trim().length > 0) {
    return json.output_text;
  }

  return null;
}

async function callOpenRouterChat(messages, env, { max_tokens = 220, temperature = 0.4 } = {}) {
  if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY missing');

  const freeModel = 'meta-llama/llama-3.3-70b-instruct:free';
  const paidModel = 'deepseek/deepseek-r1';

  const attempt = async (model) => {
    console.log('[OpenRouter] calling model', model, {
      max_tokens,
      temperature,
      msgCount: messages?.length || 0,
    });

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

    console.log('[OpenRouter] HTTP status', res.status);

    if (!res.ok) {
      const text = await res.text();
      console.error('[OpenRouter] error body', text.slice(0, 400));
      const error = new Error(`LLM error ${res.status}: ${text}`);
      error.status = res.status;
      throw error;
    }

    const json = await res.json();
    console.log('[OpenRouter] raw json keys', Object.keys(json || {}));
    console.log('[OpenRouter] first choice snapshot', JSON.stringify(json?.choices?.[0] || {}).slice(0, 400));

    const content = extractTextFromOpenRouter(json);
    if (!content) {
      console.error('OpenRouter: unexpected response shape (no content)', JSON.stringify(json).slice(0, 400));
      throw new Error('LLM empty response');
    }

    console.log('[OpenRouter] extracted content preview', content.slice(0, 200));
    return content.trim();
  };

  try {
    return await attempt(freeModel);
  } catch (err) {
    console.warn('[OpenRouter] free model failed, retrying paid', err?.message);
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

function buildRankPrompt(topGames, filtersSummary = '', bannedTitles = []) {
  const lines = topGames
    .slice(0, 10)
    .map((g, idx) => {
      const name = g.name || g.title || 'Jeu inconnu';
      const hours = g.hours || g.playtime_hours || 0;
      const ach = g.achievement_ratio ?? g.achievements_ratio ?? null;
      const tags = (g.tags || []).join(', ') || 'n/a';

      return `${idx + 1}. ${name} — ${hours}h jouées — succès: ${ach ?? 'n/a'}% — tags: ${tags}`;
    })
    .join('\n');

  const sharedConstraints =
    'Contraintes :\n' +
    '- Les jeux doivent être disponibles sur Steam (pas de jeux inventés, pas de DLC, pas de démos).\n' +
    '- Ne répète aucun des titres déjà présents dans la liste.\n' +
    '- Reste factuel et neutre (pas de superlatifs abusifs).\n\n' +
    'Réponds UNIQUEMENT en JSON strict, sans texte autour, au format :\n' +
    '{\n' +
    '  "picks": [\n' +
    '    { "title": "Nom du jeu 1", "reason": "Courte explication en français (1 phrase)." },\n' +
    '    { "title": "Nom du jeu 2", "reason": "Courte explication en français (1 phrase)." },\n' +
    '    { "title": "Nom du jeu 3", "reason": "Courte explication en français (1 phrase)." }\n' +
    '  ]\n' +
    '}\n' +
    'N’ajoute AUCUN autre champ, aucun commentaire, aucun texte hors du JSON.';

  return (
    'Voici la liste des jeux Steam les plus joués par ce joueur :\n' +
    lines +
    '\n\n' +
    'Objectif : propose EXACTEMENT 3 autres jeux Steam (qui ne sont pas déjà dans la liste ci-dessus) qui ont de très grandes chances de lui plaire en restant proche de ses préférences (compétitif, coop, tags dominants...).\n\n' +
    (filtersSummary ? `Contexte des filtres choisis par le joueur :\n${filtersSummary}\n\n` : '') +
    (Array.isArray(bannedTitles) && bannedTitles.length
      ? 'Ne propose STRICTEMENT aucun des jeux suivants (déjà recommandés récemment) :\n- ' + bannedTitles.slice(0, 20).join('\n- ') + '\n\n'
      : '') +
    sharedConstraints
  );
}

function buildSurprisePrompt(topGames, filtersSummary = '', bannedTitles = []) {
  const base = buildRankPrompt(topGames, filtersSummary, bannedTitles);
  return base.replace(
    'Objectif : propose EXACTEMENT 3 autres jeux Steam (qui ne sont pas déjà dans la liste ci-dessus) qui ont de très grandes chances de lui plaire en restant proche de ses préférences (compétitif, coop, tags dominants...).',
    'Objectif : propose EXACTEMENT 3 autres jeux Steam (non présents dans la liste) qui sont plutôt des hidden gems : bien notés, cohérents avec ses goûts, mais pas des AAA ultra connus. Le but est de surprendre avec des découvertes plausibles et cohérentes.'
  );
}

function parseJsonFromText(text) {
  const trimmed = text.trim();

  try {
    // Cas où le modèle respecte bien "UNIQUEMENT JSON"
    return JSON.parse(trimmed);
  } catch (err) {
    // On tente de récupérer le premier bloc {...}
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        // On log aussi ici pour être sûr
        console.error('[parseJsonFromText] inner JSON parse failed, raw snippet =', trimmed.slice(0, 2000));
      }
    }

    // 🔥 Erreur enrichie avec un bout de la vraie réponse du modèle
    throw new Error(
      'LLM JSON parse failed. Raw snippet: ' + trimmed.slice(0, 2000)
    );
  }
}

async function hashPayload(payload) {
  const json = JSON.stringify(payload);
  const buffer = new TextEncoder().encode(json);
  const hashArrayBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashArrayBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
