# Status

This is a status updating service to monitor the current uptime for the services we have running to track outages at a glance.

## Frontend route map

- `/` – Overview dashboard with global status, aggregated uptime, and active incident count
- `/#services` – Per-service table with current status, 30‑day uptime, and last incident
- `/#history` – Incident history timeline showing recent incidents and affected services

Open `index.html` in a browser to view the current dashboard framework. Service data and incident history are mock values that can be wired to real uptime endpoints later.

## Running the backend server

The dashboard can talk to a small Node.js backend that probes your services and exposes JSON APIs.

1. Ensure you have a recent version of Node.js installed.
2. From the project root, create a `.env` file with your service URLs, for example:

   ```dotenv
   SVC_DEV_GATEWAY_URL=https://example.dev/gateway/status
   SVC_DEV_ARCHIVER_URL=https://example.dev/archiver/status
   SVC_TEST_ARCHIVER_3_URL=https://example.test/archiver-3/cycleinfo/1
   SVC_DISCORD_STATUS_BOT_URL=http://example.test:4702/discord/health
   DISCORD_STATUS_ALERT_CHANNEL_ID=123456789012345678
   DISCORD_STATUS_BOT_TOKEN=your_discord_bot_token
   # …other SVC_* variables as needed…
   ```
3. Start the backend server (matching the frontend default `API_BASE` on port `7070`):

   ```bash
   PORT=7070 node backend-server.js
   ```

   You should see output similar to:

   ```text
   Status backend listening on http://localhost:7070
   ```
4. Open `index.html` in your browser. By default the frontend will send requests to `http://localhost:7070` for:

   - `GET /api/summary` – current snapshot of all services
   - `GET /api/history?days=90&interval=5m` – historical uptime data

If you run the backend on a different host or port, set `window.LIBERDUS_STATUS_API` before loading `main.js` so the dashboard points at the correct base URL.

In `main.js` the current network is selected via:

```js
const CURRENT_NETWORK = "testnet"; // or "devnet"
```

This value is passed as `?network=...` to the backend APIs so the dashboard can focus on devnet, testnet, or any other environment you configure.

## How the system fits together

- **Backend**: `backend-server.js` (Node.js + optional SQLite)
  - Probes each configured service on a schedule and computes:
    - A per-service `state` (`operational`, `degraded`, or `outage`)
    - A global `indicator` and `statusDescription` for the whole system
  - Exposes JSON endpoints:
    - `GET /api/summary` – current snapshot (services + overall indicator)
    - `GET /api/history` – historical uptime by time bucket
    - `GET /health` – simple health check for the status server itself
- **Frontend**: `index.html` + `main.js`
  - Renders the Liberdus status dashboard in the browser.
  - Periodically calls the backend to:
    - Update the overview banner and per-service state.
    - Draw uptime bar charts from the historical data.
  - Pings `/health` every 30 seconds to show if the status backend is online.

`main.js` picks the backend URL like this:

```js
const API_BASE =
  typeof window !== "undefined" &&
  window.LIBERDUS_STATUS_API &&
  typeof window.LIBERDUS_STATUS_API === "string"
    ? window.LIBERDUS_STATUS_API
    : "http://localhost:7070";
```

If `window.LIBERDUS_STATUS_API` is set before `main.js` loads, the frontend will use that as the base URL. Otherwise it defaults to `http://localhost:7070`.

## Deploying the backend with pm2

