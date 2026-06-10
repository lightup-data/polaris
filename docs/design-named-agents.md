# Design: Named Agents as Teammates

## Vision

Named agents are persistent, specialized participants in the Polaris workspace. They're peers alongside humans — they observe, contribute, and can be addressed by name. Unlike human sessions (transient, one project at a time), named agents are long-running services that participate across multiple projects simultaneously.

## Examples

| Agent | Identity | Specialty | Joins projects that... |
|-------|----------|-----------|----------------------|
| Dean | `agent:dean` | Data engineering, SQL, pipelines | interact with databases or data warehouses |
| Martha | `agent:martha` | Marketing copy, campaigns, email | need marketing content or strategy |
| Sean | `agent:sean` | Sales enablement, CRM, outreach | involve sales workflows or customer data |
| Sage | `agent:sage` | Security review, compliance | touch auth, encryption, or PII handling |

## How They Differ from Human Sessions

| Dimension | Human session | Named agent |
|-----------|--------------|-------------|
| Lifecycle | Transient — open, work, close | Persistent — always running |
| Projects | One at a time (join/leave) | Multiple simultaneously |
| Hosting | Client machine (Claude Code, Cursor) | Server-side (cloud container, sandbox) |
| Identity | `user:manu.bansal` | `agent:dean` |
| Invocation | Manual (`/polaris join`) | Auto-join on invite or project match |
| Driver role | Can be driver | Typically advisor, sometimes driver |
| Hooks | Captures via local hooks | Events posted directly via API |

## Participation Model

A named agent's relationship to a project:

```
                    ┌─────────────────┐
                    │   THE FLOOR     │
                    │                 │
                    │  polaris-dev    │
                    │  ┌───────────┐  │
                    │  │ manu      │──── driver (human, transient)
                    │  │ dean      │──── advisor (agent, persistent)
                    │  │ sage      │──── advisor (agent, persistent)
                    │  └───────────┘  │
                    │                 │
                    │  data-pipeline  │
                    │  ┌───────────┐  │
                    │  │ alice     │──── driver (human, transient)
                    │  │ dean      │──── advisor (agent, persistent)
                    │  └───────────┘  │
                    │                 │
                    └─────────────────┘
```

Dean appears in both projects. He monitors the event stream and responds when data-related questions arise or when addressed directly.

## Agent Behaviors

### Passive monitoring
Agent watches the event stream. When it sees a prompt or response related to its domain, it can inject an advisory message:

```
[user:manu.bansal] I need to add a Snowflake table for user events
[agent:dean] → fxm: The user_events schema already exists in warehouse.analytics. 
              Here's the current DDL: ...
```

### Direct addressing
A human or another agent addresses the agent by name on Slack or in a session:

```
@dean what tables have PII columns?
```

### Autonomous work
Agent is assigned as driver of its own session. It works independently, posting progress to the floor. Humans observe and advise.

## Identity Model

### Current
```
ParticipantId = /^(user|agent):[a-z0-9][a-z0-9._-]*$/
```
This already supports `agent:dean`. No change needed to the type system.

### Agent registry (new)
A table or config that defines named agents:

```
agents:
  - id: agent:dean
    name: Dean
    display_name: "Dean (Data)"
    icon: 📊
    description: "Data engineering specialist"
    skills: [sql, snowflake, dbt, airflow]
    auto_join: [projects with tag "data"]
    hosting: server  # or "sandbox"
```

This is metadata — it tells the system who Dean is, what icon to show on Slack, and which projects he should auto-join.

### Slack personas
Named agents already work with our persona system:
- `agent:dean` → username: "Dean (Data)", icon: 📊
- `agent:martha` → username: "Martha (Marketing)", icon: 📣

The `displayName()` function in `format.ts` handles this. Would need a lookup from the agent registry instead of the current string parsing.

## Identity Model

Every interaction on the floor has two distinct identities: the human and the agent. These are never conflated.

### Identity types

| Prefix | Meaning | Examples |
|--------|---------|---------|
| `user:*` | A human | `user:manu.bansal`, `user:alice.chen` |
| `agent:*` | An AI agent | `agent:claude`, `agent:dean`, `agent:cursor` |
| `slack:*` | A Slack user (advisor) | `slack:krishna` |

