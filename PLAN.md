# Collab: Bidirectional Coding Agent Session Bridge

## Context

We're building the first feature for the Lightup project — a system that **captures every interaction** in a coding agent session (user messages, agent responses, tool calls, tool results) and **injects external messages** into the session. This enables multiplayer collaboration where teammates and external systems can observe and participate in coding agent sessions. The system is model-agnostic — it works with any coding agent (e.g., Claude Code, Cursor, Windsurf).

Collab is a **SaaS service**. Organizations sign up, connect their Slack workspace, and team members authenticate via SSO. The cloud service is the central broker and system of record.

## Organization & Auth

### Org Signup (Admin, web app at collab.dev)

1. Admin visits `collab.dev`, signs up with **Google SSO**
2. Creates an **organization** (e.g., `lightup`)
3. Admin dashboard:
   - **Connect Slack workspace** — OAuth flow, collab gets a bot token
   - **Invite team members** — by email, or auto-join by email domain
   - **Manage projects** — create, archive, view activity

### Slack Connection (Admin, web app)

Admin clicks "Connect Slack" → Slack OAuth → collab receives bot token + workspace user list (with emails). The **Slack bridge is server-side** — managed by the SaaS, not deployed by the user. One bridge per org.

### User Auth (each team member, one-time per machine)

```sh
npx @lightup/collab login
```

Opens browser → Google SSO (same provider as the org) → callback stores a token in `~/.collab/credentials.json`.

The token carries:
- **User identity** — derived from Google profile (e.g., `user:manu`)
- **Org membership** — which org this user belongs to
- **Service URL** — the collab SaaS endpoint

The `login` command also installs:
- Local daemon (as a persistent service — launchd on Mac, systemd on Linux)
- MCP server config → `~/.claude/` (global, works in every project and Claude Desktop)
- Hook config → `~/.claude/settings.json`
- Status line config → `~/.claude/settings.json`
- `/collab` skill → `~/.claude/skills/collab/SKILL.md`

**One command sets up everything.**

### Identity Mapping (Slack ↔ Collab)

The user's **email is the common key** between Google SSO and Slack:

- When admin connects Slack (OAuth), collab gets the workspace user list with emails
- When a user logs in via Google SSO, collab has their email
- **Automatic match**: collab user `user:manu` (manu@lightup.com) ↔ Slack user `@manu` (manu@lightup.com)

When a collab event is posted to Slack, it shows the user's Slack identity (avatar, display name). When someone posts in Slack, the bridge resolves Slack user → email → collab identity.

**Edge cases:**
- **Email mismatch** (different Google vs Slack emails) — admin dashboard has manual override to link accounts
- **No Slack account** — collab posts as the bot with attribution: `collab-bot: [user:manu] built the auth middleware`
- **Slack-only advisor** (no collab account) — Slack display name used as identity: `slack:krishna`

## Participants: Humans and Agents

Every participant in collab — whether human or AI agent — has an **identity** with a type prefix:

- `user:manu`, `user:krishna`, `user:priya` — humans (identity from SSO)
- `agent:test-writer`, `agent:security-reviewer` — agents
- `slack:someone` — Slack-only participants without a collab account

Agents are **first-class participants**. They can be drivers or advisors, same as humans. Collab treats them identically — the cloud service doesn't distinguish between human and agent clients.

**Spawning**: humans create sessions and start agents out of band (not managed by collab in v1).

**Privileges & HITL**: agent permissions, approval flows, and escalation paths are configured outside collab. Collab's job is context pooling, capture, injection, and broadcast — not authorization.

**Addressed messaging**: every injection specifies a **target** — a specific session within the project. No blind broadcast into all sessions.

## Data Model: Projects, Sessions, Drivers, Advisors

### Organizations

An **organization** is the top-level account. Created via signup on `collab.dev`. All projects, users, and integrations are scoped to an org.

### Projects

A **project** is the context container within an org. All context is pooled at the project level. A project has a flat, human-readable name (e.g., `pj`). One Slack channel per project (`#pj`).

### Sessions

A project contains one or more **sessions**, each representing a concurrent workstream (e.g., feature, bugfix). Sessions have names scoped to their project (e.g., `fxm`, `fxk`).

### Drivers

Each session has **one driver** — a human or agent actively building in a coding agent (e.g., Claude Code). Multiple sessions in a project can have concurrent drivers (one per session). A driver's activity (prompts, agent responses, tool calls) is captured and broadcast.

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
3. New driver claims the session, connects their coding agent CLI
4. New driver's session is seeded with context from project history
5. Slack channel shows the transition

