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
  } catch (error) {}
}

loadEnvFile(path.join(__dirname, ".env"));

const DEFAULT_BOT_HEALTH_URL = "http://198.96.88.75:4702/health";
const BOT_HEALTH_URL =
  process.env.SVC_DISCORD_STATUS_BOT_URL || DEFAULT_BOT_HEALTH_URL;
const DISCORD_ALERT_CHANNEL_ID =
  process.env.DISCORD_STATUS_ALERT_CHANNEL_ID ||
  process.env.STATUS_DISCORD_ALERT_CHANNEL_ID ||
  null;
const DISCORD_ALERT_BOT_TOKEN =
  process.env.DISCORD_STATUS_BOT_TOKEN ||
  process.env.STATUS_DISCORD_BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN ||
  null;
const CHECK_INTERVAL_MS =
  Number.isFinite(Number(process.env.DISCORD_STATUS_BOT_CHECK_INTERVAL_MS)) &&
  Number(process.env.DISCORD_STATUS_BOT_CHECK_INTERVAL_MS) > 0
    ? Math.floor(Number(process.env.DISCORD_STATUS_BOT_CHECK_INTERVAL_MS))
    : 60000;
const REQUEST_TIMEOUT_MS =
  Number.isFinite(Number(process.env.DISCORD_STATUS_BOT_TIMEOUT_MS)) &&
  Number(process.env.DISCORD_STATUS_BOT_TIMEOUT_MS) > 0
    ? Math.floor(Number(process.env.DISCORD_STATUS_BOT_TIMEOUT_MS))
    : 5000;
const DOWN_MESSAGE =
  process.env.DISCORD_STATUS_BOT_DOWN_MESSAGE ||
  "Discord status bot server is down. Please restart it.";
const RECOVERY_MESSAGE =
  process.env.DISCORD_STATUS_BOT_RECOVERY_MESSAGE ||
  "Discord status bot server is back online.";

let lastAlertKind = null;
let checkInFlight = false;

function httpStatusGet(targetUrl, timeoutMs) {
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
    const req = transport.request(options, (res) => {
      res.resume();
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: res.statusCode });
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

function postDiscordChannelMessage(channelId, token, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    });
    const req = https.request(
      {
        hostname: "discord.com",
        path: `/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
        port: 443,
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(
            new Error(
              `Discord API returned ${res.statusCode}: ${responseBody || "empty response"}`
            )
          );
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Discord API request timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function sendTransitionAlert(nextKind, detail) {
  if (lastAlertKind === nextKind) return;
  if (lastAlertKind == null && nextKind === "up") {
    lastAlertKind = nextKind;
    return;
  }
  if (!DISCORD_ALERT_CHANNEL_ID || !DISCORD_ALERT_BOT_TOKEN) {
    if (nextKind === "down") {
      process.stdout.write(
        "Discord status bot listener alert skipped: missing DISCORD_STATUS_ALERT_CHANNEL_ID or bot token\n"
      );
    }
    lastAlertKind = nextKind;
    return;
  }

  const message =
    nextKind === "down"
      ? `${DOWN_MESSAGE}${detail ? ` Detail: ${detail}` : ""}`
      : RECOVERY_MESSAGE;

  await postDiscordChannelMessage(
    DISCORD_ALERT_CHANNEL_ID,
    DISCORD_ALERT_BOT_TOKEN,
    message
  );
  lastAlertKind = nextKind;
  process.stdout.write(`Discord status bot listener ${nextKind} alert sent\n`);
}

async function checkBotServer() {
  if (checkInFlight) return;
  checkInFlight = true;
  try {
    const result = await httpStatusGet(BOT_HEALTH_URL, REQUEST_TIMEOUT_MS);
    if (result.statusCode < 200 || result.statusCode >= 400) {
      throw new Error(`HTTP status ${result.statusCode}`);
    }
    await sendTransitionAlert("up");
    process.stdout.write(
      `Discord status bot listener check ok: ${result.statusCode}\n`
    );
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    await sendTransitionAlert("down", detail);
    process.stdout.write(`Discord status bot listener check failed: ${detail}\n`);
  } finally {
    checkInFlight = false;
  }
}

process.stdout.write(
  `Discord status bot listener starting; interval=${CHECK_INTERVAL_MS}ms\n`
);
checkBotServer().catch((error) => {
  process.stdout.write(
    `Discord status bot listener initial check error: ${
      error && error.message ? error.message : String(error)
    }\n`
  );
});
setInterval(() => {
  checkBotServer().catch((error) => {
    process.stdout.write(
      `Discord status bot listener periodic check error: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  });
}, CHECK_INTERVAL_MS);
