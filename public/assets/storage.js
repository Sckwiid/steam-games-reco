import { ONE_DAY_MS, uuid } from './utils.js';

const HISTORY_KEY = 'ssc_history_v1';
const UID_KEY = 'ssc_uid';
const CACHE_KEY = 'ssc_cache_v1';
const PROFILE_CACHE_KEY = 'ssc_profile_cache_v1';
const REROLL_USAGE_KEY = 'ssc_reroll_usage_v1';

export function getUserId() {
  let id = localStorage.getItem(UID_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(UID_KEY, id);
  }
  return id;
}

export function saveRecommendation(entry) {
  const history = getHistory();
  history.unshift({ ...entry, id: uuid(), createdAt: new Date().toISOString() });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  return history[0];
}

export function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch (err) {
    return [];
  }
}

export function saveFeedback({ recommendationId, appid, value }) {
  const history = getHistory();
  const idx = history.findIndex((r) => r.id === recommendationId);
  if (idx >= 0) {
    history[idx].feedback = { appid, value };
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }
}

export function setCachedProfile(steamid, data) {
  const cache = readCache(PROFILE_CACHE_KEY);
  cache[steamid] = { data, expires: Date.now() + ONE_DAY_MS };
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(cache));
}

export function getCachedProfile(steamid) {
  const cache = readCache(PROFILE_CACHE_KEY);
  const entry = cache[steamid];
  if (entry && entry.expires > Date.now()) return entry.data;
  return null;
}

export function setCachedRecommendation(key, data) {
  const cache = readCache(CACHE_KEY);
  cache[key] = { data, expires: Date.now() + ONE_DAY_MS };
  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
}

export function getCachedRecommendation(key) {
  const cache = readCache(CACHE_KEY);
  const entry = cache[key];
  if (entry && entry.expires > Date.now()) return entry.data;
  return null;
}

// Construit une clé de cache/reroll par config (steamid + mode + filtres normalisés).
export function buildRecoKey({ steamid, mode = 'standard', filters = {}, priceMax }) {
  const normalized = {
    quick: [...(filters.quick || [])].sort(),
    modes: [...(filters.modes || [])].sort(),
    budget: filters.budget || null,
    priceMax: priceMax ?? null,
  };
  return `reco:${steamid}:${mode}:${JSON.stringify(normalized)}`;
}

// Reroll quota : max 3 par jour et par recoKey.
export function canUseReroll(recoKey) {
  const usage = readCache(REROLL_USAGE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage[recoKey];
  if (!entry || entry.date !== today) {
    usage[recoKey] = { date: today, count: 0 };
    localStorage.setItem(REROLL_USAGE_KEY, JSON.stringify(usage));
    return { allowed: true, remaining: 3 };
  }
  return { allowed: entry.count < 3, remaining: Math.max(0, 3 - entry.count) };
}

export function trackReroll(recoKey) {
  const usage = readCache(REROLL_USAGE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const entry = usage[recoKey];
  if (!entry || entry.date !== today) {
    usage[recoKey] = { date: today, count: 1 };
  } else {
    usage[recoKey].count = Math.min(3, (usage[recoKey].count || 0) + 1);
  }
  localStorage.setItem(REROLL_USAGE_KEY, JSON.stringify(usage));
  return usage[recoKey];
}

function readCache(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value || {};
  } catch (err) {
    return {};
  }
}
