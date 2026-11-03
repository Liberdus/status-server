const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { httpJsonGet } = require("./lib/probe-http");
const { createHistoryCache } = require("./lib/history-cache");
const { createRefreshRunner, mapLimited } = require("./lib/refresh");
const readHistory = createHistoryCache();
const PROBE_CONCURRENCY = 4;

function loadEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch (error) {}
}

loadEnvFile(path.join(__dirname, ".env"));

let sqlite3;
let db = null;
try {
  sqlite3 = require("sqlite3");
  db = new sqlite3.Database("./status-history.db");
  db.serialize(() => {
    db.run(
      "CREATE TABLE IF NOT EXISTS service_history (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, state TEXT NOT NULL, latency_ms INTEGER, checked_at INTEGER NOT NULL)"
    );
    db.run("CREATE INDEX IF NOT EXISTS service_history_service_time ON service_history (service_id, checked_at)");
    db.run("CREATE INDEX IF NOT EXISTS service_history_time ON service_history (checked_at)");
    process.stdout.write(
      "SQLite history database enabled at ./status-history.db\n"
    );
  });
} catch (error) {
  db = null;
  process.stdout.write(
    `SQLite history database disabled: ${
      error && error.message ? error.message : String(error)
    }\n`
  );
}

const PORT = process.env.PORT || 6969;

let SERVICES = [];
try {
  const servicesConfigPath = path.join(__dirname, "services.json");
  const raw = fs.readFileSync(servicesConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    SERVICES = parsed.map((service) => {
      const urlFromEnv =
        service.urlEnv && typeof service.urlEnv === "string"
          ? process.env[service.urlEnv]
          : undefined;
      const url = urlFromEnv || service.url || null;
      const network =
        typeof service.network === "string" && service.network.length > 0
          ? service.network
          : typeof service.environment === "string" &&
            service.environment.length > 0
          ? service.environment
          : null;
      return {
        id: service.id,
        name: service.name,
        network,
        environment: network,
        group: service.group,
        url,
        checker: service.checker,
        expectedStatus: service.expectedStatus,
        maxAgeSeconds: service.maxAgeSeconds,
      };
    });
  }
} catch (error) {
  SERVICES = [];
}

function checkByStatusEquals(service, payload) {
  const { json } = payload;
  const value = json && typeof json === "object" ? json.status : undefined;
  if (value === service.expectedStatus) {
    return { ok: true, reason: null };
  }
  if (value == null) {
    return { ok: false, reason: "Missing status field in response" };
  }
  return {
    ok: false,
    reason: `Status value "${value}" did not match expected "${service.expectedStatus}"`,
  };
}

function readCycleStartSeconds(json) {
  if (!json || typeof json !== "object") return null;
  const root = json.cycleInfo || json.cycles;
  if (!Array.isArray(root) || root.length === 0) return null;
  const first = root[0];
  if (!first || typeof first !== "object") return null;
  const value = first.start || (first.cycleRecord && first.cycleRecord.start);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) return numeric;
  }
  return null;
}

function checkByCycleFresh(service, payload) {
  const { json } = payload;
  const startSeconds = readCycleStartSeconds(json);
  if (startSeconds == null) {
    return { ok: false, reason: "Missing cycle start timestamp in response" };
  }
  const nowSeconds = Date.now() / 1000;
  const ageSeconds = nowSeconds - startSeconds;
  if (ageSeconds < 0) {
    return {
      ok: false,
      reason: `Cycle start timestamp is in the future (${ageSeconds.toFixed(
        0
      )}s)`,
    };
  }
  if (ageSeconds > service.maxAgeSeconds) {
    return {
      ok: false,
      reason: `Cycle start is stale (${ageSeconds.toFixed(
        0
      )}s old, allowed ${service.maxAgeSeconds}s)`,
    };
  }
  return { ok: true, reason: null };
}

