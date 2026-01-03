import { fetchDataset, lightweightFingerprint } from './utils.js';
import { shortlistCandidates, toLlmCandidates, buildUserProfileForLlm, mapAiPicksToGames } from './recommender.js';
import { getLibrary, getTopAchievements } from './steamClient.js';
import { initThemeToggle, setStatus, setQueue, renderResults, renderHistory, renderIndieList, setCacheBadge, setLlmBadge, scrollToResults, toggleRerollButton } from './ui.js';
import { getHistory, saveRecommendation, saveFeedback, getUserId, setCachedRecommendation, getCachedRecommendation, buildRecoKey, canUseReroll, trackReroll, getSeenTitles, addSeenTitles } from './storage.js';
import { fetchQueue, rankCandidates } from './workerClient.js';
import { saveFeedbackRemote, saveRecommendationRemote, supabaseEnabled, savePlayerTopGames } from './supabaseClient.js';

const state = {
  dataset: null,
  userId: getUserId(),
  filters: { quick: [], modes: [], budgetType: 'custom', budgetQuickValue: null, budgetMin: 0, budgetMax: 30 },
  priceMax: 30,
  priceMaxDefault: 60,
  lastConfig: null,
};

initThemeToggle();
boot();

async function boot() {
  const page = document.body.dataset.page || 'home';
  if (page === 'history') return initHistoryPage();
  if (page === 'indie') return initIndiePage();
  return initHomePage();
}

function bindFilters() {
  const quick = document.getElementById('quickFilters');
  if (quick) {
    quick.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      btn.classList.toggle('active');
      const val = btn.dataset.filter;
      if (btn.classList.contains('active')) state.filters.quick.push(val);
      else state.filters.quick = state.filters.quick.filter((v) => v !== val);
    });
  }
  document.querySelectorAll('[data-mode]').forEach((btn) =>
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const val = btn.dataset.mode;
      if (btn.classList.contains('active')) state.filters.modes.push(val);
      else state.filters.modes = state.filters.modes.filter((v) => v !== val);
    })
  );
  document.querySelectorAll('[data-budget]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const slider = document.getElementById('priceSlider');
      const valEl = document.getElementById('priceValue');
      document.querySelectorAll('[data-budget]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filters.budgetType = 'quick';
      state.filters.budgetQuickValue = btn.dataset.budget;
      state.filters.budgetMin = 0;
      state.filters.budgetMax = state.priceMaxDefault;
      state.priceMax = state.priceMaxDefault;
      if (slider) slider.value = state.priceMaxDefault;
      if (valEl) valEl.textContent = `${state.priceMaxDefault}€`;
    })
  );
  const slider = document.getElementById('priceSlider');
  const valEl = document.getElementById('priceValue');
  if (slider && valEl) {
    state.priceMaxDefault = Number(slider.max || state.priceMaxDefault);
    slider.addEventListener('input', () => {
      state.priceMax = Number(slider.value);
      valEl.textContent = `${slider.value}€`;
      state.filters.budgetType = 'custom';
      state.filters.budgetQuickValue = null;
      state.filters.budgetMin = 0;
      state.filters.budgetMax = state.priceMax;
      document.querySelectorAll('[data-budget]').forEach((b) => b.classList.remove('active'));
    });
  }
}

async function initHomePage() {
  bindFilters();
  setStatus('Chargement du dataset…', { loading: true });
  loadDataset();
  const recommendBtn = document.getElementById('recommendBtn');
  const surpriseBtn = document.getElementById('surpriseBtn');
  const rerollBtn = document.getElementById('rerollBtn');
  if (recommendBtn) recommendBtn.addEventListener('click', () => runRecommendation({ mode: 'standard' }));
  if (surpriseBtn) surpriseBtn.addEventListener('click', () => runRecommendation({ mode: 'surprise' }));
  if (rerollBtn) rerollBtn.addEventListener('click', handleReroll);
  const queue = await fetchQueue();
  setQueue(queue);
  setStatus('Prêt à analyser ta bibliothèque.', { loading: false });
}

async function loadDataset() {
  if (state.dataset) return state.dataset;
  state.dataset = await fetchDataset();
  return state.dataset;
}

