# Deploy Polaris to Hetzner Cloud VPS

## Context

Polaris runs entirely on localhost. We need a production deployment so the API, web dashboard, Slack bridge, and Postgres all run on a Hetzner Cloud VPS with proper HTTPS. The daemon and MCP client stay local on each developer's machine — they talk to the cloud API.

Domain: `polaris.lightup.ai` (subdomains: `api.polaris.lightup.ai`, `app.polaris.lightup.ai`)

## Architecture

**On Hetzner VPS (Docker Compose):**
- **Caddy** — reverse proxy, automatic Let's Encrypt HTTPS (ports 80/443)
- **API** — `src/service/server.ts` (port 4321 internal)
- **Web** — `src/web/serve.ts` (port 3000 internal)
- **Bridge** — `src/slack/bridge.ts` (no port, outbound only)
- **Postgres 17** — persistent volume

**Stays local (each dev machine):**
- Daemon (port 4322)
- MCP client
- Hooks

## Files to Create

| File | Purpose |
|------|---------|
| `docker/Dockerfile` | Single Bun image, each service overrides CMD |
| `docker/Caddyfile` | Reverse proxy: app.polaris.lightup.ai → web:3000, api.polaris.lightup.ai → api:4321 |
| `docker/bridge-entrypoint.sh` | Wait for Postgres, discover org ID, start bridge |
| `src/bridge-discover-org.ts` | Tiny script: query DB for Slack-connected org ID |
| `docker-compose.prod.yml` | Full production orchestration |
| `.env.example` | Template of required env vars (no secrets) |
| `deploy.sh` | SSH deploy script: git pull + docker compose up |

## Code Change

**`src/service/server.ts`** — The API calls `http://localhost:${WEB_PORT}/api/notify-dashboard` to push SSE updates to the web app. In Docker, `localhost` doesn't reach other containers. Change to:
```
http://${process.env.WEB_HOST ?? "localhost"}:${WEB_PORT}/api/notify-dashboard
```
Set `WEB_HOST=web` in the production compose. Backward compatible for local dev.

## Docker Strategy

**Single Dockerfile**, multi-service via different `command:` overrides in compose:
```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
COPY docker/bridge-entrypoint.sh ./docker/
CMD ["bun", "run", "src/service/server.ts"]
```

**Bridge entrypoint** waits for Postgres, queries `orgs` table for first Slack-connected org, starts bridge with that ID. Retries every 30s if no org found.

## Caddy Config

```
app.polaris.lightup.ai {
    reverse_proxy web:3000
}

api.polaris.lightup.ai {
    reverse_proxy api:4321
}
```

Caddy auto-provisions Let's Encrypt certs. WebSocket upgrades pass through transparently.

## Production Compose (key decisions)

- Only Caddy exposes ports (80, 443). All other services are internal.
- Postgres has healthcheck; API and web depend on it.
- Bridge depends on API being healthy.
- Secrets via `.env` file on server (Docker Compose reads it automatically).
- Persistent volumes: `pgdata` (Postgres), `caddy_data` (TLS certs).

## Server Setup (one-time)

1. Provision Hetzner CX22 (2 vCPU, 4 GB RAM)
2. Install Docker + Docker Compose
3. Create deploy user, add SSH key
4. Clone repo to `/opt/polaris`
5. Create `.env` with production secrets
6. DNS: A records for `api.polaris.lightup.ai` and `app.polaris.lightup.ai` → VPS IP
7. Update Google OAuth + Slack redirect URIs to `https://app.polaris.lightup.ai/...`
8. Firewall: allow 80, 443, 22 only
9. `docker compose -f docker-compose.prod.yml up -d`

## Verification

1. `docker compose -f docker-compose.prod.yml up --build` locally — all services start
2. `curl https://api.polaris.lightup.ai/status` returns `{"ok":true}`
3. `https://app.polaris.lightup.ai` loads login page
4. Google SSO login works end-to-end
5. Slack bridge connects and posts to channels
6. Local daemon connects to `https://api.polaris.lightup.ai` and events flow
