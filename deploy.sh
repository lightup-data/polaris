#!/bin/bash
set -euo pipefail

HOST="${DEPLOY_HOST:-withpolaris.ai}"
USER="${DEPLOY_USER:-deploy}"
DIR="${DEPLOY_DIR:-/opt/polaris}"
# Commit to deploy. CD passes the exact SHA that CI tested; a queued older run then
# fast-forwards to an ancestor of HEAD, which is a no-op.
REF="${DEPLOY_REF:-origin/master}"
HEALTH_URL="${HEALTH_URL:-https://api.withpolaris.ai/projects}"

echo "Deploying $REF to $USER@$HOST:$DIR ..."

ssh "$USER@$HOST" "
  cd $DIR &&
  git fetch -q origin &&
  git merge -q --ff-only $REF &&
  git log --oneline -1 &&
  docker compose -f docker-compose.prod.yml build &&
  docker compose -f docker-compose.prod.yml up -d --remove-orphans &&
  docker compose -f docker-compose.prod.yml restart caddy &&
  docker compose -f docker-compose.prod.yml ps
"

# Post-deploy health check: a deploy only counts if the API answers through the
# public URL and the container isn't crash-looping (any HTTP status < 500 is "up").
echo "Health check: $HEALTH_URL"
code=0
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
  if [ "$code" -gt 0 ] 2>/dev/null && [ "$code" -lt 500 ]; then break; fi
  code=0
  sleep 2
done
if [ "$code" = 0 ]; then
  echo "✗ API not answering 60s after deploy"
  exit 1
fi

api_state() { ssh "$USER@$HOST" "docker inspect -f '{{.RestartCount}} {{.State.Running}}' polaris-api-1"; }
before=$(api_state)
sleep 30
after=$(api_state)
if [ "$before" != "$after" ] || [ "${after#* }" != "true" ]; then
  echo "✗ API unstable after deploy (restarts/running: $before -> $after)"
  exit 1
fi

echo "✓ Deploy complete: API answering (HTTP $code), no restarts in 30s."
