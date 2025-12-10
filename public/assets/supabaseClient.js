const cfg = window.__SUPABASE || {};

function enabled() {
  return Boolean(cfg.url && cfg.key);
}

function headers() {
  return {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

export async function saveRecommendationRemote(payload) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  try {
    const res = await fetch(`${cfg.url}/rest/v1/recommendations`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function saveFeedbackRemote(payload) {
  if (!enabled()) return { ok: false, reason: 'disabled' };
  try {
    const res = await fetch(`${cfg.url}/rest/v1/feedback`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function supabaseEnabled() {
  return enabled();
}
