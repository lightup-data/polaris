.PHONY: dev dev-up dev-down api web daemon bridge test clean

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
# nohup so the service survives `make` exiting. A bare `&` leaves it as an
# orphaned job that receives SIGHUP and dies (banner prints, then it's gone);
# nohup makes it ignore SIGHUP. Logs go to /tmp/polaris-*.log.
api:
	@echo "Starting API server on http://localhost:4321"
	@nohup npx bun run src/service/server.ts >/tmp/polaris-api.log 2>&1 &

# Web app (port 3000)
web:
	@echo "Starting web app on http://localhost:3000"
	@nohup npx bun --hot run src/web/serve.ts >/tmp/polaris-web.log 2>&1 &

# Local daemon (port 4322) — uses local profile token if available
daemon:
	@echo "Starting daemon on http://127.0.0.1:4322"
	@TOKEN=$$(jq -r '.profiles.local.token // empty' ~/.polaris/config.json 2>/dev/null || echo ""); \
	POLARIS_DAEMON_PORT=4322 POLARIS_SERVICE_URL=http://localhost:4321 POLARIS_AUTH_TOKEN="$$TOKEN" nohup npx bun run src/daemon/daemon.ts >/tmp/polaris-daemon.log 2>&1 &

# Slack bridge (auto-detects org from DB, needs SLACK_APP_TOKEN in .env)
bridge:
	@if [ -z "$(SLACK_APP_TOKEN)" ]; then echo "Skipping bridge (no SLACK_APP_TOKEN in .env)"; else \
	  ORG=$$(docker exec collab-polaris-postgres-1 psql -U polaris -d polaris -t -A -c "SELECT id FROM orgs WHERE slack_team_id IS NOT NULL LIMIT 1;" 2>/dev/null); \
	  if [ -n "$$ORG" ]; then \
	    echo "Starting Slack bridge for org $$ORG"; \
	    nohup npx bun run src/slack/bridge.ts $$ORG >/tmp/polaris-bridge.log 2>&1 & \
	  else echo "Skipping bridge (no Slack-connected org found)"; fi; \
	fi

# Run tests
test:
	npx bun test

# Stop all background processes and Postgres
clean:
	@lsof -ti :4321 | xargs kill -9 2>/dev/null || true
	@lsof -ti :4322 | xargs kill -9 2>/dev/null || true
	@lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	@pgrep -f "bridge.ts" | xargs kill -9 2>/dev/null || true
	docker compose down
	@echo "Cleaned up"
