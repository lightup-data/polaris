# Collab: Bidirectional Claude Code Session Bridge

## Context

We're building the first feature for the Lightup project — a system that **captures every interaction** in a Claude Code session (user messages, Claude responses, tool calls, tool results) and **injects external messages** into the session. This enables multiplayer collaboration where teammates and external systems can observe and participate in Claude Code sessions.

The system is backed by a **cloud service** that acts as the central broker and system of record. All state is persisted there. Multiple clients (Claude Code sessions, Slack, dashboards) connect to the cloud service to collaborate.

## Participants: Humans and Agents

Every participant in collab — whether human or AI agent — has an **identity** with a type prefix:

- `user:manu`, `user:krishna`, `user:priya` — humans
- `agent:test-writer`, `agent:security-reviewer`, `agent:docs-writer` — agents

Agents are **first-class participants**. They can be drivers or advisors, same as humans. Collab treats them identically — the cloud service doesn't distinguish between human and agent clients. The difference is purely in how they're labeled in the log and how they connect.

**Spawning**: humans create sessions and start agents out of band (not managed by collab in v1).

**Privileges & HITL**: agent permissions, approval flows, and escalation paths are configured outside collab. Collab's job is context pooling, capture, injection, and broadcast — not authorization.

**Addressed messaging**: every injection specifies a **target** — a specific session within the project. No blind broadcast into all sessions. An advisor (human or agent) must address their input to the session that needs it.

## Data Model: Projects, Sessions, Drivers, Advisors

### Projects

A **project** is the top-level context container. All context is pooled at the project level. A project has a flat, human-readable name (e.g., `pj`). One Slack channel per project (`#pj`).

### Sessions

A project contains one or more **sessions**, each representing a concurrent workstream (e.g., feature, bugfix). Sessions have names scoped to their project (e.g., `fxm`, `fxk`).

### Drivers

Each session has **one driver** — a human or agent actively building in Claude Code. Multiple sessions in a project can have concurrent drivers (one per session). A driver's activity (prompts, Claude responses, tool calls) is captured and broadcast.

### Advisors

**Advisors** (human or agent) contribute context via Slack or another client. Advisory messages are injected into a **specific target session's** driver. Multiple advisors can participate simultaneously. Every injection must specify its target session.

### Context Pooling

All events across all sessions in a project are persisted together as the project's shared context. This means:

