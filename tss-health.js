const http = require("http");
const https = require("https");
const { URL } = require("url");

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(targetUrl, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      timeout: timeoutMs,
      headers: { Accept: "application/json" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) request.destroy(new Error("response-too-large"));
      });
      response.on("end", () => {
        let data;
        try { data = JSON.parse(body); } catch (_error) { data = null; }
        resolve({ statusCode: response.statusCode || 0, data });
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
}

function failureCategory(error) {
  if (error && error.message === "timeout") return "timeout";
  return "request failed";
}

function endpointUrl(baseUrl, endpoint) {
  return `${String(baseUrl).replace(/\/+$/, "")}${endpoint}`;
}

function parseProviderHealth(value) {
  if (!value || typeof value !== "object") throw new Error("invalid response");
  if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) {
    throw new Error("invalid response");
  }
  if (!Array.isArray(value.failedProviders)) throw new Error("invalid response");
  const failedProviders = value.failedProviders.map((provider) => {
    if (!provider || typeof provider.chainId !== "number" ||
        typeof provider.chainName !== "string" || typeof provider.providerName !== "string") {
      throw new Error("invalid response");
    }
    return {
      chainId: provider.chainId,
      chainName: provider.chainName,
      providerName: provider.providerName,
    };
  });
  if (value.failedProviderCount !== failedProviders.length) throw new Error("invalid response");
  return { checkedAt: value.checkedAt, failedProviderCount: failedProviders.length, failedProviders };
}

async function fetchWithRetries(observer, endpoint, options = {}) {
  const get = options.requestJson || requestJson;
  const wait = options.delay || delay;
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  let lastFailure = "request failed";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await get(endpointUrl(observer.baseUrl, endpoint), REQUEST_TIMEOUT_MS);
      if (!response.data || typeof response.data !== "object") {
        lastFailure = "invalid response";
      } else {
        const validationFailure = options.validateResponse ? options.validateResponse(response.data) : null;
        if (!validationFailure && (response.statusCode >= 200 && response.statusCode < 300 || options.acceptNon2xxValidated)) return response;
        lastFailure = validationFailure || `HTTP ${response.statusCode}`;
      }
    } catch (error) {
      lastFailure = failureCategory(error);
    }
    log(`[tss-health] observer=${observer.id} endpoint=${endpoint} attempt=${attempt}/${MAX_ATTEMPTS} failed: ${lastFailure}`);
    if (attempt < MAX_ATTEMPTS) await wait(0);
  }
  throw new Error(lastFailure);
}

function resultBase(observer, type, identity, observedAt) {
  const observerAddress = new URL(observer.baseUrl).hostname;
  return {
    id: `${observer.id}:${type}:${identity}`,
    observerId: observer.id,
    label: observer.label,
    observerAddress,
    network: observer.network,
    type,
    observedAt,
  };
}

function validateObserver(observer) {
  return observer && typeof observer.id === "string" && typeof observer.label === "string" &&
    typeof observer.network === "string" && typeof observer.baseUrl === "string" &&
    /^https?:\/\//.test(observer.baseUrl);
}

function createTssHealthPoller(observers, options = {}) {
  if (!Array.isArray(observers) || !observers.every(validateObserver)) {
    throw new Error("Invalid tss-observers.json configuration");
  }
  const previousCheckedAt = new Map();
  let snapshot = { generatedAt: null, results: [] };
  let sequence = 0;

  async function pollObserver(observer, observedAt) {
    const results = [];
    try {
      await fetchWithRetries(observer, "/health", {
        ...options,
        acceptNon2xxValidated: true,
        validateResponse: (data) =>
          data.status === "healthy" && data.observer?.healthy === true && data.tssParty?.healthy === true
            ? null : "unhealthy",
      });
    } catch (error) {
      const reason = error && error.message === "unhealthy" ? "unhealthy" : "poll-failed";
      results.push({
        ...resultBase(observer, "health-error", `${observedAt}:${sequence}`, observedAt),
        reason,
      });
    }

    try {
      const response = await fetchWithRetries(observer, "/provider-health", {
        ...options,
        validateResponse: (data) => {
          try { parseProviderHealth(data); return null; } catch (_error) { return "invalid response"; }
        },
      });
      const providerHealth = parseProviderHealth(response.data);
      const prior = previousCheckedAt.get(observer.id);
      previousCheckedAt.set(observer.id, providerHealth.checkedAt);
      if (prior === providerHealth.checkedAt) {
        results.push({
          ...resultBase(observer, "provider-health-error", `unchanged:${providerHealth.checkedAt}`, observedAt),
          reason: "file-not-updated",
          checkedAt: providerHealth.checkedAt,
        });
      } else if (providerHealth.failedProviderCount > 0) {
        results.push({
          ...resultBase(observer, "provider-health-result", providerHealth.checkedAt, observedAt),
          providerHealth,
        });
      }
    } catch (_error) {
      results.push({
        ...resultBase(observer, "provider-health-error", `poll:${observedAt}:${sequence}`, observedAt),
        reason: "poll-failed",
      });
    }
    return results;
  }

  async function pollAll(now = new Date()) {
    const observedAt = now.toISOString();
    sequence += 1;
    const nested = await Promise.all(observers.map((observer) => pollObserver(observer, observedAt)));
    snapshot = { generatedAt: observedAt, results: nested.flat() };
    return snapshot;
  }

  return {
    pollAll,
    getSnapshot: () => snapshot,
    intervalMs: DAY_MS,
  };
}

module.exports = {
  DAY_MS,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  createTssHealthPoller,
  fetchWithRetries,
  parseProviderHealth,
  requestJson,
};
