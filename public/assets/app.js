import { fetchDataset, lightweightFingerprint } from './utils.js';
import { recommend, filtersKey } from './recommender.js';
import { getLibrary, getTopAchievements } from './steamClient.js';
import { initThemeToggle, setStatus, setQueue, renderResults, renderExplanation, renderHistory, renderIndieList, setCacheBadge, setLlmBadge } from './ui.js';
import { getHistory, saveRecommendation, saveFeedback, getUserId, setCachedRecommendation, getCachedRecommendation } from './storage.js';
import { fetchQueue, fetchExplanation } from './workerClient.js';
import { saveFeedbackRemote, saveRecommendationRemote, supabaseEnabled } from './supabaseClient.js';

const state = {
  dataset: null,
  userId: getUserId(),
  filters: { quick: [], modes: [], budget: null },
  priceMax: 30,
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
      document.querySelectorAll('[data-budget]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filters.budget = btn.dataset.budget;
    })
  );
  const slider = document.getElementById('priceSlider');
  const valEl = document.getElementById('priceValue');
  if (slider && valEl) {
    slider.addEventListener('input', () => {
      state.priceMax = Number(slider.value);
      valEl.textContent = `${slider.value}€`;
    });
  }
}

async function initHomePage() {
  bindFilters();
  setStatus('Chargement du dataset…', { loading: true });
  loadDataset();
  const recommendBtn = document.getElementById('recommendBtn');
  const surpriseBtn = document.getElementById('surpriseBtn');
  if (recommendBtn) recommendBtn.addEventListener('click', () => runRecommendation({ surprise: false }));
  if (surpriseBtn) surpriseBtn.addEventListener('click', () => runRecommendation({ surprise: true }));
  const queue = await fetchQueue();
  setQueue(queue);
  setStatus('Prêt à analyser ta bibliothèque.', { loading: false });
}

async function loadDataset() {
  if (state.dataset) return state.dataset;
  state.dataset = await fetchDataset();
  return state.dataset;
}

async function runRecommendation({ surprise }) {
  const steamInput = document.getElementById('steamIdInput');
  const steamid = steamInput?.value?.trim();
  if (!steamid || !/^\d{5,}$/.test(steamid)) {
    setStatus('SteamID64 invalide.', { loading: false });
    return;
  }
  setStatus('Chargement du dataset…', { loading: true });
  renderExplanation('');
  setCacheBadge(false);
  setLlmBadge(false);
  try {
    const dataset = await loadDataset();
    setStatus('Récupération de ta bibliothèque Steam…', { loading: true });

    const cacheKey = filtersKey({ ...state.filters, surprise }, state.priceMax, steamid);
    const cached = getCachedRecommendation(cacheKey);
    if (cached) {
      renderResults(cached.items, handleFeedback);
      renderExplanation(cached.explanation || '');
      setCacheBadge(true);
      setLlmBadge(Boolean(cached.explanation));
      setStatus('Résultat issu du cache (24h).', { loading: false });
      return;
    }

    const library = await getLibrary(steamid, state.userId);
    const games = library?.games || [];
    if (!games.length) throw new Error('Profil vide ou privé. Rends ta bibliothèque publique.');

    setStatus('Analyse des jeux les plus joués…', { loading: true });
    const topPlayed = [...games].sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, 15);
    const achievements = await getTopAchievements(steamid, topPlayed, state.userId, 12);

    setStatus('Calcul des recommandations…', { loading: true });
    const recos = recommend({
      dataset,
      library,
      achievements,
      filters: state.filters,
      priceMax: state.priceMax,
      surprise,
      userId: `${state.userId}-${lightweightFingerprint()}`,
    });

    if (!recos.length) throw new Error('Aucune recommandation trouvée avec ces filtres.');

    setStatus('Formulation par DeepSeek R1…', { loading: true });
    renderResults(recos, handleFeedback);

    const explanation = await buildExplanation(recos, surprise);
    if (explanation) {
      renderExplanation(explanation);
      setLlmBadge(true);
    } else {
      renderExplanation('');
    }

    setCachedRecommendation(cacheKey, { items: recos, explanation });
    persistHistory(steamid, recos, surprise);
    setStatus('Terminé.', { loading: false });
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Erreur', { loading: false });
  }
}

async function buildExplanation(recos, surprise) {
  try {
    const summary = `Profil généré côté client. Pertinence 70%, découverte 30%. Mode surprise: ${surprise ? 'oui' : 'non'}.`;
    const picks = recos.slice(0, 3).map((r) => ({
      title: r.name,
      compatibility: r.compatibility,
      tags: r.tags?.slice(0, 6) || [],
    }));
    return await fetchExplanation(summary, picks, state.userId);
  } catch (err) {
    console.warn('LLM explanation skipped', err?.message);
    return '';
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
