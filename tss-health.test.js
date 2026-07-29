const assert = require("assert/strict");
const {
  createTssHealthPoller, MAX_EVENTS, PROCESS_HEALTH_INTERVAL_MS,
  PROVIDER_HEALTH_INTERVAL_MS, severityForPercentage,
} = require("./tss-health");

const observer = { id: "signer-1", label: "Signer One", network: "testnet", baseUrl: "http://203.0.113.10:8080" };
const healthy = { status: "healthy", observer: { healthy: true }, tssParty: { healthy: true } };
const report = (percentage, checkedAt = "2026-07-20T00:00:00.000Z") => ({
  checkedAt,
  chains: [{ chainId: 97, chainName: "BSC Testnet", configuredCount: 20,
    healthyCount: percentage / 5, healthyPercentage: percentage, severity: severityForPercentage(percentage) }],
  failedProviderCount: 1,
  failedProviders: [{ chainId: 97, chainName: "BSC Testnet", providerName: "alchemy" }],
});

async function run() {
  assert.throws(() => createTssHealthPoller([]), /at least one observer/);
  assert.equal(severityForPercentage(20), "emergency");
  assert.equal(severityForPercentage(25), "warning");
  assert.equal(severityForPercentage(40), "warning");
  assert.equal(severityForPercentage(45), "normal");

  const responses = new Map([["/health", healthy], ["/provider-health", report(45)]]);
  const requestJson = async (url) => ({ statusCode: 200, data: responses.get(new URL(url).pathname) });
  const poller = createTssHealthPoller([observer], { requestJson, delay: async () => {}, log: () => {} });
  assert.equal(poller.processIntervalMs, PROCESS_HEALTH_INTERVAL_MS);
  assert.equal(poller.providerIntervalMs, PROVIDER_HEALTH_INTERVAL_MS);

  const initiallyDown = createTssHealthPoller([observer], {
    requestJson: async (url) => ({
      statusCode: 503,
      data: new URL(url).pathname === "/health"
        ? { status: "unhealthy", observer: { healthy: true }, tssParty: { healthy: false } }
        : report(45),
    }),
    delay: async () => {}, log: () => {},
  });
  const initialOutage = await initiallyDown.pollProcessHealth(new Date("2026-07-20T00:59:00Z"));
  assert.equal(initialOutage.results[0].type, "process-outage");
  assert.deepEqual(initialOutage.results[0].failedComponents, ["tss-party"]);

  assert.equal((await poller.pollProcessHealth(new Date("2026-07-20T01:00:00Z"))).results.length, 0);
  responses.set("/health", { status: "unhealthy", observer: { healthy: false }, tssParty: { healthy: true } });
  let snapshot = await poller.pollProcessHealth(new Date("2026-07-20T01:01:00Z"));
  assert.equal(snapshot.results.at(-1).type, "process-outage");
  assert.deepEqual(snapshot.results.at(-1).failedComponents, ["observer"]);
  const outageId = snapshot.results.at(-1).id;
  snapshot = await poller.pollProcessHealth(new Date("2026-07-20T01:02:00Z"));
  assert.equal(snapshot.results.at(-1).id, outageId);
  responses.set("/health", healthy);
  snapshot = await poller.pollProcessHealth(new Date("2026-07-20T01:03:00Z"));
  assert.equal(snapshot.results.at(-1).type, "process-recovery");

  responses.set("/provider-health", report(20));
  snapshot = await poller.pollProviderHealth(new Date("2026-07-20T02:00:00Z"));
  assert.equal(snapshot.results.at(-1).severity, "emergency");
  responses.set("/provider-health", report(40, "2026-07-21T00:00:00.000Z"));
  snapshot = await poller.pollProviderHealth(new Date("2026-07-21T02:00:00Z"));
  assert.equal(snapshot.results.at(-1).severity, "warning");
  const count = snapshot.results.length;
  responses.set("/provider-health", report(45, "2026-07-22T00:00:00.000Z"));
  assert.equal((await poller.pollProviderHealth()).results.length, count);

  // Both streams share one bounded event buffer.
  for (let i = 0; i < MAX_EVENTS + 10; i += 1) {
    responses.set("/provider-health", report(20, new Date(2026, 0, 1, 0, 0, i).toISOString()));
    await poller.pollProviderHealth();
  }
  assert.equal(poller.getSnapshot().results.length, MAX_EVENTS);
  console.log("tss-health tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
