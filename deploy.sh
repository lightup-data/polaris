#!/bin/bash
set -euo pipefail

HOST="${DEPLOY_HOST:-withpolaris.ai}"
USER="${DEPLOY_USER:-deploy}"
DIR="${DEPLOY_DIR:-/opt/polaris}"

echo "Deploying to $USER@$HOST:$DIR ..."

ssh "$USER@$HOST" "
  cd $DIR &&
  git pull --ff-only &&
  docker compose -f docker-compose.prod.yml build &&
  docker compose -f docker-compose.prod.yml up -d --remove-orphans &&
  docker compose -f docker-compose.prod.yml restart caddy &&
  docker compose -f docker-compose.prod.yml ps
"

echo "Deploy complete."
