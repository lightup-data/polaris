.PHONY: dev dev-up dev-down api web daemon bridge test perf seo clean

# Load .env if it exists
ifneq (,$(wildcard .env))
  include .env
  export
endif

# Start everything for local development
dev: dev-up api web daemon bridge

# Postgres
dev-up:
	docker compose up -d

dev-down:
	docker compose down

# Cloud service API (port 4321)
api:
	@echo "Starting API server on http://localhost:4321"
	@npx bun run src/service/server.ts 2>/tmp/polaris-api.log &

# Web app (port 3000)
web:
	@echo "Starting web app on http://localhost:3000"
	@npx bun --hot run src/web/serve.ts &

# Local daemon (port 4322) — uses local profile token if available
daemon:
	@echo "Starting daemon on http://127.0.0.1:4322"
	@TOKEN=$$(jq -r '.profiles.local.token // empty' ~/.polaris/config.json 2>/dev/null || echo ""); \
	POLARIS_DAEMON_PORT=4322 POLARIS_SERVICE_URL=http://localhost:4321 POLARIS_AUTH_TOKEN="$$TOKEN" npx bun run src/daemon/daemon.ts &

# Slack bridge (auto-detects org from DB, needs SLACK_APP_TOKEN in .env)
bridge:
	@if [ -z "$(SLACK_APP_TOKEN)" ]; then echo "Skipping bridge (no SLACK_APP_TOKEN in .env)"; else \
	  ORG=$$(docker exec collab-polaris-postgres-1 psql -U polaris -d polaris -t -A -c "SELECT id FROM orgs WHERE slack_team_id IS NOT NULL LIMIT 1;" 2>/dev/null); \
	  if [ -n "$$ORG" ]; then \
	    echo "Starting Slack bridge for org $$ORG"; \
	    npx bun run src/slack/bridge.ts $$ORG 2>/tmp/polaris-bridge.log & \
	  else echo "Skipping bridge (no Slack-connected org found)"; fi; \
	fi

# Run tests
test:
	npx bun test

# Lighthouse performance audit against production
PERF_URL ?= https://app.withpolaris.ai
perf:
	@npx bun run scripts/perf-audit.ts $(PERF_URL)

# DataForSEO on-page SEO audit against production
SEO_URL ?= https://app.withpolaris.ai
seo:
	@npx bun run scripts/seo-audit.ts $(SEO_URL)

# Stop all background processes and Postgres
clean:
	@lsof -ti :4321 | xargs kill -9 2>/dev/null || true
	@lsof -ti :4322 | xargs kill -9 2>/dev/null || true
	@lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	@pgrep -f "bridge.ts" | xargs kill -9 2>/dev/null || true
	docker compose down
	@echo "Cleaned up"