## Setup Flow

### Step 1: Admin signs up org (once)

On `collab.dev`:
1. Google SSO → org created
2. Connect Slack workspace → OAuth
3. Invite team (or set auto-join by email domain)

### Step 2: User sets up machine (once per machine)

```sh
npx @lightup/collab login
```

Browser opens → Google SSO → token stored → daemon installed → MCP/hooks/skill/status line configured in `~/.claude/`. Done.

### Step 3: User connects to a session (each time)

Inside any coding agent:
```
/collab join my-project fxm
```

Project is scoped to the user's org (from token). User identity is from SSO. Session is created if it doesn't exist, or joined if it does. The Slack channel `#my-project` is auto-created by the server-side bridge if this is the first session in this project.

That's the complete flow: **one web signup, one CLI command, one slash command.**

## Example: Project `pj` with Humans + Agents

```
Project pj (org: lightup)
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
[user:manu/fxm → agent]                "Let's implement the auth middleware"
[agent → user:manu/fxm]                "I'll create src/middleware/auth.ts..."
[user:krishna/fxk → agent]             "Set up the database schema for users"
[agent → user:krishna/fxk]             "Creating migrations/001_users.sql..."
[user:priya → fxk]                     "Remember we need GDPR compliance on the users table"
[agent → user:krishna/fxk]             "Good point from Priya. Adding data retention fields..."
[agent:security-reviewer → fxm]        "This auth endpoint needs rate limiting"
[agent → user:manu/fxm]                "Adding rate limiting middleware..."
[agent:test-writer/tests → agent]      "Writing integration tests for auth middleware"
[agent → agent:test-writer/tests]      "Created tests/auth.test.ts..."
[user:manu/fxm → agent]               "What has Krishna done on fxk so far?"
[agent → user:manu/fxm]               "Krishna has set up the users schema with GDPR fields..."
```

6. Manu finishes `fxm`, hands off `fxk` to himself to continue Krishna's work
7. The Slack log is continuous and complete — humans, agents, handoffs, all in one stream

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                    Collab SaaS (collab.dev)                    │
│                                                               │
│  Web App:                                                     │
│    Signup (Google SSO) | Org dashboard | Slack OAuth           │
│                                                               │
│  Cloud Service (Broker / System of Record):                   │
│    REST API (all endpoints authenticated via token)           │
│    POST /projects                       create                │
│    GET  /projects/:proj                 metadata              │
│    GET  /projects/:proj/messages        full history          │
│    GET  /projects/:proj/events          SSE (all)             │
│    POST /projects/:proj/sessions        create session        │
│    GET  /projects/:proj/sessions/:sess  metadata              │
│    POST /projects/:proj/sessions/:sess/events   push          │
│    GET  /projects/:proj/sessions/:sess/events   SSE           │
│    POST /projects/:proj/sessions/:sess/inject   inject        │
│    GET  /projects/:proj/sessions/:sess/messages history       │
│    POST /projects/:proj/sessions/:sess/handoff  release       │
│    POST /projects/:proj/sessions/:sess/driver   claim         │
│                                                               │
│  WebSocket (authenticated):                                   │
│    /projects/:proj/ws              project-level              │
│    /projects/:proj/sessions/:sess/ws  session-level           │
│                                                               │
│  Slack Bridge (server-side, managed per org):                 │
│    project ↔ Slack channel (auto-created)                     │
│    Email-based identity mapping (SSO ↔ Slack)                 │
│                                                               │
│  Persistence: Postgres (Hetzner VPS)                          │
└────────┬──────────────────────────────────────────────────────┘
         │
         │ authenticated WebSocket + REST
         │
┌────────┴──────────────────────────────────────────────────────┐
│                    User's Machine                              │
│                                                               │
│  Daemon (port 4321, one per machine):                         │
│    Routes hook events by CC session_id                        │
│    Manages WS connections to cloud (one per collab session)   │
│    Auth token from ~/.collab/credentials.json                 │
│                                                               │
│  MCP Server (one per coding agent session, stdio):            │
│    Registers with daemon on startup                           │
│    collab_connect | collab_reply | collab_context tools       │
│    claude/channel capability for advisor injection            │
│                                                               │
│  Hooks (capture.sh → POST localhost:4321/events)              │
│  Status Line (queries daemon for connection state)            │
│  /collab Skill (slash command UX)                             │
└───────────────────────────────────────────────────────────────┘
```

## File Structure

```
src/
  types.ts              # Shared event types + zod schemas
  service/
    server.ts           # Cloud service: HTTP + WebSocket + persistence
    db.ts               # Postgres persistence layer
    auth.ts             # Token validation, Google SSO, org scoping
  daemon/
    daemon.ts           # Local daemon: hook routing, WS management
  client/
    client.ts           # MCP channel server (stdio only)
  slack/
    bridge.ts           # Slack ↔ cloud bridge (server-side, Socket Mode)
    format.ts           # Event → Slack mrkdwn formatting
    identity.ts         # Email-based Slack ↔ collab user mapping
  cli/
    cli.ts              # CLI: login, daemon, status
  web/
    app.ts              # Web app: signup, dashboard, Slack OAuth
