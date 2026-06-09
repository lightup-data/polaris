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

# Login (opens browser for Google SSO, installs hooks + MCP server)
polaris login

# Check daemon status
polaris status
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
| `POLARIS_LONG_MSG` | `thread` | How long Slack messages are posted: `thread` (summary in channel, full content in thread reply) or `inline` (full message in channel) |
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

## Development

Services run as background processes. Logs go to `/tmp/polaris-*.log`. The Makefile's `clean` target kills all processes and stops Postgres.

Tests use a separate `polaris_test` database so dev data is preserved.
