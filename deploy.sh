#!/bin/bash
set -euo pipefail

HOST="${DEPLOY_HOST:-withpolaris.ai}"
USER="${DEPLOY_USER:-deploy}"
DIR="${DEPLOY_DIR:-/opt/polaris}"
# Commit to deploy. CD passes the exact SHA that CI tested; a queued older run then
# fast-forwards to an ancestor of HEAD, which is a no-op.
REF="${DEPLOY_REF:-origin/master}"
HEALTH_URL="${HEALTH_URL:-https://api.withpolaris.ai/projects}"
# Images are built by CD (ghcr.io/lightup-data/polaris:<sha>); the server only pulls.
# GHCR_TOKEN (CD passes its short-lived job token) logs the server in for the pull
# and is logged out afterwards, so no registry credentials stay on the box.
GHCR_TOKEN="${GHCR_TOKEN:-}"

echo "Deploying $REF to $USER@$HOST:$DIR ..."

if [ -n "$GHCR_TOKEN" ]; then
  printf '%s' "$GHCR_TOKEN" | ssh "$USER@$HOST" "docker login ghcr.io -u github-actions --password-stdin >/dev/null"
  trap 'ssh "$USER@$HOST" "docker logout ghcr.io >/dev/null" || true' EXIT
fi

ssh "$USER@$HOST" "
  set -e
  cd $DIR
  git fetch -q origin
  git merge -q --ff-only $REF
  TAG=\$(git rev-parse HEAD)
  git log --oneline -1
  # Record the deployed tag in .env so manual docker compose commands use the same image
  if grep -q '^POLARIS_IMAGE_TAG=' .env; then
    sed -i \"s/^POLARIS_IMAGE_TAG=.*/POLARIS_IMAGE_TAG=\$TAG/\" .env
  else
    echo \"POLARIS_IMAGE_TAG=\$TAG\" >> .env
  fi
  docker compose -f docker-compose.prod.yml pull -q api web bridge
  docker compose -f docker-compose.prod.yml up -d --remove-orphans
  docker compose -f docker-compose.prod.yml restart caddy
  # Keep the box clean: nothing is built here, so no image or build-cache leftovers
  docker image prune -af >/dev/null
  docker builder prune -af >/dev/null
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
