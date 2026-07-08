const assert = require("node:assert/strict");
const http = require("node:http");
const {
  createStatusServer,
  resetLatestTssProviderHealthAlert,
  getLatestTssProviderHealthAlert,
} = require("./backend-server");

function validPayload(overrides = {}) {
  return {
    source: "tss-signer",
    instanceId: "tss-signer-1",
    hostname: "bridge-observer-01",
    hostIp: "10.0.1.25",
    environment: "testnet",
    generatedAt: "2026-07-08T20:00:00.000Z",
    chains: [{
      chainId: 97,
      chainName: "BSC Testnet",
      totalProviderCount: 10,
      activeProviderCount: 4,
      activeProviderPercentage: 40,
      severity: "warning",
      failedProviders: ["alchemy", "infura"],
    }],
    ...overrides,
  };
}

function request({ port, method = "POST", path = "/api/tss-provider-health/alert", body, token }) {
  return new Promise((resolve, reject) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method,
      path,
      headers: method === "POST" ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(text),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (method === "POST") req.end(text);
    else req.end();
  });
}

async function withServer(server, fn) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function run() {
  resetLatestTssProviderHealthAlert();
  let forwardedBody = null;
  let forwardedAuth = null;
  const mockBot = http.createServer((req, res) => {
    forwardedAuth = req.headers.authorization;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      forwardedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await withServer(mockBot, async (botPort) => {
    const server = createStatusServer({
      tssProviderAlertToken: "shared-secret",
      discordBotAlertUrl: `http://127.0.0.1:${botPort}`,
      statusToBotAlertToken: "shared-secret-2",
    });
    await withServer(server, async (port) => {
      assert.equal((await request({ port, body: validPayload() })).statusCode, 401);
      assert.equal((await request({ port, body: validPayload(), token: "wrong" })).statusCode, 401);
      assert.equal((await request({ port, body: "{no", token: "shared-secret" })).statusCode, 400);
      assert.equal((await request({
        port,
        body: validPayload({ chains: [{ ...validPayload().chains[0], severity: "info" }] }),
        token: "shared-secret",
      })).statusCode, 400);
      assert.equal((await request({
        port,
        body: validPayload({ chains: [{ ...validPayload().chains[0], failedProviders: ["https://rpc.example/key"] }] }),
        token: "shared-secret",
      })).statusCode, 400);
      assert.equal((await request({
        port,
        body: validPayload({ chains: [{ ...validPayload().chains[0], failedProviders: ["alchemy?api_key=secret"] }] }),
        token: "shared-secret",
      })).statusCode, 400);

      const accepted = await request({ port, body: validPayload(), token: "shared-secret" });
      assert.equal(accepted.statusCode, 200);
      assert.equal(getLatestTssProviderHealthAlert().chains[0].severity, "warning");
      assert.equal(forwardedAuth, "Bearer shared-secret-2");
      assert.equal(forwardedBody.chains[0].failedProviders[0], "alchemy");

      const latest = await request({ port, method: "GET", path: "/api/tss-provider-health/latest" });
      assert.equal(latest.statusCode, 200);
      assert.match(latest.body, /BSC Testnet/);
    });
  });

  const failingForwardServer = createStatusServer({
    tssProviderAlertToken: "shared-secret",
    discordBotAlertUrl: "http://127.0.0.1:1",
    statusToBotAlertToken: "shared-secret-2",
  });
  await withServer(failingForwardServer, async (port) => {
    const res = await request({ port, body: validPayload(), token: "shared-secret" });
    assert.equal(res.statusCode, 502);
  });

  console.log("tss-provider-health status-server tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

