const http = require("http");
const https = require("https");
const { URL } = require("url");

const PROCESS_HEALTH_INTERVAL_MS = 60_000;
const PROVIDER_HEALTH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const MAX_EVENTS = 500;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestJson(targetUrl, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: `${url.pathname}${url.search}`, method: "GET", timeout: timeoutMs,
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

function endpointUrl(baseUrl, endpoint) {
  return `${String(baseUrl).replace(/\/+$/, "")}${endpoint}`;
}

function severityForPercentage(percentage) {
  if (percentage <= 20) return "emergency";
  if (percentage <= 40) return "warning";
  return "normal";
}

function parseProviderHealth(value) {
  if (!value || typeof value !== "object" ||
      typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) ||
      !Array.isArray(value.chains) || !Array.isArray(value.failedProviders)) {
    throw new Error("invalid response");
  }
  const chains = value.chains.map((chain) => {
    if (!chain || typeof chain.chainId !== "number" || typeof chain.chainName !== "string" ||
        !Number.isInteger(chain.configuredCount) || chain.configuredCount < 0 ||
        !Number.isInteger(chain.healthyCount) || chain.healthyCount < 0 ||
        chain.healthyCount > chain.configuredCount ||
        typeof chain.healthyPercentage !== "number" || !Number.isFinite(chain.healthyPercentage) ||
        chain.healthyPercentage < 0 || chain.healthyPercentage > 100 ||
        Math.abs(chain.healthyPercentage - (chain.configuredCount === 0
          ? 0 : chain.healthyCount / chain.configuredCount * 100)) > Number.EPSILON * 100 ||
        chain.severity !== severityForPercentage(chain.healthyPercentage)) {
      throw new Error("invalid response");
    }
    return { chainId: chain.chainId, chainName: chain.chainName,
      configuredCount: chain.configuredCount, healthyCount: chain.healthyCount,
      healthyPercentage: chain.healthyPercentage, severity: chain.severity };
  });
  const failedProviders = value.failedProviders.map((provider) => {
    if (!provider || typeof provider.chainId !== "number" ||
        typeof provider.chainName !== "string" || typeof provider.providerName !== "string") {
      throw new Error("invalid response");
    }
    return { chainId: provider.chainId, chainName: provider.chainName, providerName: provider.providerName };
  });
  if (value.failedProviderCount !== failedProviders.length) throw new Error("invalid response");
  return { checkedAt: value.checkedAt, chains, failedProviderCount: failedProviders.length, failedProviders };
}

async function fetchWithRetries(observer, endpoint, options = {}) {
  const get = options.requestJson || requestJson;
  const wait = options.delay || delay;
  const log = options.log || ((line) => process.stdout.write(`${line}\n`));
  let lastFailure = "request failed";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await get(endpointUrl(observer.baseUrl, endpoint), REQUEST_TIMEOUT_MS);
      const validationFailure = response.data && typeof response.data === "object" && options.validateResponse
        ? options.validateResponse(response.data) : (!response.data || typeof response.data !== "object" ? "invalid response" : null);
      if (!validationFailure && ((response.statusCode >= 200 && response.statusCode < 300) || options.acceptNon2xxValidated)) return response;
      lastFailure = validationFailure || `HTTP ${response.statusCode}`;
    } catch (error) {
      lastFailure = error && error.message === "timeout" ? "timeout" : "request failed";
    }
    log(`[tss-health] observer=${observer.id} endpoint=${endpoint} attempt=${attempt}/${MAX_ATTEMPTS} failed: ${lastFailure}`);
    if (attempt < MAX_ATTEMPTS) await wait(0);
  }
  throw new Error(lastFailure);
}

function resultBase(observer, type, identity, observedAt) {
  return {
    id: `${observer.id}:${type}:${identity}`, observerId: observer.id, label: observer.label,
    observerAddress: new URL(observer.baseUrl).hostname, network: observer.network, type, observedAt,
  };
}

