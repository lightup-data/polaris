# Design: @Mentions

## Context

Users want to tag teammates while working in a coding session — "get Krishna's opinion on this approach." The tag should be a real Slack mention that triggers a notification, not plain text.

## UX Goal

As close to native Slack `@mention` as possible. The agent knows the team, resolves names accurately, and the tagged person gets a real notification.

## Design Decisions

1. **Discovery**: Agent has the full team member list available (via `polaris_team` tool). No guessing or fuzzy matching.
2. **Resolution**: Agent resolves `@krishna` → Slack user ID inline when constructing the message. The team list is fetched at session start or on demand.
3. **Semantics**: Start as a Slack mention (notification only). Extend later to invitations, review requests, tracked consultations.
4. **Inbound mentions**: When Slack users @mention other users in messages to sessions, the floor captures the mention semantically (who was tagged, in what context).

## Implementation

### polaris_team tool

New MCP tool that returns the org's team members with their Slack user IDs.

```typescript
{
  name: "polaris_team",
  description: "List team members with their Slack identities. Use this to resolve @mentions.",
  inputSchema: { type: "object", properties: {} },
}
```

Response:
```json
{
  "members": [
    { "name": "Krishna Patel", "participant_id": "user:krishna.patel", "slack_id": "U0XXXXXXX", "slack_display": "krishna" },
    { "name": "Tuhin Roy", "participant_id": "user:tuhin.roy", "slack_id": "U0YYYYYYY", "slack_display": "tuhin" },
    { "name": "Manu Bansal", "participant_id": "user:manu.bansal", "slack_id": "UCUHHNJDT", "slack_display": "manu" }
  ]
}
```

### Data source

The team list comes from:
1. **Slack workspace members** — `users.list` API call, cached by the bridge/API
2. **Polaris users table** — users who have signed up, with their participant IDs

The API needs a new endpoint: `GET /team` that joins Slack workspace members with Polaris users. The daemon proxies this like other API calls.

### Mention in polaris_reply

When the agent calls `polaris_reply` with text containing `<@UXXXXXXX>`, the bridge posts it as-is — Slack renders the mention natively.

The agent's flow:
1. User says "tag krishna about this auth approach"
2. Agent calls `polaris_team` (or uses cached result)
3. Finds Krishna → `slack_id: U0XXXXXXX`
4. Calls `polaris_reply` with `"<@U0XXXXXXX> what do you think about this auth approach?"`
5. Bridge posts to Slack, Krishna gets a notification

### Mention resolution in the bridge (outbound)

As a fallback, the bridge can also resolve `@krishna` → `<@U0XXXXXXX>` in message text before posting. This handles cases where the agent or hooks include plain `@name` without resolution.

Resolution logic:
1. Scan message text for `@word` patterns
2. Look up each word against Slack display names (cached)
3. Replace with `<@slack_id>` if unique match
4. Leave as plain text if no match or ambiguous

### Inbound mention tracking

When a Slack message is injected into a session and contains `<@UXXXXXXX>` patterns:
1. The bridge resolves the Slack ID to a display name
2. The inject event payload includes a `mentions` array: `["user:krishna.patel"]`
3. The floor records who was consulted on what

This is metadata on the event — no schema change needed (it goes in the JSONB payload).

## Caching

The Slack user list is expensive to fetch (paginated API call). Cache it:
- **Bridge**: on startup and every 30 minutes
- **API /team endpoint**: cache for 5 minutes
- **Agent**: fetches once per session via `polaris_team`, uses for all mentions in that session

## Skill update

The skill instructions should tell the agent:
- When the user mentions someone by name, call `polaris_team` to resolve their Slack ID
- Use `<@slack_id>` format in `polaris_reply` messages
- If unsure which person, present the matches and ask

## UX Flow (v1)

Claude Code CLI's `@` is reserved for file references. Instead, use a conversational `/polaris tag` command:

```
User: /polaris tag
Agent: Who would you like to tag?
  1. Krishna Patel (@krishna)
  2. Tuhin Roy (@tuhin)
  3. Laura Mowry (@laura)
User: 1
Agent: What message?
User: what do you think about this auth approach?
Agent: → Posted to #polaris-dev: @krishna what do you think about this auth approach?
```

The agent calls `polaris_team` to get the list, presents it, and calls `polaris_reply` with the resolved Slack mention.

### Shorthand (future)

Once the flow works, add inline shorthand so the user can skip the interactive steps:
- `/polaris tag krishna what do you think?` — resolves and posts in one step
- Custom Claude Code `@` completion provider (feature request to Anthropic)

## Future extensions

- **Mention as invitation**: tagging someone could auto-invite them as an advisor to the session
- **Review request**: `@krishna review this PR` creates a tracked review request
- **Mention analytics**: dashboard shows who was consulted most, on which projects
- **Agent-to-person tagging**: named agents like Dean could tag humans when they need input

## Implementation Order

1. `GET /team` API endpoint (join Slack users with Polaris users)
2. Daemon `/team` proxy endpoint
3. `polaris_team` MCP tool
4. Bridge fallback mention resolution (outbound)
5. Inbound mention tracking in inject events
6. Skill update with mention instructions
