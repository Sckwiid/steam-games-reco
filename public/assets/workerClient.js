function getBase() {
  const b = (window.__WORKER_BASE || "").replace(/\/$/, "");
  return b;
}

const BASE = (window.__WORKER_BASE || "").replace(/\/$/, "");

function apiUrl(path) {
  if (!BASE) throw new Error("Worker base manquant. Vérifie assets/config.js");
  return `${BASE}${path}`;
}

async function request(path, options = {}) {
  const BASE = getBase();
  if (!BASE) {
    const error = new Error("Worker base manquant. Vérifie assets/config.js");
    error.status = 0;
    throw error;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json.error || 'Worker error');
    error.status = res.status;
    throw error;
  }
  return json;
}

export async function fetchQueue() {
  try {
    const res = await request('/api/queue', { method: 'GET' });
    return res.waiting || 0;
  } catch (err) {
    return 0;
  }
}

export async function checkRateLimit(userId) {
  return request('/api/ratelimit/check', { method: 'POST', body: JSON.stringify({ userId }) });
}

export async function fetchOwnedGames(steamid, userId) {
  const res = await request(`/api/steam/owned?steamid=${encodeURIComponent(steamid)}`, {
    method: 'GET',
    headers: { 'x-user-id': userId },
  });
  return res.data;
}

export async function fetchAchievements(steamid, appid, userId) {
  const res = await request(
    `/api/steam/achievements?steamid=${encodeURIComponent(steamid)}&appid=${encodeURIComponent(appid)}`,
    { method: 'GET', headers: { 'x-user-id': userId } }
  );
  return res.data;
}

export async function fetchExplanation(summary, picks, userId) {
  const res = await request('/api/llm/explain', {
    method: 'POST',
    headers: { 'x-user-id': userId },
    body: JSON.stringify({ summary, picks }),
  });
  return res.explanation;
}

export async function rankCandidates(userProfile, candidates, userId) {
  const res = await request('/api/llm/rank', {
    method: 'POST',
    headers: { 'x-user-id': userId },
    body: JSON.stringify({ userProfile, candidates }),
  });
  return res.picks || [];
}