- **Real-time**: advisors' messages are injected into the target driver's session immediately
- **Sibling activity**: events from other sessions (e.g., Krishna's `fxk` work) are available on-demand to a driver (e.g., Manu on `fxm`) but not auto-injected to avoid noise
- **Handoff/new session**: when a driver takes over or starts a new session, they can be seeded with full project context

### Handoff

The driver role on a session can transfer from one person to another:

1. Current driver releases (via command or API)
2. Session goes to "open" state (no driver)
3. New driver claims the session, connects their Claude Code CLI
4. New driver's session is seeded with context from project history
5. Slack channel shows the transition

## Example: Project `pj` with Humans + Agents

```
Project pj
├── session fxm      driver: user:manu              auth middleware
├── session fxk      driver: user:krishna            database schema
├── session tests    driver: agent:test-writer       tests for fxm + fxk
│
├── advisor: agent:security-reviewer   (watches project, advises sessions)
└── advisor: user:priya                (via Slack)
```

1. **Manu** creates project `pj` with session `fxm`, connects as driver
2. **Krishna** creates session `fxk`, connects as driver
3. `agent:test-writer` is started out of band, drives session `tests`
4. `agent:security-reviewer` connects as an advisor, watching project events
5. Slack `#pj` shows an interleaved, attributed log:

```
[user:manu/fxm → cc]                "Let's implement the auth middleware"
[cc → user:manu/fxm]                "I'll create src/middleware/auth.ts..."
[user:krishna/fxk → cc]             "Set up the database schema for users"
[cc → user:krishna/fxk]             "Creating migrations/001_users.sql..."
[user:priya → fxk]                  "Remember we need GDPR compliance on the users table"
[cc → user:krishna/fxk]             "Good point from Priya. Adding data retention fields..."
[agent:security-reviewer → fxm]     "This auth endpoint needs rate limiting"
[cc → user:manu/fxm]                "Adding rate limiting middleware..."
[agent:test-writer/tests → cc]      "Writing integration tests for auth middleware"
[cc → agent:test-writer/tests]      "Created tests/auth.test.ts..."
[user:manu/fxm → cc]                "What has Krishna done on fxk so far?"
[cc → user:manu/fxm]                "Krishna has set up the users schema with GDPR fields..."
```

6. Manu finishes `fxm`, hands off `fxk` to himself to continue Krishna's work
7. The Slack log is continuous and complete — humans, agents, handoffs, all in one stream

## Architecture: Cloud-Backed with Local Clients + Slack Bridge

```
┌──────────────────────────────────────────────────────┐
│                    Cloud Service                      │
│              (Broker / System of Record)              │
│                                                       │
│  REST API:                                            │
│    POST /projects                       create        │
│    GET  /projects/:proj                 metadata      │
│    GET  /projects/:proj/messages        full history  │
│    GET  /projects/:proj/events          SSE (all)     │
│                                                       │
│    POST /projects/:proj/sessions        create session│
│    GET  /projects/:proj/sessions/:sess  metadata      │
│    POST /projects/:proj/sessions/:sess/events   push  │
│    GET  /projects/:proj/sessions/:sess/events   SSE   │
│    POST /projects/:proj/sessions/:sess/inject   inject │
│    GET  /projects/:proj/sessions/:sess/messages hist. │
│    POST /projects/:proj/sessions/:sess/handoff  rel.  │
│    POST /projects/:proj/sessions/:sess/driver   claim │
│                                                       │
│  WebSocket:                                           │
│    /projects/:proj/ws              project-level      │
│    /projects/:proj/sessions/:sess/ws  session-level   │
│                                                       │
│  Persistence: SQLite (bun:sqlite)                     │
└────────┬────────────────────┬────────────────────────-┘
         │                    │
         ▼                    ▼
  ┌──────────────┐     ┌──────────────┐
  │ Local Clients │     │ Slack Bridge │
  │ (drivers)     │     │              │
  │               │     │ project ←→   │
  │ One per       │     │ Slack channel│
  │ session       │     │              │
  └──────────────┘     └──────────────┘
       ↕ stdio              ↕ Socket Mode
  Claude Code CLI       Slack API
```

### Local Client (Driver)

Single Bun process, runs on the driver's machine. Connects to a specific session within a project.

```
┌──────────────────────────────┐
│  Local MCP Channel Process   │
│  (src/client/client.ts)      │
│                              │
│  Config:                     │
│    project: "pj"             │
│    session: "fxm"            │
│    user: "manu"              │
│                              │
│  HTTP on localhost:4321      │
│    POST /events ← hooks      │
│    (relay to cloud)          │
│                              │
│  WebSocket to cloud          │
│    → forwards captured events│
│    ← receives advisor msgs   │
│                              │
│  MCP stdio to Claude Code    │
│    → channel notifications   │
│    ← collab_reply tool       │
└──────────────────────────────┘
         ↕ stdio
Claude Code (Desktop or CLI)
    → Hooks fire → capture.sh → localhost:4321/events
```

### Slack Bridge

Bridges one project to one Slack channel. Shows all sessions' activity.

```
┌──────────────────────────────┐
│  Slack Bridge                │
│  (src/slack/bridge.ts)       │
│                              │
│  Config:                     │
│    project: "pj"             │
│    slack_channel: "#pj"      │
│                              │
│  WebSocket to cloud          │
│    (project-level WS)        │
│    ← receives all events     │
│    → injects Slack messages  │
│                              │
│  Slack Socket Mode           │
│    ← receives channel msgs   │
│    → posts formatted events  │
└──────────────────────────────┘
```

- **Project → Slack**: receives events from all sessions via project-level WS. Posts attributed, formatted messages (`[manu/fxm → cc]`, `[cc → krishna/fxk]`). `UserPromptSubmit` and `Stop` events posted; tool calls skipped or collapsed.
- **Slack → Session**: advisor posts in `#pj` targeting a specific session (e.g., `@fxk remember GDPR`). The message is injected into that session's driver only. Every injection requires a target.

### Data Flow

**Capture (driver → Slack):**
Claude Code → hooks → `capture.sh` → local client → WS → cloud → persisted → project WS → Slack bridge → `#pj`

**Advise (Slack → driver):**
Advisor posts in `#pj` → Slack bridge → WS → cloud → persisted → session WS → local client → MCP channel notification → Claude Code

**Cross-session context (on-demand):**
Driver asks Claude "what has Krishna done on fxk?" → Claude calls a tool or the local client fetches `GET /projects/pj/sessions/fxk/messages` → returns history

**Handoff:**
Driver calls `POST /projects/:proj/sessions/:sess/handoff` → cloud clears driver → new driver claims via `POST .../driver` → context seeded from project history

## File Structure

```
src/
  types.ts              # Shared event types + zod schemas
  service/
    server.ts           # Cloud service: HTTP + WebSocket + persistence
    db.ts               # SQLite persistence layer (bun:sqlite)
  client/
    client.ts           # Local MCP channel + HTTP relay + WS connection
  slack/
    bridge.ts           # Slack ↔ cloud bridge (Socket Mode)
    format.ts           # Event → Slack mrkdwn formatting
hooks/
  capture.sh            # Shell script: reads hook JSON stdin, POSTs to local client
tests/
  types.test.ts         # Schema validation tests
  db.test.ts            # Persistence layer tests
  service.test.ts       # Cloud service API tests
  client.test.ts        # Local client tests
  slack.test.ts         # Slack bridge tests
  format.test.ts        # Formatting tests
  capture.test.ts       # Hook script test
tsconfig.json
.mcp.json               # MCP server registration for Claude Code
```

## Implementation Phases

### Phase 1: Types + Persistence
- `src/types.ts` — shared types, zod schemas: participant identity (`user:name` / `agent:name`), hook payloads, inject/reply messages (with required `target` session), `CollabEvent` envelope, project model, session model (project, name, driver, created_at)
- `src/service/db.ts` — SQLite layer:
  - Projects table: `name` PK, `created_at`
  - Sessions table: `name`, `project` FK, `driver`, `created_at`
  - Events table: `id`, `project` FK, `session` FK, `timestamp`, `source`, `sender`, `payload`
  - Functions: `createProject(name)`, `createSession(project, name, driver)`, `setDriver(project, session, driver)`, `clearDriver(project, session)`, `pushEvent(...)`, `getProjectEvents(project)`, `getSessionEvents(project, session)`, `getEventsSince(...)`
- `tests/types.test.ts`, `tests/db.test.ts`
- Add deps to `package.json`: `@modelcontextprotocol/sdk`, `zod`
- Add `tsconfig.json`

### Phase 2: Cloud Service
- `src/service/server.ts` — Bun HTTP server + WebSocket:
  - Project endpoints: create, get metadata, get all events (aggregated), SSE stream
  - Session endpoints: create under project, get metadata, push events, SSE, inject, messages, handoff, claim driver
  - WebSocket at both project level (all events) and session level (session events + advisor injections)
- `tests/service.test.ts`

### Phase 3: Local Client + Hooks
- `src/client/client.ts` — single Bun process configured with `(project, session, user)`:
  - MCP channel server (stdio) with `claude/channel` capability
  - `collab_reply` tool + `collab_context` tool (fetch sibling session history on demand)
  - HTTP on localhost for hook relay
  - WebSocket to cloud (session-level)
  - On connect: claims driver, optionally seeded with project context
- `hooks/capture.sh` — POSIX shell, curl to localhost, always exits 0
- `.mcp.json` — project-scoped MCP registration
- `tests/client.test.ts`, `tests/capture.test.ts`

### Phase 4: Slack Bridge
- `src/slack/bridge.ts` — connects to cloud via project-level WS and to Slack via Socket Mode:
  - All session events → attributed, formatted Slack posts in `#project`
  - Slack messages → injected into target session (must specify target)
  - Handoff events → Slack notification
- `src/slack/format.ts` — markdown → Slack mrkdwn, event → attributed message
- `tests/slack.test.ts`, `tests/format.test.ts`

## Key Design Decisions

1. **Agents are first-class** — same identity model as humans (`agent:name` vs `user:name`), can be drivers or advisors. Spawned out of band. Privileges/HITL managed externally.
2. **Addressed messaging** — every injection targets a specific session. No blind broadcasts.
3. **Project-level context pooling** — all events persisted under the project. Shared context across sessions. Sibling activity available on-demand, not auto-injected.
4. **One driver per session, multiple sessions per project** — concurrent human and agent drivers on different workstreams
5. **Advisors inject in real-time** — advisory messages pushed into the target session immediately
6. **One Slack channel per project** — `#pj` shows interleaved, attributed log from all sessions (human and agent)
7. **Cloud service is the source of truth** — all events persisted, all clients are thin relays
8. **Slack Socket Mode** — no public URL needed for v1
9. **WebSocket at two levels** — project-level (aggregated, for Slack bridge) and session-level (for local clients)
10. **On-demand cross-session context** — `collab_context` tool lets a driver ask "what happened in session X?" without noise from auto-injection
11. **SQLite via bun:sqlite** — zero-dep persistence for v1
12. **Flat names** — project names globally unique, session names unique within a project

## Verification

- `bun test` covers all unit + integration tests
- Manual end-to-end test:
  1. Start cloud service: `bun run src/service/server.ts`
  2. Create project: `curl -X POST localhost:PORT/projects -d '{"name":"pj"}'`
  3. Create sessions: `curl -X POST localhost:PORT/projects/pj/sessions -d '{"name":"fxm","driver":"manu"}'`
  4. Start Slack bridge for `pj`
  5. Start local client as Manu on `pj/fxm`
  6. Send a prompt → verify it appears in Slack `#pj` attributed to `manu/fxm`
  7. Start local client as Krishna on `pj/fxk`
  8. Both work → verify interleaved log in Slack
  9. Post in Slack targeting `fxk` → verify it appears in Krishna's session
  10. Manu asks "what has Krishna done?" → `collab_context` fetches `fxk` history
  11. Handoff `fxm` from Manu → Krishna → verify transition in Slack
- CI gate: GitHub Actions runs `bun test` on PRs
