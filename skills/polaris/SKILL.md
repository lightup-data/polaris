---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename polaris_backfill
argument-hint: [join #channel | backfill [duration] | rename <new-name> | disconnect | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**`/polaris join #channel-name`** — Connect to a channel:
1. Call `polaris_connect` with the given channel and user identity `user:manu.bansal`
2. A session name is auto-generated
3. Report the connection status including the session name

**`/polaris rename <new-name>`** — Rename the current channel:
1. Call `polaris_rename` with the new name
2. Report the result

**`/polaris backfill [duration]`** — Recover lost events:
1. Call `polaris_backfill` with the optional duration (e.g., `2h`, `30m`)
2. Report how many events were recovered

**`/polaris disconnect`** — Disconnect:
1. Call `polaris_disconnect`
2. Confirm disconnection

**`/polaris`** (no arguments) — Show status:
1. Call `polaris_status`
2. Display the current connection state

### Arguments: $ARGUMENTS