hooks/
  capture.sh            # Shell script: reads hook JSON stdin, POSTs to daemon
  statusline.sh         # Status line script: queries daemon, formats output
skills/
  collab/SKILL.md       # /collab slash command skill definition
tests/
  types.test.ts         # Schema validation tests
  db.test.ts            # Persistence layer tests
  service.test.ts       # Cloud service API tests
  auth.test.ts          # Auth + org scoping tests
  daemon.test.ts        # Daemon routing tests
  client.test.ts        # MCP client tests
  slack.test.ts         # Slack bridge tests
  format.test.ts        # Formatting tests
  identity.test.ts      # Identity mapping tests
  capture.test.ts       # Hook script test
tsconfig.json
.mcp.json               # MCP server registration
docker-compose.yml      # Local dev (Postgres)
```

## Implementation Phases

### Phase 1: Types + Persistence ✓
- `src/types.ts` — zod schemas for participant IDs, hook payloads, inject/reply messages, event envelope, project/session models
- `src/service/db.ts` — Postgres persistence layer
- Tests, deps, tsconfig

### Phase 2: Cloud Service ✓
- `src/service/server.ts` — Bun HTTP + WebSocket server with full REST API
- Project and session endpoints, WebSocket at project and session levels
- Tests

### Phase 3: Local Client + Hooks ✓ (v1, pre-daemon)
- `src/client/client.ts` — MCP channel server + HTTP relay + WS connection
- `hooks/capture.sh` — hook event relay
- Tests

### Phase 4: Auth + Org Model
- `src/service/auth.ts` — Google SSO, token issuance/validation, org scoping
- `src/web/app.ts` — web app: signup flow, dashboard, Slack OAuth
- Add org + user tables to Postgres schema
- All API endpoints require auth, scope to org
- `src/cli/cli.ts` — `collab login` command (browser SSO flow + local setup)

### Phase 5: Local Daemon + `/collab` Skill + Status Line

The local architecture uses a **single daemon per machine** that routes between multiple concurrent coding agent sessions. Users interact through the `/collab` slash command.

#### `/collab` Slash Command (Skill)

`skills/collab/SKILL.md` — the primary UX. Installed to `~/.claude/skills/collab/` by `collab login`.

- `/collab join <project> <session>` — connects the current coding agent session to a collab session. Creates the session if it doesn't exist. Project scoped to user's org (from token). User identity from SSO.
- `/collab` (no args) — shows status: connected project/session/user, or "not connected".
- `/collab disconnect` — disconnects from the current session.

Example:
```
/collab join pj fxm              ← connect to project pj, session fxm
/collab                          ← check status
/collab join pj fxk              ← switch to different session
/collab disconnect               ← disconnect
```

#### Status Line

Persistent bar at the bottom of the coding agent CLI. Always visible, updates after every turn.

When connected:
```
collab: pj/fxm (user:manu) ● connected
```

When disconnected:
```
collab: not connected
```

- `hooks/statusline.sh` — queries daemon's `GET /status/:cc-session-id`, formats output
- Installed to `~/.claude/settings.json` by `collab login`

#### Daemon

`src/daemon/daemon.ts` — persistent process on port 4321 (one per machine):
  - `POST /events` ← hooks POST here (routes via `session_id` in hook JSON)
  - `POST /register` ← MCP servers register their CC session → collab session mapping on startup
  - `POST /connect` ← `/collab join` triggers this to bind a CC session to a collab session
  - `POST /disconnect` ← `/collab disconnect` triggers this
  - `GET /status/:cc-session-id` ← status line script queries this
  - Auth token from `~/.collab/credentials.json` for all cloud API calls
  - Manages WebSocket connections to cloud service (one per active collab session)
  - Routes advisor messages from cloud to the correct MCP server instance

#### MCP Client

`src/client/client.ts` — MCP channel server (stdio only, no HTTP):
  - Registers with daemon on startup (sends CC session_id)
  - Exposes tools: `collab_connect`, `collab_disconnect`, `collab_status`, `collab_reply`, `collab_context`
  - `claude/channel` capability for injecting advisor messages
  - Receives advisor messages from daemon via IPC

#### CLI

`src/cli/cli.ts`:
  - `collab login` — browser SSO → token stored → daemon + MCP + hooks + skill + status line installed
  - `collab daemon` — starts the daemon (normally auto-started)
  - `collab status` — shows all active sessions and daemon health
  - `collab logout` — removes token and local config

### Phase 6: Slack Bridge (Floor, server-side)

The Slack bridge runs server-side as part of the SaaS — not deployed by the user.

#### Slack Channel Lifecycle

- **Channel name = project name** — project `pj` → Slack `#pj`
- **Created automatically** when the first session is created in a project (if Slack is connected for the org)
- **Channel ID stored in the project record** on the cloud service
- Users never manually create or configure the Slack channel