### Who sends what

In a coding session, the human and agent alternate. The `sender` field must reflect who actually produced the content:

| Hook event | Sender | Why |
|-----------|--------|-----|
| `UserPromptSubmit` | `user:manu.bansal` | The human typed the prompt |
| `Stop` | `agent:claude` | The agent produced the response |
| `PreToolUse` | `agent:claude` | The agent decided to use a tool |
| `PostToolUse` | `agent:claude` | The agent received the tool result |
| `inject` | `slack:krishna` or `user:alice.chen` | An advisor sent a message |

### Agent identity in a session

When a human connects a session, two identities are established:
- **Driver** (human): `user:manu.bansal` — from the participant ID in credentials
- **Agent**: `agent:claude` — the coding tool's agent identity

The agent identity could be:
- Generic: `agent:claude`, `agent:cursor`, `agent:copilot` (identifies the tool)
- Named: `agent:dean` (a named specialist agent)
- Session-specific: derived automatically from the tool being used

For local coding sessions, the agent identity defaults to the tool name (Claude Code → `agent:claude`). For named agents like Dean, it's explicitly `agent:dean`.

### On Slack

The Slack formatter uses the sender identity to pick the persona:
- `user:manu.bansal` → "Manu Bansal (session-name)" with 👤
- `agent:claude` → "Claude (session-name)" with 🤖
- `agent:dean` → "Dean (Data)" with 📊 (from agent registry)
- `slack:krishna` → "Krishna" with 💬

This makes the conversation on Slack clearly distinguish human prompts from agent responses.

## Architecture: Daemon as Universal Nexthop

All participants — human sessions and cloud agents alike — connect through a daemon. The daemon is the universal transit layer.

### Why always a daemon

1. **Fault tolerance**: If the API is slow or down, the daemon buffers events locally. No data loss.
2. **Auth**: Daemon handles token management. Agents and tools don't need to deal with auth.
3. **Cutover**: Switching from dev to prod is a daemon restart. Nothing else changes.
4. **Identity**: Daemon knows both the human and agent identity for a session. It stamps the correct sender on each event.
5. **Logging**: Every event passes through the daemon JSONL log for recovery.

### Local agent (human coding session)

```
┌──────────────┐     ┌──────────┐     ┌─────────────┐
│ Claude Code  │────▶│  Daemon  │────▶│ Polaris API │
│              │     │ :4322    │     │             │
│ hooks fire   │     │          │     │             │
│ MCP tools    │     │ buffers  │     │             │
│              │     │ auth     │     │             │
│ on laptop    │     │ logging  │     │ on Hetzner  │
└──────────────┘     └──────────┘     └─────────────┘
```

### Cloud agent (named agent like Dean)

```
┌──────────────┐     ┌──────────┐     ┌─────────────┐
│ Dean process │────▶│  Daemon  │────▶│ Polaris API │
│              │     │ (sidecar)│     │             │
│ listens for  │     │          │     │             │
│ events,      │     │ buffers  │     │             │
│ responds     │     │ auth     │     │             │
│              │     │ logging  │     │             │
│ on server    │     └──────────┘     │ on Hetzner  │
└──────────────┘                      └─────────────┘
```

Same architecture. The daemon runs as a sidecar container for cloud agents. The agent process talks to localhost, same as a human's Claude Code talks to localhost.

### Comparison

| Dimension | Local agent | Cloud agent |
|-----------|------------|-------------|
| Agent process | Claude Code / Cursor | Custom process or Claude API |
| Daemon | Runs on laptop | Sidecar container |
| Hook capture | Shell hooks (capture.sh) | Agent posts events directly to daemon |
| Human in the loop | Yes (the user) | Optional (can run autonomous) |
| Identity | `user:*` + `agent:claude` | `agent:dean` (no human) |
| Lifecycle | Transient | Persistent |
| Session creation | `/polaris join` | Auto-join or API call |

From the floor's perspective: identical. Events flow in, show up on Slack, appear on the dashboard. The source doesn't matter.

## Hosting Options

