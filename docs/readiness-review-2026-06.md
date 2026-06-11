# Polaris — Internal-Testing & Production Readiness Review

*Written 2026-06-11. Assessed at commit `b35448e`. Method: multi-agent review across five dimensions (dogfooding readiness, security, scalability/reliability, maintainability, product/competitive), with every blocker/high finding adversarially re-verified against the code. Companion to `product-critique-2026-06.md`.*

---

## TL;DR

Polaris at `b35448e` is **a working capture-and-broadcast pipeline, not yet the multiplayer product it advertises.** The half that records what your agent does and posts it to Slack/dashboard largely works. The half that defines the product — teammates injecting advice into a *live* session — is **dead code**. On top of that, the API enforces no authentication and the JWT secret has a hardcoded default, so it is not safe to expose. It is **not ready for internal testing today**; the gap is roughly **1–2 focused weeks** of must-have fixes.

Verification note: of the 16 blocker/high findings re-checked against the code, **14 were confirmed and 2 were partially-confirmed** (the Slack "missing signature verification" was relabeled — Socket Mode authenticates at the transport layer, so the real issue is missing app-level authorization + prompt-injection, not signatures; and the email-domain-takeover is bounded today because Google is the only IdP and returns provider-verified emails). Nothing was refuted.

---

## 1. Current state, by dimension

**Dogfooding readiness — not ready.** A 4-person session would connect, see teammates' *prompts* in Slack, but never see agent *responses* (a hook-wiring regression), and could never advise a running session (injection is unimplemented). Onboarding also silently depends on `bun` and the `claude` CLI being installed.

**Security — not safe to expose.** `resolveOrgId()` (`server.ts:152`) treats the bearer token as optional and falls back to a shared `default` org, so every endpoint is reachable unauthenticated. The JWT secret defaults to `polaris-dev-secret-change-in-prod` (`auth.ts:3`) with no production check — anyone who knows it can mint a token for any `org_id`, collapsing tenant isolation. Inject/event endpoints let any caller spoof an arbitrary `sender`. The localhost daemon (`:4322`) is fully unauthenticated. Secrets and full transcripts are stored plaintext. *Good news:* DB queries are consistently org-scoped, so there is no cross-org IDOR **once** the JWT secret is fixed.

**Scalability/reliability — fine for one tiny team, not for load or a 2nd org.** Two issues are functional, not just performance: the Slack bridge writes events straight to the DB and bypasses the in-process broadcast, so injected messages never reach connected agents over WebSocket; and every history query is an unbounded full table scan returned to the client. The hosted Slack bridge serves exactly **one org** (`bridge-discover-org.ts`, `LIMIT 1`). In-memory WS/SSE subscriber maps are per-process, so you can't run more than one API replica.

**Maintainability — decent structure, dangerous gaps.** ~4,500 LOC, 11 test files / ~80 cases — but coverage concentrates on HTTP plumbing and **skips the two things that make the product work**: the daemon→MCP last hop and any auth/tenancy test. The "inject" tests pass while the feature is dead, because they assert against a WebSocket the test opens directly. Schema handling is still drop-and-recreate. The SKILL.md template is duplicated verbatim in two places in `cli.ts`.

---

## 2. Must-have before internal testing can start

Ordered by importance. Rough effort in brackets.

