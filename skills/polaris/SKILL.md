---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context
argument-hint: [join <project> <session> | disconnect | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**`/polaris join <project> <session>`** — Connect to a session:
1. Call `polaris_connect` with the given project, session, and user identity
2. If `.polaris.json` exists in the repo root, read the `user` field from it. Otherwise ask the user for their participant ID (e.g., `user:manu`).
3. Report the connection status

**`/polaris disconnect`** — Disconnect:
1. Call `polaris_disconnect`
2. Confirm disconnection

**`/polaris`** (no arguments) — Show status:
1. Call `polaris_status`
2. Display the current connection state

### Arguments: $ARGUMENTS
