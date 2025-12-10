import { ONE_DAY_MS, uuid } from './utils.js';

const HISTORY_KEY = 'ssc_history_v1';
const UID_KEY = 'ssc_uid';
const CACHE_KEY = 'ssc_cache_v1';
const PROFILE_CACHE_KEY = 'ssc_profile_cache_v1';

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

function readCache(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value || {};
  } catch (err) {
    return {};
  }
}