1. **Implement inject delivery into the live session.** [days] The daemon's `mcpCallbacks` map (`daemon.ts:25`) is never populated and the MCP client's poll loop (`client.ts:244-249`) is comment-only. Add a daemon endpoint the MCP client long-polls (e.g. `GET /inbox/:ccSessionId`); push inject events into a per-session queue; have the client drain it and surface messages to the model. **Also** route Slack injects through the broadcast path (`bridge.ts:264` writes to DB only). Do **not** depend on the `claude/channel` MCP notification — it's a gated research-preview feature requiring `--dangerously-load-development-channels` for non-allowlisted servers. *Confirmed blocker — this is the entire value prop.*
2. **Install the transcript-walking Stop hook.** [hours] `install()` wires all hooks to `capture.sh`, a raw forwarder; native Stop payloads have no `stop_response`, so `format.ts` drops them and agent responses never reach Slack. The correct producer (`capture-stop.ts`) exists but is never referenced. Point the Stop hook at it. *Confirmed — guts the experience.*
3. **Enforce auth + ban the default JWT secret in the deployed service.** [hours] Reject unauthenticated/invalid-token requests with 401 instead of falling back to `default` org; fail startup if `POLARIS_JWT_SECRET` is unset/default. Even an internal alpha shouldn't run with a forgeable-token, open-API posture. *Confirmed blocker.*
4. **Add an onboarding preflight.** [hours] Check `bun` and `claude` are on PATH and abort with instructions if missing; document both as prerequisites. Today a missing `claude` makes `claude mcp add` warn-and-continue, leaving a silently broken install with no `/polaris` tools.
5. **Fix `polaris_reply` attribution.** [hours] `daemon.ts:493` sends `sender: mapping.user`, so agent floor messages render as the human in Slack — corrupting the "who said what" record the product depends on.
6. **Fix or surface multi-session hook routing.** [days] Events are keyed by CC session id but the client mints its own UUID; with >1 connected session the daemon returns `ambiguous` and **silently discards** the event. Engineers run multiple Claude windows — this will bite within the first hour.
7. **Back up the DB and guard the destructive migration.** [hours] `db.ts:57-76` runs `DROP TABLE events/sessions/projects` on a schema mismatch at every startup. Gate it behind an explicit flag; `pg_dump` before pointing the team at the shared instance.

---

## 3. Compact product & competitive critique

*(Builds on `product-critique-2026-06.md`; not repeated here.)*

**Defensible value after Claude's native shipments — thin, and unbuilt.** The observe + Slack-broadcast + advisor-inject loop is now **commoditized by the platform owner**: Claude Code in Slack does async initiation, thread context, progress, and PRs; `claude/channel` (which Polaris is literally built on) does push-into-session; and v2.1.81's permission relay already *is* remote HITL approvals. What's left that Anthropic structurally won't build: **(a) cross-vendor capture** (one floor across Cursor + Claude + Devin) and **(b) summarized, attributed, cross-session project memory that survives handoff.** Both are design-doc prose and stub code today.

**Assumptions that may not hold.** (1) That teams want *synchronous* multiplayer — an advisor watching and injecting mid-flight — when observed 2026 behavior is *async* delegation. (2) That engineers accept their full transcript broadcast to a shared Slack channel (trust in AI tools sits ~29%). Neither is validated: there is **zero usage instrumentation and zero design-partner evidence** in the repo.

**Competitive position — squeezed, no segment owned.** Below, free platform features (Claude-in-Slack, channels) and deep incumbents (Devin, $80/mo, Slack/Linear-native); above, sub-$10 parallel-agent managers (Omnara $9/mo, Conductor, Vibe Kanban). Each owns a concrete behavior (async delegation, mobile approval) Polaris doesn't.

**Odds Claude absorbs the remaining featureset — high for most of it.**
- HITL approvals: **already shipped** (channel permission relay).
- Multi-person attribution / durable project floor: **likely** — squarely in the Slack/Teams-visibility roadmap.
- Cross-session shared memory: **likely, but Claude-only** — which is precisely why the *cross-vendor* version is the wedge.
- Cross-vendor capture: **won't build** — structural conflict with being the model vendor. This is the one durable square, and it's getting no investment.

**The thesis contradicts the code.** You cannot sell "durable attributed team memory" on a store that silently drops events, serves one org, and can wipe production on a schema change. Memory-as-moat requires the memory to be complete and multi-tenant **first**.

**Recommendation:** pick ONE wedge Anthropic can't take (cross-vendor capture, or cross-vendor shared memory), ship it as product not prose, demote Slack-broadcast to a rendering surface, freeze named-agents past the metadata table, and instrument injection/handoff usage now.

---

## 4. Production rollout task list

**P0 — blocks launch**
- Enforce strong JWT secret at boot; fail startup on unset/default in production. *(security)*
- Make authentication mandatory on the API; 401 instead of `default`-org fallback. *(security)*
- Validate `sender` matches the authenticated caller's `participant_id` on event/inject. *(security)*
- Replace drop-and-recreate migration with additive migrations; never auto-run destructive paths in prod. *(reliability)*
- Scheduled Postgres backups + documented restore. *(ops)*
- Rate-limit auth/token endpoints before public exposure. *(security)*
- Per-org Slack bridge (remove `LIMIT 1` single-tenant ceiling). *(multi-tenancy)*

