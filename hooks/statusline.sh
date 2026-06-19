#!/bin/sh
# hooks/statusline.sh — Polaris status line for coding agent CLI
# Reads session JSON from stdin, queries daemon for connection state.

POLARIS_DAEMON_PORT="${POLARIS_DAEMON_PORT:-4322}"

# Shared local daemon secret (wired by `polaris install`); sent when available
SECRET_HEADER=""
if [ -n "$POLARIS_DAEMON_SECRET" ]; then
  SECRET_HEADER="x-polaris-daemon-secret: $POLARIS_DAEMON_SECRET"
fi

# Read stdin (session JSON from the coding agent)
INPUT=$(cat)

# Extract the CC session ID if available
CC_SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# Query daemon — try specific session first, fall back to any connected session
if [ -n "$CC_SESSION_ID" ]; then
  STATUS=$(curl -s ${SECRET_HEADER:+-H "$SECRET_HEADER"} "http://127.0.0.1:${POLARIS_DAEMON_PORT}/status/${CC_SESSION_ID}" 2>/dev/null)
  CONNECTED=$(echo "$STATUS" | jq -r '.connected' 2>/dev/null || echo "false")
fi

# If no match, check if there's any active session
if [ "$CONNECTED" != "true" ]; then
  STATUS=$(curl -s ${SECRET_HEADER:+-H "$SECRET_HEADER"} "http://127.0.0.1:${POLARIS_DAEMON_PORT}/status" 2>/dev/null)
  FIRST_SESSION=$(echo "$STATUS" | jq -r '.sessions[0] // empty' 2>/dev/null)
  if [ -n "$FIRST_SESSION" ]; then
    STATUS="{\"connected\":true,\"project\":$(echo "$STATUS" | jq '.sessions[0].project'),\"session\":$(echo "$STATUS" | jq '.sessions[0].session'),\"user\":$(echo "$STATUS" | jq '.sessions[0].user')}"
    CONNECTED="true"
  fi
fi

if [ "$CONNECTED" = "true" ]; then
  PROJECT=$(echo "$STATUS" | jq -r '.project' 2>/dev/null)
  SESSION=$(echo "$STATUS" | jq -r '.session' 2>/dev/null)
  USER=$(echo "$STATUS" | jq -r '.user' 2>/dev/null)
  SLACK=$(echo "$STATUS" | jq -r '.slackChannel // empty' 2>/dev/null)
  if [ -n "$SLACK" ]; then
    echo "polaris: ${PROJECT}/${SESSION} (${USER}) #${SLACK}"
  else
    echo "polaris: ${PROJECT}/${SESSION} (${USER})"
  fi
else
  echo "polaris: not connected"
fi