function validateObserver(observer) {
  return observer && typeof observer.id === "string" && typeof observer.label === "string" &&
    typeof observer.network === "string" && typeof observer.baseUrl === "string" &&
    /^https?:\/\//.test(observer.baseUrl);
}

function createTssHealthPoller(observers, options = {}) {
  if (!Array.isArray(observers) || observers.length === 0) {
    throw new Error("TSS observer configuration is required and must contain at least one observer");
  }
  if (!observers.every(validateObserver)) {
    throw new Error("Invalid TSS observer configuration: every entry requires id, label, network, and an http(s) baseUrl");
  }
  const previousHealth = new Map();
  let events = [];
  let generatedAt = null;
  let sequence = 0;

  function append(newEvents, observedAt) {
    generatedAt = observedAt;
    events = events.concat(newEvents).slice(-MAX_EVENTS);
    return { generatedAt, results: events.slice() };
  }

  async function pollProcessHealth(now = new Date()) {
    const observedAt = now.toISOString();
    sequence += 1;
    const results = await Promise.all(observers.map(async (observer) => {
      let health = null;
      let endpointFailed = false;
      try {
        const response = await fetchWithRetries(observer, "/health", {
          ...options, acceptNon2xxValidated: true,
          validateResponse: (data) => data.status && data.observer &&
            typeof data.observer.healthy === "boolean" && data.tssParty &&
            typeof data.tssParty.healthy === "boolean" ? null : "invalid response",
        });
        health = response.data;
      } catch (_error) {
        endpointFailed = true;
      }
      const failedComponents = endpointFailed ? ["endpoint"] : [
        ...(health.observer.healthy ? [] : ["observer"]),
        ...(health.tssParty.healthy ? [] : ["tss-party"]),
      ];
      const healthy = failedComponents.length === 0;
      const prior = previousHealth.get(observer.id);
      previousHealth.set(observer.id, healthy);
      if ((prior === undefined && healthy) || prior === healthy) return null;
      if (healthy) {
        return { ...resultBase(observer, "process-recovery", `${observedAt}:${sequence}`, observedAt), failedComponents: [] };
      }
      return { ...resultBase(observer, "process-outage", `${observedAt}:${sequence}`, observedAt), failedComponents };
    }));
    return append(results.filter(Boolean), observedAt);
  }

  async function pollProviderHealth(now = new Date()) {
    const observedAt = now.toISOString();
    const results = await Promise.all(observers.map(async (observer) => {
      try {
        const response = await fetchWithRetries(observer, "/provider-health", {
          ...options,
          validateResponse: (data) => { try { parseProviderHealth(data); return null; } catch (_error) { return "invalid response"; } },
        });
        const providerHealth = parseProviderHealth(response.data);
        const rank = { normal: 0, warning: 1, emergency: 2 };
        const severity = providerHealth.chains.reduce(
          (worst, chain) => rank[chain.severity] > rank[worst] ? chain.severity : worst, "normal");
        if (severity === "normal") return null;
        return { ...resultBase(observer, "provider-health-result", providerHealth.checkedAt, observedAt),
          severity, providerHealth };
      } catch (_error) {
        return null;
      }
    }));
    return append(results.filter(Boolean), observedAt);
  }

  return {
    pollProcessHealth, pollProviderHealth,
    pollAll: async (now = new Date()) => {
      await pollProcessHealth(now);
      return pollProviderHealth(now);
    },
    getSnapshot: () => ({ generatedAt, results: events.slice() }),
    processIntervalMs: PROCESS_HEALTH_INTERVAL_MS,
    providerIntervalMs: PROVIDER_HEALTH_INTERVAL_MS,
  };
}

module.exports = {
  DAY_MS: PROVIDER_HEALTH_INTERVAL_MS, PROCESS_HEALTH_INTERVAL_MS, PROVIDER_HEALTH_INTERVAL_MS,
  MAX_ATTEMPTS, MAX_EVENTS, REQUEST_TIMEOUT_MS, createTssHealthPoller, fetchWithRetries,
  parseProviderHealth, requestJson, severityForPercentage,
};
