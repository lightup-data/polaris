.PHONY: dev dev-up dev-down api web daemon test clean

# Start everything for local development
dev: dev-up api web daemon

# Postgres
dev-up:
	docker compose up -d

dev-down:
	docker compose down

# Cloud service API (port 4321)
api:
	@echo "Starting API server on http://localhost:4321"
	@bun run src/service/server.ts &

# Web app (port 3000)
web:
	@echo "Starting web app on http://localhost:3000"
	@bun run src/web/serve.ts &

# Local daemon (port 4322)
daemon:
	@echo "Starting daemon on http://127.0.0.1:4322"
	@POLARIS_DAEMON_PORT=4322 POLARIS_SERVICE_URL=http://localhost:4321 bun run src/daemon/daemon.ts &

# Run tests
test:
	bun test

# Stop all background processes and Postgres
clean:
	@lsof -ti :4321 | xargs kill -9 2>/dev/null || true
	@lsof -ti :4322 | xargs kill -9 2>/dev/null || true
	@lsof -ti :3000 | xargs kill -9 2>/dev/null || true
	docker compose down
	@echo "Cleaned up"
