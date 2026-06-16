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

const BOT_HEALTH_URL = process.env.SVC_DISCORD_STATUS_BOT_URL || null;
const DISCORD_ALERT_CHANNEL_ID =
  process.env.DISCORD_STATUS_ALERT_CHANNEL_ID ||
  process.env.STATUS_DISCORD_ALERT_CHANNEL_ID ||
  null;
const DISCORD_ALERT_BOT_TOKEN =
  process.env.DISCORD_STATUS_BOT_TOKEN ||
  process.env.STATUS_DISCORD_BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN ||
  null;
const ENABLE_DISCORD_COMMAND_LISTENER =
  String(process.env.DISCORD_STATUS_COMMAND_LISTENER || "true").toLowerCase() !==
  "false";
const EPHEMERAL_FLAGS = 64;
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
const LISTENER_STATUS_PORT =
  Number.isFinite(Number(process.env.DISCORD_STATUS_LISTENER_PORT)) &&
  Number(process.env.DISCORD_STATUS_LISTENER_PORT) > 0
    ? Math.floor(Number(process.env.DISCORD_STATUS_LISTENER_PORT))
    : 4703;
const LISTENER_STATUS_HOST =
  process.env.DISCORD_STATUS_LISTENER_HOST || "127.0.0.1";
const LISTENER_STATUS_PATH =
  process.env.DISCORD_STATUS_LISTENER_PATH || "/discord/status-bot-check";

let lastAlertKind = null;
let checkInFlight = false;
let lastCheckSnapshot = {
  service_name: "discord bot watchdog",
  service_id: "discord-status-bot-listener",
  watched_service_name: "discord bot",
  watched_service_id: "status-discord-bot",
  status: "unknown",
  checkedAt: null,
  detail: "No checks have run yet",
  statusCode: null,
  targetConfigured: Boolean(BOT_HEALTH_URL),
  inFlight: false,
};

