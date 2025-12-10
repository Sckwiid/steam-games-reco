const DEFAULT_BASE =
  window.__WORKER_BASE ||
  (location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://<your-worker>.workers.dev');

async function request(path, options = {}) {
  const res = await fetch(`${DEFAULT_BASE}${path}`, {
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
