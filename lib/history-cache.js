function createHistoryCache({ ttlMs = 30000, maxEntries = 64, maxInFlight = 2, maxWaiters = 32 } = {}) {
  const cached = new Map();
  const pending = new Map();
  const busy = callback => callback(Object.assign(new Error("History is busy; retry shortly"), { busy: true }));
  return function read(key, loader, callback) {
    const hit = cached.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      callback(null, hit.value);
      return;
    }
    cached.delete(key);
    const waiters = pending.get(key);
    if (waiters) {
      if (waiters.length >= maxWaiters) busy(callback);
      else waiters.push(callback);
      return;
    }
    if (pending.size >= maxInFlight) { busy(callback); return; }
    pending.set(key, [callback]);
    let done = false;
    const complete = (error, value) => {
      if (done) return;
      done = true;
      const listeners = pending.get(key);
      pending.delete(key);
      if (!error) {
        while (cached.size >= maxEntries) cached.delete(cached.keys().next().value);
        cached.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      for (const listener of listeners) listener(error, value);
    };
    try { loader(complete); } catch (error) { complete(error); }
  };
}

module.exports = { createHistoryCache };
