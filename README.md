# Polaris

Multiplayer collaboration for AI coding agents. Connects coding sessions (Claude Code, Cursor, etc.) to team communication channels (Slack, WhatsApp) so teammates can observe, advise, and coordinate in real time.

## Architecture

- **API** (`src/service/server.ts`) — Cloud service on port 4321. REST + WebSocket for projects, sessions, events.
- **Web** (`src/web/`) — Dashboard on port 3000. Google SSO, Slack OAuth, real-time SSE updates.
- **Daemon** (`src/daemon/daemon.ts`) — Local daemon on port 4322. Routes hook events from coding agents to the API.
- **MCP Client** (`src/client/client.ts`) — MCP channel server for Claude Code. Provides `/polaris` commands.
- **Slack Bridge** (`src/slack/bridge.ts`) — Bidirectional bridge between project event streams and Slack channels.
- **Hooks** (`hooks/`) — Shell scripts that capture coding agent interactions (prompts, responses, tool calls).

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

## Testing

```sh
# Unit tests (uses polaris_test database)
make test

# Lighthouse performance audit against production
# Runs mobile + desktop, checks budgets (score >= 90, FCP <= 1.8s, LCP <= 2.5s)
# Saves results to docs/audits/perf-audit-YYYY-MM-DD.json
make perf

# DataForSEO on-page SEO audit against production
# Checks meta tags, headings, social tags, content rate, technical SEO
# Saves results to docs/audits/seo-audit-YYYY-MM-DD.json
# Requires DataForSEO API credentials (see scripts/seo-audit.ts)
make seo
```

All three targets exit non-zero on failure. `make perf` and `make seo` run against the live production site (`app.withpolaris.ai`) by default. Override with `make perf PERF_URL=http://localhost:3000` or `make seo SEO_URL=http://localhost:3000`.

Audit results are saved as JSON in `docs/audits/` for historical tracking.

## Development

Services run as background processes. Logs go to `/tmp/polaris-*.log`. The Makefile's `clean` target kills all processes and stops Postgres.

Tests use a separate `polaris_test` database so dev data is preserved.