Given the daemon-always architecture, hosting becomes about where the daemon + agent pair runs:

### Option A: Self-hosted (any machine)
Agent + daemon run on any server the customer controls. Agent connects to daemon on localhost, daemon connects to Polaris API.

### Option B: Polaris-hosted
Polaris spawns a container pair (agent + daemon sidecar) in its own infrastructure. Admin configures the agent in the dashboard.

### Recommendation
Start with **Option A** — self-hosted. The customer runs the agent wherever they want. Polaris doesn't need to manage compute. Option B comes later when customers want managed agents.

## What to Implement Now

### 1. Agent registry table (small, foundational)
```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,            -- e.g., "agent:dean"
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,             -- "Dean"
  display_name TEXT,              -- "Dean (Data)"
  icon TEXT,                      -- emoji or URL
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Just metadata. No behavior yet. Used by the Slack formatter for richer personas.

### 2. Update Slack formatting to use agent registry
Instead of deriving "Agent: Dean" from string parsing, look up the agent's display name and icon from the registry.

### 3. Agent identity in the dashboard
Show registered agents alongside users in the profile/team section.

### Defer for later
- Auto-join logic (which projects an agent participates in)
- Agent hosting (Option B WebSocket client)
- Agent spawning and lifecycle management
- Skills/capability matching
- Autonomous driver mode

## Context Model

### Phase 1: Shared context, no isolation (ship first)
One Dean instance per org. Dean participates in all projects and accumulates context across them. No boundaries between projects.

This matches the small-team reality: one data expert who knows everything about the company's data. Everyone has the same access level. Dean's cross-project knowledge is a feature, not a bug — "Dean, you set up the schema for Project A, can we reuse it in Project B?"

### Phase 2: Per-project isolation (add when needed)
As the team grows and projects have different confidentiality levels, Dean gets isolated per-project instances. Each instance only sees its own project's context.

Dean's identity stays the same on Slack ("Dean (Data)"), but behind the name, each project gets a fresh instance with no cross-project memory.

### Phase 3: Controlled sharing (enterprise)
Admin-curated shared knowledge base (schemas, conventions, docs) that all Dean instances can read. Per-project context stays isolated. Sharing policies control what crosses boundaries.

### Phase 4: Agent hierarchy (northstar)
Dean becomes the head of a data team. He delegates to specialized subagents:

```
agent:dean (Data Lead)
  ├── agent:dean.snowflake   — Snowflake schema, queries, optimization
  ├── agent:dean.spark       — Spark jobs, pipeline tuning
  ├── agent:dean.dbt         — dbt models, lineage, testing
  └── agent:dean.quality     — Data quality checks, anomaly detection
```

Dean is the public face — humans address "Dean" and he routes to the right subagent. Subagents have:
- **Limited context**: only their specialty area, not the full org
- **Project isolation**: each subagent instance is scoped to one project
- **Dean as arbiter**: Dean sees across all subagents and synthesizes answers that span specialties

On the floor and Slack, subagent messages appear as "Dean (Data)" — the hierarchy is an implementation detail. Humans don't need to know which subagent answered.

When to introduce hierarchy:
- Team has 50+ projects and one Dean can't keep up
- Different projects need different levels of data expertise
- Compliance requires that certain subagents don't see certain data
- Response latency matters — subagents work in parallel

### Design principle
Start with the simplest model that matches how small teams actually work. Add isolation as a response to real customer needs, not speculatively. The architecture supports all phases — the difference is what context gets loaded when Dean starts participating in a project.

## Open Questions

1. **Multi-project sessions**: Dean is in all projects simultaneously. One session per project (`dean-polaris-dev`, `dean-data-pipeline`) keeps the model simple and isolation-ready for Phase 2.

2. **Agent-to-agent communication**: Can Dean ask Sage a question? The floor already supports this — any participant can inject into any session. But should there be a direct channel?

3. **Rate limiting**: A busy agent in 10 projects could flood the floor. Should agents have throttling or priority levels?

4. **Configuration UI**: Where do admins define named agents? Dashboard page? Config file? API?

5. **Credentials/secrets**: Dean needs database credentials. Sage needs access to security tools. How are agent-specific secrets managed?
