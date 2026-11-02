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

# --- Version / update check (cached, non-blocking) ---
# Always shows the installed version; appends "latest" or "update available"
# once the npm cache is populated. Background curl refresh never blocks.
VERSION_TAG=""
INSTALLED_PKG="$HOME/.polaris/mcp/node_modules/@lightupai/polaris/package.json"
UPDATE_CACHE="$HOME/.polaris/update-check.json"

if [ -f "$INSTALLED_PKG" ]; then
  INSTALLED_VERSION=$(jq -r '.version // ""' "$INSTALLED_PKG" 2>/dev/null || echo "")

  if [ -n "$INSTALLED_VERSION" ]; then
    VERSION_TAG=" [v${INSTALLED_VERSION}]"  # shown even before cache is populated

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

    if [ -n "$CACHED_LATEST" ]; then
      _ver_gt() {
        # Returns true (0) when $1 is semver-greater than $2 ("0.0.NNN" format).
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
        VERSION_TAG=" [v${INSTALLED_VERSION}, update available]"
      else
        VERSION_TAG=" [v${INSTALLED_VERSION}, latest]"
      fi
    fi
  fi
fi

# --- Token expiry check (local JWT decode, no network) ---
TOKEN_WARN=""
CREDS="$HOME/.polaris/credentials.json"
if [ -f "$CREDS" ]; then
  TOKEN=$(jq -r '.token // ""' "$CREDS" 2>/dev/null || echo "")
  if [ -n "$TOKEN" ]; then
    # Extract JWT payload (middle segment), pad to multiple of 4, base64-decode
    PAYLOAD=$(echo "$TOKEN" | cut -d. -f2)
    # Add padding
    PAD=$(( ${#PAYLOAD} % 4 ))
    [ "$PAD" -eq 2 ] && PAYLOAD="${PAYLOAD}=="
    [ "$PAD" -eq 3 ] && PAYLOAD="${PAYLOAD}="
    EXP=$(echo "$PAYLOAD" | base64 -d 2>/dev/null | jq -r '.exp // 0' 2>/dev/null || echo "0")
    NOW=$(date +%s 2>/dev/null || echo "0")
    if [ -n "$EXP" ] && [ "$EXP" != "0" ] && [ "$NOW" -gt "$EXP" ] 2>/dev/null; then
      TOKEN_WARN=" \033[1;31m🚨 TOKEN EXPIRED — run: polaris login\033[0m"
    fi
  fi
fi

fmt_age() {
  if [ "$1" -lt 60 ] 2>/dev/null; then echo "<1m"
  elif [ "$1" -lt 3600 ] 2>/dev/null; then echo "$(( $1 / 60 ))m"
  elif [ "$1" -lt 86400 ] 2>/dev/null; then echo "$(( $1 / 3600 ))h"
  else echo "$(( $1 / 86400 ))d"
  fi
}

# --- Server reachability (daemon probes the cloud service every 30s) ---
SERVER_WARN=""
DOWN_FOR=$(echo "$STATUS" | jq -r '.serverDownFor // empty' 2>/dev/null || echo "")
if [ -n "$DOWN_FOR" ]; then
  DOWN_TXT="⚠ POLARIS SERVER UNREACHABLE ($(fmt_age "$DOWN_FOR")) — events not syncing"
  if [ "$DOWN_FOR" -lt 300 ] 2>/dev/null; then
    SERVER_WARN="\033[1;31m${DOWN_TXT}\033[0m "
  elif [ "$DOWN_FOR" -lt 3600 ] 2>/dev/null; then
    SERVER_WARN="\033[1;97;41m ${DOWN_TXT} \033[0m "
  else
    SERVER_WARN="\033[1;5;97;41m ${DOWN_TXT} — CHECK SERVER NOW \033[0m "
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
    if [ "$LAST_AGE" -lt 60 ] 2>/dev/null; then RECENCY=" · just now"
    else RECENCY=" · $(fmt_age "$LAST_AGE") ago"
    fi
  fi

  # Delivery drift: age of the oldest event still queued. Idle sessions have no
  # drift, so this only escalates when captured events are actually not syncing.
  DRIFT_TAG=""
  DRIFT=$(echo "$STATUS" | jq -r '.drift.driftSec // empty' 2>/dev/null || echo "")
  QUEUED=$(echo "$STATUS" | jq -r '.drift.queued // empty' 2>/dev/null || echo "")
  if [ -n "$DRIFT" ] && [ "$DRIFT" -ge 60 ] 2>/dev/null; then
    D="$(fmt_age "$DRIFT") behind, ${QUEUED} queued"
    if [ "$DRIFT" -lt 300 ]; then DRIFT_TAG=" · \033[33m⚠ ${D}\033[0m"
    elif [ "$DRIFT" -lt 1800 ]; then DRIFT_TAG=" · \033[1;33m⚠ ${D}\033[0m"
    elif [ "$DRIFT" -lt 7200 ]; then DRIFT_TAG=" · \033[1;31m⚠ ${D}\033[0m"
    else DRIFT_TAG=" · \033[1;97;41m ⚠ EVENTS $(fmt_age "$DRIFT") BEHIND (${QUEUED} QUEUED) \033[0m"
    fi
  fi

  # Show Slack channel only when it differs from the project name (adds info, avoids duplication)
  SLACK_TAG=""
  if [ -n "$SLACK" ] && [ "$SLACK" != "$PROJECT" ]; then
    SLACK_TAG=" → #${SLACK}"
  fi
  printf "${SERVER_WARN}polaris: ${ACCOUNT_TAG}#${PROJECT}/${SESSION} (${USER})${SLACK_TAG}${RECENCY}${DRIFT_TAG}${VERSION_TAG}${TOKEN_WARN}\n"
else
  # Account chosen with /polaris account before joining
  PENDING_ACCOUNT=$(echo "$STATUS" | jq -r '.account // empty' 2>/dev/null)
  PENDING_TAG=""
  [ -n "$PENDING_ACCOUNT" ] && PENDING_TAG=" [${PENDING_ACCOUNT}]"
  printf "${SERVER_WARN}polaris: not connected${PENDING_TAG}${VERSION_TAG}${TOKEN_WARN}\n"
fi
