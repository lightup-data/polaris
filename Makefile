.PHONY: dev dev-up dev-down api web daemon bridge test perf seo css css-watch clean prod

# Load .env if it exists
ifneq (,$(wildcard .env))
  include .env
  export
endif

# Build purged Tailwind CSS
css:
	@npx bun x tailwindcss -i src/web/styles/input.css -o src/web/styles/output.css --minify

css-watch:
	@npx bun x tailwindcss -i src/web/styles/input.css -o src/web/styles/output.css --watch

# Start everything for local development
dev: dev-up css api web daemon bridge

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
	  ORG=$$(docker compose exec -T polaris-postgres psql -U polaris -d polaris -t -A -c "SELECT id FROM orgs WHERE slack_team_id IS NOT NULL LIMIT 1;" 2>/dev/null); \
	  if [ -n "$$ORG" ]; then \
	    echo "Starting Slack bridge for org $$ORG"; \
	    nohup npx bun run src/slack/bridge.ts $$ORG >/tmp/polaris-bridge.log 2>&1 & \
	  else echo "Skipping bridge (no Slack-connected org found)"; fi; \
	fi

# Run web locally against prod DB
# Opens SSH tunnel to prod postgres, starts web app with hot reload, cleans up on Ctrl-C.
prod:
	@lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti :5433 | xargs kill -9 2>/dev/null || true
	@PW=$$(ssh deploy@withpolaris.ai "grep POSTGRES_PASSWORD /opt/polaris/.env" | cut -d= -f2); \
	PG_IP=$$(ssh deploy@withpolaris.ai "docker inspect polaris-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'"); \
	echo "Tunneling prod postgres ($$PG_IP:5432) to localhost:5433"; \
	ssh -f -N -L 5433:$$PG_IP:5432 deploy@withpolaris.ai; \
	echo "Starting web app on http://localhost:3000 (prod DB)"; \
	DATABASE_URL=postgres://polaris:$$PW@localhost:5433/polaris npx bun --hot run src/web/serve.ts; \
	lsof -ti :5433 | xargs kill 2>/dev/null || true

# Run tests
test:
	npx bun test

# Lighthouse performance audit against production and local
perf:
	@prod_failed=0; \
	npx bun run scripts/perf-audit.ts https://app.withpolaris.ai || prod_failed=1; \
	npx bun run scripts/perf-audit.ts local || exit 1; \
	if [ "$$prod_failed" = "1" ]; then exit 1; fi

# DataForSEO on-page SEO audit against production
SEO_URL ?= https://app.withpolaris.ai
seo:
	@npx bun run scripts/seo-audit.ts $(SEO_URL)

# Stop all background processes, tunnels, and Postgres
clean:
	@lsof -ti :4321 | xargs kill -9 2>/dev/null || true
	@lsof -ti :4322 | xargs kill -9 2>/dev/null || true
	@lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	@lsof -ti :5433 | xargs kill -9 2>/dev/null || true
	@pgrep -f "bridge.ts" | xargs kill -9 2>/dev/null || true
	docker compose down
	@echo "Cleaned up"
