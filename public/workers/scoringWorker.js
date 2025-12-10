// Placeholder scoring worker. You can wire this to offload scoring if needed.
self.onmessage = (event) => {
  const { dataset = [], owned = [] } = event.data || {};
  const ownedSet = new Set(owned);
  const picks = dataset
    .filter((g) => !ownedSet.has(g.appid))
    .slice(0, 3)
    .map((g, idx) => ({ ...g, compatibility: 70 - idx * 5 }));
  self.postMessage({ picks });
};
