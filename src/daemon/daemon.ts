import type { Server, ServerWebSocket } from "bun";
import { readFile, writeFile, appendFile, mkdir, readdir, unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { POLARIS_DIR } from "../paths.js";
import { processTable, findOwner, type Owner, type Proc } from "../claude-process.js";

// Re-exported for tests
export { processTable, findOwner };

// --- Session registry ---

interface SessionMapping {
  ccSessionId: string;
  project: string;
  session: string;
  user: string;
  agent: string;
  profile: string; // which account profile this session is using
  slackChannel?: string;
  ws: WebSocket | null;
  pendingMapping?: boolean; // true until the first hook event from this shell claims the mapping
  closingIntentionally?: boolean; // set before deliberate ws.close() so onclose can distinguish drops
  connectedAt?: number; // epoch ms when /connect was called — used to detect livelock
  wsRetries?: number; // consecutive cloud WS drops without a successful open; drives backoff
}

function generateSessionName(): string {
  return `s-${crypto.randomUUID().slice(0, 4)}`;
}

const sessions = new Map<string, SessionMapping>(); // keyed by ccSessionId

// Advisor injects queued for delivery via the UserPromptSubmit hook
const injectQueues = new Map<string, Array<{ from: string; content: string; timestamp: string; type?: "direct" }>>(); // keyed by ccSessionId

// Direct session-to-session messages queued for immediate claude/channel push.
// Keyed by "project/session" so the MCP client can drain by its own session name
// without needing to know which ccSessionId alias the daemon chose.
const channelPushQueues = new Map<string, Array<{ from: string; content: string; timestamp: string }>>();

// Long-poll standby waiters: keyed by "project/session".
// polaris_standby registers a resolver here; polaris_send wakes it immediately.
const standbyWaiters = new Map<string, (pushes: Array<{ from: string; content: string; timestamp: string }>) => void>();

// --- Config resolution (env var > config.json > legacy credentials.json > defaults) ---

interface PolarisConfig {
  active: string;
  profiles: Record<string, { api: string; token: string; [key: string]: unknown }>;
  daemonSecret?: string;
}

let cachedConfig: PolarisConfig | null | undefined = undefined;
async function loadConfig(): Promise<PolarisConfig | null> {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    const configPath = join(POLARIS_DIR,"config.json");
    cachedConfig = JSON.parse(await readFile(configPath, "utf-8"));
    return cachedConfig;
  } catch {
    cachedConfig = null;
    return null;
  }
}

function getServiceUrlForProfile(profile: string): string {
  // 1. Env var override (Makefile / tests)
  if (process.env.POLARIS_SERVICE_URL) return process.env.POLARIS_SERVICE_URL;
  // 2. Named profile
  if (profile && cachedConfig?.profiles[profile]?.api) return cachedConfig.profiles[profile].api;
  // 3. Active profile
  if (cachedConfig?.active && cachedConfig.profiles[cachedConfig.active]?.api) {
    return cachedConfig.profiles[cachedConfig.active].api;
  }
  return "https://api.withpolaris.ai";
}

function getServiceUrl(): string {
  return getServiceUrlForProfile(cachedConfig?.active ?? "");
}

// --- Upstream reachability ---
// Surfaced in /status so the status line can warn loudly when the cloud service
// is down; otherwise an outage just looks like "no recent events".

const UPSTREAM_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 30_000;
let upstreamDownSince: number | null = null;

function markUpstream(ok: boolean): void {
  if (ok) upstreamDownSince = null;
  else upstreamDownSince ??= Date.now();
}

async function probeUpstream(): Promise<void> {
  try {
    // Any non-5xx answer (401 included) means the service is up; a 5xx is
    // usually the reverse proxy reporting a dead API container.
    const res = await fetch(`${getServiceUrl()}/projects`, { signal: AbortSignal.timeout(5_000) });
    markUpstream(res.status < 500);
  } catch {
    markUpstream(false);
  }
}

function upstreamDownForSec(): number | null {
  return upstreamDownSince === null ? null : Math.floor((Date.now() - upstreamDownSince) / 1000);
}

// Per-profile token cache. Key "" is used for env-var / test mode.
const tokenCache = new Map<string, string | null>();

async function getTokenForProfile(profile: string): Promise<string | null> {
  // Env var always wins (test mode) — ignore profile entirely
  if (process.env.POLARIS_AUTH_TOKEN !== undefined) {
    return process.env.POLARIS_AUTH_TOKEN || null;
  }
  // Evict expired tokens from cache so a re-login is picked up immediately.
  if (tokenCache.has(profile) && isTokenExpired(tokenCache.get(profile) ?? null)) {
    tokenCache.delete(profile);
  }
  if (tokenCache.has(profile)) return tokenCache.get(profile)!;
  // Fresh read on a cache miss so `polaris login` (new account or re-login) is
  // picked up without restarting the daemon
  cachedConfig = undefined;
  const config = await loadConfig();
  if (config) {
    const token = pickToken(config, profile);
    if (token !== undefined) {
      if (token) tokenCache.set(profile, token); // never cache "none": a re-login must be seen
      return token;
    }
  }
  // Legacy credentials.json
  try {
    const credsPath = join(POLARIS_DIR,"credentials.json");
    const creds = JSON.parse(await readFile(credsPath, "utf-8"));
    tokenCache.set(profile, creds.token ?? null);
    return creds.token ?? null;
  } catch {
    tokenCache.set(profile, null);
    return null;
  }
}

// Token for a session's profile. Falls back to the active profile only when it is the
// same account (same email): an expired personal token must never send a personal
// session's events into the work org. Returns null when there's no usable token for
// this account (relays fail and queue; the status line shows the expired token), or
// undefined when config has nothing to say (legacy credentials.json applies).
export function pickToken(config: PolarisConfig, profile: string): string | null | undefined {
  const own = profile ? config.profiles[profile] : undefined;
  if (own?.token && !isTokenExpired(own.token)) return own.token;
  const active = config.active ? config.profiles[config.active] : undefined;
  const sameAccount = !profile || !own || (own.email !== undefined && own.email === active?.email);
  if (sameAccount && active?.token && !isTokenExpired(active.token)) return active.token;
  if (own || (profile && sameAccount && active)) return null;
  return undefined;
}

// Login details for the account a session uses (or would use), read fresh from config
// so a `polaris login` shows immediately. expiresAt: ms epoch from the JWT exp.
async function accountLogin(profile: string | undefined): Promise<{
  accountProfile: string | null; accountServer: string | null; accountExpiresAt: number | null; email: string | null;
}> {
  const none = { accountProfile: null, accountServer: null, accountExpiresAt: null, email: null };
  try {
    const cfg = JSON.parse(await readFile(join(POLARIS_DIR, "config.json"), "utf-8")) as PolarisConfig;
    const key = profile || cfg.active;
    // Report the token the daemon would actually send (same rule as relaying: a
    // same-account fallback when this profile's own token is expired), not the raw
    // stored one — else a session joined under a stale profile shows "expired" while
    // its events go out on a valid login.
    const used = key ? pickToken(cfg, key) : undefined;
    const holder = used ? (Object.keys(cfg.profiles ?? {}).find((k) => cfg.profiles[k].token === used) ?? key) : key;
    const p = holder ? cfg.profiles?.[holder] : undefined;
    if (!p) return none;
    const exp = jwtPayload(used || p.token || null)?.exp;
    return {
      accountProfile: holder,
      accountServer: typeof p.api === "string" ? p.api : null,
      accountExpiresAt: typeof exp === "number" ? exp * 1000 : null,
      email: String(p.email ?? holder),
    };
  } catch {
    return none;
  }
}

function jwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try { return JSON.parse(atob(token.split(".")[1])); } catch { return null; }
}

function emailFromToken(token: string | null): string | null {
  return (jwtPayload(token)?.email as string | undefined) ?? null;
}

function isTokenExpired(token: string | null): boolean {
  const p = jwtPayload(token);
  if (!p) return true;
  return typeof p.exp === "number" && Date.now() / 1000 > p.exp;
}

async function authHeadersForProfile(profile: string): Promise<Record<string, string>> {
  const token = await getTokenForProfile(profile);
  if (token) return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return { "Content-Type": "application/json" };
}

// Non-session calls (channel listing, team, etc.) use the active profile
async function authHeaders(): Promise<Record<string, string>> {
  return authHeadersForProfile(cachedConfig?.active ?? "");
}

// --- Daemon shared-secret auth ---
//
// When a secret is resolved (env POLARIS_DAEMON_SECRET, else config.json
// `daemonSecret`), ALL daemon HTTP endpoints require the header
// `x-polaris-daemon-secret: <secret>` and reply 401 otherwise. When no
// secret is resolved, no auth is enforced (back-compat / tests).
// Note: config.json is only consulted via the startup cache (loaded in the
// import.meta.main block). Tests that call startDaemon() in-process never
// load the developer's real config, so they always run unauthenticated.
function getDaemonSecret(): string | null {
  // Env var wins; an explicitly empty value means "no auth" (matches the
  // POLARIS_AUTH_TOKEN convention above).
  if (process.env.POLARIS_DAEMON_SECRET !== undefined) {
    return process.env.POLARIS_DAEMON_SECRET || null;
  }
  const secret = cachedConfig?.daemonSecret;
  return typeof secret === "string" && secret ? secret : null;
}

// --- Cloud WebSocket management ---

