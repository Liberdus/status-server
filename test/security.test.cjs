const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { once } = require("node:events");
const { httpJsonGet, httpStatusGet, MAX_RESPONSE_BYTES } = require("../lib/probe-http");
const { createHistoryCache } = require("../lib/history-cache");
const { createRefreshRunner, mapLimited } = require("../lib/refresh");

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("silent probes reject and subsequent probes recover", { timeout: 2000 }, async t => {
  let healthy = false;
  const url = await endpoint(t, (req, res) => { if (healthy) res.end('{"status":"online"}'); });
  await assert.rejects(httpJsonGet(url, 50), /deadline/);
  await assert.rejects(httpStatusGet(url, 50), /deadline/);
  healthy = true;
  assert.equal((await httpJsonGet(url, 500)).json.status, "online");
});

test("continuous data cannot extend a probe's total deadline", { timeout: 2000 }, async t => {
  const url = await endpoint(t, (req, res) => {
    res.writeHead(200); res.write(" ");
    const timer = setInterval(() => res.write(" "), 10);
    res.on("close", () => clearInterval(timer));
  });
  await assert.rejects(httpJsonGet(url, 70), /deadline/);
});

test("status-only probes finish without waiting for a response body", { timeout: 2000 }, async t => {
  const url = await endpoint(t, (req, res) => { res.writeHead(200); res.flushHeaders(); });
  assert.equal((await httpStatusGet(url, 100)).statusCode, 200);
});

test("response byte limits apply with and without Content-Length", async t => {
  for (const declared of [true, false]) {
    const url = await endpoint(t, (req, res) => {
      if (declared) res.setHeader("Content-Length", MAX_RESPONSE_BYTES + 1);
      res.end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 32));
    });
    await assert.rejects(httpJsonGet(url, 1000), /size limit/);
  }
});

test("truncated responses settle and invalid JSON has a bounded error", async t => {
  const broken = await endpoint(t, (req, res) => {
    res.writeHead(200, { "Content-Length": "1000" });
    res.write('{"status":');
    setTimeout(() => res.destroy(), 10);
  });
  await assert.rejects(httpJsonGet(broken, 500), /aborted|closed|failed/);
  const invalid = await endpoint(t, (req, res) => res.end("private upstream text"));
  await assert.rejects(httpJsonGet(invalid, 500), { message: "Probe response is not valid JSON" });
});

test("unsupported protocols and URL credentials are rejected", async () => {
  await assert.rejects(httpJsonGet("file:///etc/hosts", 100), /Unsupported/);
  await assert.rejects(httpJsonGet("http://user:pass@localhost/", 100), /Unsupported/);
});

test("refreshes coalesce, release on failure, and bound probe concurrency", async () => {
  let release;
  let calls = 0;
  const run = createRefreshRunner(() => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = run(); assert.equal(run(), first);
  await Promise.resolve(); assert.equal(calls, 1); release(); await first;
  const second = run(); await Promise.resolve(); assert.equal(calls, 2); release(); await second;
  const fail = createRefreshRunner(async () => { throw new Error("test"); });
  await assert.rejects(fail()); await assert.rejects(fail());
  let active = 0, peak = 0;
  const result = await mapLimited([1, 2, 3, 4, 5, 6], 2, async item => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return item * 2;
  });
  assert.equal(peak, 2); assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});

test("history requests coalesce, cache, and cap in-flight work and waiters", () => {
  const read = createHistoryCache({ maxInFlight: 1, maxWaiters: 2 });
  let complete, calls = 0;
  const loader = done => { calls++; complete = done; };
  const responses = [];
  read("one", loader, (error, value) => responses.push(value));
  read("one", loader, (error, value) => responses.push(value));
  read("one", loader, error => assert.equal(error.busy, true));
  read("two", loader, error => assert.equal(error.busy, true));
  complete(null, "cached");
  read("one", loader, (error, value) => responses.push(value));
  assert.equal(calls, 1); assert.deepEqual(responses, ["cached", "cached", "cached"]);
});

function loadBackend() {
  const filename = path.resolve(__dirname, "../backend-server.js");
  const source = fs.readFileSync(filename, "utf8");
  const localRequire = createRequire(filename);
  let handler;
  const context = vm.createContext({
    require(name) {
      if (name === "fs") return { readFileSync() { throw new Error("No local configuration in tests"); } };
      if (name === "sqlite3") throw new Error("Isolated test");
      if (name === "http") return { createServer(fn) { handler = fn; return {}; } };
      return localRequire(name);
    },
    __dirname: path.dirname(filename), Buffer, Date, URL,
    process: { env: {}, stdout: { write() {} } },
  });
  vm.runInContext(source.slice(0, source.indexOf("runRefresh().catch")), context);
  vm.runInContext(source.slice(source.indexOf("const server = http.createServer"), source.indexOf("server.listen(PORT")), context);
  vm.runInContext(`SERVICES = [{id: "test", name: "Gateway", network: "testnet"}];`, context);
  function request(url) {
    let body;
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(text) { body = JSON.parse(text); } };
    handler({ method: "GET", url }, res);
    return { res, get body() { return body; } };
  }
  return { context, request };
}

test("API rejects stale snapshots and serializes only public fields", () => {
  const { context, request } = loadBackend();
  vm.runInContext(`latestSnapshot = {generatedAt: "2000-01-01T00:00:00Z", services: [{id: "test"}]};`, context);
  assert.equal(request("/health").res.statusCode, 503);
  assert.equal(request("/api/summary?network=testnet").res.statusCode, 503);
  vm.runInContext(`latestSnapshot = {generatedAt: new Date().toISOString(), services: [{id: "test", name: "Gateway", state: "outage", url: "http://private.example/?secret=synthetic", detail: "private diagnostic"}]};`, context);
  const response = request("/api/summary?network=testnet");
  assert.equal(response.res.statusCode, 200);
  assert.equal(response.body.services[0].url, undefined);
  assert.equal(response.body.services[0].detail, "Service check did not pass");
  assert.equal(request("/health").res.statusCode, 200);
  assert.equal(request("/api/summary?network=unknown").res.statusCode, 400);
  assert.equal(request("/api/summary-extra").res.statusCode, 404);
});

test("history SQL filters by service and preserves missing samples", () => {
  const { context, request } = loadBackend();
  let queries = 0;
  context.testDb = { all(sql, params, done) {
    queries++;
    assert.match(sql, /service_id IN \(\?\).*checked_at >= \?/s);
    assert.match(sql, /ORDER BY service_id, checked_at/);
    assert.equal(params[0], "test");
    done(null, []);
  } };
  vm.runInContext("db = testDb", context);
  const first = request("/api/history?network=testnet&days=999&interval=5m");
  assert.equal(first.body.days, 7);
  assert(first.body.services[0].history.every(value => value === null));
  request("/api/history?network=testnet&days=8&interval=5m");
  assert.equal(queries, 1);
  assert.equal(request("/api/history?network=unknown").res.statusCode, 400);
  assert.equal(queries, 1);
});
