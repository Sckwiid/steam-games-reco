import { formatPrice, hashFilters, normalizePercent, clamp } from './utils.js';

export function recommend({ dataset, library, achievements = {}, filters, priceMax, surprise = false, userId }) {
  if (!dataset?.length) return [];
  const ownedSet = new Set((library?.games || []).map((g) => g.appid));
  const topPlayed = [...(library?.games || [])]
    .filter((g) => g.playtime_forever > 0)
    .sort((a, b) => b.playtime_forever - a.playtime_forever)
    .slice(0, 15);
  const profile = buildProfile(dataset, topPlayed, achievements);
  const candidates = [];

  const noveltyWeight = surprise ? 0.3 : 0.2; // max 30% influence
  const priceCap = priceMax ?? 60;

  for (const game of dataset) {
    if (ownedSet.has(game.appid)) continue;
    if (!passesQualityRules(game)) continue;
    if (!matchesFilters(game, filters)) continue;
    if (game.price > priceCap) continue;

    const scoreParts = computeScoreParts(game, profile, priceCap);
    const overlap = computeOverlap(game, profile);
    const novelty = noveltyWeight * computeNovelty(userId, game.appid, overlap, surprise);
    const score =
      0.45 * scoreParts.tags +
      0.25 * scoreParts.genres +
      0.1 * scoreParts.categories +
      0.1 * scoreParts.price +
      novelty;

    candidates.push({
      ...game,
      score,
      overlap,
      compatibility: 0,
      price_label: formatPrice(game.price || 0),
    });
  }

  if (!candidates.length) return [];

  candidates.sort((a, b) => b.score - a.score);
  const topPool = candidates.slice(0, 100);
  const scores = topPool.map((c) => c.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);

  const withCompat = topPool.map((c) => ({ ...c, compatibility: normalizePercent(c.score, min, max) }));
  const diversified = pickDiversified(withCompat, surprise);
  return diversified;
}

function buildProfile(dataset, topGames, achievements) {
  const tagWeights = {};
  const genreWeights = {};
  const categoryWeights = {};
  const maxPlaytime = Math.max(...topGames.map((g) => g.playtime_forever), 1);
  const index = new Map(dataset.map((g) => [g.appid, g]));

  for (const entry of topGames) {
    const data = index.get(entry.appid);
    if (!data) continue;
    const playWeight = entry.playtime_forever / maxPlaytime;
    const achieve = achievements[entry.appid];
    const boost = achieve?.ratio >= 70 ? 1.5 : 1;
    const weight = playWeight * boost;
    (data.tags || []).forEach((tag) => (tagWeights[tag] = (tagWeights[tag] || 0) + weight));
    (data.genres || []).forEach((g) => (genreWeights[g] = (genreWeights[g] || 0) + weight * 0.8));
    (data.categories || []).forEach((c) => (categoryWeights[c] = (categoryWeights[c] || 0) + weight * 0.6));
  }

  return { tagWeights, genreWeights, categoryWeights, topTags: Object.keys(tagWeights).slice(0, 8) };
}

function computeScoreParts(game, profile, priceCap) {
  const tags = game.tags || [];
  const genres = game.genres || [];
  const categories = game.categories || [];

  const tagScore = tags.reduce((acc, tag) => acc + (profile.tagWeights[tag] || 0), 0);
  const genreScore = genres.reduce((acc, g) => acc + (profile.genreWeights[g] || 0), 0);
  const categoryScore = categories.reduce((acc, c) => acc + (profile.categoryWeights[c] || 0), 0);

  const priceScore = clamp(1 - (game.price || 0) / (priceCap || 1), 0, 1);

  return {
    tags: tagScore,
    genres: genreScore,
    categories: categoryScore,
    price: priceScore,
  };
}

function computeOverlap(game, profile) {
  const tags = new Set(game.tags || []);
  const top = profile.topTags || [];
  const common = top.filter((t) => tags.has(t)).length;
  return common / Math.max(1, tags.size);
}

function computeNovelty(userId, appid, overlap, surprise) {
  const seed = `${userId}-${appid}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const base = Math.abs(Math.sin(hash)) % 1; // deterministic 0-1
  const novelty = (1 - overlap) * (surprise ? 1 : 0.6) * base;
  return clamp(novelty, 0, 0.3);
}

function matchesFilters(game, filters = {}) {
  const map = {
    fps: 'FPS',
    f2p: 'Free to Play',
    coop: 'Co-op',
    horror: 'Horror',
    roguelite: 'Rogue-like',
    indie: 'Indie',
    adventure: 'Adventure',
    rpg: 'RPG',
    simulator: 'Simulation',
  };
  const tags = new Set(game.tags || []);
  const categories = new Set(game.categories || []);

  if (filters.quick?.length) {
    for (const f of filters.quick) {
      const mapped = map[f];
      if (mapped && !tags.has(mapped) && !categories.has(mapped)) return false;
    }
  }

  if (filters.modes?.length) {
    const modeMap = {
      online: 'Online Co-op',
      local: 'Local Co-op',
      solo: 'Single-player',
    };
    for (const m of filters.modes) {
      const mapped = modeMap[m];
      if (mapped && !categories.has(mapped)) return false;
    }
  }

  if (filters.budget === '0' && (game.price || 0) > 0) return false;
  if (filters.budget === '10' && (game.price || 0) > 10) return false;
  if (filters.budget === '20' && (game.price || 0) > 20) return false;

  return true;
}

function passesQualityRules(game) {
  if (game.total_reviews >= 10 && (game.review_ratio || 0) < 0.5) return false;
  return true;
}

function pickDiversified(list, surprise) {
  if (!list.length) return [];
  const first = list[0];
  const others = list.slice(1);
  const alt1 = others.find((g) => !isTooSimilar(first, g)) || others[0];
  const alt2 =
    others.find((g) => g !== alt1 && !isTooSimilar(first, g) && !isTooSimilar(alt1, g)) ||
    others[1] ||
    others[0];
  const result = [first, alt1, alt2].filter(Boolean);
  if (surprise) {
    // push a more surprising pick if available
    const quirky = others.reverse().find((g) => g.overlap < 0.3);
    if (quirky && !result.includes(quirky)) result[result.length - 1] = quirky;
  }
  return result.slice(0, 3);
}

function isTooSimilar(a, b) {
  const setA = new Set(a.tags || []);
  const setB = new Set(b.tags || []);
  const common = [...setA].filter((t) => setB.has(t)).length;
  const ratio = common / Math.max(1, setA.size, setB.size);
  return ratio > 0.6;
}

export function filtersKey(filters, priceMax, steamid) {
  return hashFilters({ filters, priceMax, steamid });
}
