export const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xf) >> 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function formatPrice(euros) {
  if (euros <= 0) return 'Gratuit';
  return `${euros.toFixed(2)}€`;
}

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function hashFilters(filters = {}) {
  return btoa(
    JSON.stringify(filters, Object.keys(filters).sort()).replace(/[^a-zA-Z0-9:+/=.-]/g, '')
  ).slice(0, 32);
}

export async function fetchDataset() {
  const candidates = ['data/games.min.json.gz', 'data/games.mock.json', 'data/games.json', 'data/games.json.gz'];
  for (const path of candidates) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      if (path.endsWith('.gz') && 'DecompressionStream' in self) {
        const ds = new DecompressionStream('gzip');
        const decompressed = res.body.pipeThrough(ds);
        const text = await new Response(decompressed).text();
        return JSON.parse(text);
      }
      return await res.json();
    } catch (err) {
      console.warn('Dataset fetch failed for', path, err);
    }
  }
  throw new Error('Dataset introuvable');
}

export function normalizePercent(value, min, max) {
  if (max === min) return 50;
  const pct = ((value - min) / (max - min)) * 100;
  return clamp(Math.round(pct), 0, 100);
}

export function lightweightFingerprint() {
  const ua = navigator.userAgent || 'na';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'tz';
  return btoa(`${ua.slice(0, 32)}|${tz}`).slice(0, 24);
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
