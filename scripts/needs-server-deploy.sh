#!/bin/bash
# Decide whether going from the deployed commit to a new one changes what runs on
# the server. Client-only changes (CLI, MCP client, daemon, hooks, docs, tests) ship
# via npm alone.
#   scripts/needs-server-deploy.sh <deployed-sha> <new-sha>
# Prints "true" or "false" on stdout and the reason on stderr. When in doubt
# (unknown deployed commit, git error) it says "true".
set -uo pipefail

from="${1:-}"
to="${2:-HEAD}"
patterns="$(dirname "$0")/../.github/server-paths.regex"

if [ -z "$from" ] || ! git cat-file -e "${from}^{commit}" 2>/dev/null; then
  echo "deployed commit unknown (${from:-none}) — deploying to be safe" >&2
  echo true; exit 0
fi
if ! changed=$(git diff --name-only "$from" "$to" 2>/dev/null); then
  echo "git diff failed — deploying to be safe" >&2
  echo true; exit 0
fi

server_files=$(printf '%s\n' "$changed" | grep -E -f "$patterns" || true)
if [ -n "$server_files" ]; then
  echo "server files changed: $(printf '%s' "$server_files" | tr '\n' ' ')" >&2
  echo true; exit 0
fi

# package.json: every release bumps "version"; only other changes (deps) matter
if printf '%s\n' "$changed" | grep -qx 'package.json'; then
  if git diff "$from" "$to" -- package.json | grep -E '^[+-][^+-]' | grep -vq '"version"'; then
    echo "package.json changed beyond the version bump" >&2
    echo true; exit 0
  fi
fi

echo "no server-side changes since ${from:0:7} — skipping deploy (npm publish only)" >&2
echo false
