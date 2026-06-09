#!/bin/sh
# hooks/capture-stop.sh — Wrapper for capture-stop.ts
# Always exits 0 to avoid blocking the coding agent.
DIR="$(cd "$(dirname "$0")" && pwd)"
cat | npx bun "$DIR/capture-stop.ts" 2>/dev/null || true
exit 0