// Queue inject messages that arrived while this session's socket was down. They're
// persisted server-side; query from the last delivered inject (or, failing that, the
// last delivered hook event as a safe lower bound). Deduped against the queue.
async function catchUpInjects(mapping: SessionMapping): Promise<void> {
  const serviceUrl = getServiceUrlForProfile(mapping.profile);
  try {
    let since = await readInjectCheckpoint(mapping.ccSessionId);
    if (!since) {
      // No inject checkpoint yet — fall back to the outbound delivery checkpoint.
      // Any inject sent after the last successfully delivered hook event could be missed.
      const cp = await readCheckpoint(mapping.ccSessionId);
      if (!cp || cp.project !== mapping.project || cp.session !== mapping.session) return;
      since = cp.lastEventTimestamp;
    }
    const headers = await authHeadersForProfile(mapping.profile);
    // Filter server-side: unfiltered, this returns every event in the project since
    // the checkpoint (hundreds of MB on big projects), which OOM-looped the API when
    // all daemons reconnected at once. Older servers ignore the extra params.
    const q = new URLSearchParams({ since, source: "inject", session: mapping.session });
    const res = await fetch(
      `${serviceUrl}/projects/${encodeURIComponent(mapping.project)}/messages?${q}`,
      { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
    );
    if (!res.ok) return;
    const events = await res.json() as Array<{
      source?: string; session?: string; sender?: string;
      payload?: { content?: string }; timestamp?: string;
    }>;
    const missed = events.filter(e => e.source === "inject" && e.session === mapping.session);
    if (missed.length === 0) return;

    let queue = injectQueues.get(mapping.ccSessionId);
    if (!queue) { queue = []; injectQueues.set(mapping.ccSessionId, queue); }
    let added = 0;
    for (const e of missed) {
      const ts = e.timestamp ?? "";
      const from = e.sender ?? "";
      // Dedup: skip if already in queue (e.g. WS dropped while message was undelivered)
      if (queue.some(m => m.timestamp === ts && m.from === from)) continue;
      queue.push({ from, content: e.payload?.content ?? "", timestamp: ts });
      added++;
    }
    if (added > 0) {
      console.error(`[daemon] Recovered ${added} missed inject message(s) for ${mapping.project}/${mapping.session}`);
    }
  } catch { /* best-effort */ }
}

function connectCloudWs(mapping: SessionMapping) {
  const serviceUrl = getServiceUrlForProfile(mapping.profile);
  const wsUrl = serviceUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsUrl}/projects/${mapping.project}/sessions/${mapping.session}/ws`);

  // On connect: fetch any inject messages that arrived while the WS was down.
  // Inject messages are durably persisted server-side, so we can recover them
  // by querying the project messages API with the timestamp of the last delivered inject.
  // Falls back to the outbound event checkpoint as a safe lower bound.
  ws.onopen = () => {
    mapping.wsRetries = 0;
    void catchUpInjects(mapping);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string);
      // Queue inject events for delivery via the UserPromptSubmit hook
      if (data.source === "inject") {
        let queue = injectQueues.get(mapping.ccSessionId);
        if (!queue) {
          queue = [];
          injectQueues.set(mapping.ccSessionId, queue);
        }
        queue.push({
          from: data.sender,
          content: data.payload?.content ?? "",
          timestamp: data.timestamp,
        });
      }
    } catch {
      // Ignore malformed messages
    }
  };

  ws.onclose = () => {
    const m = sessions.get(mapping.ccSessionId);
    if (m && m.project === mapping.project && mapping.project !== "" && !m.closingIntentionally) {
      // Unexpected cloud WS drop — log it so the user has a record
      void logSessionChange("ws-drop", mapping.ccSessionId, mapping.project, mapping.session, mapping.user, mapping.agent);
      // Exponential backoff with jitter: when the API restarts, every daemon's sessions
      // drop together; a fixed delay made them all reconnect in the same instant.
      const retries = m.wsRetries ?? 0;
      m.wsRetries = retries + 1;
      const delay = Math.min(60_000, 3000 * 2 ** retries) * (0.5 + Math.random());
      setTimeout(() => {
        const current = sessions.get(mapping.ccSessionId);
        if (current && current.project) {
          connectCloudWs(current);
        }
      }, delay);
    }
    if (m) m.closingIntentionally = false;
  };

  ws.onerror = () => {
    // Will trigger onclose
  };

  mapping.ws = ws;
}

function disconnectCloudWs(ccSessionId: string) {
  const mapping = sessions.get(ccSessionId);
  if (mapping?.ws) {
    mapping.closingIntentionally = true;
    mapping.ws.close();
    mapping.ws = null;
  }
}

// --- Local event log (JSONL) for manual recovery ---

const LOG_DIR = join(POLARIS_DIR,"logs");
let logReady: Promise<void> | null = null;

function ensureLogDir(): Promise<void> {
  if (!logReady) logReady = mkdir(LOG_DIR, { recursive: true }).then(() => {});
  return logReady;
}

async function logEvent(endpoint: string, payload: unknown, response?: { status: number; body?: unknown }, context?: { project?: string; session?: string; ccSessionId?: string }): Promise<void> {
  try {
    await ensureLogDir();
    const entry: Record<string, unknown> = { t: new Date().toISOString(), endpoint, payload };
    if (context?.project) entry.project = context.project;
    if (context?.session) entry.session = context.session;
    if (context?.ccSessionId) entry.ccSessionId = context.ccSessionId;
    if (response) entry.response = response;
    const file = join(LOG_DIR, `daemon-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(entry) + "\n");
  } catch { /* best-effort — don't break the request */ }
}

// --- Write-ahead outbox ---
//
// When an upstream relay fails (network error or 5xx), the event is persisted
// to ~/.polaris/outbox/ instead of being dropped, and a background retry loop
// re-POSTs it with exponential backoff (1s doubling, capped at 30s). Files are
// removed on success — and on a permanent upstream 4xx, which no retry can
// fix. Re-sends are idempotent upstream (events have stable ids), so a
// duplicate POST after a lost response is harmless. The JSONL log above is
// unchanged and still records everything.

const OUTBOX_DIR = join(POLARIS_DIR,"outbox");

interface OutboxEntry {
  t: string;
  project: string;
  session: string;
  profile: string; // which account to use when flushing
  body: unknown; // the exact { sender, payload } body for the events endpoint
}

// Absolute file path awaiting retry → which session it belongs to and when it was queued
const pendingOutbox = new Map<string, { project: string; session: string; at: number }>();

// Drift = how far behind delivery is: age of the oldest event still queued for this
// session. Zero when everything has been delivered, so an idle session never alarms.
function outboxDrift(project: string, session: string): { driftSec: number; queued: number } | null {
  let oldest = Infinity;
  let queued = 0;
  for (const m of pendingOutbox.values()) {
    if (m.project !== project || m.session !== session) continue;
    queued++;
    oldest = Math.min(oldest, m.at);
  }
  return queued === 0 ? null : { driftSec: Math.floor((Date.now() - oldest) / 1000), queued };
}
let outboxTimer: ReturnType<typeof setTimeout> | null = null;
let outboxDelayMs = 1000;
const OUTBOX_MAX_DELAY_MS = 30_000;
let outboxReady: Promise<void> | null = null;

function ensureOutboxDir(): Promise<void> {
  if (!outboxReady) outboxReady = mkdir(OUTBOX_DIR, { recursive: true }).then(() => {});
  return outboxReady;
}

