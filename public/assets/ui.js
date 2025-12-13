const themeKey = 'ssc_theme';

export function initThemeToggle() {
  const saved = localStorage.getItem(themeKey) || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.textContent = saved === 'dark' ? '☾' : '☀';
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(themeKey, next);
      btn.textContent = next === 'dark' ? '☾' : '☀';
    });
  }
}

export function setStatus(text, { loading = false } = {}) {
  const el = document.getElementById('statusText');
  const loader = document.querySelector('.loader');
  if (el) el.textContent = text;
  if (loader) loader.hidden = !loading;
}

export function setQueue(waiting) {
  const el = document.getElementById('queueInfo');
  if (el) el.textContent = waiting ? `${waiting} personnes en attente` : '';
}

export function setCacheBadge(visible) {
  const el = document.getElementById('cacheInfo');
  if (el) el.hidden = !visible;
}

export function setLlmBadge(visible) {
  const el = document.getElementById('llmInfo');
  if (el) el.hidden = !visible;
}

export function toggleRerollButton(visible) {
  const btn = document.getElementById('rerollBtn');
  if (btn) btn.hidden = !visible;
}

export function scrollToResults() {
  document.getElementById('reco-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function renderResults(results = [], onFeedback) {
  const container = document.getElementById('results');
  const empty = document.createElement('p');
  empty.textContent = 'Aucune recommandation pour le moment.';
  if (!container) return;
  container.innerHTML = '';
  if (!results.length) {
    container.appendChild(empty);
    return;
  }
  results.forEach((item, idx) => {
    const card = document.createElement('article');
    card.className = 'card';
    const storeUrl = item.store_url || `https://store.steampowered.com/app/${item.appid}/`;
    if (item.header_image) {
      const cover = document.createElement('a');
      cover.className = 'cover';
      cover.href = storeUrl;
      cover.target = '_blank';
      cover.rel = 'noreferrer';
      const img = document.createElement('img');
      img.src = item.header_image;
      img.alt = item.name;
      cover.appendChild(img);
      card.appendChild(cover);
    }
    const title = document.createElement('h3');
    title.innerHTML = `${rankLabel(idx)} ${item.name} <span class="pill success">${item.compatibility}%</span>`;
    const meta = document.createElement('div');
    meta.className = 'tagline';
    const reviewPct =
      typeof item.review_ratio === 'number' ? `${(item.review_ratio * 100).toFixed(0)}% avis` : 'Avis n/a';
    meta.innerHTML = [
      `<span class="badge">Prix ${item.price_label}</span>`,
      `<span class="badge">${reviewPct}</span>`,
      item.categories?.includes('Multiplayer') ? `<span class="badge">Multi/Coop</span>` : '',
    ]
      .filter(Boolean)
      .join('');
    const tags = document.createElement('div');
    tags.className = 'tagline';
    (item.tags || []).slice(0, 6).forEach((tag) => {
      const pill = document.createElement('span');
      pill.className = 'pill ghost';
      pill.textContent = tag;
      tags.appendChild(pill);
    });
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(tags);
    if (item.aiReason) {
      const reason = document.createElement('p');
      reason.className = 'ai-reason';
      reason.innerHTML = `<em>Pourquoi ce jeu ?</em> ${item.aiReason}`;
      card.appendChild(reason);
    }
    const steamLink = document.createElement('a');
    steamLink.className = 'steam-link';
    steamLink.href = storeUrl;
    steamLink.target = '_blank';
    steamLink.rel = 'noreferrer';
    steamLink.textContent = 'Voir sur Steam →';
    card.appendChild(steamLink);
    if (onFeedback) {
      const fb = document.createElement('div');
      fb.className = 'feedback';
      const like = document.createElement('button');
      like.textContent = '👍';
      like.addEventListener('click', () => onFeedback(item, 1));
      const dislike = document.createElement('button');
      dislike.textContent = '👎';
      dislike.addEventListener('click', () => onFeedback(item, -1));
      fb.appendChild(like);
      fb.appendChild(dislike);
      card.appendChild(fb);
    }
    container.appendChild(card);
  });
}

export function renderExplanation(text) {
  const el = document.getElementById('explanation');
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.innerText = text;
}

export function renderHistory(list = [], onFeedback) {
  const container = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  if (!container || !empty) return;
  container.innerHTML = '';
  if (!list.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.forEach((entry) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <h3>${entry.primary?.name || 'Inconnu'} <span class="pill success">${entry.primary?.compatibility || '?'}%</span></h3>
      <p class="muted small">${new Date(entry.createdAt).toLocaleString()}</p>
      <div class="tagline">
        <span class="badge">Alt: ${entry.alt1?.name || '-'}</span>
        <span class="badge">Alt: ${entry.alt2?.name || '-'}</span>
      </div>
    `;
    const fb = document.createElement('div');
    fb.className = 'feedback';
    const like = document.createElement('button');
    like.textContent = '👍';
    like.addEventListener('click', () => onFeedback(entry, 1));
    const dislike = document.createElement('button');
    dislike.textContent = '👎';
    dislike.addEventListener('click', () => onFeedback(entry, -1));
    fb.appendChild(like);
    fb.appendChild(dislike);
    card.appendChild(fb);
    container.appendChild(card);
  });
}

export function renderIndieList(list = []) {
  const container = document.getElementById('indieList');
  const empty = document.getElementById('indieEmpty');
  if (!container || !empty) return;
  container.innerHTML = '';
  if (!list.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <h3>${item.name} <span class="pill">${item.price_label}</span></h3>
      <div class="tagline">
        <span class="badge">${(item.review_ratio * 100).toFixed(0)}% avis</span>
        <span class="badge">${item.total_reviews} reviews</span>
      </div>
      <div class="tagline">${(item.tags || []).slice(0, 6).map((t) => `<span class="pill ghost">${t}</span>`).join('')}</div>
    `;
    container.appendChild(card);
  });
}

function rankLabel(idx) {
  if (idx === 0) return '#1 ·';
  if (idx === 1) return '#2 ·';
  if (idx === 2) return '#3 ·';
  return `#${idx + 1} ·`;
}
