#!/bin/sh
set -e

echo "[bridge] Waiting for Postgres..."
until bun run src/bridge-discover-org.ts >/dev/null 2>&1; do
  sleep 2
done

ORG_ID=$(bun run src/bridge-discover-org.ts)
if [ -z "$ORG_ID" ]; then
  echo "[bridge] No Slack-connected org found. Retrying in 30s..."
  sleep 30
  exec "$0"
fi

echo "[bridge] Starting bridge for org: $ORG_ID"
exec bun run src/slack/bridge.ts "$ORG_ID"
