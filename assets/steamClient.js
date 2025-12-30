import { getCachedProfile, setCachedProfile } from './storage.js';
import { fetchOwnedGames, fetchAchievements } from './workerClient.js';

export async function getLibrary(steamid, userId) {
  const cached = getCachedProfile(steamid);
  if (cached) return cached;
  const data = await fetchOwnedGames(steamid, userId);
  setCachedProfile(steamid, data);
  return data;
}

export async function getTopAchievements(steamid, topGames, userId, limit = 5) {
  const results = {};
  const slice = topGames.slice(0, limit);
  for (const game of slice) {
    try {
      const res = await fetchAchievements(steamid, game.appid, userId);
      const total = res?.achievements?.length || 0;
      const unlocked = res?.achievements?.filter((a) => a?.achieved === 1).length || 0;
      const ratio = total ? Math.round((unlocked / total) * 100) : 0;
      results[game.appid] = { total, unlocked, ratio };
    } catch (err) {
      results[game.appid] = { total: 0, unlocked: 0, ratio: 0 };
    }
  }
  return results;
}
