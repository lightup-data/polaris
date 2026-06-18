# Polaris

Multiplayer collaboration for AI coding agents. Connects coding sessions (Claude Code, Cursor, etc.) to team communication channels (Slack, WhatsApp) so teammates can observe, advise, and coordinate in real time.

## Architecture

- **API** (`src/service/server.ts`) — Cloud service on port 4321. REST + WebSocket for projects, sessions, events.
- **Web** (`src/web/`) — Dashboard on port 3000. Google SSO, Slack OAuth, real-time SSE updates.
- **Daemon** (`src/daemon/daemon.ts`) — Local daemon on port 4322. Routes hook events from coding agents to the API.
- **MCP Client** (`src/client/client.ts`) — MCP channel server for Claude Code. Provides `/polaris` commands.
- **Slack Bridge** (`src/slack/bridge.ts`) — Bidirectional bridge between project event streams and Slack channels.
- **Hooks** (`hooks/`) — Shell scripts that capture coding agent interactions (prompts, responses, tool calls).

## Prerequisites

Install these before running the Quick Start:

| Tool | Why | Install |
|---|---|---|
| [Bun](https://bun.sh) | Runtime for all services, the CLI, and the test suite | `npm install -g bun`, `brew install oven-sh/bun/bun`, or `curl -fsSL https://bun.sh/install \| bash` |
| [Docker](https://docs.docker.com/get-docker/) | Runs the Postgres container | Docker Desktop (macOS/Windows) or Docker Engine (Linux) — must be **running** |

Then verify:

```sh
bun --version       # 1.x
docker info         # should succeed (daemon running)
```

> **Port 5432 must be free.** `docker compose up -d` binds Postgres to `5432`. If another
> Postgres already uses that port, either stop it, or run the container on `5433` and set
> `DATABASE_URL=postgres://polaris:polaris@127.0.0.1:5433/polaris` (and pass the same
> `DATABASE_URL` to `make test`, pointing at the `polaris_test` database).

> **Login needs Google OAuth.** `make dev` and `polaris login` authenticate via Google SSO,
> so `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` must be set in `.env` (see
> [Configuration](#configuration)). The test suite (`make test`) does **not** require this.

## Quick Start

```sh
# Install dependencies
bun install

# Start Postgres
docker compose up -d

# Start all services (API, web, daemon, bridge)
make dev

# Run tests
make test

# Stop everything
make clean
```

## CLI

```sh
# Install globally
npm install -g @lightupai/polaris

# Default setup: install local components + login to production
polaris

# Or run steps independently:
polaris install          # Install MCP server, hooks, skill, status line (no auth)
polaris login            # Authenticate against production
polaris login --local    # Authenticate against localhost (for local dev)

# Manage environments
polaris profiles         # List all profiles
polaris use local        # Switch to local dev
polaris use prod         # Switch to production

# Other commands
polaris daemon           # Start the local daemon
polaris status           # Show active profile, daemon state, sessions
polaris logout           # Remove active profile credentials
polaris logout --all     # Remove all credentials
```

## Configuration

Copy `.env.example` to `.env` and fill in your credentials. All settings are loaded by the Makefile and passed to services.

### Required

| Variable | Description |
|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | OAuth callback URL (e.g., `http://localhost:3000/auth/google/callback`) |
| `SLACK_CLIENT_ID` | Slack app client ID |
| `SLACK_CLIENT_SECRET` | Slack app client secret |
| `SLACK_APP_TOKEN` | Slack app-level token (for Socket Mode) |
| `SLACK_REDIRECT_URI` | Slack OAuth callback URL |

### Local Google OAuth setup

Login — both `polaris login --local` and the dashboard — uses Google SSO, so you need a Google OAuth client. (The repo ships `scripts/setup-google-oauth.sh`, but it overwrites `.env` and its automation is unreliable; set it up manually.)

1. Open the [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) and create or select a project.
2. **OAuth consent screen** (now called the *Google Auth Platform*): set User type **External**, fill in an app name and support email, and Save.
3. **Add yourself as a Test user.** In the redesigned console this moved — it's no longer on the consent screen. Go to **APIs & Services → OAuth consent screen → Audience** (left sidebar) — or directly [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience) — and under **Test users** click **+ Add users**, add the email you'll sign in with, and Save. This is **required** while the app is in *Testing* mode; without it, sign-in is blocked with `access_denied`.
4. **Create Credentials → OAuth client ID → Web application**.
5. Under **Authorized redirect URIs** (not "JavaScript origins"), add this **exactly**:
   ```
   http://localhost:3000/auth/google/callback
   ```
   It must match character-for-character — no trailing slash, `http` not `https`, `localhost` not `127.0.0.1`, port `3000`. This is the value the app sends by default (override with `GOOGLE_REDIRECT_URI`).
6. Copy the **Client ID** and **Client Secret** into `.env` — edit the existing empty lines, don't recreate the file (you'd lose `POSTGRES_PASSWORD`, the JWT secret, etc.):
   ```
   GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=<your-secret>
   ```
7. Reload so the values take effect: `make clean && make dev`.

> Redirect-URI changes can take a few minutes to propagate on Google's side. If you get `redirect_uri_mismatch` immediately after saving, wait ~5 minutes and retry.

### Local Slack app setup (optional)

Slack is optional — without `SLACK_APP_TOKEN`, `make dev` just skips the bridge. Set it up to mirror sessions to Slack channels. Slack has no API to create apps, so this is manual.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**. Name it "Polaris" and pick a workspace you can install into. (If your workspace requires admin approval to install apps, an admin must approve it — otherwise use a workspace where you're an admin.)
2. **OAuth & Permissions → Redirect URLs**: add `http://localhost:3000/slack/callback` and click **Save URLs**. Slack accepts `http://localhost` for local dev — just make sure you actually **Save** it. A missing or unsaved redirect URL is the usual cause of `redirect_uri did not match any configured URIs`. Under **Bot Token Scopes**, add: `channels:manage`, `channels:join`, `channels:read`, `chat:write`, `users:read`, `users:read.email`.
3. **Socket Mode**: toggle **Enable Socket Mode** on, then generate an app-level token (scope `connections:write`). Copy it — this is `SLACK_APP_TOKEN` (starts with `xapp-`).
4. **Event Subscriptions**: toggle **Enable Events** on, and under **Subscribe to bot events** add `message.channels`, then Save. **Required** for Slack messages to reach a session — without it the bridge connects but never receives messages.
5. **Basic Information**: copy the **Client ID** and **Client Secret**.
6. Add to `.env`:
   ```
   SLACK_CLIENT_ID=<client-id>
   SLACK_CLIENT_SECRET=<client-secret>
   SLACK_APP_TOKEN=xapp-<socket-mode-token>
   ```
   `SLACK_REDIRECT_URI` is optional — it defaults to `http://localhost:3000/slack/callback`. Only set it if you register a different URL (e.g. an `ngrok`/`cloudflared` tunnel when you need a public HTTPS callback).
7. `make clean && make dev`, then open the dashboard, log in, and click **Connect Slack → Allow** to install the bot. This stores the bot token on your org.

### Running the Slack bridge locally

The bridge (`src/slack/bridge.ts`) mirrors session activity to Slack and injects Slack replies back into sessions. It's part of `make dev` (`dev: dev-up api web daemon bridge`), but it only starts once an org is **Slack-connected** — so the first time there's a chicken-and-egg:

1. `make dev` — the bridge is **skipped** ("no Slack-connected org found"), because nothing is connected yet.
2. Complete **Connect Slack** on the dashboard (above) to link your org.
3. Start the bridge against the now-connected org **without restarting everything**:
   ```sh
   make bridge          # → "Starting Slack bridge for org <id>"
   ```

After that, the Slack connection lives in Postgres and **survives `make clean`** (which keeps the volume), so subsequent `make clean && make dev` runs start the bridge **automatically** — no separate `make bridge` needed. You'd only reconnect + re-run `make bridge` if you drop the DB volume (`docker compose down -v`).

Bridge logs: `/tmp/polaris-bridge.log`.

### Optional

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://polaris:polaris@localhost:5432/polaris` | Postgres connection string |
| `POLARIS_SERVICE_URL` | `http://localhost:4321` | API URL (used by daemon) |
| `POLARIS_DAEMON_PORT` | `4322` | Local daemon port |
| `POLARIS_LONG_MSG` | `snippet` | How long Slack messages are posted: `snippet` (preview + expandable file attachment), `thread` (preview + thread reply), or `inline` (full message in channel) |
| `POLARIS_PROMPT_STYLE` | — | Slack formatting style for prompts |

## Project Structure

```
src/
  service/     Cloud API + DB layer
  web/         Dashboard (Hono)
  daemon/      Local daemon
  client/      MCP channel server
  slack/       Slack bridge + formatting
  cli/         CLI (login, status)
hooks/         Capture scripts for coding agents
skills/        /polaris slash command skill
tests/         Test suite (bun test)
```

## TODOs / Known Issues

- [ ] Multiple bridge processes can spawn if `make dev` is run without `make clean` first — causes duplicate Slack posts
- [ ] Daemon token is cached for the process lifetime — if credentials change, daemon must be restarted
- [ ] `raw_turn` in Stop events can contain Unicode escape sequences that Postgres JSONB rejects — fallback retries without `raw_turn`
- [ ] `POLARIS_PROMPT_STYLE` env var exists but only `color-header` mode remains — clean up dead references
- [ ] No pagination on event queries — will be slow for projects with thousands of events
- [ ] Bridge polls DB every 5 seconds for new events — switch to Postgres LISTEN/NOTIFY for lower latency
- [ ] No auth on daemon HTTP endpoints — any local process can connect/disconnect sessions
- [ ] Slack channel creation uses sanitized project name — names with special characters may collide
- [ ] Dashboard SSE connection has no reconnect logic on the client side
- [ ] No way to delete a project or archive old sessions
- [ ] MCP server needs restart to pick up new tools (e.g., `polaris_rename` added mid-session)
- [ ] `capture-stop.ts` reads the full transcript file on every Stop event — expensive for long sessions
- [ ] Tool call rejection breaks logging — when the user rejects a tool call, no Stop event fires so the agent's response up to that point is never logged to Slack
- [ ] Schema migration drops all data — the auto-migration detects old schema and recreates tables, losing all events including device connections. Need a proper migration strategy for production.
- [ ] Capture all user input — currently only UserPromptSubmit is captured. Need to also capture tool call approvals, tool use rejections, ask-question responses, and any other user interaction that constitutes a prompt
- [ ] Postgres backup cron job — scheduled `pg_dump` to Hetzner object storage for production disaster recovery
- [ ] Daemon local buffer — write-ahead log for fault tolerance. If the API is slow or down, the daemon should persist events locally and flush them asynchronously with retry/backoff, so hooks and MCP tools never block or lose data
- [ ] Reconciliation and recovery — `polaris recover` command that diffs the daemon JSONL log against the DB, backfills missing events, and posts an abridged recovery summary to Slack as a thread reply at the correct timeline position
- [ ] CD pipeline for Hetzner — auto-deploy to production on merge to master (SSH + docker compose up), similar to the npm publish job
- [ ] Auto-update local skill/hooks — locally installed skill and hook files go stale when the repo changes. `polaris install` fixes it but there's no staleness detection or auto-update mechanism
- [ ] Update available indicator — daemon periodically checks npm for newer version, caches the result. Status line shows "update available" when stale. `polaris update` command installs the latest version and rewrites skill/hooks.
- [ ] Slack channel name collision — if a channel name was previously deleted, Slack reserves it. Bridge should handle `name_taken` by trying a prefix/suffix (e.g., `p-project-name`)

## Development

Services run as background processes. Logs go to `/tmp/polaris-*.log`. The Makefile's `clean` target kills all processes and stops Postgres.

Tests use a separate `polaris_test` database so dev data is preserved.