async function enqueueOutbox(project: string, session: string, profile: string, body: unknown): Promise<void> {
  try {
    await ensureOutboxDir();
    const entry: OutboxEntry = { t: new Date().toISOString(), project, session, profile, body };
    const file = join(OUTBOX_DIR, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`);
    await writeFile(file, JSON.stringify(entry) + "\n");
    pendingOutbox.set(file, { project, session, at: Date.parse(entry.t) });
    scheduleOutboxFlush();
  } catch { /* best-effort — the JSONL log still has the payload */ }
}

function scheduleOutboxFlush(): void {
  if (outboxTimer || pendingOutbox.size === 0) return;
  outboxTimer = setTimeout(() => {
    outboxTimer = null;
    void flushOutbox();
  }, outboxDelayMs);
  // Don't keep the process (or the test runner) alive just for retries
  (outboxTimer as unknown as { unref?: () => void }).unref?.();
}

async function flushOutbox(): Promise<void> {
  let hadFailure = false;
  for (const file of Array.from(pendingOutbox.keys())) {
    try {
      const entry = JSON.parse(await readFile(file, "utf-8")) as OutboxEntry;
      const profile = entry.profile ?? ""; // legacy entries without profile use active
      const serviceUrl = getServiceUrlForProfile(profile);
      const outboxHeaders = await authHeadersForProfile(profile);
      const res = await fetch(
        `${serviceUrl}/projects/${entry.project}/sessions/${entry.session}/events`,
        { method: "POST", headers: outboxHeaders, body: JSON.stringify(entry.body), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
      );
      await adoptRenewedToken(outboxHeaders, res);
      markUpstream(res.status < 500);
      if (res.ok) {
        pendingOutbox.delete(file);
        await unlink(file).catch(() => {});
      } else if (res.status === 401) {
        // Auth failure — token may be stale; retry (getTokenForProfile will use fresh token next pass)
        hadFailure = true;
      } else if (res.status >= 400 && res.status < 500) {
        // Other permanent client error (404, 409, etc.) — drop it
        console.error(`polaris daemon: dropping outbox entry ${file} — upstream rejected it permanently (${res.status})`);
        pendingOutbox.delete(file);
        await unlink(file).catch(() => {});
      } else {
        hadFailure = true; // 5xx or network — keep for the next pass
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        pendingOutbox.delete(file); // removed externally (e.g. polaris recover)
      } else {
        hadFailure = true; // network/parse error — keep for the next pass
      }
    }
  }
  outboxDelayMs = hadFailure ? Math.min(outboxDelayMs * 2, OUTBOX_MAX_DELAY_MS) : 1000;
  scheduleOutboxFlush();
}

// Pick up outbox files left over from a previous daemon run. Only called from
// the import.meta.main block: tests that start the daemon in-process must
// never replay (or delete) a developer's real outbox against a test server.
async function scanOutbox(): Promise<void> {
  try {
    await ensureOutboxDir();
    for (const name of await readdir(OUTBOX_DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(OUTBOX_DIR, name);
      try {
        const e = JSON.parse(await readFile(file, "utf-8")) as OutboxEntry;
        pendingOutbox.set(file, { project: e.project, session: e.session, at: Date.parse(e.t) });
      } catch { /* unreadable — flushOutbox will retry or clean it up */ }
    }
    scheduleOutboxFlush();
  } catch { /* best-effort */ }
}

// --- Per-session account selection (/polaris account) ---
// The MCP server doesn't know Claude Code's session id, but Claude Code sends the
// daemon a PreToolUse hook (carrying that id and the tool input) just before it
// calls polaris_account. Pairing the two binds the selection to the exact Claude
// session, so the status line can show the account before any join.

interface PolarisToolCall { ccSessionId: string; tool: string; input: Record<string, unknown>; at: number }
const recentPolarisCalls: PolarisToolCall[] = [];
const PAIRING_WINDOW_MS = 30_000;

// key: CC hook session id (or MCP id until paired) → selected profile
const accountSelections = new Map<string, { profile: string; email: string }>();

function notePolarisToolCall(body: Record<string, unknown>): void {
  const tool = typeof body.tool_name === "string" ? body.tool_name : "";
  if (body.hook_event_name !== "PreToolUse" || !/polaris_(account|connect)$/.test(tool)) return;
  const now = Date.now();
  while (recentPolarisCalls.length && now - recentPolarisCalls[0].at > PAIRING_WINDOW_MS) recentPolarisCalls.shift();
  recentPolarisCalls.push({ ccSessionId: String(body.session_id), tool, input: (body.tool_input as Record<string, unknown>) ?? {}, at: now });
}

// Most recent unpaired polaris_account call asking for this account
function pairAccountCall(account: string): string | null {
  for (let i = recentPolarisCalls.length - 1; i >= 0; i--) {
    const c = recentPolarisCalls[i];
    if (Date.now() - c.at <= PAIRING_WINDOW_MS && /polaris_account$/.test(c.tool) && c.input.account === account) {
      recentPolarisCalls.splice(i, 1);
      return c.ccSessionId;
    }
  }
  return null;
}

// Most recent unpaired polaris_connect call for this project (and session, if the
// call named one). Binds a join to the exact Claude session that made it, instead of
// letting the next hook event from any unmapped session claim the pending join.
function pairConnectCall(project: string, session: string | undefined): string | null {
  for (let i = recentPolarisCalls.length - 1; i >= 0; i--) {
    const c = recentPolarisCalls[i];
    if (Date.now() - c.at > PAIRING_WINDOW_MS || !/polaris_connect$/.test(c.tool)) continue;
    const channel = typeof c.input.channel === "string" ? c.input.channel.replace(/^#/, "") : "";
    if (channel !== project) continue;
    if (session && typeof c.input.session === "string" && c.input.session !== session) continue;
    recentPolarisCalls.splice(i, 1);
    return c.ccSessionId;
  }
  return null;
}

// Fresh read (not the startup cache) so accounts added by `polaris login` are visible
async function resolveProfile(account: string): Promise<{ profile: string; email: string } | null> {
  try {
    const cfg = JSON.parse(await readFile(join(POLARIS_DIR, "config.json"), "utf-8")) as PolarisConfig;
    for (const [key, p] of Object.entries(cfg.profiles ?? {})) {
      if (key === account || p.email === account) return { profile: key, email: String(p.email ?? key) };
    }
  } catch { /* no config */ }
  return null;
}

// --- Scheduled reconciliation ---
// Periodically runs `polaris recover --reconcile` (watermark mode) so holes from
// outages, dropped events or old bugs are filled without anyone running recover.
// Jittered so a fleet of daemons never hits the API in lockstep.

const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconcile(baseMs: number): void {
  const delay = baseMs * (0.75 + Math.random() * 0.5);
  reconcileTimer = setTimeout(() => void runReconcile(), delay);
  (reconcileTimer as unknown as { unref?: () => void }).unref?.();
}

async function runReconcile(): Promise<void> {
  // Known outage: nothing can be checked; try again sooner than a full interval
  if (upstreamDownSince !== null) return scheduleReconcile(30 * 60_000);
  try {
    const cli = join(import.meta.dir, "..", "cli", "cli.ts");
    const proc = Bun.spawn([process.execPath, cli, "recover", "--reconcile"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const summary = `${out}${err}`.replace(/\r[^\n]*(?=\r)/g, "").trim();
    await ensureLogDir();
    await appendFile(join(LOG_DIR, "reconcile.log"), `--- ${new Date().toISOString()} exit=${code}\n${summary}\n`);
  } catch (e) {
    console.error(`polaris daemon: reconcile failed to run: ${(e as Error).message}`);
  }
  scheduleReconcile(RECONCILE_INTERVAL_MS);
}

// --- Background relay ---
// Hook events are relayed off the request path, serialized per CC session so
// upstream order matches capture order. Failures land in the outbox.

interface RelayJob {
  project: string;
  session: string;
  profile: string;
  relayBody: { sender: string; payload: Record<string, unknown>; at: string };
}

const relayChains = new Map<string, Promise<void>>();

function enqueueRelay(ccSessionId: string, job: RelayJob): void {
  const next = (relayChains.get(ccSessionId) ?? Promise.resolve()).then(() => relayEvent(ccSessionId, job));
  relayChains.set(ccSessionId, next);
  void next.finally(() => {
    if (relayChains.get(ccSessionId) === next) relayChains.delete(ccSessionId);
  });
}

// Sliding renewal: the server returns `x-polaris-token` when the token we sent is close
// to expiry. Save it in place of the token we sent (matched by value, since a session
// may be using a same-account fallback profile), only if it's the same account and
// expires later. Machines in regular use then never hit the 30-day expiry.
async function adoptRenewedToken(sentHeaders: Record<string, string>, res: Response | null): Promise<void> {
  const fresh = res?.headers.get("x-polaris-token");
  const sent = sentHeaders.Authorization?.startsWith("Bearer ") ? sentHeaders.Authorization.slice(7) : null;
  if (!fresh || !sent || fresh === sent) return;
  const oldP = jwtPayload(sent), newP = jwtPayload(fresh);
  if (!oldP || !newP || oldP.email !== newP.email || oldP.org_id !== newP.org_id) return;
  if (!(typeof newP.exp === "number" && typeof oldP.exp === "number" && newP.exp > oldP.exp)) return;
  try {
    const path = join(POLARIS_DIR, "config.json");
    const cfg = JSON.parse(await readFile(path, "utf-8")) as PolarisConfig;
    const keys = Object.keys(cfg.profiles ?? {}).filter((k) => cfg.profiles[k].token === sent);
    if (keys.length === 0) return; // token came from elsewhere (env var / legacy file)
    for (const k of keys) cfg.profiles[k].token = fresh;
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2));
    await rename(tmp, path);
    for (const [k, v] of tokenCache) if (v === sent) tokenCache.set(k, fresh);
    cachedConfig = undefined;
    console.error(`[daemon] Login renewed for ${String(newP.email ?? keys[0])} (${keys.join(", ")})`);
  } catch { /* best-effort: the old token keeps working until it expires */ }
}

async function postRelay(job: RelayJob): Promise<Response | null> {
  try {
    const headers = await authHeadersForProfile(job.profile);
    const res = await fetch(
      `${getServiceUrlForProfile(job.profile)}/projects/${job.project}/sessions/${job.session}/events`,
      { method: "POST", headers, body: JSON.stringify(job.relayBody), signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
    );
    await adoptRenewedToken(headers, res);
    return res;
  } catch {
    return null; // network failure or timeout
  }
}

async function relayEvent(ccSessionId: string, job: RelayJob): Promise<void> {
  const ctx = { project: job.project, session: job.session, ccSessionId };
  const payload = job.relayBody.payload;
  // Known outage: skip the doomed 10s attempt. The outbox flush and the
  // reachability probe clear the flag once the service answers again.
  if (upstreamDownSince !== null) {
    await enqueueOutbox(job.project, job.session, job.profile, job.relayBody);
    return;
  }
  let res = await postRelay(job);

  // Stop events carry the raw transcript turn, which upstream sometimes rejects
  // (bad Unicode); retry once without it rather than losing the response.
  if (res && res.status === 400 && "raw_turn" in payload) {
    const { raw_turn: _dropped, ...rest } = payload;
    job = { ...job, relayBody: { ...job.relayBody, payload: rest } };
    res = await postRelay(job);
  }

  markUpstream(!!res && res.status < 500);
  if (!res || res.status >= 500 || res.status === 401) {
    console.error(`polaris daemon: upstream relay failed (${res ? res.status : "network error/timeout"}) — queued to outbox`);
    await logEvent("/events", payload, { status: res?.status ?? 0, body: "queued to outbox" }, ctx);
    await enqueueOutbox(job.project, job.session, job.profile, job.relayBody);
    return;
  }
  if (!res.ok) {
    await logEvent("/events", payload, { status: res.status, body: await res.text().catch(() => "") }, ctx);
    return;
  }
  try {
    const delivered = await res.json() as { id?: string; timestamp?: string };
    if (delivered.id && delivered.timestamp) {
      await writeCheckpoint(ccSessionId, delivered.id, delivered.timestamp, job.project, job.session);
    }
  } catch { /* best-effort */ }
}

// --- Session history (persistent connect/disconnect log for backfill) ---

const SESSION_HISTORY_FILE = join(POLARIS_DIR,"session-history.jsonl");

async function logSessionChange(action: "connect" | "disconnect" | "ws-drop", ccSessionId: string, project: string, session: string, user: string, agent: string): Promise<void> {
  try {
    await ensureLogDir();
    const entry = JSON.stringify({ t: new Date().toISOString(), action, ccSessionId, project, session, user, agent });
    await appendFile(SESSION_HISTORY_FILE, entry + "\n");
  } catch { /* best-effort */ }
}

// --- Session persistence ---
//
// The daemon writes its session map to ~/.polaris/sessions/daemon-state.json
// after every mutation, and reloads it on startup. This makes daemon restarts
// (e.g. during `polaris update`) invisible to connected sessions: the new daemon
// loads the map and re-opens cloud WebSocket connections before serving requests.
//
// Persistence is only active when the daemon is run as main (import.meta.main).
// Tests that call startDaemon() in-process never enable it, so developer state
// is never overwritten by the test suite.

const SESSIONS_DIR = join(POLARIS_DIR,"sessions");
const DAEMON_STATE_FILE = join(SESSIONS_DIR, "daemon-state.json");
let persistenceEnabled = false;

interface PersistedSession {
  ccSessionId: string;
  project: string;
  session: string;
  user: string;
  agent: string;
  profile: string;
  slackChannel?: string;
}

// --- Session liveness ---
// Every daemon session belongs to one Claude Code process. It goes dormant only when
// that session is known to be over — Claude Code's SessionEnd hook, or its owning
// process is gone (pid + start time, so a reused pid can't fool it). No timers: an
// idle but open session keeps its socket and gets teammate messages live. Dormant =
// socket closed, nothing reconnects. Any hook event (SessionStart on resume) wakes
// it, and the first prompt after waking waits briefly for missed injects so none
// arrive a prompt late. A dormant session is forgotten only once its transcript is
// gone (it can no longer be resumed). Tracked per project/session pair: a Claude
// session's MCP id and hook id are two mappings sharing one pair and one socket.

const LIVENESS_INTERVAL_MS = 60_000;
const WAKE_CATCHUP_WAIT_MS = 1_500;
interface PairState {
  lastActiveAt: number;
  dormant: boolean;
  owner?: Owner | null; // null = looked up, no Claude process found (liveness unknown)
  transcript?: string;
}
const pairState = new Map<string, PairState>();
const pendingCatchUp = new Map<string, Promise<void>>();
const pairKey = (m: { project: string; session: string }) => `${m.project}/${m.session}`;

function mappingsForPair(key: string): SessionMapping[] {
  return [...sessions.values()].filter((m) => m.project && pairKey(m) === key);
}

// Swappable so tests can describe a process tree deterministically
let processTableSource: () => Map<number, Proc> | null = processTable;
export function setProcessTableSource(fn: () => Map<number, Proc> | null): void {
  processTableSource = fn;
}

// Record activity (and the owner/transcript, once); wake the pair if it was dormant.
// Returns true when this call woke it.
function touchPair(mapping: SessionMapping, info: { pid?: number; transcript?: string } = {}): boolean {
  const key = pairKey(mapping);
  const st = pairState.get(key) ?? { lastActiveAt: 0, dormant: false };
  const woke = st.dormant;
  const next: PairState = { ...st, lastActiveAt: Date.now(), dormant: false };
  if (info.transcript) next.transcript = info.transcript;
  if (info.pid && (st.owner === undefined || woke)) {
    // Hooks can run under Claude Code's shared background daemon, with no session
    // process above them; finding nothing must not erase an owner the MCP server's
    // join already established.
    const table = processTableSource();
    const found = table ? findOwner(info.pid, table) : null;
    if (found) next.owner = found;
    else if (st.owner === undefined) next.owner = null;
  }
  pairState.set(key, next);
  if (woke) {
    if (!mappingsForPair(key).some((m) => m.ws)) connectCloudWs(mapping);
    pendingCatchUp.set(key, catchUpInjects(mapping).finally(() => pendingCatchUp.delete(key)));
    console.error(`[daemon] Session ${key} active again`);
  }
  if (woke || next.owner !== st.owner || next.transcript !== st.transcript) void persistSessions();
  return woke;
}

// A prompt right after waking waits (bounded) for missed injects, so they ride along
async function awaitWakeCatchUp(mapping: SessionMapping): Promise<void> {
  const p = pendingCatchUp.get(pairKey(mapping));
  if (p) await Promise.race([p, new Promise((r) => setTimeout(r, WAKE_CATCHUP_WAIT_MS))]);
}

function makeDormant(key: string, why: string): void {
  const st = pairState.get(key) ?? { lastActiveAt: Date.now(), dormant: false };
  if (st.dormant) return;
  pairState.set(key, { ...st, dormant: true });
  for (const m of mappingsForPair(key)) {
    if (m.ws) {
      m.closingIntentionally = true;
      m.ws.close();
      m.ws = null;
    }
  }
  console.error(`[daemon] Session ${key} dormant (${why})`);
  void persistSessions();
}

function isDormant(m: SessionMapping): boolean {
  return pairState.get(pairKey(m))?.dormant ?? false;
}

export function checkLiveness(table: Map<number, Proc> | null = processTableSource()): void {
  if (!table) return;
  for (const [key, st] of [...pairState]) {
    if (!st.dormant && st.owner) {
      const p = table.get(st.owner.pid);
      if (!p || p.start !== st.owner.start) makeDormant(key, "Claude Code process exited");
    } else if (st.dormant && st.transcript && !existsSync(st.transcript)) {
      for (const m of mappingsForPair(key)) {
        sessions.delete(m.ccSessionId);
        injectQueues.delete(m.ccSessionId);
      }
      pairState.delete(key);
      console.error(`[daemon] Forgot session ${key} (transcript gone — can't be resumed)`);
      void persistSessions();
    }
  }
}

async function persistSessions(): Promise<void> {
  if (!persistenceEnabled) return;
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const active: PersistedSession[] = [];
    for (const m of sessions.values()) {
      if (!m.project) continue; // skip empty stubs from /register
      active.push({
        ccSessionId: m.ccSessionId,
        project: m.project,
        session: m.session,
        user: m.user,
        agent: m.agent,
        profile: m.profile,
        ...(m.slackChannel ? { slackChannel: m.slackChannel } : {}),
      });
    }
    const pairs = Object.fromEntries([...pairState].filter(([k]) => mappingsForPair(k).length > 0));
    await writeFile(DAEMON_STATE_FILE, JSON.stringify({ sessions: active, pairs }));
  } catch { /* best-effort */ }
}