function buildStatusCommandDefinition() {
  return {
    name: "status",
    description: "Status notifier commands",
    options: [
      {
        type: 1,
        name: "help",
        description: "Show help",
      },
      {
        type: 1,
        name: "config",
        description: "Show current configuration",
      },
      {
        type: 1,
        name: "setchannel",
        description: "Set the channel to post alerts/reports",
        options: [
          {
            type: 7,
            name: "channel",
            description: "Target channel",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "setserverurl",
        description: "Set the Status backend base URL",
        options: [
          {
            type: 3,
            name: "url",
            description: "Example: http://host:3001",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "setnetwork",
        description: "Set the network query param",
        options: [
          {
            type: 3,
            name: "network",
            description: "Example: testnet",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "setinterval",
        description: "Set report interval",
        options: [
          {
            type: 3,
            name: "interval",
            description: "5m, 10m, 20m, 30m, 1h, 1d, off",
            required: true,
            choices: [
              { name: "5m", value: "5m" },
              { name: "10m", value: "10m" },
              { name: "20m", value: "20m" },
              { name: "30m", value: "30m" },
              { name: "1h", value: "1h" },
              { name: "1d", value: "1d" },
              { name: "off", value: "off" },
            ],
          },
        ],
      },
      {
        type: 1,
        name: "notifychanges",
        description: "Toggle per-service status change messages",
        options: [
          {
            type: 5,
            name: "enabled",
            description: "true/false",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "reportdownonly",
        description: "Only send scheduled cards when down or degraded",
        options: [
          {
            type: 5,
            name: "enabled",
            description: "true/false",
            required: true,
          },
        ],
      },
      {
        type: 1,
        name: "enable",
        description: "Enable monitoring",
      },
      {
        type: 1,
        name: "disable",
        description: "Disable monitoring",
      },
      {
        type: 1,
        name: "reportnow",
        description: "Post a status card now",
      },
      {
        type: 1,
        name: "bothealth",
        description: "Show the Discord bot watchdog status from the Status server",
      },
    ],
  };
}

function formatBotHealthResponse(snapshot) {
  const data = snapshot && typeof snapshot === "object" ? snapshot : {};
  const lines = [
    `Discord bot watchdog: ${data.status || "unknown"}`,
    `Watched service: ${data.watched_service_name || "discord bot"}`,
    "Source: status server watchdog",
  ];

  if (data.detail) {
    lines.push(`Detail: ${data.detail}`);
  }
  if (data.statusCode != null) {
    lines.push(`Watched endpoint HTTP: ${data.statusCode}`);
  }
  lines.push(`Checked at: ${data.checkedAt || "not checked yet"}`);
  return lines.join("\n");
}

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

  try {
    await postDiscordChannelMessage(
      DISCORD_ALERT_CHANNEL_ID,
      DISCORD_ALERT_BOT_TOKEN,
      message
    );
    lastAlertKind = nextKind;
    process.stdout.write(`Discord status bot listener ${nextKind} alert sent\n`);
  } catch (error) {
    process.stdout.write(
      `Discord status bot listener alert failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  }
}

async function checkBotServer() {
  if (checkInFlight) return;
  checkInFlight = true;
  lastCheckSnapshot = {
    ...lastCheckSnapshot,
    inFlight: true,
    targetConfigured: Boolean(BOT_HEALTH_URL),
  };
  try {
    if (!BOT_HEALTH_URL) {
      throw new Error("Missing SVC_DISCORD_STATUS_BOT_URL");
    }
    const result = await httpStatusGet(BOT_HEALTH_URL, REQUEST_TIMEOUT_MS);
    if (result.statusCode < 200 || result.statusCode >= 400) {
      throw new Error(`HTTP status ${result.statusCode}`);
    }
    await sendTransitionAlert("up");
    lastCheckSnapshot = {
      ...lastCheckSnapshot,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      detail: null,
      statusCode: result.statusCode,
      targetConfigured: true,
      inFlight: false,
      lastAlertKind,
    };
    process.stdout.write(
      `Discord status bot listener check ok: ${result.statusCode}\n`
    );
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    await sendTransitionAlert("down", detail);
    lastCheckSnapshot = {
      ...lastCheckSnapshot,
      status: "outage",
      checkedAt: new Date().toISOString(),
      detail,
      statusCode: null,
      targetConfigured: Boolean(BOT_HEALTH_URL),
      inFlight: false,
      lastAlertKind,
    };
    process.stdout.write(`Discord status bot listener check failed: ${detail}\n`);
  } finally {
    checkInFlight = false;
    lastCheckSnapshot = {
      ...lastCheckSnapshot,
      inFlight: false,
      lastAlertKind,
    };
  }
}

async function registerStatusCommand(client) {
  const command = buildStatusCommandDefinition();
  try {
    const guilds = await client.guilds.fetch();
    const entries = Array.from(guilds.values());
    let okCount = 0;
    for (const g of entries) {
      try {
        const guild = await client.guilds.fetch(g.id);
        await guild.commands.set([command]);
        okCount += 1;
      } catch (error) {}
    }
    process.stdout.write(
      `Discord status bot watchdog command registered in ${okCount}/${entries.length} guild(s)\n`
    );
  } catch (error) {
    process.stdout.write(
      `Discord status bot watchdog command registration failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  }
}

function startDiscordCommandListener() {
  if (!ENABLE_DISCORD_COMMAND_LISTENER) {
    process.stdout.write("Discord status bot command listener disabled\n");
    return;
  }
  if (!DISCORD_ALERT_BOT_TOKEN) {
    process.stdout.write(
      "Discord status bot command listener skipped: missing DISCORD_STATUS_BOT_TOKEN\n"
    );
    return;
  }

  let discord;
  try {
    discord = require("discord.js");
  } catch (error) {
    process.stdout.write(
      "Discord status bot command listener skipped: install discord.js in status-backend to enable /status bothealth\n"
    );
    return;
  }

  const client = new discord.Client({
    intents: [discord.GatewayIntentBits.Guilds],
  });

  client.on("ready", () => {
    process.stdout.write(
      `Discord status bot watchdog logged in as ${client.user.tag}\n`
    );
    registerStatusCommand(client).catch((error) => {
      process.stdout.write(
        `Discord status bot watchdog command registration error: ${
          error && error.message ? error.message : String(error)
        }\n`
      );
    });
  });

  client.on("guildCreate", () => {
    registerStatusCommand(client).catch((error) => {
      process.stdout.write(
        `Discord status bot watchdog guild command registration error: ${
          error && error.message ? error.message : String(error)
        }\n`
      );
    });
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction || !interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "status") return;
      const sub = interaction.options.getSubcommand();
      if (sub !== "bothealth") return;
      await interaction.reply({
        content: formatBotHealthResponse(lastCheckSnapshot),
        flags: EPHEMERAL_FLAGS,
      });
    } catch (error) {
      process.stdout.write(
        `Discord status bot watchdog interaction failed: ${
          error && error.message ? error.message : String(error)
        }\n`
      );
    }
  });

  client.on("error", (error) => {
    process.stdout.write(
      `Discord status bot watchdog client error: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  });

  client.login(DISCORD_ALERT_BOT_TOKEN).catch((error) => {
    process.stdout.write(
      `Discord status bot watchdog login failed: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  });
}

const statusServer = http.createServer((req, res) => {
  const requestPath = req.url ? req.url.split("?")[0] : "";
  if (req.method !== "GET" || requestPath !== LISTENER_STATUS_PATH) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ status: "not_found" }));
    return;
  }
  res.statusCode = lastCheckSnapshot.status === "healthy" ? 200 : 503;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(lastCheckSnapshot));
});

statusServer.on("error", (error) => {
  process.stdout.write(
    `Discord status bot listener status endpoint error: ${
      error && error.message ? error.message : String(error)
    }\n`
  );
});

statusServer.listen(LISTENER_STATUS_PORT, LISTENER_STATUS_HOST, () => {
  process.stdout.write(
    `Discord status bot listener endpoint listening on http://${LISTENER_STATUS_HOST}:${LISTENER_STATUS_PORT}${LISTENER_STATUS_PATH}\n`
  );
});

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
startDiscordCommandListener();
setInterval(() => {
  checkBotServer().catch((error) => {
    process.stdout.write(
      `Discord status bot listener periodic check error: ${
        error && error.message ? error.message : String(error)
      }\n`
    );
  });
}, CHECK_INTERVAL_MS);