For a long-running production deployment you can use [`pm2`](https://pm2.keymetrics.io/) to keep the backend alive and restart it on failure or reboot.

1. Install pm2 globally on the server:

   ```bash
   npm install -g pm2
   ```

2. On the server, clone this repository and create your `.env` file with the real service URLs.
3. Start the backend under pm2, choosing a port that will be exposed (for example `7070`):

   ```bash
   cd /path/to/Status
   PORT=7070 pm2 start backend-server.js --name liberdus-status
   ```

4. Check that it is running:

   ```bash
   pm2 status
   pm2 logs liberdus-status
   ```

5. To have pm2 restart the process after a reboot:

   ```bash
   pm2 save
   pm2 startup
   # follow the printed instructions once, then run `pm2 save` again if needed
   ```

With this setup the backend HTTP server will be accessible on:

- `http://SERVER_IP:7070` (directly by IP and port), and
- any DNS name (for example `status.example.com`) that resolves to `SERVER_IP` and forwards traffic to port `7070` (usually via a reverse proxy such as Nginx or a load balancer).

## Making the backend reachable via DNS

To make the status page available at a friendly name:

1. Create a DNS `A` or `AAAA` record:
   - `A` record: `status.example.com` → `SERVER_IP`.
   - Or `AAAA` record if your server has IPv6.
2. On the server, either:
   - Expose the backend port directly (e.g. allow `7070` in your firewall and security group), or
   - Put a reverse proxy in front (for example Nginx on port 80/443) that forwards requests to `http://127.0.0.1:7070`.

If you serve the frontend (the `index.html` + `main.js` files) from the same domain as the backend, you avoid most CORS issues.

## CORS configuration and avoiding CORS issues

The backend APIs set the `Access-Control-Allow-Origin` header so browsers can call them from other origins:

- `/api/summary`
- `/api/history`
- `/health`

By default, the backend is configured to allow all origins:

```js
res.setHeader("Access-Control-Allow-Origin", "*");
```

This is the simplest option and works when:

- You want to embed the status dashboard from multiple domains.
- You are not exposing sensitive data from the status API.

If you want to restrict access to a specific frontend origin (for example only `https://status.example.com`), update the backend responses to set:

```js
res.setHeader("Access-Control-Allow-Origin", "https://status.example.com");
```

In that case the browser will only accept responses when the page making the request is served from `https://status.example.com`. Make sure:

- The protocol, host, and port match exactly.
- You restart the backend after changing the header.

If you plan to call the backend from multiple known origins, you can implement a small whitelist in `backend-server.js` and choose the header based on `req.headers.origin`.

## How service health and colors are determined

At the lowest level each probe of a service produces:

- `state`: `"operational"`, `"degraded"`, or `"outage"`.
- `healthPct`: a numeric health score.

The backend follows these rules for each probe:

- Query the configured endpoint.
- If there is **no response** (timeout, connection error, etc.) →  
  - `state = "outage"`, `healthPct = 0`.
- If the endpoint responds, run the configured checker:
  - `checker: "httpOk"`:
    - Treats any HTTP `2xx` or `3xx` response as healthy.
  - `checker: "statusEquals"`:
    - Compares the JSON `status` field to `expectedStatus`.
  - `checker: "cycleFreshSeconds"`:
    - Reads the cycle start timestamp (for example `cycleInfo[0].start`).
    - Computes how old it is and compares it to `maxAgeSeconds` (typically 120s).
- If the checker reports **bad data** (missing status, mismatched status, or stale cycle) →  
  - `state = "degraded"`, `healthPct = 20`.
- If the checker reports **good data**:
  - If the response took **more than 1 second**:
    - `state = "operational"`, `healthPct = 80` (slow but not degraded).
  - If the response took **1 second or less**:
    - `state = "operational"`, `healthPct = 100`.

## Discord status bot alerting

Run `discord-status-bot-listener.js` as its own process, separate from
`backend-server.js`. This process watches the Discord status bot server from the
status server host and posts to Discord if the bot server is down. It also logs
in as a small failsafe Discord client that answers `/status bothealth` directly
from the status server watchdog snapshot, so that command can still work when
the watched Discord bot server is down.

Configure `SVC_DISCORD_STATUS_BOT_URL` with the bot server health route. When the
listener sees that route change from healthy to down, it sends a Discord message
using the configured bot token:

```dotenv
SVC_DISCORD_STATUS_BOT_URL=http://example.test:4702/discord/health
DISCORD_STATUS_ALERT_CHANNEL_ID=123456789012345678
DISCORD_STATUS_BOT_TOKEN=your_discord_bot_token
```

The token can also be provided as `STATUS_DISCORD_BOT_TOKEN` or
`DISCORD_BOT_TOKEN`. The channel can also be provided as
`STATUS_DISCORD_ALERT_CHANNEL_ID`.

Optional message overrides:

```dotenv
DISCORD_STATUS_BOT_DOWN_MESSAGE=Discord status bot server is down. Please restart it.
DISCORD_STATUS_BOT_RECOVERY_MESSAGE=Discord status bot server is back online.
DISCORD_STATUS_COMMAND_LISTENER=true
```

The listener also exposes its own status endpoint from the status server process:

```dotenv
DISCORD_STATUS_LISTENER_HOST=127.0.0.1
DISCORD_STATUS_LISTENER_PORT=4703
DISCORD_STATUS_LISTENER_PATH=/discord/status-bot-check
```

Default local URL:

```text
http://127.0.0.1:4703/discord/status-bot-check
```

This endpoint reports the status server listener's last check of the Discord bot
server without exposing the watched server URL.

The main status backend also proxies that local listener snapshot at:

```text
https://status.liberdus.com/api/discord-bot-status
```

That public API is what the Discord `/status bothealth` command reads. It
returns the status-server watchdog snapshot and does not include the watched bot
server URL.

Run it under pm2 as a separate service:

```bash
npm install discord.js
pm2 start discord-status-bot-listener.js --name liberdus-status-bot-listener
pm2 save
```

The status backend can still include `discord-status-bot` in `services.json` so
the web dashboard shows its state, but Discord alerting runs in the separate
listener process.

The failsafe Discord command listener uses the same bot token as the normal
Discord status bot. It registers the same `/status` command shape to avoid
removing the normal bot's other subcommands, but it only answers the
`/status bothealth` subcommand.

When the backend stores history, it converts `healthPct` into a daily/bucketed state using these thresholds:

- `< 10` → `down`
- `< 50` → `issue`
- `< 95` → `slow`
- otherwise → `up`

The historical API returns per-bucket `successPct` values based on those rules. The frontend:

- Uses `classifyStateFromPct(successPct)` to convert the percentage into `"up"`, `"partial"` or `"down"`.
- Colors bars and calendar cells based on that state:
  - `< 10` → red.
  - `< 50` → orange.
  - `< 95` → orange (slow/partial).
  - `≥ 95` → green.

This keeps backend scoring and frontend coloring aligned on a simple 0 / 20 / 80 / 100 model while only treating invalid or stale data as degraded.

## How overall status is determined

Each service that the backend probes ends up with a `state`:

77→- `operational` – checks are passing and data is fresh.
78→- `degraded` – checks are failing (wrong status, missing fields, or stale data).
- `outage` – endpoint is unreachable, missing configuration, or consistently failing.

The backend combines these into an overall indicator:

- `computeIndicator(services)` in `backend-server.js` counts:
  - `outageCount` – services in state `outage`
  - `degradedCount` – services in state `degraded`
  - `total` – total number of services
- Rules:
  - If **more than half** of all services are `outage` → indicator = `major`.
  - Else if **any** service is `outage` or `degraded` → indicator = `minor`.
  - Else → indicator = `none`.
- That indicator is mapped to a human description:
  - `none` → `All Systems Operational`
  - `minor` → `Partial System Outage`
  - `major` → `Major Service Outage`

The frontend uses a mirrored rule in `summarizeOverallStatus` to compute:

- `status` – `operational`, `degraded`, or `outage`
- `statusLabel` – text like `All Systems Operational` or `Partial System Outage`

The top banner:

- Uses `snapshot.statusDescription` from `/api/summary` when available.
- Falls back to its own `statusLabel` if the backend did not provide one.
- Applies CSS classes:
  - `degraded` when overall status is degraded.
  - `outage` when overall status is a major outage.

This keeps the UI and backend in sync and makes sure “Major Service Outage” is only shown when a majority of services are fully down.

## Backend health checks and refresh behavior

The frontend runs two different timers:

- **Every 5 minutes**: calls `/api/summary` and `/api/history` to refresh:
  - The overview banner.
  - Per-service status and uptime history charts.
- **Every 30 seconds**: calls `/health` to confirm that the backend is reachable.

When `/health` fails:

- The footer shows `Status server is down` and turns it red.

When `/health` starts succeeding again after failures:

- The footer switches to `Status server: online`.
- The frontend immediately triggers a data refresh, so you do not have to manually reload the page after bringing the backend back up.

## What the frontend expects from the backend

From `GET /api/summary`:

- An object with:
  - `services`: array of `{ id, name, environment, group, state, ... }`
  - `indicator`: `none` | `minor` | `major`
  - `statusDescription`: optional banner text (used when present)
  - `generatedAt`: ISO timestamp for “Last updated” in the footer

From `GET /api/history`:

- An object with:
  - `days`: number of days included
  - `intervalMinutes`: size of each bucket in minutes
  - `services`: array of `{ id, history }`, where `history` is an array of:
    - `{ date, successPct, state }` for each time bucket.

From `GET /health`:

- A simple JSON payload like:

  ```json
  {
    "status": "ok",
    "generatedAt": "2026-01-27T12:34:56.000Z"
  }
  ```

The important part is that it returns a `200 OK` with the CORS header so the frontend can tell the backend is alive.

## Adding or removing services

The backend tracks services via `services.json`:

```js
const SERVICES = [
  {
    id: "dev-gateway",
    name: "Gateway",
    network: "devnet",
    group: "Devnet",
    urlEnv: "SVC_DEV_GATEWAY_URL",
    checker: "statusEquals",
    expectedStatus: "online",
  },
  // ...
];
```

To **add** a new service:

1. Duplicate one of the existing entries in `SERVICES`.
2. Change:
   - `id` – a unique identifier for this service (no spaces).
   - `name` – label that will appear in the frontend.
   - `network` – e.g. `"devnet"`, `"testnet"`, `"shared"`.
   - `group` – grouping label, such as `"Devnet"`, `"Testnet"`, `"Core"`.
   - `urlEnv` – optional environment variable name that can override the endpoint on the server.
   - `url` – optional default endpoint the backend should probe when `urlEnv` is unset.
   - `checker` and its config:
     - `checker: "statusEquals"` with `expectedStatus`, when the endpoint returns JSON like `{ "status": "online" }`.
     - `checker: "cycleFreshSeconds"` with `maxAgeSeconds`, when the endpoint exposes cycle info and you want to ensure the latest cycle is recent.
     - `checker: "httpOk"`, when you only need to confirm that an HTTP server responds.
3. Add the corresponding environment variable in `.env`, for example:

   ```dotenv
   SVC_NEW_SERVICE_URL=https://example.test/new/status
   ```

4. Restart the backend:

   ```bash
   PORT=7070 node backend-server.js
   ```

To **remove** a service:

1. Delete its entry from the `SERVICES` array in `backend-server.js`.
2. Optionally remove the related environment variable from `.env`.
3. Restart the backend.

Once the backend is restarted:

- The new services will appear in the frontend automatically.
- Their status will be included in the overall banner and in the category/group they match.

Categories in the frontend are inferred from service names:

- Names containing `"gateway"`, `"archiver"`, `"explorer"`, `"monitor"`, `"notification"`, `"faucet"`, `"oauth"`, or `"golden"` are grouped under the matching category (Gateways, Archivers, Explorers, Monitors, Notification, Faucet, OAuth, Golden Ticket).
- If a service name does not contain any of these keywords, it is ignored for category-level grouping but still counted for the overall status.