async function runRecommendation({ mode = 'standard', forceReroll = false }) {
  const steamInput = document.getElementById('steamIdInput');
  const steamid = steamInput?.value?.trim();
  if (!steamid || !/^\d{5,}$/.test(steamid)) {
    setStatus('SteamID64 invalide.', { loading: false });
    return;
  }
  const userFingerprint = `${state.userId}-${lightweightFingerprint()}`;
  setStatus('Chargement du dataset…', { loading: true });
  setCacheBadge(false);
  setLlmBadge(false);
  toggleRerollButton(false);
  try {
    const dataset = await loadDataset();
    setStatus('Récupération de ta bibliothèque Steam…', { loading: true });

    const cacheKey = buildRecoKey({
      steamid,
      mode,
      filters: state.filters,
      priceMax: state.priceMax,
      budget: {
        type: state.filters.budgetType,
        quickValue: state.filters.budgetQuickValue,
        min: state.filters.budgetMin,
        max: state.filters.budgetMax ?? state.priceMax,
      },
    });
    const cached = !forceReroll ? getCachedRecommendation(cacheKey) : null;
    if (cached) {
      renderResults(cached.items, handleFeedback, mode);
      setCacheBadge(true);
      setLlmBadge(true);
      setStatus('Résultat issu du cache (24h).', { loading: false });
      addSeenTitles(cacheKey, (cached.items || []).map((r) => r.name));
      state.lastConfig = { steamid, mode, cacheKey };
      toggleRerollButton(true);
      scrollToResults();
      return;
    }

    const library = await getLibrary(steamid, state.userId);
    const games = library?.games || [];
    if (!games.length) throw new Error('Profil vide ou privé. Rends ta bibliothèque publique.');

    setStatus('Analyse des jeux les plus joués…', { loading: true });
    const topPlayed = [...games].sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, 15);
    const achievements = await getTopAchievements(steamid, topPlayed, state.userId, 12);

    setStatus('Préparation shortlist et profil…', { loading: true });
    const filtersSummary = buildFiltersSummary(state.filters, state.priceMax);
    const bannedTitles = getSeenTitles(cacheKey);

    const shortlist = shortlistCandidates({
      dataset,
      library,
      achievements,
      filters: state.filters,
      priceMax: state.priceMax,
      userId: userFingerprint,
      bannedTitles,
    });
    console.log('[reco] shortlist built', {
      shortlistCount: shortlist.length,
      activeTags: state.filters.quick,
      activeModes: state.filters.modes,
      activeBudget: {
        type: state.filters.budgetType,
        quick: state.filters.budgetQuickValue,
        max: state.filters.budgetMax,
      },
      bannedTitlesCount: bannedTitles.length,
      ownedGamesCount: games.length,
    });

    if (!shortlist.length) {
      setStatus("Aucun jeu dans le catalogue ne correspond à ces filtres. Essaie avec moins de filtres ou un budget plus large.", { loading: false });
      return;
    }

    if (shortlist.length <= 3) {
      const recosDirect = shortlist.slice(0, 3).map((g, idx) => ({
        ...g,
        aiReason: 'Proposition basée sur tes jeux les plus joués',
        compatibility: 98 - idx * 3,
      }));
      renderResults(recosDirect, handleFeedback, mode);
      setCachedRecommendation(cacheKey, { items: recosDirect, explanation: '' });
      persistHistory(steamid, recosDirect, mode === 'surprise');
      state.lastConfig = { steamid, mode, cacheKey };
      addSeenTitles(cacheKey, recosDirect.map((r) => r.name));
      toggleRerollButton(true);
      scrollToResults();
      setStatus('Terminé.', { loading: false });
      return;
    }

    const userProfile = buildUserProfileForLlm(dataset, library, achievements, state.filters, state.priceMax);
    if (supabaseEnabled()) {
      savePlayerTopGames(steamid, userProfile.playtime_top).catch((err) => console.warn('Supabase top games failed', err));
    }

    setStatus('Classement par l’IA…', { loading: true });
    const aiPicks = await rankCandidates(
      userProfile,
      toLlmCandidates(shortlist),
      state.userId,
      mode,
      {
        filtersSummary,
        bannedTitles,
        isSurprise: mode === 'surprise',
        candidates: toLlmCandidates(shortlist),
      }
    );
    let recos = mapAiPicksToGames(aiPicks, shortlist || dataset, shortlist).slice(0, 3);

    if (!recos.length) {
      console.log('[reco] no IA picks after mapping', { shortlistCount: shortlist.length, aiPicksCount: aiPicks?.length || 0, mode });
      throw new Error("L'IA n’a pas trouvé de jeux correspondants. Essaie avec moins de filtres ou un budget plus large.");
    }

    addSeenTitles(cacheKey, recos.map((r) => r.name));
    renderResults(recos, handleFeedback, mode);
    setLlmBadge(true);

    setCachedRecommendation(cacheKey, { items: recos, explanation: '' });
    persistHistory(steamid, recos, mode === 'surprise');
    state.lastConfig = { steamid, mode, cacheKey };
    toggleRerollButton(true);
    scrollToResults();
    setStatus('Terminé.', { loading: false });
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Erreur', { loading: false });
  }
}