async function loadPersistedSessions(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(DAEMON_STATE_FILE, "utf-8")) as {
      sessions: PersistedSession[];
      pairs?: Record<string, { lastActiveAt: number; dormant: boolean }>;
    };
    if (!Array.isArray(data.sessions)) return;
    for (const [k, v] of Object.entries(data.pairs ?? {})) pairState.set(k, v);

    // Populate the sessions map
    for (const s of data.sessions) {
      if (!s.ccSessionId || !s.project || !s.session) continue;
      sessions.set(s.ccSessionId, {
        ccSessionId: s.ccSessionId,
        project: s.project,
        session: s.session,
        user: s.user,
        agent: s.agent,
        profile: s.profile || "",
        slackChannel: s.slackChannel,
        ws: null,
        pendingMapping: false, // aliases are already known — no claiming needed
      });
    }

    // Sessions saved before owners were tracked have no known Claude process, so there's
    // no evidence they're still open: start them dormant. A live one wakes on its next
    // hook event (and records its owner). Sessions with a known owner are checked now.
    for (const m of sessions.values()) {
      if (!pairState.has(pairKey(m))) pairState.set(pairKey(m), { lastActiveAt: 0, dormant: true });
    }
    checkLiveness();

    // Open one cloud WebSocket per active (project, session) pair; alias entries share it
    const primaryForPair = new Map<string, SessionMapping>();
    for (const mapping of sessions.values()) {
      if (!mapping.project || isDormant(mapping)) continue;
      const key = `${mapping.project}/${mapping.session}`;
      if (!primaryForPair.has(key)) {
        primaryForPair.set(key, mapping);
        connectCloudWs(mapping);
      } else {
        mapping.ws = primaryForPair.get(key)!.ws;
      }
    }

    const count = Array.from(sessions.values()).filter((m) => m.project).length;
    if (count > 0) {
      console.error(`polaris daemon: restored ${count} mapping(s) across ${primaryForPair.size} session(s)`);
    }
  } catch { /* no state file — fresh start */ }
}

// --- Delivery checkpoint ---
//
// After each successful event relay, the daemon writes a tiny checkpoint file
// next to the session state file: ~/.polaris/sessions/{hash}-checkpoint.json
// where {hash} is the same SHA-256 prefix used by the client. On reconnect,
// the checkpoint is used to auto-backfill the gap without any manual action.

function checkpointPath(ccSessionId: string): string {
  const hash = createHash("sha256").update(ccSessionId).digest("hex").slice(0, 16);
  return join(SESSIONS_DIR, `${hash}-checkpoint.json`);
}

interface Checkpoint {
  lastEventId: string;
  lastEventTimestamp: string;
  project: string;
  session: string;
}

async function writeCheckpoint(ccSessionId: string, eventId: string, eventTimestamp: string, project: string, session: string): Promise<void> {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const cp: Checkpoint = { lastEventId: eventId, lastEventTimestamp: eventTimestamp, project, session };
    await writeFile(checkpointPath(ccSessionId), JSON.stringify(cp));
  } catch { /* best-effort */ }
}

async function readCheckpoint(ccSessionId: string): Promise<Checkpoint | null> {
  try {
    const data = JSON.parse(await readFile(checkpointPath(ccSessionId), "utf-8")) as Checkpoint;
    if (data.lastEventId && data.lastEventTimestamp) return data;
  } catch { /* none */ }
  return null;
}

// Inject delivery checkpoint: tracks the timestamp of the last advisor inject message
// that was successfully delivered to the agent (drained by UserPromptSubmit).
// Written after delivery; read on WS reconnect to fetch any missed injects from the API.
function injectCheckpointPath(ccSessionId: string): string {
  const hash = createHash("sha256").update(ccSessionId).digest("hex").slice(0, 16);
  return join(SESSIONS_DIR, `${hash}-inject.json`);
}

async function readInjectCheckpoint(ccSessionId: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(injectCheckpointPath(ccSessionId), "utf-8")) as { ts?: string };
    return data.ts ?? null;
  } catch { return null; }
}

async function writeInjectCheckpoint(ccSessionId: string, timestamp: string): Promise<void> {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeFile(injectCheckpointPath(ccSessionId), JSON.stringify({ ts: timestamp }));
  } catch { /* best-effort */ }
}

// --- Backfill: recover lost events from daemon log ---

