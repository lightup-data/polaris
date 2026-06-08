#!/bin/sh
# hooks/statusline.sh — Polaris status line for coding agent CLI
# Reads session JSON from stdin, queries daemon for connection state.

POLARIS_DAEMON_PORT="${POLARIS_DAEMON_PORT:-4321}"

# Read stdin (session JSON from the coding agent)
INPUT=$(cat)

# Extract the CC session ID if available (jq optional, fallback to "unknown")
CC_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")

# Query daemon for polaris connection status
STATUS=$(curl -s "http://127.0.0.1:${POLARIS_DAEMON_PORT}/status/${CC_SESSION_ID}" 2>/dev/null)

if [ -z "$STATUS" ]; then
  echo "polaris: daemon offline"
  exit 0
fi

CONNECTED=$(echo "$STATUS" | jq -r '.connected' 2>/dev/null || echo "false")

if [ "$CONNECTED" = "true" ]; then
  PROJECT=$(echo "$STATUS" | jq -r '.project' 2>/dev/null)
  SESSION=$(echo "$STATUS" | jq -r '.session' 2>/dev/null)
  USER=$(echo "$STATUS" | jq -r '.user' 2>/dev/null)
  echo "polaris: ${PROJECT}/${SESSION} (${USER})"
else
  echo "polaris: not connected"
fi