#### Bridge

`src/slack/bridge.ts` — runs server-side, one instance per org:
  - Connects to Slack via Socket Mode
  - Watches all projects in the org via project-level WebSocket connections
  - **Project → Slack**: session events → attributed, formatted Slack posts. `UserPromptSubmit` and `Stop` events posted; tool calls skipped or collapsed.
  - **Slack → Project**: advisor messages → injected into target session (must specify target, e.g., `@fxm use RS256`)
  - **Handoff events** → Slack notification showing the transition

#### Identity Mapping

`src/slack/identity.ts` — email-based Slack ↔ collab user mapping:
  - Automatic match via shared email between Google SSO and Slack workspace
  - Admin override in dashboard for email mismatches
  - Slack-only participants get `slack:displayname` identity

#### Formatter

`src/slack/format.ts` — event → Slack mrkdwn conversion:
  - Attribution: `[user:manu/fxm → agent]`, `[agent:security-reviewer → fxm]`
  - Markdown → Slack mrkdwn (different bold/italic/link syntax)
  - Long messages truncated with "see full message" link

#### Slack App Requirements

- Socket Mode enabled
- Bot token scopes: `channels:manage`, `channels:join`, `chat:write`, `channels:read`, `users:read`, `users:read.email`
- Tokens stored per org in the database (from the Slack OAuth flow in the dashboard)

## Key Design Decisions

1. **SaaS with SSO** — organizations sign up on collab.dev, users authenticate via Google SSO. No self-hosted setup for end users.
2. **Email-based identity mapping** — Google SSO email = Slack email. Automatic, no manual mapping. Admin override for mismatches.
3. **One command machine setup** — `collab login` installs everything: daemon, MCP, hooks, skill, status line.
4. **One slash command to connect** — `/collab join project session` from inside any coding agent. No terminal switching.
5. **Agents are first-class** — same identity model as humans (`agent:name` vs `user:name`). Spawned out of band. Privileges/HITL managed externally.
6. **Addressed messaging** — every injection targets a specific session. No blind broadcasts.
7. **Project-level context pooling** — all events persisted under the project. Sibling activity on-demand, not auto-injected.
8. **One driver per session, multiple sessions per project** — concurrent human and agent drivers.
9. **Status line** — persistent collab connection indicator in the coding agent CLI. Queries daemon, updates every turn.
10. **Single daemon per machine** — routes hook events and cloud messages between multiple concurrent coding agent sessions.
11. **Server-side Slack bridge** — managed by the SaaS, not by the user. Auto-creates channels. Email-based identity mapping.
12. **`/collab` slash command** — single entry point: join, disconnect, status.
13. **Postgres on Hetzner** — persistent, production-ready from day one.
14. **Flat names** — project names unique within an org, session names unique within a project.

## Verification

- `bun test` covers all unit + integration tests
- Manual end-to-end test:
  1. Sign up org on collab.dev, connect Slack
  2. `npx @lightup/collab login` — authenticate, install local components
  3. Open coding agent, `/collab join pj fxm` — verify status line shows connected
  4. Send a prompt → verify it appears in Slack `#pj` attributed to `user:manu/fxm`
  5. Another user: `/collab join pj fxk` — verify both sessions broadcast to `#pj`
  6. Post in Slack targeting `fxk` → verify it appears in Krishna's session
  7. Manu asks "what has Krishna done?" → `collab_context` fetches `fxk` history
  8. Handoff `fxm` from Manu → Krishna → verify transition in Slack
  9. Verify Slack identity mapping (collab user shows as correct Slack profile)
- CI gate: GitHub Actions runs `bun test` on PRs
