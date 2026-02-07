const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

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
  } catch (error) {
    process.stderr.write(
      `Warning: Failed to load .env file: ${error && error.message ? error.message : String(error)}\n`
    );
  }
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

function httpJsonGet(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const urlObj = new URL(targetUrl);
    const isHttps = urlObj.protocol === "https:";
    const transport = isHttps ? https : http;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      port: urlObj.port || (isHttps ? 443 : 80),
      method: "GET",
      timeout: timeoutMs,
    };
    const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit
    const req = transport.request(options, (res) => {
      const chunks = [];
      let totalSize = 0;
      res.on("data", (chunk) => {
        if (settled) return;
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          settled = true;
          req.destroy(new Error("Response body exceeds maximum size"));
          reject(new Error("Response body exceeds maximum size"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          const json = JSON.parse(body);
          resolve({ statusCode: res.statusCode, json });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error("Request timeout"));
    });
    req.end();
  });
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
      ? Math.min(Math.floor(days), maxDays)
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
  const sql =
    "SELECT service_id, state, checked_at FROM service_history WHERE checked_at >= ? ORDER BY checked_at ASC";
  db.all(sql, [sinceMs], (error, rows) => {
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
          totalCount > 0 && minScore != null ? minScore : 0;
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

async function refreshSnapshot() {
  const results = await Promise.all(SERVICES.map((service) => probeService(service)));
  const indicator = computeIndicator(results);
  if (db) {
    try {
      const stmt = db.prepare(
        "INSERT INTO service_history (service_id, state, latency_ms, checked_at) VALUES (?, ?, ?, ?)"
      );
      try {
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
      } finally {
        stmt.finalize();
      }
      const retentionMs = 7 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - retentionMs;
      db.run(
        "DELETE FROM service_history WHERE checked_at < ?",
        [cutoff],
        (err) => {
          if (err) {
            process.stdout.write(
              `Warning: Failed to clean old history: ${err.message}\n`
            );
          }
        }
      );
    } catch (error) {
      process.stdout.write(
        `Warning: Failed to save history: ${error && error.message ? error.message : String(error)}\n`
      );
    }
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

refreshSnapshot().catch((error) => {
  process.stdout.write(
    `Initial snapshot refresh error: ${error && error.message ? error.message : String(
      error
    )}\n`
  );
});
setInterval(() => {
  refreshSnapshot().catch((error) => {
    process.stdout.write(
      `Periodic snapshot refresh error: ${error && error.message ? error.message : String(
        error
      )}\n`
    );
  });
}, 300000);

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("status: running version: 0.01");
    return;
  }
  if (req.method === "GET" && req.url && req.url.startsWith("/api/history")) {
    const fullUrl = new URL(req.url, `http://localhost:${PORT}`);
    const daysParam = fullUrl.searchParams.get("days");
    const intervalParam = fullUrl.searchParams.get("interval");
    const networkParam = fullUrl.searchParams.get("network");
    const daysValue = daysParam ? Number(daysParam) : 7;
    const intervalMinutes = resolveIntervalMinutes(intervalParam);
    const targetNetwork = networkParam || "testnet";
    queryHistory(daysValue, intervalMinutes, targetNetwork, (error, payload) => {
      if (error) {
        res.statusCode = db ? 500 : 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(
          JSON.stringify({
            error: db
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
  if (req.method === "GET" && req.url && req.url.startsWith("/api/summary")) {
    const fullUrl = new URL(req.url, `http://localhost:${PORT}`);
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
      services,
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
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(
      JSON.stringify({
        status: "ok",
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

server.listen(PORT, () => {
  process.stdout.write(`Status backend listening on http://localhost:${PORT}\n`);
});

function gracefulShutdown() {
  process.stdout.write("Shutting down gracefully...\n");
  server.close(() => {
    process.stdout.write("HTTP server closed\n");
    if (db) {
      db.close((err) => {
        if (err) {
          process.stderr.write(`Error closing database: ${err.message}\n`);
          process.exit(1);
        } else {
          process.stdout.write("Database closed\n");
          process.exit(0);
        }
      });
    } else {
      process.exit(0);
    }
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    process.stderr.write("Forced shutdown after timeout\n");
    if (db) {
      db.close(() => {});
    }
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
