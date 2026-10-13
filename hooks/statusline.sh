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

# --- Update check (cached, non-blocking) ---
# Reads installed version from the MCP package, caches the latest npm version
# for up to 1 hour. Background curl refresh never blocks the status line.
UPDATE_MSG=""
INSTALLED_PKG="$HOME/.polaris/mcp/node_modules/@lightupai/polaris/package.json"
UPDATE_CACHE="$HOME/.polaris/update-check.json"

if [ -f "$INSTALLED_PKG" ]; then
  INSTALLED_VERSION=$(jq -r '.version // ""' "$INSTALLED_PKG" 2>/dev/null || echo "")

  CACHED_LATEST=""
  if [ -f "$UPDATE_CACHE" ]; then
    CACHED_LATEST=$(jq -r '.latest // ""' "$UPDATE_CACHE" 2>/dev/null || echo "")
    CACHE_TS=$(jq -r '.checked // 0' "$UPDATE_CACHE" 2>/dev/null || echo "0")
    NOW=$(date +%s 2>/dev/null || echo "0")
    CACHE_AGE=$(( NOW - CACHE_TS )) 2>/dev/null || CACHE_AGE=9999
    STALE=false
    [ "$CACHE_AGE" -gt 300 ] 2>/dev/null && STALE=true
  else
    STALE=true
  fi

  if [ "$STALE" = "true" ]; then
    # Refresh in background — never blocks the status line
    (
      LATEST_V=$(curl -sf --max-time 5 "https://registry.npmjs.org/@lightupai/polaris/latest" 2>/dev/null \
        | jq -r '.version // ""' 2>/dev/null)
      if [ -n "$LATEST_V" ]; then
        printf '{"latest":"%s","checked":%s}\n' "$LATEST_V" "$(date +%s)" > "$UPDATE_CACHE"
      fi
    ) &
  fi

  # Only notify when the registry version is strictly newer (prevents false
  # positives when a freshly-updated client's cache still shows an older latest).
  if [ -n "$CACHED_LATEST" ] && [ -n "$INSTALLED_VERSION" ]; then
    _ver_gt() {
      # Returns true (0) when $1 is semver-greater than $2
      # Works for the "0.0.NNN" format used by polaris.
      IFS=. read -r _a1 _a2 _a3 <<_EOF_
$1
_EOF_
      IFS=. read -r _b1 _b2 _b3 <<_EOF_
$2
_EOF_
      [ "${_a1:-0}" -gt "${_b1:-0}" ] && return 0
      [ "${_a1:-0}" -lt "${_b1:-0}" ] && return 1
      [ "${_a2:-0}" -gt "${_b2:-0}" ] && return 0
      [ "${_a2:-0}" -lt "${_b2:-0}" ] && return 1
      [ "${_a3:-0}" -gt "${_b3:-0}" ] && return 0
      return 1
    }
    if _ver_gt "$CACHED_LATEST" "$INSTALLED_VERSION"; then
      UPDATE_MSG=" [update available: v${CACHED_LATEST}]"
    fi
  fi
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

  # Liveness indicator: seconds since last delivered event
  RECENCY=""
  LAST_AGE=$(echo "$STATUS" | jq -r '.lastEventAge // ""' 2>/dev/null || echo "")
  if [ -n "$LAST_AGE" ] && [ "$LAST_AGE" != "null" ]; then
    if [ "$LAST_AGE" -lt 60 ] 2>/dev/null; then
      RECENCY=" · just now"
    elif [ "$LAST_AGE" -lt 3600 ] 2>/dev/null; then
      RECENCY=" · $(( LAST_AGE / 60 ))m ago"
    else
      RECENCY=" · $(( LAST_AGE / 3600 ))h ago"
    fi
  fi

  # Show Slack channel only when it differs from the project name (adds info, avoids duplication)
  SLACK_TAG=""
  if [ -n "$SLACK" ] && [ "$SLACK" != "$PROJECT" ]; then
    SLACK_TAG=" → #${SLACK}"
  fi
  echo "polaris: ${ACCOUNT_TAG}#${PROJECT}/${SESSION} (${USER})${SLACK_TAG}${RECENCY}${UPDATE_MSG}"
else
  echo "polaris: not connected${UPDATE_MSG}"
fi