async function backfill(mapping: SessionMapping, duration?: string, from?: string, dryRun = false): Promise<{ recovered: number; would_recover?: number; source: string; gaps: string[] }> {
  const now = new Date();
  let since: Date;

  if (from) {
    since = new Date(from);
  } else if (duration) {
    const match = duration.match(/^(\d+)(h|m|d)$/);
    if (!match) return { recovered: 0, source: "none", gaps: ["invalid duration format"] };
    const val = parseInt(match[1]);
    const unit = match[2];
    since = new Date(now.getTime() - val * (unit === "h" ? 3600000 : unit === "m" ? 60000 : 86400000));
  } else {
    // Auto-detect: query API for most recent event, backfill from there
    try {
      const serviceUrl = getServiceUrlForProfile(mapping.profile);
      const res = await fetch(
        `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/messages`,
        { headers: await authHeadersForProfile(mapping.profile) }
      );
      if (res.ok) {
        const events = (await res.json()) as Array<{ timestamp: string }>;
        if (events.length > 0) {
          since = new Date(events[events.length - 1].timestamp);
        } else {
          since = new Date(now.getTime() - 3600000); // default 1h
        }
      } else {
        since = new Date(now.getTime() - 3600000);
      }
    } catch {
      since = new Date(now.getTime() - 3600000);
    }
  }

  // Collect all CC session IDs that belong to this mapping (MCP UUID + any hook alias).
  // Both the MCP client's UUID and the CC hook session_id (if they differ) must match.
  const knownCcIds = new Set<string>();
  knownCcIds.add(mapping.ccSessionId);
  for (const [id, m] of sessions) {
    if (m.project === mapping.project && m.session === mapping.session) {
      knownCcIds.add(id);
    }
  }

  // Read daemon log files covering the time range
  const logEntries: Array<{ t: string; endpoint: string; payload: Record<string, unknown>; project?: string; session?: string; ccSessionId?: string; response?: unknown }> = [];
  const startDate = since.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  // Collect all dates in range
  const dates: string[] = [];
  const d = new Date(startDate);
  while (d.toISOString().slice(0, 10) <= endDate) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }

  for (const date of dates) {
    const logFile = join(LOG_DIR, `daemon-${date}.jsonl`);
    try {
      const content = await readFile(logFile, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.endpoint !== "/events") continue;
          if (new Date(entry.t) <= since) continue;
          if (new Date(entry.t) > now) continue;
          // Skip error-response entries — they're duplicates of the primary entry
          // and would cause the same event to be replayed twice.
          if (entry.response !== undefined) continue;
          // Filter by origin. New entries (v0.0.105+) have explicit context fields;
          // old entries can be matched via payload.session_id. Both must belong to
          // this mapping's known CC session IDs to prevent cross-session pollution.
          const entrySessionId: string | undefined = entry.ccSessionId ?? entry.payload.session_id;
          if (entrySessionId !== undefined && !knownCcIds.has(entrySessionId)) continue;
          if (entry.project !== undefined && entry.project !== mapping.project) continue;
          if (entry.session !== undefined && entry.session !== mapping.session) continue;
          logEntries.push(entry);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* log file doesn't exist for this date — not an error */ }
  }

  if (logEntries.length === 0) {
    return { recovered: 0, source: "daemon_log", gaps: [`no log entries found since ${since.toISOString()}`] };
  }

  // Dry-run: report how many events would be sent without actually sending
  if (dryRun) {
    return { recovered: 0, would_recover: logEntries.length, source: "daemon_log", gaps: [] };
  }

  // Replay events to the API
  let recovered = 0;
  const serviceUrl = getServiceUrlForProfile(mapping.profile);
  const headers = await authHeadersForProfile(mapping.profile);

  for (const entry of logEntries) {
    const hookEvent = entry.payload.hook_event_name as string | undefined;
    const sender = hookEvent === "UserPromptSubmit" ? mapping.user : mapping.agent;

    try {
      const res = await fetch(
        `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/events`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ sender, payload: entry.payload }),
        }
      );
      if (res.ok) recovered++;
    } catch { /* skip failed replays */ }
  }

  return { recovered, source: "daemon_log", gaps: [] };
}

// Auto-backfill from checkpoint after a reconnect. Called non-blocking (void)
// so the /connect response is returned immediately while replay runs in background.
async function autoBackfillAfterConnect(mapping: SessionMapping): Promise<void> {
  const cp = await readCheckpoint(mapping.ccSessionId);
  if (!cp) return;
  if (cp.project !== mapping.project || cp.session !== mapping.session) return;
  const result = await backfill(mapping, undefined, cp.lastEventTimestamp);
  if (result.recovered > 0) {
    console.error(`polaris daemon: gap detected — auto-backfilled ${result.recovered} events since ${cp.lastEventTimestamp}`);
  }
}

// --- HTTP Server ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

