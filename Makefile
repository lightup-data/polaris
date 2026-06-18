.PHONY: dev dev-up dev-down api web daemon bridge test perf clean

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
	@echo "Running Lighthouse against $(PERF_URL) ..."
	@npx --yes lighthouse $(PERF_URL) \
		--only-categories=performance \
		--output=json \
		--output-path=./lighthouse-mobile.json \
		--chrome-flags="--headless --no-sandbox" 2>/dev/null
	@npx lighthouse $(PERF_URL) \
		--only-categories=performance \
		--preset=desktop \
		--output=json \
		--output-path=./lighthouse-desktop.json \
		--chrome-flags="--headless --no-sandbox" 2>/dev/null
	@node -e " \
		const m = require('./lighthouse-mobile.json'); \
		const d = require('./lighthouse-desktop.json'); \
		const ms = m.categories.performance.score * 100; \
		const ds = d.categories.performance.score * 100; \
		const mFCP = m.audits['first-contentful-paint'].numericValue; \
		const dFCP = d.audits['first-contentful-paint'].numericValue; \
		const mLCP = m.audits['largest-contentful-paint'].numericValue; \
		const dLCP = d.audits['largest-contentful-paint'].numericValue; \
		const mTBT = m.audits['total-blocking-time'].numericValue; \
		const dTBT = d.audits['total-blocking-time'].numericValue; \
		const mCLS = m.audits['cumulative-layout-shift'].numericValue; \
		const dCLS = d.audits['cumulative-layout-shift'].numericValue; \
		const mSI  = m.audits['speed-index'].numericValue; \
		const dSI  = d.audits['speed-index'].numericValue; \
		const mW   = m.audits['total-byte-weight'].numericValue; \
		const dW   = d.audits['total-byte-weight'].numericValue; \
		console.log(''); \
		console.log('  Metric                  Mobile     Desktop'); \
		console.log('  ──────────────────────────────────────────'); \
		console.log('  Performance score       ' + String(ms).padStart(6) + '     ' + String(ds).padStart(6)); \
		console.log('  First Contentful Paint  ' + (mFCP/1000).toFixed(1).padStart(5) + 's    ' + (dFCP/1000).toFixed(1).padStart(5) + 's'); \
		console.log('  Largest Contentful Paint' + (mLCP/1000).toFixed(1).padStart(5) + 's    ' + (dLCP/1000).toFixed(1).padStart(5) + 's'); \
		console.log('  Total Blocking Time     ' + String(Math.round(mTBT)).padStart(4) + 'ms    ' + String(Math.round(dTBT)).padStart(4) + 'ms'); \
		console.log('  Cumulative Layout Shift ' + mCLS.toFixed(3).padStart(6) + '     ' + dCLS.toFixed(3).padStart(6)); \
		console.log('  Speed Index             ' + (mSI/1000).toFixed(1).padStart(5) + 's    ' + (dSI/1000).toFixed(1).padStart(5) + 's'); \
		console.log('  Page weight             ' + Math.round(mW/1024) + ' KB     ' + Math.round(dW/1024) + ' KB'); \
		console.log(''); \
		let fail = false; \
		if (ms < 90) { console.error('  FAIL: Mobile score ' + ms + ' < 90'); fail = true; } \
		if (ds < 90) { console.error('  FAIL: Desktop score ' + ds + ' < 90'); fail = true; } \
		if (mFCP > 1800) { console.error('  FAIL: Mobile FCP ' + (mFCP/1000).toFixed(1) + 's > 1.8s'); fail = true; } \
		if (dFCP > 1800) { console.error('  FAIL: Desktop FCP ' + (dFCP/1000).toFixed(1) + 's > 1.8s'); fail = true; } \
		if (mLCP > 2500) { console.error('  FAIL: Mobile LCP ' + (mLCP/1000).toFixed(1) + 's > 2.5s'); fail = true; } \
		if (dLCP > 2500) { console.error('  FAIL: Desktop LCP ' + (dLCP/1000).toFixed(1) + 's > 2.5s'); fail = true; } \
		if (fail) process.exit(1); \
		console.log('  All budgets passed.'); \
		console.log(''); \
	"
	@rm -f lighthouse-mobile.json lighthouse-desktop.json

# Stop all background processes and Postgres
clean:
	@lsof -ti :4321 | xargs kill -9 2>/dev/null || true
	@lsof -ti :4322 | xargs kill -9 2>/dev/null || true
	@lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	@pgrep -f "bridge.ts" | xargs kill -9 2>/dev/null || true
	docker compose down
	@echo "Cleaned up"
