# Design: Backfill

## Context

Events can be lost when the daemon is down, the API is unreachable, or the daemon crashes. The backfill feature recovers lost events from local sources and replays them to the API.

## Command

```
/polaris backfill              — auto-detect gap, backfill from best source
/polaris backfill 2h           — backfill the last 2 hours
/polaris backfill --from <ts>  — backfill from a specific timestamp
```

## Data Sources (in priority order)

### 1. Daemon JSONL log (`~/.polaris/logs/daemon-YYYY-MM-DD.jsonl`)

**When it's available**: Daemon was running and received the hook event. The log is written before the API relay, so even failed relays are captured.

**What it contains**: Full request payloads — endpoint, timestamp, hook_event_name, prompt/response content, tool calls. Also response status on failures.

**When it's incomplete**:
- Daemon wasn't running (hooks failed to reach localhost:4322)
- Daemon crashed before writing the log entry
- Log file was manually deleted or rotated

**Parsing**: Already structured JSONL. Each line is `{t, endpoint, payload, response?}`. Direct replay to the API.

### 2. Claude Code transcript (`~/.claude/projects/.../SESSION_ID.jsonl`)

**When it's available**: Always — Claude Code manages this file regardless of Polaris. Every conversation is persisted.

**What it contains**: The complete conversation — every user message, every assistant response, every tool call and result. Raw and unstructured relative to Polaris events.

**When it's incomplete**: Only if Claude Code itself crashed or the file was deleted.

**Parsing**: Requires extracting Polaris-relevant events from the conversation format:
- User messages (role: "user", content is string) → UserPromptSubmit
- Assistant messages (role: "assistant") → Stop events
- Tool use blocks → PreToolUse/PostToolUse
- Need to distinguish real user prompts from tool_result messages (content is array)

The `capture-stop.ts` hook already does this parsing for Stop events. The same logic can be reused.

### 3. Nothing

Both sources are gone. Data is irrecoverably lost. Backfill reports the gap.

## Backfill Algorithm

```
1. Query API for the most recent event timestamp for the current session/project
2. Determine the gap: from last API event to now (or specified time range)
3. Try daemon log first:
   a. Read log entries in the gap period
   b. Filter to /events endpoint entries
   c. Check each against the API (by timestamp + payload hash) to avoid duplicates
   d. Replay missing entries to the API
4. If daemon log is incomplete (gap still exists after step 3):
   a. Find the transcript file (path is in hook payloads or daemon log)
   b. Parse transcript for events in the remaining gap
   c. Construct Polaris events from transcript entries
   d. Replay to API
5. Report results:
   a. How many events were recovered
   b. From which source (daemon log vs transcript)
   c. Any remaining gaps
   d. Post abridged summary to Slack as a thread reply
```

## Deduplication

Events replayed during backfill must not create duplicates. Strategies:
- **Timestamp matching**: Check if an event with the same timestamp (±1s) and same hook_event_name already exists
- **Content hash**: Hash the payload content and check against existing events
- **Idempotent insert**: The API could support an `idempotency_key` parameter that rejects duplicates

For v1, timestamp matching is sufficient. The API's event IDs are UUIDs generated on insert, so backfilled events get new IDs but the content matches.

## Slack Recovery Summary

After backfill, post an abridged summary to the project's Slack channel as a thread reply on the last message before the gap:

```
:warning: Recovery log — N events recovered from daemon log / transcript.
Gap: 3:29am – 3:44am PT

• 3:29 — user:manu: "add a todo for the stale daemon issue"
• 3:30 — agent:claude: fixed daemon default port
• 3:37 — user:manu: "so at this point, nothing is making it to slack"
• ...

M events recovered, K gaps remain.
```

## MCP Tool

```typescript
{
  name: "polaris_backfill",
  description: "Recover lost events from local logs",
  inputSchema: {
    properties: {
      duration: { type: "string", description: "e.g., '2h', '30m'" },
      from: { type: "string", description: "ISO timestamp" },
    },
  },
}
```

The tool calls the daemon's `/backfill` endpoint. The daemon does the actual work (reads logs, parses transcripts, replays to API).

## Daemon Endpoint

```
POST /backfill
{
  "ccSessionId": "...",
  "duration": "2h",       // optional
  "from": "2026-06-10...", // optional
}
```

Response:
```json
{
  "recovered": 42,
  "source": "daemon_log",    // or "transcript" or "both"
  "gaps": [],                 // time ranges with no data
  "slackThreadTs": "..."     // where the recovery summary was posted
}
```

## Implementation Order

1. **Daemon log replay** — simplest, most structured, covers the common case (API was unreachable but daemon was running)
2. **Transcript parsing** — more complex, covers the case where daemon was also down
3. **Slack recovery summary** — nice to have, reuse the pattern from the manual recovery we did
4. **Deduplication** — important for correctness, add after basic replay works

## Name Changes During Gap

Project renames, session changes, and Slack channel renames can happen during a gap. Backfill must handle these correctly.

**Key insight**: The daemon log stores raw hook payloads, not project/session names. The daemon adds the project/session from its session mapping at relay time. So on replay, the daemon should use the *current* mapping, not reconstruct a historical one.

| Change during gap | Impact | Handling |
|---|---|---|
| Project renamed | Log doesn't contain project name — daemon resolves it from current mapping | Works automatically |
| Slack channel renamed | Bridge looks up channel by project → channel ID in DB | Works if DB mapping is current |
| User switched projects | Log has events for both time periods | Filter by timestamp range per project |
| Session handed off to new driver | Sender identity changes | Use current session's driver/agent at replay time |

**Transcript fallback complication**: The transcript doesn't know about Polaris projects/sessions at all. When parsing the transcript, backfill must ask: "which project was this CC session connected to at this timestamp?" The daemon log has `/connect` entries that establish the timeline of project associations. If the daemon log is also missing, the current session mapping is the only reference — which may not reflect historical state.

**Recommendation**: Always log `/connect` and `/disconnect` events to a separate persistent file (`~/.polaris/session-history.jsonl`) that survives daemon restarts. This gives backfill a reliable timeline of which CC session was in which project at what time.

## Open Questions

1. **Should backfill be automatic?** The daemon could detect gaps on startup (compare last log entry to last API event) and auto-backfill. Risk: could replay stale events unintentionally.

2. **Transcript format stability**: Claude Code's transcript format is not a public API. It could change between versions. How brittle is the parser?

3. **Multi-day gaps**: The daemon log is per-day. A multi-day outage requires reading multiple files. The transcript spans the whole session.

4. **Cross-session backfill**: If the user was in session A, disconnected, joined session B, and wants to backfill A — the daemon log has events for both. Need to filter by session/project.

5. **Session history persistence**: Should we add `~/.polaris/session-history.jsonl` now (cheap, foundational for backfill) or defer until backfill is implemented?
