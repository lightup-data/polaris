---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename polaris_backfill polaris_team
argument-hint: [join #channel | tag [name] | backfill [duration] | rename <new-name> | disconnect | (no args for status)]
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

**`/polaris tag [name]`** — Tag a teammate on Slack:
1. Call `polaris_team` to get the team list with Slack identities
2. If a name was given, find the matching member. If no name, present a numbered list for the user to pick.
3. Ask the user what message to send (if not already provided)
4. Call `polaris_reply` with the message, including the Slack mention in `<@SLACK_ID>` format
5. Confirm the message was sent

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