**P1 — immediately after**
- Authn/authz on the local daemon endpoints (shared local secret). *(security)*
- Daemon write-ahead buffer with async retry/backoff so hooks never block or lose events. *(reliability)*
- Single-instance lock on the bridge to stop duplicate Slack posts. *(reliability)*
- Pagination on all event queries. *(scalability)*
- Copy hook scripts to a stable path (`~/.polaris/hooks`) so npm reinstalls/nvm switches don't leave stale paths. *(reliability)*
- Bundle/transpile for end users; drop the `npx --yes bun` download-on-every-invocation path. *(ops)*
- Capture tool approvals/rejections and ask-question answers, not just prompts. *(feature)*
- Encrypt at-rest Slack bot tokens; retention/redaction policy for captured payloads. *(security)*
- Integration test exercising the real inject path (daemon → MCP client → Claude). *(quality)*

**P2 — later**
- Postgres `LISTEN/NOTIFY` to replace the 5s bridge poll. *(scalability)*
- Daemon credential reload on `polaris use`/login. *(ops)*
- Dashboard SSE client reconnect. *(reliability)*
- Project delete / session archive lifecycle. *(feature)*
- `polaris recover` reconciliation (diff JSONL log vs DB, backfill). *(reliability)*
- CD to production on merge. *(ops)*
- Sanitize `raw_turn` Unicode before JSONB insert. *(reliability)*

---

## 5. Debt to clear BEFORE the named-agents / context-pooling featureset

Building the roadmap on the current foundation compounds debt. Clear these first:
- **One stable session-identity scheme** shared across hook env, MCP client, and daemon — before named agents multiply concurrent sessions and turn the ambiguous-drop bug into routine loss.
- **The real daemon↔MCP IPC channel** (long-poll inbox / unix socket) — named agents depend on reliably delivering targeted messages; don't bolt them onto the dead `mcpCallbacks` map.
- **One authoritative sender-attribution path** — reply mislabels agent as human, events infer sender from `hook_event_name`; multi-agent identities make centralized attribution a prerequisite.
- **Additive migrations** — before the featureset adds agent-identity columns/tables.
- **Server-side auth + sender validation** — before more writers/identities expand the surface.
- **Pagination/streaming on event reads** — before context pooling fans out across many sessions.

---

## 6. Issues that emerge or worsen ONCE the planned featureset ships

**Scalability**
- Context pooling fans unbounded full-scan queries across many sibling sessions → slow, DB-heavy context fetches as history grows.
- Named agents multiply concurrent sessions per machine → amplifies the multi-session ambiguous-drop bug.
- Bridge polls the whole org every 5s and keeps an unbounded in-memory `postedEventIds` set → grows with agent/session count.
- Single bridge + single `channelCache` per org becomes a throughput bottleneck; all org traffic funnels through one Socket Mode connection.
- Per-process, unbounded WS/SSE subscriber maps → broadcast cost and memory grow with no backpressure.
- The new inject long-poll gets hit by every named agent on an interval → O(agents × poll-rate) load without coalescing.

**Security**
- Optional auth + unvalidated `sender` + named agents = impersonation gets worse; no way to tell a genuine named agent from a forged one on the floor.
- The forgeable JWT secret + context pooling = an attacker with a minted token reads pooled cross-session context across tenants.
- Unencrypted captured payloads + pooling (which intentionally surfaces one session's content to others) = a cross-session data-exposure channel without per-session ACLs.
- The unauthenticated local daemon gains more powerful verbs (targeted inject to a specific agent) → any local process can impersonate/direct a named agent.

**Maintenance**
- Sender/identity logic already duplicated across `daemon.ts`, `server.ts`, `format.ts`, `bridge.ts` → adding agent identities scatters naming rules across all four.
- SKILL.md duplicated in two `cli.ts` sites → adding agent commands means editing both; they will drift.
- Hooks resolved from the global package dir with no staleness detection → featureset releases that change hook behavior risk silently running stale hooks.
- MCP server must be restarted to pick up new tools → shipping agent tools mid-alpha forces every dogfooder to restart with no signal to do so.
- Dead/half-built scaffolding (comment-only poll loop, unpopulated `mcpCallbacks`, unused `claude/channel` declaration, dead `POLARIS_PROMPT_STYLE`) gives false confidence and the misleading "inject" tests keep masking regressions.
- `capture-stop.ts` re-reads the full transcript on every Stop → cost compounds across more agents/sessions.