async function probeService(service) {
  const startedAt = Date.now();
  if (!service.url) {
    const latencyMs = Date.now() - startedAt;
    return {
      id: service.id,
      name: service.name,
      network: service.network,
      environment: service.environment,
      group: service.group,
      url: null,
      state: "outage",
      latencyMs,
      detail: "Missing service URL configuration",
      lastCheckedAt: new Date().toISOString(),
      healthPct: 0,
    };
  }
  try {
    const payload = await httpJsonGet(service.url, 5000);
    if (payload.statusCode < 200 || payload.statusCode >= 300) {
      throw new Error("Probe returned an unsuccessful HTTP status");
    }
    const latencyMs = Date.now() - startedAt;
    const baseCheck =
      service.checker === "statusEquals"
        ? checkByStatusEquals(service, payload)
        : service.checker === "cycleFreshSeconds"
        ? checkByCycleFresh(service, payload)
        : { ok: false, reason: "Unknown checker configuration" };
    let state = "operational";
    let detail = baseCheck.reason || null;
    let healthPct = 100;
    if (!baseCheck.ok) {
      state = "degraded";
      healthPct = 20;
    } else if (latencyMs > 1000) {
      healthPct = 80;
    }
    return {
      id: service.id,
      name: service.name,
      network: service.network,
      environment: service.environment,
      group: service.group,
      url: service.url,
      state,
      latencyMs,
      detail,
      lastCheckedAt: new Date().toISOString(),
      healthPct,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return {
      id: service.id,
      name: service.name,
      network: service.network,
      environment: service.environment,
      group: service.group,
      url: service.url,
      state: "outage",
      latencyMs,
      detail: error.message || String(error),
      lastCheckedAt: new Date().toISOString(),
      healthPct: 0,
    };
  }
}

function computeIndicator(services) {
  if (!services.length) return { indicator: "unknown", description: "Status Unknown" };
  let indicator = "none";
  const total = services.length;
  if (total > 0) {
    let outageCount = 0;
    let degradedCount = 0;
    for (const service of services) {
      const pct =
        typeof service.healthPct === "number"
          ? service.healthPct
          : service.state === "operational"
          ? 100
          : service.state === "degraded"
          ? 20
          : 0;
      if (pct === 0) {
        outageCount += 1;
      } else if (pct < 100) {
        degradedCount += 1;
      }
    }
    if (outageCount > total / 2) {
      indicator = "major";
    } else if (outageCount > 0 || degradedCount > 0) {
      indicator = "minor";
    } else {
      indicator = "none";
    }
  }
  let description = "All Systems Operational";
  if (indicator === "minor") {
    description = "Partial System Outage";
  } else if (indicator === "major") {
    description = "Major Service Outage";
  }
  return { indicator, description };
}

let latestSnapshot = {
  generatedAt: null,
  services: [],
  indicator: "none",
  statusDescription: "Unknown",
};

function resolveIntervalMinutes(raw) {
  if (!raw || typeof raw !== "string") return 1440;
  const value = raw.toLowerCase();
  if (value === "5m") return 5;
  if (value === "10m") return 10;
  if (value === "20m") return 20;
  if (value === "30m") return 30;
  if (value === "1h") return 60;
  if (value === "1d") return 1440;
  return 1440;
}

function queryHistory(days, intervalMinutes, network, callback) {
  if (!db) {
    callback(new Error("History database is not available"), null);
    return;
  }
  const maxDays = 7;
  const clampedDays =
    typeof days === "number" && Number.isFinite(days) && days > 0
      ? Math.max(1, Math.min(Math.floor(days), maxDays))
      : maxDays;
  const safeIntervalMinutes =
    typeof intervalMinutes === "number" && Number.isFinite(intervalMinutes)
      ? Math.max(1, Math.floor(intervalMinutes))
      : 1440;
  const intervalMs = safeIntervalMinutes * 60 * 1000;
  const now = Date.now();
  const sinceMs = now - clampedDays * 24 * 60 * 60 * 1000;
  const allowedServiceIds = new Set(
    SERVICES.filter(
      (service) => !network || service.network === network
    ).map((service) => service.id)
  );
  const ids = [...allowedServiceIds];
  if (!ids.length) { callback(new Error("Unknown network"), null); return; }
  const placeholders = ids.map(() => "?").join(",");
  const sql = `SELECT service_id, state, checked_at FROM service_history
    WHERE service_id IN (${placeholders}) AND checked_at >= ?
    ORDER BY service_id, checked_at ASC`;
  db.all(sql, [...ids, sinceMs], (error, rows) => {
    if (error) {
      callback(error, null);
      return;
    }
    const byService = new Map();
    for (const row of rows || []) {
      const serviceId = row.service_id;
      if (!allowedServiceIds.has(serviceId)) {
        continue;
      }
      const checkedAt =
        typeof row.checked_at === "number"
          ? row.checked_at
          : Number(row.checked_at);
      if (!Number.isFinite(checkedAt)) {
        continue;
      }
      const bucketStart = Math.floor(checkedAt / intervalMs) * intervalMs;
      let perService = byService.get(serviceId);
      if (!perService) {
        perService = new Map();
        byService.set(serviceId, perService);
      }
      let bucket = perService.get(bucketStart);
      if (!bucket) {
        bucket = { scoreSum: 0, totalCount: 0, minScore: 100 };
        perService.set(bucketStart, bucket);
      }
      let sampleScore = 0;
      if (row.state === "operational" || row.state === "up") {
        sampleScore = 100;
      } else if (row.state === "slow") {
        sampleScore = 80;
      } else if (row.state === "issue" || row.state === "degraded") {
        sampleScore = 20;
      } else if (row.state === "down" || row.state === "outage") {
        sampleScore = 0;
      } else {
        sampleScore = 0;
      }
      bucket.totalCount += 1;
      bucket.scoreSum += sampleScore;
      if (sampleScore < bucket.minScore) {
        bucket.minScore = sampleScore;
      }
    }
    const totalDurationMs = clampedDays * 24 * 60 * 60 * 1000;
    const bucketCount = Math.max(
      1,
      Math.ceil(totalDurationMs / intervalMs)
    );
    const endBucketStart = Math.floor(now / intervalMs) * intervalMs;
    const startBucketStart =
      endBucketStart - (bucketCount - 1) * intervalMs;
    const services = [];
    for (const service of SERVICES) {
      if (network && service.network !== network) {
        continue;
      }
      const serviceId = service.id;
      const buckets = byService.get(serviceId) || new Map();
      const history = [];
      for (let i = 0; i < bucketCount; i += 1) {
        const startMs = startBucketStart + i * intervalMs;
        const bucket = buckets.get(startMs);
        const totalCount = bucket ? bucket.totalCount || 0 : 0;
        const minScore = bucket ? bucket.minScore : null;
        const successPct =
          totalCount > 0 && minScore != null ? minScore : null;
        history.push(successPct);
      }
      services.push({ id: serviceId, history });
    }
    process.stdout.write(
      `History query complete for last ${clampedDays} days across ${services.length} services at interval=${safeIntervalMinutes}m\n`
    );
    callback(null, {
      days: clampedDays,
      intervalMinutes: safeIntervalMinutes,
      startTimeMs: startBucketStart,
      services,
    });
  });
}

const PROBE_INTERVAL_MS = 300000;

async function refreshSnapshot() {
  const results = await mapLimited(SERVICES, PROBE_CONCURRENCY, probeService);
  const indicator = computeIndicator(results);
  if (db) {
    const stmt = db.prepare(
      "INSERT INTO service_history (service_id, state, latency_ms, checked_at) VALUES (?, ?, ?, ?)"
    );
    for (const service of results) {
      const checkedAt = Date.parse(service.lastCheckedAt);
      const pct =
        typeof service.healthPct === "number" ? service.healthPct : null;
      let historyState = "up";
      if (pct == null || Number.isNaN(pct)) {
        historyState = service.state || "up";
      } else if (pct < 10) {
        historyState = "down";
      } else if (pct < 50) {
        historyState = "issue";
      } else if (pct < 95) {
        historyState = "slow";
      } else {
        historyState = "up";
      }
      stmt.run(
        service.id,
        historyState,
        service.latencyMs,
        Number.isNaN(checkedAt) ? Date.now() : checkedAt
      );
    }
    stmt.finalize();
    const retentionMs = 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - retentionMs;
    db.run(
      "DELETE FROM service_history WHERE checked_at < ?",
      [cutoff]
    );
  }
  process.stdout.write(
    `Snapshot refreshed: ${results.length} services, indicator=${indicator.indicator}\n`
  );
  latestSnapshot = {
    generatedAt: new Date().toISOString(),
    services: results,
    indicator: indicator.indicator,
    statusDescription: indicator.description,
  };
}

const runRefresh = createRefreshRunner(refreshSnapshot);
const SNAPSHOT_MAX_AGE_MS = PROBE_INTERVAL_MS + Math.ceil(SERVICES.length / PROBE_CONCURRENCY) * 30000 + 60000;
function snapshotIsFresh() {
  const age = Date.now() - Date.parse(latestSnapshot.generatedAt);
  return latestSnapshot.services.length > 0 && Number.isFinite(age) && age >= 0 && age <= SNAPSHOT_MAX_AGE_MS;
}
function publicService(service) {
  return {
    id: service.id, name: service.name, network: service.network,
    environment: service.environment, group: service.group, state: service.state,
    healthPct: service.healthPct, latencyMs: service.latencyMs,
    lastCheckedAt: service.lastCheckedAt,
    detail: service.state === "operational" ? null : "Service check did not pass",
  };
}

runRefresh().catch((error) => {
  process.stdout.write(
    `Initial snapshot refresh error: ${error && error.message ? error.message : String(
      error
    )}\n`
  );
});
setInterval(() => {
  runRefresh().catch((error) => {
    process.stdout.write(
      `Periodic snapshot refresh error: ${error && error.message ? error.message : String(
        error
      )}\n`
    );
  });
}, PROBE_INTERVAL_MS);

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  let fullUrl;
  try { fullUrl = new URL(req.url, "http://localhost"); }
  catch { res.statusCode = 400; res.end("Invalid request"); return; }
  if (["/api/summary", "/api/history"].includes(fullUrl.pathname)) {
    const network = fullUrl.searchParams.get("network") || "testnet";
    if (!SERVICES.some(service => service.network === network)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Unknown network" }));
      return;
    }
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("status: running version: 0.01");
    return;
  }
  if (req.method === "GET" && fullUrl.pathname === "/api/history") {
    const daysParam = fullUrl.searchParams.get("days");
    const intervalParam = fullUrl.searchParams.get("interval");
    const networkParam = fullUrl.searchParams.get("network");
    const rawDays = Number(daysParam);
    const daysValue = Number.isFinite(rawDays) && rawDays > 0 ? Math.max(1, Math.min(7, Math.floor(rawDays))) : 7;
    const intervalMinutes = resolveIntervalMinutes(intervalParam);
    const targetNetwork = networkParam || "testnet";
    const cacheKey = JSON.stringify([daysValue, intervalMinutes, targetNetwork]);
    readHistory(cacheKey, done => queryHistory(daysValue, intervalMinutes, targetNetwork, done), (error, payload) => {
      if (error) {
        res.statusCode = error.busy ? 503 : db ? 500 : 503;
        if (error.busy) res.setHeader("Retry-After", "30");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(
          JSON.stringify({
            error: error.busy ? "History is busy; retry shortly" : db
              ? "Failed to read history"
              : "History database is not available",
          })
        );
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(JSON.stringify(payload));
    });
    return;
  }
  if (req.method === "GET" && fullUrl.pathname === "/api/summary") {
    if (!snapshotIsFresh()) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Status snapshot unavailable or stale", generatedAt: latestSnapshot.generatedAt }));
      return;
    }
    const networkParam = fullUrl.searchParams.get("network");
    const targetNetwork = networkParam || "testnet";
    const allowedServiceIds = new Set(
      SERVICES.filter(
        (service) => !targetNetwork || service.network === targetNetwork
      ).map((service) => service.id)
    );
    const services = latestSnapshot.services.filter((service) =>
      allowedServiceIds.has(service.id)
    );
    const indicator = computeIndicator(services);
    const payload = {
      generatedAt: latestSnapshot.generatedAt,
      services: services.map(publicService),
      indicator: indicator.indicator,
      statusDescription: indicator.description,
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify(payload));
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    const fresh = snapshotIsFresh();
    res.statusCode = fresh ? 200 : 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(
      JSON.stringify({
        status: fresh ? "ok" : "stale",
        generatedAt: latestSnapshot.generatedAt,
      })
    );
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, process.env.HOST || "127.0.0.1", () => {
  process.stdout.write(`Status backend listening on http://localhost:${PORT}\n`);
});