function persistHistory(steamid, recos, surprise) {
  const primary = recos[0];
  const alt1 = recos[1];
  const alt2 = recos[2];
  const entry = saveRecommendation({
    steamid,
    primary,
    alt1,
    alt2,
    filters: state.filters,
    priceMax: state.priceMax,
    surprise,
    mode: surprise ? 'surprise' : 'normal',
    picks: recos.map((r) => ({ appid: r.appid, title: r.name, reason: r.aiReason, compatibility: r.compatibility })),
  });
  if (supabaseEnabled()) {
    saveRecommendationRemote({
      user_id: state.userId,
      steamid,
      appid_primary: primary?.appid,
      appid_alt1: alt1?.appid,
      appid_alt2: alt2?.appid,
      score_primary: primary?.compatibility,
      score_alt1: alt1?.compatibility,
      score_alt2: alt2?.compatibility,
      filters_json: entry.filters,
      created_at: entry.createdAt,
    });
  }
}

function handleFeedback(item, value) {
  const history = getHistory();
  const latest = history[0];
  if (latest) {
    saveFeedback({ recommendationId: latest.id, appid: item.appid, value });
    if (supabaseEnabled()) {
      saveFeedbackRemote({ user_id: state.userId, recommendation_id: latest.id, appid: item.appid, value, created_at: new Date().toISOString() });
    }
  }
}

function initHistoryPage() {
  const history = getHistory();
  renderHistory(history, (entry, value) => {
    saveFeedback({ recommendationId: entry.id, appid: entry.primary?.appid, value });
    if (supabaseEnabled()) {
      saveFeedbackRemote({
        user_id: state.userId,
        recommendation_id: entry.id,
        appid: entry.primary?.appid,
        value,
        created_at: new Date().toISOString(),
      });
    }
  });
}

async function initIndiePage() {
  try {
    const dataset = await fetchDataset();
    window.__DATASET = dataset;
    const indie = dataset
      .filter((g) => (g.tags || []).includes('Indie'))
      .filter((g) => g.review_ratio >= 0.5 || g.total_reviews < 20)
      .sort((a, b) => (b.review_ratio || 0) - (a.review_ratio || 0))
      .slice(0, 30)
      .map((g) => ({ ...g, price_label: g.price === 0 ? 'Gratuit' : `${g.price}€` }));
    renderIndieList(indie);
  } catch (err) {
    console.error(err);
    const empty = document.getElementById('indieEmpty');
    if (empty) empty.textContent = 'Impossible de charger le dataset indé.';
  }
}

function handleReroll() {
  if (!state.lastConfig) {
    setStatus('Aucune recommandation à relancer.', { loading: false });
    return;
  }
  const { steamid, mode, cacheKey } = state.lastConfig;
  const steamInput = document.getElementById('steamIdInput');
  if (steamInput && !steamInput.value) {
    steamInput.value = steamid;
  }
  const usage = canUseReroll(cacheKey);
  if (!usage.allowed) {
    setStatus('Tu as atteint la limite de 3 rerolls pour cette configuration aujourd’hui.', { loading: false });
    const btn = document.getElementById('rerollBtn');
    if (btn) btn.disabled = true;
    return;
  }
  trackReroll(cacheKey);
  setStatus('Nouveau tirage IA en cours…', { loading: true });
  runRecommendation({ mode, forceReroll: true });
}

function buildFiltersSummary(filters, priceMax) {
  const modes = (filters.modes || []).join(', ') || 'non précisé';
  const tags = (filters.quick || []).join(', ') || 'non précisé';
  const budget =
    filters.budgetType === 'quick'
      ? `Budget rapide : ${filters.budgetQuickValue || 'n/a'}`
      : `Budget max : ${filters.budgetMax ?? priceMax}€`;
  return `Modes : ${modes}\nBudget : ${budget}\nTags principaux : ${tags}`;
}

function applyClientFilters(recos, filters, priceMax) {
  return recos.filter((g) => {
    const categories = new Set(g.categories || []);
    const tags = new Set(g.tags || []);
    // Modes
    if (filters.modes?.length) {
      const modeMap = {
        solo: 'Single-player',
        online: 'Online Co-op',
        local: 'Local Co-op',
        coop: 'Co-op',
      };
      for (const m of filters.modes) {
        const cat = modeMap[m];
        if (cat && !categories.has(cat)) return false;
      }
    }
    // Tags quick
    if (filters.quick?.length) {
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
      for (const q of filters.quick) {
        const t = map[q];
        if (t && !tags.has(t) && !categories.has(t)) return false;
      }
    }
    // Budget
    if (filters.budgetType === 'quick') {
      const v = filters.budgetQuickValue;
      if (v === '0' && (g.price || 0) > 0) return false;
      if (v === '10' && (g.price || 0) > 10) return false;
      if (v === '20' && (g.price || 0) > 20) return false;
    } else {
      if ((g.price || 0) > (filters.budgetMax ?? priceMax)) return false;
    }
    return true;
  });
}
