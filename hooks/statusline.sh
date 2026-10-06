#!/bin/sh
# hooks/statusline.sh — Polaris status line for coding agent CLI
# Reads session JSON from stdin, queries daemon for connection state.

POLARIS_DAEMON_PORT="${POLARIS_DAEMON_PORT:-4322}"

# Shared local daemon secret (wired by `polaris install`); sent when available
SECRET_HEADER=""
if [ -n "$POLARIS_DAEMON_SECRET" ]; then
  SECRET_HEADER="x-polaris-daemon-secret: $POLARIS_DAEMON_SECRET"
fi

# Account is read from the per-session daemon status (set after connection)

# Read stdin (session JSON from the coding agent)
INPUT=$(cat)

# Extract the CC session ID if available
CC_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# Query daemon for this shell's session only — no fallback to other sessions
if [ -n "$CC_SESSION_ID" ]; then
  STATUS=$(curl -s ${SECRET_HEADER:+-H "$SECRET_HEADER"} "http://127.0.0.1:${POLARIS_DAEMON_PORT}/status/${CC_SESSION_ID}" 2>/dev/null)
  CONNECTED=$(echo "$STATUS" | jq -r '.connected' 2>/dev/null || echo "false")
fi

if [ "$CONNECTED" = "true" ]; then
  PROJECT=$(echo "$STATUS" | jq -r '.project' 2>/dev/null)
  SESSION=$(echo "$STATUS" | jq -r '.session' 2>/dev/null)
  USER=$(echo "$STATUS" | jq -r '.user' 2>/dev/null)
  SLACK=$(echo "$STATUS" | jq -r '.slackChannel // empty' 2>/dev/null)
  ACCOUNT=$(echo "$STATUS" | jq -r '.account // empty' 2>/dev/null)
  ACCOUNT_TAG=""
  if [ -n "$ACCOUNT" ]; then
    ACCOUNT_TAG="[${ACCOUNT}] "
  fi
  if [ -n "$SLACK" ]; then
    echo "polaris: ${ACCOUNT_TAG}${PROJECT}/${SESSION} (${USER}) #${SLACK}"
  else
    echo "polaris: ${ACCOUNT_TAG}${PROJECT}/${SESSION} (${USER})"
  fi
else
  echo "polaris: not connected"
fi
