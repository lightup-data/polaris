#!/bin/sh
# hooks/capture.sh - Forward Claude Code hook events to polaris local client
# Reads hook JSON from stdin, POSTs to the local polaris client.
# Always exits 0 to avoid blocking the coding agent.
#
# The raw hook payload is forwarded verbatim — no fields are stripped — so any
# tool approval/rejection or permission decision fields Claude Code includes
# (e.g. permission_mode, permission decisions on PreToolUse/PostToolUse) pass
# through to the daemon untouched.

POLARIS_PORT="${POLARIS_PORT:-4322}"
POLARIS_URL="http://127.0.0.1:${POLARIS_PORT}/events"

# Read all of stdin
INPUT=$(cat)

# Shared local daemon secret (wired by `polaris install`); sent when available
SECRET_HEADER=""
if [ -n "$POLARIS_DAEMON_SECRET" ]; then
  SECRET_HEADER="x-polaris-daemon-secret: $POLARIS_DAEMON_SECRET"
fi

# POST to polaris local client, fail silently
curl -s -X POST \
  -H "Content-Type: application/json" \
  ${SECRET_HEADER:+-H "$SECRET_HEADER"} \
  -d "$INPUT" \
  "$POLARIS_URL" \
  >/dev/null 2>&1 || true

exit 0
