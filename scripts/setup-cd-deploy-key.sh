#!/bin/bash
# Give GitHub Actions (CD) its own SSH key to deploy to prod. Re-run to rotate.
#   ./scripts/setup-cd-deploy-key.sh
# Generates an ed25519 key, authorizes it on the server (no port/agent forwarding,
# no pty), verifies it can log in, stores it as DEPLOY_SSH_KEY, sets DEPLOY_HOST,
# and removes the local copy of the private key.
set -euo pipefail

HOST="${DEPLOY_HOST:-withpolaris.ai}"
USER="${DEPLOY_USER:-deploy}"
COMMENT="github-actions-deploy@polaris"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ssh-keygen -q -t ed25519 -N "" -C "$COMMENT" -f "$tmp/deploy"
pub=$(cat "$tmp/deploy.pub")

echo "Authorizing key on $USER@$HOST (replacing any previous CD key)..."
ssh "$USER@$HOST" "
  set -e
  cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak-\$(date +%Y%m%d%H%M%S)
  grep -v ' $COMMENT\$' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.new || true
  echo 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $pub' >> ~/.ssh/authorized_keys.new
  chmod 600 ~/.ssh/authorized_keys.new
  mv ~/.ssh/authorized_keys.new ~/.ssh/authorized_keys
"

echo "Verifying the new key can log in..."
ssh -o IdentitiesOnly=yes -o BatchMode=yes -i "$tmp/deploy" "$USER@$HOST" 'echo "  ok: $(whoami)@$(hostname)"'

echo "Storing GitHub secrets..."
gh secret set DEPLOY_SSH_KEY < "$tmp/deploy"
gh secret set DEPLOY_HOST --body "$HOST"

echo "Done. CD will deploy on the next CI-green merge to master (or: gh workflow run cd.yml)."
