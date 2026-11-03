function createRefreshRunner(refresh) {
  let inFlight = null;
  return function run() {
    if (!inFlight) {
      inFlight = Promise.resolve().then(refresh).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

module.exports = { createRefreshRunner, mapLimited };
