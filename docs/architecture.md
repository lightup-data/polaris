# Polaris — System Architecture

*As of branch `feat/knowledge-capture-alpha` (PR #71), 2026-06-11. Grounded in the actual code: `src/service/{server,db,auth}.ts`, `src/daemon/daemon.ts`, `src/client/client.ts`, `src/slack/bridge.ts`, `src/web/app.ts`, `src/cli/cli.ts`, `hooks/*`.*

Legend: `──▶` one-way · `◀──▶` two-way (request/response or bidirectional) · `≈≈▶` deferred/not-yet-wired.

---

## 1. What Polaris is, in one paragraph

Polaris captures everything a coding agent does (prompts, responses, tool calls) into a durable, org-scoped, searchable record, broadcasts it to teammates in real time, and lets a teammate inject context back into a *live* agent session. It integrates with the **local Claude Code CLI** via two mechanisms — **hooks** (capture out) and an **MCP server** (control + inject delivery) — never with claude.ai or Claude Code web. A central cloud service is the system of record and the real-time broker; Slack is one rendering/participation surface; a web dashboard is the read/search/inject surface.

---

## 2. Where everything runs

| Plane | Components |
|---|---|
| **Each developer's machine** | Claude Code CLI · Polaris hooks (`capture.sh`, `capture-stop.ts`, `capture-prompt.ts`) · Polaris MCP server (`client.ts`, stdio) · Polaris daemon (`daemon.ts`, `127.0.0.1:4322`) · `~/.polaris/` (config + JSONL logs) · `~/.claude/settings.json` (hook/MCP wiring) |
| **Cloud (single Hetzner VPS today, behind Caddy/TLS)** | API service (`server.ts`, `:4321`) · Web app/dashboard (`app.ts`, Hono, `:3000`) · Slack bridge (`bridge.ts`, one process per org) · Postgres 17 |
| **External SaaS** | Google (OAuth/SSO) · Slack (OAuth + Socket Mode + Web API) |
| **NOT integrated** | claude.ai · Claude Code on the web · Claude Code mobile. Polaris only touches the *local* Claude Code CLI. |

---

## 3. The big picture

```
                              DEVELOPER MACHINE (one per teammate)
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │                                                                                 │
 │   ┌───────────────┐  stdio JSON-RPC   ┌──────────────────┐                      │
 │   │  Claude Code  │◀─────────────────▶│  Polaris MCP srv │  (client.ts, stdio)  │
 │   │     CLI       │                   │  tools:          │                      │
 │   │  (the agent)  │                   │  connect/reply/  │                      │
 │   │               │                   │  status/context/ │                      │
 │   │               │                   │  rename/disconn. │                      │
 │   └──┬─────▲──────┘                   └─────────┬────────┘                      │
 │      │     │ additionalContext                  │ HTTP ◀──▶                      │
 │      │ fires hooks (on events)                  │ (connect/reply/status/context)  │
 │      ▼     │                                     ▼                               │
 │   ┌─────────────────────────┐  HTTP POST   ┌───────────────────────────────┐    │
 │   │ HOOKS                    │─────────────▶│  Polaris DAEMON  127.0.0.1:4322│    │
 │   │ • capture.sh   Pre/Post  │  /events     │  • session mappings (mem)      │    │
 │   │   ToolUse      ──▶ (1-way)│             │  • injectQueues  (mem)         │    │
 │   │ • capture-stop.ts  Stop  │─────────────▶│  • ~/.polaris/logs/*.jsonl     │    │
 │   │   ──▶ (1-way, transcript)│  /events     │  • token from ~/.polaris/cfg   │    │
 │   │ • capture-prompt.ts      │◀────────────▶│                                │    │
 │   │   UserPromptSubmit       │ /events resp │                                │    │
 │   │   ◀── pendingInjects     │ pendingInject│                                │    │
 │   └─────────────────────────┘              └──────────┬──────────▲──────────┘    │
 │                                                        │          │               │
 └────────────────────────────────────────────────────── │ ──────── │ ──────────────┘
                                            HTTP POST /events│          │ WebSocket (per session)
                                            (event ingest,   │          │ cloud──▶daemon push
                                             1-way)          ▼          │ (broadcast incl. injects)
                                       ┌───────────────────────────────────────────────┐
                                       │            CLOUD API SERVICE  :4321            │
                                       │            (server.ts)                         │
   Google ◀──▶ ┌────────────┐          │  REST (auth-gated via authOrgId / Bearer JWT): │
   OAuth       │  WEB APP   │  HTTP    │   projects·sessions·events(ingest/GET page)·   │
   Slack ◀──▶  │  :3000     │◀────────▶│   inject·handoff·driver·label·search·messages  │
   OAuth       │ (Hono)     │  fetch   │  WS  /projects/:p[/sessions/:s]/ws  ──▶ push    │
               │ dashboard, │  +Bearer │  SSE /projects/:p[/sessions/:s]/events ──▶ push │
               │ transcript,│          │  in-mem subscriber maps (projectSubs/SSE)      │
               │ search,    │          └───────────────┬───────────────────────────────┘
               │ inject     │                          │ read/write
               │ proxy      │                          ▼
               └─────┬──────┘             ┌─────────────────────────────┐
                     │ read/write          │        POSTGRES 17          │
                     └────────────────────▶│ orgs·users·projects·        │
                                ▲          │ sessions(+label)·events     │
                                │ read/write│ (JSONB)·schema_migrations   │
                  ┌─────────────┴──────┐    └─────────────────────────────┘
   Slack  ◀──────▶│   SLACK BRIDGE     │ poll events every 5s ──▶ post to Slack
   (Socket Mode + │   (one per org)    │ inbound Slack msg ──▶ writes inject to DB
    Web API)      │   bridge.ts        │ ≈≈▶ does NOT broadcast to API (Slack→live
                  └────────────────────┘     session inject deferred: needs LISTEN/NOTIFY)
```

---

## 4. Communication paths (precise)

| From → To | Transport | Direction | Purpose | Auth |
|---|---|---|---|---|
| Claude Code ↔ MCP server | stdio JSON-RPC | two-way | tool calls (`polaris_connect/reply/status/context/rename`) | none (local, trusted) |
| Claude Code → hooks | process exec + stdin | one-way trigger | fire on Pre/PostToolUse, Stop, UserPromptSubmit | none (local) |
| Claude Code ◀ capture-prompt hook | hook stdout `additionalContext` | one-way **into the model** | deliver queued teammate injects on next prompt | none (local) |
| `capture.sh` / `capture-stop.ts` → daemon | HTTP POST `/events` | one-way (fire-and-forget) | event capture | none (local) |
| `capture-prompt.ts` ↔ daemon | HTTP POST `/events` | two-way (req/resp) | capture **and** read back `pendingInjects` | none (local) |
| MCP server ↔ daemon | HTTP (`/register`,`/connect`,`/reply`,`/status`,`/context`,`/rename`) | two-way | session control & queries | none (local) ⚠ |
| daemon → API | HTTP POST `/projects/:p/sessions/:s/events` | one-way | relay captured events upstream | Bearer JWT (or anon→default in dev) |
| daemon ◀ API | **WebSocket** per session `/projects/:p/sessions/:s/ws` | one-way push (cloud→daemon) | receive broadcasts, esp. `inject` events → `injectQueues` | token in WS connect |
| Web app ↔ API | HTTP `fetch` + `Authorization: Bearer` | two-way | transcript events, search, inject proxy | Bearer JWT |
| Web app ↔ Google | OAuth 2.0 redirect + userinfo | two-way | SSO login/signup | OAuth |
| Web app ↔ Slack | OAuth (`/slack/install`,`/slack/callback`) | two-way | obtain bot token | OAuth |
| Web app → CLI (login) | redirect to `http://127.0.0.1:<port>/callback?token=` | one-way | deliver JWT to the CLI loopback server | ⚠ no state/nonce |
| Browser ↔ Web app | HTTP, **JWT in `?token=` query param** | two-way | dashboard/transcript/search pages | JWT in URL ⚠ |
| Bridge ↔ Slack | Socket Mode **WebSocket** (appToken) + Web API (bot token) | two-way | receive Slack msgs (ack) + post events | Slack app/bot tokens |
| Bridge ↔ Postgres | SQL | two-way | poll `getOrgEventsSince` (every 5s); write inbound injects via `pushEvent` | DB creds |
| Bridge → API | — | **none today** | (Slack-originated inject → live session) | ≈≈▶ deferred (LISTEN/NOTIFY) |
| API ↔ Postgres | SQL (`postgres` client) | two-way | system of record | DB creds |
| CLI → API/web | HTTP | two-way | validate token, post device-connected event | Bearer |
| CLI → `~/.claude` + `claude mcp add` | filesystem + subprocess | one-way | install hooks, statusline, SKILL.md, register MCP | local |

---

## 5. Key end-to-end flows

### 5a. Capture (agent activity → record → teammates) — works today
1. Driver prompts Claude Code → `UserPromptSubmit` fires `capture-prompt.ts`; agent finishes → `Stop` fires `capture-stop.ts` (walks the transcript for the full response); tool calls fire `capture.sh`.
2. Hook → daemon `POST /events`. Daemon stamps sender (`user:*` for prompts, `agent:*` for Stop/tool events), logs to `~/.polaris/logs/*.jsonl`, relays upstream to the API.
3. API `pushEvent` → Postgres `events` (JSONB), then `broadcastEvent` (WS) + `broadcastSse` (SSE) to subscribers.
4. Subscribers: other daemons' session WS, the dashboard (SSE), and — via the bridge's 5s DB poll — Slack channels.

### 5b. Inject / live steering (teammate → driver's live agent) — works today (dashboard-initiated)
1. Advisor opens the session transcript in the dashboard and submits guidance → web `POST /sessions/:p/:s/inject` proxies to API `POST /projects/:p/sessions/:s/inject` (sender derived from the advisor's JWT, not client input).
2. API persists the `inject` event + `broadcastEvent` over the session WS.
3. The driver's daemon (subscribed to that session's WS) receives it → pushes to `injectQueues[ccSessionId]`.
4. Driver's next prompt → `capture-prompt.ts` → daemon `/events` response returns `pendingInjects` → hook emits `hookSpecificOutput.additionalContext` → **Claude Code folds the teammate's guidance into the model's context.** Delivery is at the next turn boundary (not mid-tool-call).
5. ≈≈▶ **Slack-initiated** inject is deferred: the bridge writes the inject to the DB but does not broadcast, so it never reaches the live session. Fix = Postgres `LISTEN/NOTIFY` (bridge `NOTIFY` on insert → API `LISTEN` → broadcast).

### 5c. Read / search (knowledge retrieval) — works today
- Transcript: web `GET /sessions/:p/:s` → API `GET /projects/:p/sessions/:s/events?limit=&before=` (keyset pagination, DESC) → rendered chronologically with injects highlighted.
- Search: web `GET /search` → API `GET /search?q=&project=&sender=&source=` → `searchEvents` (query-time Postgres full-text with `ts_headline` snippets).

### 5d. Onboarding / login
1. `npx @lightupai/polaris` → CLI starts a loopback server, opens browser to web `/auth/cli?port=…`.
2. Web → Google OAuth → callback mints a JWT (`createToken`, HS256) carrying `org_id` + `participant_id` (org resolved/created by email domain).
3. Web redirects the JWT to the CLI's `127.0.0.1:<port>/callback?token=` → stored in `~/.polaris/config.json`.
4. CLI installs hooks + statusline into `~/.claude/settings.json`, writes SKILL.md, registers the MCP server via `claude mcp add`, starts the daemon.

---

## 6. Persistence layer

**Postgres 17 (durable, system of record).** Migrations are now additive/idempotent (`schema_migrations` + `ALTER … IF NOT EXISTS`); the old drop-and-recreate path is removed.

| Table | Key columns | Notes |
|---|---|---|
| `orgs` | id, name, slug, domain, `slack_team_id`, **`slack_bot_token`** (⚠ plaintext), `slack_system_channel_id` | tenant root |
| `users` | id, email (unique), name, org_id→orgs, participant_id | identity |
| `projects` | id (uuid), org_id, name, slack_channel_id/name | unique (org_id, name) |
| `sessions` | PK (project_id, name), org_id, driver, **`label`** (new) | conversation/workstream |
| `events` | id (uuid), org_id, project_id, session, timestamp, source (`hook`/`inject`/`reply`), sender, **`payload` JSONB** | the record; the JSONB holds prompts/responses/tool I/O/`raw_turn` |
| `schema_migrations` | id, applied_at | new migration ledger |

Indexes: `idx_events_project(project_id, timestamp)`, `idx_events_session(project_id, session, timestamp)`. Full-text search is currently **query-time** (no FTS index yet — flagged as a pre-scale follow-up).

**Ephemeral / in-memory (lost on restart):**
- API: `projectSubs` / `sessionSubs` (WS) and SSE client sets — **per-process**, so horizontal scaling needs shared pub/sub.
- Daemon: `sessions` (mappings) and `injectQueues` — per-machine, per-process.

**Local on-disk (per developer machine):**
- `~/.polaris/config.json` — profiles + JWT (⚠ plaintext, no chmod).
- `~/.polaris/logs/*.jsonl` — full event payloads for recovery (⚠ plaintext transcripts, no rotation/redaction).

---

## 7. Auth & security model

**Authentication**
- Humans: Google SSO → JWT (HS256 via `jose`, issuer `polaris`, 30-day expiry). Payload carries `org_id` + `participant_id`.
- Service→service: the daemon and web app present that JWT as `Bearer` to the API.
- Slack: per-org bot token obtained via OAuth (stored in `orgs.slack_bot_token`); bridge uses a `SLACK_APP_TOKEN` for Socket Mode.

**Authorization & tenancy**
- Every DB query is **org-scoped** (`WHERE org_id = …`) → tenant isolation at the data layer.
- API gate `authOrgId`: valid Bearer → that org; **in production**, missing/invalid token → **401**; in dev/test → falls back to a shared `default` org (so the suite runs unauthenticated).
- `assertSecretConfigured()` fails startup in production if `POLARIS_JWT_SECRET` is unset or the dev default.
- Inject `sender` is derived from the authenticated token (client-supplied sender ignored) → no impersonation on the inject path.
- **No per-project ACLs** — every org member can read all projects/sessions/events (org-wide read; acceptable for internal alpha, ACLs deferred).

**Transport**
- Prod: Caddy terminates TLS for `app.` and `api.` (Let's Encrypt); daemon↔cloud WS upgrades to `wss`.
- Local: hooks ↔ daemon ↔ MCP all on `127.0.0.1` plaintext (acceptable — local trust domain).

**Known security gaps (tracked in `readiness-review-2026-06.md`)**
- ⚠ Local daemon HTTP endpoints are **unauthenticated** — any local process can post events, inject, or read context as the user.
- ⚠ JWT travels in the browser URL (`?token=`) and on the CLI loopback callback; CLI callback has **no state/nonce** (login-CSRF/token-injection risk).
- ⚠ Slack bot tokens stored **plaintext** in Postgres; daemon JSONL logs store **plaintext transcripts**; compose ships a default DB password.
- ⚠ Google `email_verified` is not checked; org auto-join by email domain has no admin approval.
- ⚠ No rate limiting on auth/token endpoints.
- Note: the Slack bridge uses Socket Mode (authenticated at the WS transport by Slack), so classic request-signature verification is N/A — but there is no **app-level authorization** on *which* Slack user may inject into *which* session.

---

## 8. Trust boundaries

1. **Local machine** (Claude Code, hooks, MCP, daemon) — one trust domain; localhost, unauthenticated between local components.
2. **Local ↔ cloud** — authenticated boundary (Bearer JWT over HTTPS/WSS). This is the real security perimeter.
3. **Cloud internal** (API ↔ web ↔ bridge ↔ Postgres) — co-located today; only Caddy is exposed publicly. Bridge↔API is currently a *gap* (no path), not a boundary.
4. **Cloud ↔ external SaaS** (Google, Slack) — OAuth-mediated.

---

## 9. What is intentionally NOT here (yet)

- **No claude.ai / Claude Code web / mobile integration.** Polaris hooks into the *local* Claude Code CLI only.
- **Slack-initiated injection into a live session** — deferred (needs `LISTEN/NOTIFY`); Slack capture→post works, dashboard-initiated inject works.
- **`claude/channel` push delivery** — deferred in favor of the ungated `UserPromptSubmit` `additionalContext` path.
- **Semantic/RAG search, per-project ACLs, multi-session hook-routing disambiguation, horizontal API scaling (shared pub/sub), multi-org Slack bridge** — all deferred follow-ups.
