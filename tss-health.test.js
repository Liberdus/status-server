const assert = require("assert/strict");
const { createTssHealthPoller, MAX_ATTEMPTS, REQUEST_TIMEOUT_MS } = require("./tss-health");

const observer = { id: "signer-1", label: "Signer One", network: "testnet", baseUrl: "http://secret-host.invalid" };
const healthy = { status: "healthy", observer: { healthy: true }, tssParty: { healthy: true } };
const empty = { checkedAt: "2026-07-20T00:00:00.000Z", failedProviderCount: 0, failedProviders: [] };

async function run() {
  let calls = 0;
  const logs = [];
  const responses = new Map([["/health", healthy], ["/provider-health", empty]]);
  const requestJson = async (url, timeoutMs) => {
    calls += 1;
    assert.equal(timeoutMs, REQUEST_TIMEOUT_MS);
    const endpoint = new URL(url).pathname;
    return { statusCode: 200, data: responses.get(endpoint) };
  };
  const poller = createTssHealthPoller([observer], { requestJson, delay: async () => {}, log: (line) => logs.push(line) });
  assert.deepEqual((await poller.pollAll(new Date("2026-07-20T01:00:00Z"))).results, []);
  const unchanged = await poller.pollAll(new Date("2026-07-21T01:00:00Z"));
  assert.equal(unchanged.results[0].type, "provider-health-error");
  assert.equal(unchanged.results[0].reason, "file-not-updated");

  responses.set("/provider-health", {
    checkedAt: "2026-07-21T00:00:00.000Z",
    failedProviderCount: 1,
    failedProviders: [{ chainId: 97, chainName: "BSC Testnet", providerName: "alchemy" }],
  });
  const failed = await poller.pollAll(new Date("2026-07-22T01:00:00Z"));
  assert.equal(failed.results[0].type, "provider-health-result");
  assert.equal(JSON.stringify(failed).includes("secret-host"), false);

  let attempts = 0;
  const unreachable = createTssHealthPoller([observer], {
    requestJson: async () => { attempts += 1; throw new Error("SECRET_API_KEY https://leak.invalid"); },
    delay: async () => {},
    log: (line) => logs.push(line),
  });
  const errors = await unreachable.pollAll(new Date("2026-07-23T01:00:00Z"));
  assert.equal(attempts, MAX_ATTEMPTS * 2);
  assert.equal(errors.results.length, 2);
  assert.equal(logs.join("\n").includes("SECRET_API_KEY"), false);
  assert.equal(JSON.stringify(errors).includes("leak.invalid"), false);
  assert.ok(calls >= 6);
  console.log("tss-health tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
