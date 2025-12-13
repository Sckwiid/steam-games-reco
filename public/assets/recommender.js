import { formatPrice, hashFilters, normalizePercent, clamp } from './utils.js';

export function recommend({ dataset, library, achievements = {}, filters, priceMax, surprise = false, userId }) {
  // Local fallback TOP 3 (algo classique)
  const scored = scoreCandidates({ dataset, library, achievements, filters, priceMax, surprise, userId });
  return pickDiversified(scored.slice(0, 100), surprise);
}

// Shortlist pour l'IA : renvoie des candidats scorés (compatibilité calculée localement) limités à N.
export function shortlistCandidates({ dataset, library, achievements = {}, filters, priceMax, surprise = false, userId, limit = 50 }) {
  const scored = scoreCandidates({ dataset, library, achievements, filters, priceMax, surprise, userId });
  return scored.slice(0, limit);
}

// Mappe les picks IA (par titre) vers les jeux du dataset.
export function mapAiPicksToGames(aiPicks, gamesDb) {
  if (!Array.isArray(aiPicks) || !gamesDb?.length) return [];
  return aiPicks
    .map((pick, idx) => {
      const title = (pick?.title || '').trim();
      if (!title) return null;
      const norm = title.toLowerCase();
      let game = gamesDb.find((g) => (g.name || '').toLowerCase() === norm);
      if (!game) game = gamesDb.find((g) => (g.name || '').toLowerCase().includes(norm));
      if (!game) return null;
      return {
        ...game,
        compatibility: 98 - idx * 3, // cosmétique pour l’UI
        aiReason: pick.reason || '',
        price_label: formatPrice(game.price || 0),
      };
    })
    .filter(Boolean);
}

// Transforme la shortlist en payload compact pour le LLM.
export function toLlmCandidates(candidates, limit = 50) {
  return candidates.slice(0, limit).map((g) => ({
    appid: g.appid,
    name: g.name,
    tags: (g.tags || []).slice(0, 6),
    genres: (g.genres || []).slice(0, 4),
    price: g.price || 0,
    review_ratio: g.review_ratio ?? null,
    total_reviews: g.total_reviews ?? 0,
    compatibility_hint: g.compatibility ?? null,
  }));
}

// Profil condensé pour guider le LLM (tags dominants + exemples top playtime).
export function buildUserProfileForLlm(dataset, library, achievements, filters, priceMax, maxExamples = 8) {
  const topPlayed = getTopPlayed(library, 15);
  const profile = buildProfile(dataset, topPlayed, achievements);
  const tagEntries = Object.entries(profile.tagWeights).sort((a, b) => b[1] - a[1]);
  const favTags = tagEntries.slice(0, 8).map(([tag]) => tag);
  const index = new Map(dataset.map((g) => [g.appid, g]));
  const examples = topPlayed.slice(0, maxExamples).map((g) => {
    const data = index.get(g.appid) || {};
    return {
      appid: g.appid,
      name: data.name || g.name || `App ${g.appid}`,
      hours: Math.round((g.playtime_forever || 0) / 60),
      tags: (data.tags || []).slice(0, 5),
      achievement_ratio: achievements?.[g.appid]?.ratio ?? null,
    };
  });
  return {
    playtime_top: examples,
    fav_tags: favTags,
    filters,
    budget_max: priceMax ?? null,
  };
}

function scoreCandidates({ dataset, library, achievements = {}, filters, priceMax, surprise, userId }) {
  if (!dataset?.length) return [];
  const ownedSet = new Set((library?.games || []).map((g) => g.appid));
  const topPlayed = getTopPlayed(library, 15);
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

  return candidates.map((c) => ({ ...c, compatibility: normalizePercent(c.score, min, max) }));
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
    const achieve = achievements?.[entry.appid];
    const boost = achieve?.ratio >= 70 ? 1.5 : 1;
    const weight = playWeight * boost;
    (data.tags || []).forEach((tag) => (tagWeights[tag] = (tagWeights[tag] || 0) + weight));
    (data.genres || []).forEach((g) => (genreWeights[g] = (genreWeights[g] || 0) + weight * 0.8));
    (data.categories || []).forEach((c) => (categoryWeights[c] = (categoryWeights[c] || 0) + weight * 0.6));
  }

  return { tagWeights, genreWeights, categoryWeights, topTags: Object.keys(tagWeights).slice(0, 8) };
}

function getTopPlayed(library, limit) {
  return [...(library?.games || [])]
    .filter((g) => g.playtime_forever > 0)
    .sort((a, b) => b.playtime_forever - a.playtime_forever)
    .slice(0, limit);
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

  if (filters.budgetType === 'quick') {
    if (filters.budgetQuickValue === '0' && (game.price || 0) > 0) return false;
    if (filters.budgetQuickValue === '10' && (game.price || 0) > 10) return false;
    if (filters.budgetQuickValue === '20' && (game.price || 0) > 20) return false;
  } else {
    const max = filters.budgetMax ?? filters.priceMax;
    if (max != null && (game.price || 0) > max) return false;
  }

  return true;
}

function passesQualityRules(game) {
  if (game.total_reviews >= 10 && (game.review_ratio || 0) < 0.5) return false;
  return true;
}

function isTooSimilar(a, b) {
  const setA = new Set(a.tags || []);
  const setB = new Set(b.tags || []);
  const common = [...setA].filter((t) => setB.has(t)).length;
  const ratio = common / Math.max(1, setA.size, setB.size);
  return ratio > 0.6;
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
    const quirky = others.reverse().find((g) => g.overlap < 0.3);
    if (quirky && !result.includes(quirky)) result[result.length - 1] = quirky;
  }
  return result.slice(0, 3);
}