export function startDaemon(port = Number(process.env.POLARIS_DAEMON_PORT ?? 4322)): {
  server: Server;
  sessions: Map<string, SessionMapping>;
  stop: () => void;
} {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",

    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      // Shared-secret auth: enforced on ALL endpoints when a secret is
      // configured; no-op when none is resolved (tests / back-compat).
      const daemonSecret = getDaemonSecret();
      if (daemonSecret && req.headers.get("x-polaris-daemon-secret") !== daemonSecret) {
        return error("Unauthorized", 401);
      }

      // POST /register — MCP server registers its CC session
      if (method === "POST" && pathname === "/register") {
        try {
          const body = (await req.json()) as { ccSessionId: string };
          if (!body.ccSessionId) return error("ccSessionId required", 400);
          // Register without a session mapping yet — that comes from /connect
          if (!sessions.has(body.ccSessionId)) {
            sessions.set(body.ccSessionId, {
              ccSessionId: body.ccSessionId,
              project: "",
              session: "",
              user: "",
              agent: "",
              ws: null,
            });
          }
          return json({ status: "registered", ccSessionId: body.ccSessionId });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /connect — bind a CC session to a polaris project/session
      if (method === "POST" && pathname === "/connect") {
        try {
          const body = (await req.json()) as {
            ccSessionId: string;
            claudeSessionId?: boolean; // ccSessionId is Claude Code's own session id
            pid?: number;
            project: string;
            session?: string;
            user: string;
            agent?: string;
            profile?: string;
            create?: boolean;
          };
          await logEvent("/connect", body);
          if (!body.ccSessionId || !body.project || !body.user) {
            return error("ccSessionId, project, and user are required", 400);
          }

          // Resolve profile: explicit > active > ""
          const profile = body.profile || cachedConfig?.active || "";
          const serviceUrl = getServiceUrlForProfile(profile);
          const headers = await authHeadersForProfile(profile);

          // Generate session name if not provided
          const sessionName = body.session || generateSessionName();
          const agentId = body.agent || "agent:claude";

          // Check whether the project exists. If not, refuse unless create: true.
          const signal = () => AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
          let checkRes: Response;
          try {
            checkRes = await fetch(`${serviceUrl}/projects/${body.project}`, { headers, signal: signal() });
            await adoptRenewedToken(headers, checkRes);
          } catch (e) {
            markUpstream(false);
            return error(`Polaris server unreachable (${serviceUrl}): ${(e as Error).message}`, 502);
          }
          markUpstream(checkRes.status < 500);
          if (!checkRes.ok) {
            if (checkRes.status === 404) {
              // Return existing project list so the caller can show a helpful error
              const listRes = await fetch(`${serviceUrl}/projects`, { headers, signal: signal() });
              const projects: string[] = listRes.ok
                ? ((await listRes.json() as { name: string }[]).map((p) => p.name))
                : [];
              if (!body.create) {
                const account = emailFromToken(await getTokenForProfile(profile));
                return json({ error: "project_not_found", project: body.project, existing: projects, account }, 404);
              }
              // create: true — create the project now
              const createRes = await fetch(`${serviceUrl}/projects`, {
                method: "POST",
                headers,
                body: JSON.stringify({ name: body.project }),
                signal: signal(),
              });
              if (!createRes.ok && createRes.status !== 409) {
                return error(`Failed to create project: ${await createRes.text()}`, 500);
              }
            } else {
              return error(`Failed to verify project: ${await checkRes.text()}`, 500);
            }
          }

          // Disconnect existing cloud WS if switching sessions
          disconnectCloudWs(body.ccSessionId);

          const nowMs = Date.now();

          // Reject if another active session from the SAME USER already owns this
          // (project, session) pair. Without this guard two CC instances with the same
          // saved state (same user, same project/session) form a livelock: each /connect
          // evicts the other, which immediately reconnects, ad infinitum.
          //
          // We scope the check to same-user because a different user connecting to the
          // same session is a legitimate handoff (driver transfer), not a livelock.
          // We also skip create:true requests — those are explicit first-time setups.
          if (!body.create) {
            const CONFLICT_GRACE_MS = 30_000;
            for (const [id, m] of sessions) {
              if (
                id !== body.ccSessionId &&
                m.project === body.project &&
                m.session === sessionName &&
                m.user === body.user &&
                nowMs - (m.connectedAt ?? 0) < CONFLICT_GRACE_MS
              ) {
                const ageSec = Math.round((nowMs - (m.connectedAt ?? 0)) / 1000);
                console.error(
                  `[daemon] Rejected /connect for ${body.project}/${sessionName}: ` +
                  `session ${id.slice(0, 8)} connected ${ageSec}s ago (grace ${CONFLICT_GRACE_MS / 1000}s)`
                );
                return json(
                  { error: "session_conflict", conflicting: id.slice(0, 8), project: body.project, session: sessionName },
                  409
                );
              }
            }
          }

          const mapping: SessionMapping = {
            ccSessionId: body.ccSessionId,
            project: body.project,
            session: sessionName,
            user: body.user,
            agent: agentId,
            profile,
            ws: null,
            // Only an MCP server with a made-up id needs its first hook event to claim it;
            // with Claude's real session id the mapping is already exact.
            pendingMapping: !body.claudeSessionId,
            connectedAt: nowMs,
          };
          sessions.set(body.ccSessionId, mapping);

          // Evict stale alias entries that share this (project, session) pair.
          // After a reconnect the old CC session ID still has an entry with the
          // same pair; leaving it allows hook events from the old shell to
          // alias-claim a future pending session or send duplicate events.
          // We only reach here when the existing entry is old (outside CONFLICT_GRACE_MS).
          for (const [id, m] of sessions) {
            if (id !== body.ccSessionId && m.project === mapping.project && m.session === mapping.session) {
              sessions.delete(id);
              console.error(`[daemon] Evicted stale alias ${id.slice(0, 8)} for ${mapping.project}/${mapping.session}`);
            }
          }

          // Ensure the session exists (create if not, claim driver)
          // Retry with new name on 409 (collision with generated name)
          let attempts = 0;
          let created = false;
          let isReconnect = false; // true only when the session already existed (409 + explicit name)
          while (!created && attempts < 3) {
            const sessionRes = await fetch(`${serviceUrl}/projects/${body.project}/sessions`, {
              method: "POST",
              headers,
              body: JSON.stringify({ name: mapping.session, driver: body.user }),
              signal: signal(),
            });
            if (sessionRes.ok) {
              created = true;
            } else if (sessionRes.status === 409) {
              if (body.session) {
                // Explicit session name — claim driver instead of retrying
                await fetch(`${serviceUrl}/projects/${body.project}/sessions/${mapping.session}/driver`, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ driver: body.user }),
                  signal: signal(),
                });
                created = true;
                isReconnect = true; // session pre-existed → this is a true reconnect
              } else {
                // Generated name collision — retry with new name
                mapping.session = generateSessionName();
                attempts++;
              }
            } else {
              const err = await sessionRes.text();
              await logEvent("/connect", body, { status: sessionRes.status, body: err });
              return error(`Failed to create session: ${err}`, 500);
            }
          }
          if (!created) {
            return error("Failed to generate unique session name", 500);
          }

          // Fetch Slack channel name for status display
          try {
            const projRes = await fetch(`${serviceUrl}/projects/${body.project}`, { headers, signal: signal() });
            if (projRes.ok) {
              const projData = await projRes.json() as { slack_channel_name?: string };
              mapping.slackChannel = projData.slack_channel_name ?? undefined;
            }
          } catch {}

          // Bind to the exact Claude session that called polaris_connect (its PreToolUse
          // hook carried the real session id). Without a pair (e.g. CLI connect) the
          // pendingMapping fallback in /events applies, as before.
          const hookId = pairConnectCall(body.project, body.session);
          if (hookId && hookId !== body.ccSessionId) {
            mapping.pendingMapping = false;
            sessions.set(hookId, { ...mapping, ccSessionId: hookId });
            const queue = injectQueues.get(mapping.ccSessionId) ?? [];
            injectQueues.set(mapping.ccSessionId, queue);
            injectQueues.set(hookId, queue);
            console.error(`[daemon] Paired CC session ${hookId.slice(0, 8)} → ${mapping.project}/${mapping.session}`);
          }

          // Connect to cloud WebSocket
          {
            // The MCP server sends its pid: its owning Claude process is this session's owner
            const table = body.pid ? processTableSource() : null;
            pairState.set(pairKey(mapping), {
              lastActiveAt: Date.now(), dormant: false,
              owner: table && body.pid ? findOwner(body.pid, table) : undefined,
            });
          }
          connectCloudWs(mapping);
          await logSessionChange("connect", mapping.ccSessionId, mapping.project, mapping.session, mapping.user, mapping.agent);

          // Check for a delivery gap since the last checkpoint (local-only dry run — no network).
          // Only meaningful on a true reconnect (existing session); a brand-new session has no
          // history to recover. Clear any stale checkpoint when starting a fresh session.
          let gap: { events: number; since: string } | null = null;
          if (isReconnect) {
            const cp = await readCheckpoint(mapping.ccSessionId);
            if (cp && cp.project === mapping.project && cp.session === mapping.session) {
              const dryResult = await backfill(mapping, undefined, cp.lastEventTimestamp, true);
              const count = dryResult.would_recover ?? 0;
              if (count > 0) {
                gap = { events: count, since: cp.lastEventTimestamp };
                void autoBackfillAfterConnect(mapping);
              }
            }
          } else {
            // Fresh session — clear any checkpoint left over from a previous session
            // on this CC session ID so stale data never triggers a false backfill.
            void unlink(checkpointPath(mapping.ccSessionId)).catch(() => {});
          }

          void persistSessions();
          return json({
            status: "connected",
            project: mapping.project,
            session: mapping.session,
            user: mapping.user,
            agent: mapping.agent,
            gap,
          });
        } catch (e) {
          if (e instanceof SyntaxError) return error("Invalid JSON", 400);
          markUpstream(false);
          return error(`Polaris server unreachable: ${(e as Error).message}`, 502);
        }
      }

      // POST /disconnect — unbind a CC session
      if (method === "POST" && pathname === "/disconnect") {
        try {
          const body = (await req.json()) as { ccSessionId: string };
          if (!body.ccSessionId) return error("ccSessionId required", 400);
          disconnectCloudWs(body.ccSessionId);
          injectQueues.delete(body.ccSessionId);
          const mapping = sessions.get(body.ccSessionId);
          if (mapping && mapping.project) {
            await logSessionChange("disconnect", body.ccSessionId, mapping.project, mapping.session, mapping.user, mapping.agent);
            mapping.project = "";
            mapping.session = "";
            mapping.user = "";
          }
          // Clear checkpoint — a deliberate disconnect means there is nothing to recover
          void unlink(checkpointPath(body.ccSessionId)).catch(() => {});
          void persistSessions();
          return json({ status: "disconnected" });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /disconnect-all — disconnect all sessions (for testing)
      if (method === "POST" && pathname === "/disconnect-all") {
        for (const [id, mapping] of sessions) {
          disconnectCloudWs(id);
          mapping.project = "";
          mapping.session = "";
          mapping.user = "";
          void unlink(checkpointPath(id)).catch(() => {});
        }
        sessions.clear();
        injectQueues.clear();
        void persistSessions();
        return json({ status: "all_disconnected" });
      }

      // POST /events — hook events arrive here, routed by session_id in the payload
      if (method === "POST" && pathname === "/events") {
        try {
          const body = (await req.json()) as { session_id?: string; [key: string]: unknown };
          const ccSessionId = body.session_id;
          if (!ccSessionId) return error("session_id required in hook payload", 400);
          // Before routing: works for sessions that haven't joined anything yet
          notePolarisToolCall(body);

          // Session routing (deterministic, in priority order):
          // 1. Exact match: session_id is a known mapping (registered via
          //    MCP, connected via /connect, or a previously learned alias) —
          //    always routed by that match, regardless of how many other
          //    sessions are connected. A matchable event is never dropped.
          // 2. No exact match + a pending session exists: the MCP client's
          //    generated UUID differs from CC's hook session_id. The first
          //    hook event from the shell that ran /connect claims the pending
          //    slot and becomes the canonical alias going forward.
          // 3. No match + no pending session: unknown hook — the shell never
          //    ran polaris_connect. Always returns not_connected; hooks from
          //    unjoined shells are never auto-routed to an existing session.
          let mapping = sessions.get(ccSessionId);
          if (mapping && !mapping.project) {
            // Known CC session ID but deliberately disconnected (project cleared
            // by /disconnect). Hooks still fire after disconnect — do NOT
            // alias-claim a pending session; the shell intentionally left.
            return json({ status: "not_connected" });
          }
          if (mapping?.pendingMapping) {
            // The hook's id IS the joined id (the MCP server got Claude's real session
            // id), so there's no alias to learn. Left pending, any other session's
            // first event could claim this join.
            mapping.pendingMapping = false;
            void persistSessions();
          }
          if (!mapping && (body.hook_event_name === "SessionStart" || body.hook_event_name === "SessionEnd")) {
            // Lifecycle events come from sessions starting or stopping — never from the
            // window that just ran /polaris join — so they never claim a pending join.
            return json({ status: "not_connected" });
          }
          if (!mapping) {
            // Truly unknown CC session_id — the MCP client's UUID differs from
            // CC's hook session_id. Match to a session with pendingMapping
            // (most recent first) to learn the alias.
            const pending = Array.from(sessions.values()).filter((m) => m.project && m.pendingMapping);
            if (pending.length > 0) {
              // Map the CC session ID to the most recently connected pending session
              mapping = pending[pending.length - 1];
              mapping.pendingMapping = false;
              // Register under the real CC session ID for future events
              sessions.set(ccSessionId, { ...mapping, ccSessionId });
              void persistSessions();
              console.error(`[daemon] Mapped CC session ${ccSessionId.slice(0, 8)} → ${mapping.project}/${mapping.session}`);
              // Share the inject queue between the original ccSessionId (where the
              // cloud WS enqueues) and this CC hook session_id alias, so injected
              // messages are drained regardless of which key later events use.
              const queue = injectQueues.get(mapping.ccSessionId) ?? [];
              injectQueues.set(mapping.ccSessionId, queue);
              injectQueues.set(ccSessionId, queue);
            } else {
              // No pending sessions — this hook's session_id doesn't match any
              // known mapping. Unjoined shells are never auto-routed; the user
              // must run polaris_connect explicitly in this Claude session.
              return json({ status: "not_connected" });
            }
          }

          // Claude Code says the session closed: stop holding its socket. Local only —
          // not part of the event stream (and the server schema doesn't take it).
          if (body.hook_event_name === "SessionEnd") {
            makeDormant(pairKey(mapping), `Claude session ended${body.reason ? `: ${body.reason}` : ""}`);
            return json({ status: "ended" });
          }
          // Hooks send their own pid; the daemon walks up to the owning Claude process once
          const hookPid = Number(req.headers.get("x-polaris-hook-pid")) || undefined;
          touchPair(mapping, { pid: hookPid, transcript: typeof body.transcript_path === "string" ? body.transcript_path : undefined });
          // Lifecycle signal only (startup / resume): waking is all it's for
          if (body.hook_event_name === "SessionStart") return json({ status: "active" });

          // Log with session context so backfill can filter by exact origin
          await logEvent("/events", body, undefined, { project: mapping.project, session: mapping.session, ccSessionId });

          // Determine sender: human for prompts, agent for everything else
          const hookEvent = body.hook_event_name as string | undefined;
          const sender = hookEvent === "UserPromptSubmit" ? mapping.user : mapping.agent;

          // Relay in the background: the hook sits on Claude Code's critical path,
          // so it must never wait on the network. `at` preserves capture time.
          enqueueRelay(ccSessionId, {
            project: mapping.project,
            session: mapping.session,
            profile: mapping.profile,
            relayBody: { sender, payload: body, at: new Date().toISOString() },
          });

          // UserPromptSubmit: drain queued advisor injects and hand them back
          // to the hook, which surfaces them via additionalContext
          if (hookEvent === "UserPromptSubmit") {
            // Just woken (resume): let missed injects arrive so they ride with this prompt
            await awaitWakeCatchUp(mapping);
            const queue = injectQueues.get(mapping.ccSessionId);
            const pendingInjects = queue ? queue.splice(0, queue.length) : [];
            // Advance inject checkpoint so WS reconnects don't re-deliver these
            const maxInjectTs = pendingInjects.reduce((m, i) => i.timestamp > m ? i.timestamp : m, "");
            if (maxInjectTs) void writeInjectCheckpoint(mapping.ccSessionId, maxInjectTs);
            return json({ ok: true, pendingInjects });
          }
          return json({ status: "accepted" });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /rename — rename a project (proxies to cloud API, updates local state)
      if (method === "POST" && pathname === "/rename") {
        try {
          const body = (await req.json()) as { oldName: string; newName: string };
          if (!body.oldName || !body.newName) return error("oldName and newName required", 400);

          // Find the profile for the session connected to this project
          const renamingSession = Array.from(sessions.values()).find((m) => m.project === body.oldName);
          const renameProfile = renamingSession?.profile ?? cachedConfig?.active ?? "";
          const serviceUrl = getServiceUrlForProfile(renameProfile);
          const res = await fetch(`${serviceUrl}/projects/${body.oldName}/rename`, {
            method: "POST",
            headers: await authHeadersForProfile(renameProfile),
            body: JSON.stringify({ name: body.newName }),
          });
          if (!res.ok) {
            const err = await res.text();
            return new Response(err, { status: res.status });
          }

          // Update in-memory sessions
          for (const m of sessions.values()) {
            if (m.project === body.oldName) {
              m.project = body.newName;
              m.slackChannel = body.newName;
            }
          }
          void persistSessions();
          return json({ status: "renamed", oldName: body.oldName, newName: body.newName });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /rename-session — rename the current session (not the project)
      if (method === "POST" && pathname === "/rename-session") {
        try {
          const body = (await req.json()) as { ccSessionId: string; newName: string };
          if (!body.ccSessionId || !body.newName) return error("ccSessionId and newName required", 400);
          const mapping = sessions.get(body.ccSessionId);
          if (!mapping || !mapping.project) return error("Not connected", 400);

          const serviceUrl = getServiceUrlForProfile(mapping.profile);
          const res = await fetch(
            `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/rename`,
            {
              method: "POST",
              headers: await authHeadersForProfile(mapping.profile),
              body: JSON.stringify({ name: body.newName }),
            }
          );
          if (!res.ok) {
            const err = await res.text();
            return new Response(err, { status: res.status });
          }

          const oldName = mapping.session;
          mapping.session = body.newName;
          void persistSessions();
          return json({ status: "renamed", oldName, newName: body.newName });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /channel-update — bridge pushes channel rename notifications
      if (method === "POST" && pathname === "/channel-update") {
        try {
          const body = (await req.json()) as { project: string; slackChannel: string };
          if (!body.project || !body.slackChannel) return error("project and slackChannel required", 400);
          // Update all sessions for this project
          for (const m of sessions.values()) {
            if (m.project === body.project) {
              m.slackChannel = body.slackChannel;
            }
          }
          void persistSessions();
          return json({ status: "updated" });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /account — select the account a session will use (before or without join)
      if (method === "POST" && pathname === "/account") {
        let body: { ccSessionId?: string; account?: string };
        try { body = await req.json(); } catch { return error("Invalid JSON", 400); }
        if (!body.ccSessionId || !body.account) return error("ccSessionId and account required", 400);
        const resolved = await resolveProfile(body.account);
        if (!resolved) return error(`No account "${body.account}" — run \`polaris login\` to add it`, 404);
        const existing = sessions.get(body.ccSessionId);
        if (existing?.project && existing.profile !== resolved.profile) {
          return error(`Connected to #${existing.project}/${existing.session} on another account — disconnect first`, 409);
        }
        accountSelections.set(body.ccSessionId, resolved);
        const hookId = pairAccountCall(body.account);
        if (hookId) accountSelections.set(hookId, resolved);
        return json({ ...resolved, paired: hookId !== null });
      }

      // GET /status/:ccSessionId — status line queries this
      if (method === "GET" && pathname.startsWith("/status/")) {
        const ccSessionId = pathname.slice("/status/".length);
        const mapping = sessions.get(ccSessionId);
        if (!mapping || !mapping.project) {
          // Which account a join would use: this session's /polaris account choice, else
          // the default (read fresh, so `polaris use` / `polaris login` show immediately)
          const selected = accountSelections.get(ccSessionId);
          let account = selected?.email ?? null;
          let accountSource: "selected" | "default" | null = selected ? "selected" : null;
          if (!selected) {
            try {
              const cfg = JSON.parse(await readFile(join(POLARIS_DIR, "config.json"), "utf-8")) as PolarisConfig;
              const active = cfg.active ? cfg.profiles?.[cfg.active] : undefined;
              if (active) {
                account = String(active.email ?? cfg.active);
                accountSource = "default";
              }
            } catch { /* no config: no account */ }
          }
          const login = await accountLogin(selected?.profile);
          return json({
            connected: false, account, accountSource,
            accountProfile: login.accountProfile, accountServer: login.accountServer, accountExpiresAt: login.accountExpiresAt,
            serverDownFor: upstreamDownForSec(),
          });
        }
        // Resolve slackChannel from any session in the same project
        let slackChannel = mapping.slackChannel ?? null;
        if (!slackChannel) {
          for (const m of sessions.values()) {
            if (m.project === mapping.project && m.slackChannel) {
              slackChannel = m.slackChannel;
              break;
            }
          }
        }
        // Include seconds since last delivered event so the status line can show
        // a liveness indicator (e.g. "· 2m ago") without a second request.
        let lastEventAge: number | null = null;
        const cp = await readCheckpoint(ccSessionId);
        if (cp && cp.project === mapping.project && cp.session === mapping.session) {
          lastEventAge = Math.floor((Date.now() - new Date(cp.lastEventTimestamp).getTime()) / 1000);
        }
        return json({
          connected: true,
          project: mapping.project,
          session: mapping.session,
          user: mapping.user,
          slackChannel,
          account: emailFromToken(await getTokenForProfile(mapping.profile)),
          ...(({ email: _e, ...l }) => l)(await accountLogin(mapping.profile)),
          lastEventAge,
          drift: outboxDrift(mapping.project, mapping.session),
          serverDownFor: upstreamDownForSec(),
        });
      }

      // GET /status — daemon health + all active sessions
      if (method === "GET" && pathname === "/status") {
        const WS_STATES = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const;
        const active = Array.from(sessions.values())
          .filter((m) => m.project)
          .map((m) => ({
            ccSessionId: m.ccSessionId,
            project: m.project,
            session: m.session,
            user: m.user,
            profile: m.profile,
            wsState: m.ws != null ? (WS_STATES[m.ws.readyState] ?? "UNKNOWN") : "NONE",
            dormant: isDormant(m),
            lastActiveAt: pairState.get(pairKey(m))?.lastActiveAt ?? null,
          }));
        return json({ ok: true, version: "0.0.1", sessions: active });
      }

      // POST /reply — proxy a reply event to the cloud API
      if (method === "POST" && pathname === "/reply") {
        try {
          const body = (await req.json()) as { ccSessionId: string; message: string };
          await logEvent("/reply", body);
          if (!body.ccSessionId || !body.message) return error("ccSessionId and message required", 400);
          const mapping = sessions.get(body.ccSessionId);
          if (!mapping || !mapping.project) return error("Not connected", 400);

          const serviceUrl = getServiceUrlForProfile(mapping.profile);
          const relayBody = {
            // Replies come from the agent, not the human driver
            sender: mapping.agent,
            payload: {
              hook_event_name: "Stop",
              session_id: body.ccSessionId,
              stop_response: body.message,
            },
          };
          let res: Response | null = null;
          try {
            res = await fetch(
              `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/events`,
              {
                method: "POST",
                headers: await authHeadersForProfile(mapping.profile),
                body: JSON.stringify(relayBody),
              }
            );
          } catch {
            res = null; // network failure
          }
          if (!res || res.status >= 500) {
            console.error(`polaris daemon: upstream reply relay failed (${res ? res.status : "network error"}) — queued to outbox`);
            await logEvent("/reply", body, { status: res?.status ?? 0, body: "queued to outbox" });
            await enqueueOutbox(mapping.project, mapping.session, mapping.profile, relayBody);
            return json({ status: "queued" });
          }
          if (!res.ok) {
            const err = await res.text();
            await logEvent("/reply", body, { status: res.status, body: err });
            return new Response(err, { status: res.status });
          }
          return json({ status: "sent" });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /send — deliver a message to a sibling session and log it on both timelines
      if (method === "POST" && pathname === "/send") {
        try {
          const body = (await req.json()) as { ccSessionId: string; targetSession: string; message: string };
          if (!body.ccSessionId || !body.targetSession || !body.message) {
            return error("ccSessionId, targetSession, and message required", 400);
          }
          const sender = sessions.get(body.ccSessionId);
          if (!sender || !sender.project) return error("Not connected", 400);

          // Find the target session by name within the same project
          const target = Array.from(sessions.values()).find(
            (m) => m.project === sender.project && m.session === body.targetSession && m.ccSessionId !== body.ccSessionId
          );
          if (!target) {
            return error(`Session '${body.targetSession}' is not connected in project '${sender.project}'`, 404);
          }

          const serviceUrl = getServiceUrlForProfile(sender.profile);
          const headers = await authHeadersForProfile(sender.profile);
          const timestamp = new Date().toISOString();

          // 1. Log outbound event on sender's timeline
          await fetch(`${serviceUrl}/projects/${sender.project}/sessions/${sender.session}/events`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              sender: sender.agent,
              payload: {
                hook_event_name: "SendMessage",
                session_id: body.ccSessionId,
                to: body.targetSession,
                message: body.message,
              },
            }),
          });

          // 2. Log inbound event on target's timeline (attributed to the sender's session name)
          await fetch(`${serviceUrl}/projects/${target.project}/sessions/${target.session}/events`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              sender: sender.agent,
              payload: {
                hook_event_name: "ReceiveMessage",
                session_id: target.ccSessionId,
                from: sender.session,
                message: body.message,
              },
            }),
          });

          // 3. Inject into target's local queue for delivery on next UserPromptSubmit
          let queue = injectQueues.get(target.ccSessionId);
          if (!queue) {
            queue = [];
            injectQueues.set(target.ccSessionId, queue);
          }
          // Also register under any alias ccSessionId the target may be using
          for (const [id, m] of sessions) {
            if (m.project === target.project && m.session === target.session && !injectQueues.has(id)) {
              injectQueues.set(id, queue);
            }
          }
          queue.push({ from: `${sender.project}/${sender.session}`, content: body.message, timestamp, type: "direct" });

          // Also queue for immediate claude/channel push so the MCP client can
          // surface the message visually without waiting for a UserPromptSubmit.
          const cpKey = `${target.project}/${target.session}`;
          const push = { from: `${sender.project}/${sender.session}`, content: body.message, timestamp };

          // Wake a standby waiter immediately if one is registered (polaris_standby).
          const waiter = standbyWaiters.get(cpKey);
          if (waiter) {
            standbyWaiters.delete(cpKey);
            waiter([push]);
          } else {
            let cpQueue = channelPushQueues.get(cpKey);
            if (!cpQueue) { cpQueue = []; channelPushQueues.set(cpKey, cpQueue); }
            cpQueue.push(push);
          }

          await logEvent("/send", body, undefined, { project: sender.project, session: sender.session, ccSessionId: body.ccSessionId });
          return json({ status: "delivered", from: sender.session, to: body.targetSession });
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // GET /channel-push/:project/:session — drain pending claude/channel pushes
      // Called by the MCP client on a short poll; returns and clears the queue.
      if (method === "GET" && pathname.match(/^\/channel-push\/[^/]+\/[^/]+$/)) {
        const parts = pathname.split("/");
        const project = decodeURIComponent(parts[2]);
        const session = decodeURIComponent(parts[3]);
        const key = `${project}/${session}`;
        const pushes = channelPushQueues.get(key) ?? [];
        channelPushQueues.delete(key);
        return json({ pushes });
      }

      // GET /standby/:ccSessionId?timeout=N — long-poll for incoming messages.
      // Blocks until polaris_send delivers a message to this session or timeout.
      // The receiving agent calls this via polaris_standby to remain responsive
      // while idle, without requiring a human to prompt it.
      if (method === "GET" && pathname.match(/^\/standby\/[^/]+$/)) {
        const ccSessionId = decodeURIComponent(pathname.split("/")[2]);
        const mapping = sessions.get(ccSessionId);
        if (!mapping || !mapping.project) return error("Not connected", 400);

        const timeoutSec = parseInt(new URL(req.url).searchParams.get("timeout") ?? "60");
        const timeoutMs = Math.max(timeoutSec, 1) * 1000;
        server.timeout(req, 0); // disable Bun's idle timeout for this long-poll
        const key = `${mapping.project}/${mapping.session}`;

        // Return any already-queued pushes immediately
        const existing = channelPushQueues.get(key) ?? [];
        if (existing.length > 0) {
          channelPushQueues.delete(key);
          return json({ status: "message", pushes: existing });
        }

        // Wait for a push or timeout
        return new Promise<Response>((resolve) => {
          const timer = setTimeout(() => {
            standbyWaiters.delete(key);
            resolve(json({ status: "timeout", pushes: [] }));
          }, timeoutMs);

          standbyWaiters.set(key, (pushes) => {
            clearTimeout(timer);
            resolve(json({ status: "message", pushes }));
          });
        });
      }

      // GET /context/:ccSessionId/:session — proxy context fetch from cloud API
      if (method === "GET" && pathname.match(/^\/context\/[^/]+\/[^/]+$/)) {
        const parts = pathname.split("/");
        const ccSessionId = parts[2];
        const targetSession = parts[3];
        const mapping = sessions.get(ccSessionId);
        if (!mapping || !mapping.project) return error("Not connected", 400);

        const serviceUrl = getServiceUrlForProfile(mapping.profile);
        const res = await fetch(
          `${serviceUrl}/projects/${mapping.project}/sessions/${targetSession}/messages`,
          { headers: await authHeadersForProfile(mapping.profile) }
        );
        if (!res.ok) {
          const err = await res.text();
          return new Response(err, { status: res.status });
        }
        const data = await res.json();
        return json(data);
      }

      // GET /channels — list available channels/projects
      // GET /channels[?account=<email|profile>] — projects visible to that account
      // (default: the active one, read fresh so `polaris use`/`login` apply immediately)
      if (method === "GET" && pathname === "/channels") {
        try {
          const account = new URL(req.url).searchParams.get("account");
          cachedConfig = undefined;
          const cfg = await loadConfig();
          let profile = cfg?.active ?? "";
          if (account) {
            const resolved = await resolveProfile(account);
            if (!resolved) return error(`No account "${account}" — run \`polaris login\` to add it`, 404);
            profile = resolved.profile;
          }
          const res = await fetch(`${getServiceUrlForProfile(profile)}/projects`, {
            headers: await authHeadersForProfile(profile),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          });
          if (!res.ok) return error("Failed to fetch channels", res.status);
          const projects = (await res.json()) as Array<{ name: string; slack_channel_name?: string }>;
          const channels = projects
            .filter((p) => p.name !== "_system")
            .map((p) => `#${p.slack_channel_name || p.name}`);
          const email = String(cfg?.profiles[profile]?.email ?? profile);
          return json({ channels, account: email });
        } catch {
          return error("API unreachable", 503);
        }
      }

      // GET /team — list team members with Slack identities
      if (method === "GET" && pathname === "/team") {
        try {
          const serviceUrl = getServiceUrl();
          const res = await fetch(`${serviceUrl}/team`, {
            headers: await authHeaders(),
          });
          if (!res.ok) return error("Failed to fetch team", res.status);
          const data = await res.json();
          return json(data);
        } catch {
          return error("API unreachable", 503);
        }
      }

      // GET /checkpoint/:ccSessionId — checkpoint state + pending count for polaris_status
      if (method === "GET" && pathname.startsWith("/checkpoint/")) {
        const ccSessionId = pathname.slice("/checkpoint/".length);
        const cp = await readCheckpoint(ccSessionId);
        if (!cp) return json({ hasCheckpoint: false });
        const mapping = sessions.get(ccSessionId);
        let pending = 0;
        if (mapping?.project && cp.project === mapping.project && cp.session === mapping.session) {
          const dryResult = await backfill(mapping, undefined, cp.lastEventTimestamp, true);
          pending = dryResult.would_recover ?? 0;
        }
        return json({ hasCheckpoint: true, lastEventTimestamp: cp.lastEventTimestamp, pending });
      }

      // POST /backfill — recover lost events from daemon log
      if (method === "POST" && pathname === "/backfill") {
        try {
          const body = (await req.json()) as { ccSessionId: string; duration?: string; from?: string; dry_run?: boolean };
          if (!body.ccSessionId) return error("ccSessionId required", 400);
          const mapping = sessions.get(body.ccSessionId);
          if (!mapping || !mapping.project) return error("Not connected", 400);

          const result = await backfill(mapping, body.duration, body.from, body.dry_run ?? false);
          return json(result);
        } catch {
          return error("Invalid JSON", 400);
        }
      }

      // POST /shutdown — graceful shutdown (used by `polaris install` to replace an old daemon)
      if (method === "POST" && pathname === "/shutdown") {
        // Respond first, then exit after a short delay so the response is delivered
        setTimeout(() => process.exit(0), 100);
        return json({ status: "shutting_down" });
      }

      return error("Not found", 404);
    },
  });

  void probeUpstream();
  const probeTimer = setInterval(() => void probeUpstream(), PROBE_INTERVAL_MS);
  const livenessTimer = setInterval(() => checkLiveness(), LIVENESS_INTERVAL_MS);
  (livenessTimer as unknown as { unref?: () => void }).unref?.();

  return {
    server,
    sessions,
    stop: () => {
      clearInterval(probeTimer);
      clearInterval(livenessTimer);
      if (outboxTimer) {
        clearTimeout(outboxTimer);
        outboxTimer = null;
      }
      // Disconnect all cloud WS connections intentionally so the onclose handler
      // does not schedule a 3-second reconnect (which would fire after the server
      // has stopped, causing errors in tests and wasted work in production).
      for (const [id] of sessions) {
        disconnectCloudWs(id);
      }
      server.stop(true);
    },
  };
}

// --- Run if executed directly ---
if (import.meta.main) {
  // Load config before starting so getServiceUrl() has the active profile
  // (and getDaemonSecret() the configured daemonSecret)
  await loadConfig();
  // Enable session persistence (only when running as main, never in tests)
  persistenceEnabled = true;
  // Restore sessions from disk before opening the port — new daemon is ready
  // to serve hook events immediately, before clients notice the restart
  await loadPersistedSessions();
  // Replay any events left in the outbox by a previous daemon run
  await scanOutbox();
  // First reconciliation pass 5–15 min after start (lets the outbox drain first)
  scheduleReconcile(10 * 60_000);
  const { server } = startDaemon();
  console.error(`Polaris daemon listening on http://127.0.0.1:${server.port}`);
  console.error(`  API endpoint: ${getServiceUrl()}`);
  if (getDaemonSecret()) {
    console.error("  Auth: x-polaris-daemon-secret required on all endpoints");
  }
}
