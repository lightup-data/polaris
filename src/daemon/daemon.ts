import type { Server, ServerWebSocket } from "bun";
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

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
    const configPath = join(homedir(), ".polaris", "config.json");
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

// Per-profile token cache. Key "" is used for env-var / test mode.
const tokenCache = new Map<string, string | null>();

async function getTokenForProfile(profile: string): Promise<string | null> {
  // Env var always wins (test mode) — ignore profile entirely
  if (process.env.POLARIS_AUTH_TOKEN !== undefined) {
    return process.env.POLARIS_AUTH_TOKEN || null;
  }
  if (tokenCache.has(profile)) return tokenCache.get(profile)!;
  const config = await loadConfig();
  // Named profile
  if (profile && config?.profiles[profile]?.token) {
    tokenCache.set(profile, config.profiles[profile].token);
    return config.profiles[profile].token;
  }
  // Active profile fallback
  if (config?.active && config.profiles[config.active]?.token) {
    tokenCache.set(profile, config.profiles[config.active].token);
    return config.profiles[config.active].token;
  }
  // Legacy credentials.json
  try {
    const credsPath = join(homedir(), ".polaris", "credentials.json");
    const creds = JSON.parse(await readFile(credsPath, "utf-8"));
    tokenCache.set(profile, creds.token ?? null);
    return creds.token ?? null;
  } catch {
    tokenCache.set(profile, null);
    return null;
  }
}

function emailFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.email ?? null;
  } catch {
    return null;
  }
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

function connectCloudWs(mapping: SessionMapping) {
  const serviceUrl = getServiceUrlForProfile(mapping.profile);
  const wsUrl = serviceUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsUrl}/projects/${mapping.project}/sessions/${mapping.session}/ws`);

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
      setTimeout(() => {
        const current = sessions.get(mapping.ccSessionId);
        if (current && current.project) {
          connectCloudWs(current);
        }
      }, 3000);
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

const LOG_DIR = join(homedir(), ".polaris", "logs");
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

const OUTBOX_DIR = join(homedir(), ".polaris", "outbox");

interface OutboxEntry {
  t: string;
  project: string;
  session: string;
  profile: string; // which account to use when flushing
  body: unknown; // the exact { sender, payload } body for the events endpoint
}

const pendingOutbox = new Set<string>(); // absolute file paths awaiting retry
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
    pendingOutbox.add(file);
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
  for (const file of Array.from(pendingOutbox)) {
    try {
      const entry = JSON.parse(await readFile(file, "utf-8")) as OutboxEntry;
      const profile = entry.profile ?? ""; // legacy entries without profile use active
      const serviceUrl = getServiceUrlForProfile(profile);
      const res = await fetch(
        `${serviceUrl}/projects/${entry.project}/sessions/${entry.session}/events`,
        { method: "POST", headers: await authHeadersForProfile(profile), body: JSON.stringify(entry.body) }
      );
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        if (!res.ok) {
          console.error(`polaris daemon: dropping outbox entry ${file} — upstream rejected it permanently (${res.status})`);
        }
        pendingOutbox.delete(file);
        await unlink(file).catch(() => {});
      } else {
        hadFailure = true; // 5xx — keep for the next pass
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
      if (name.endsWith(".json")) pendingOutbox.add(join(OUTBOX_DIR, name));
    }
    scheduleOutboxFlush();
  } catch { /* best-effort */ }
}

// --- Session history (persistent connect/disconnect log for backfill) ---

const SESSION_HISTORY_FILE = join(homedir(), ".polaris", "session-history.jsonl");

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

const SESSIONS_DIR = join(homedir(), ".polaris", "sessions");
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
    await writeFile(DAEMON_STATE_FILE, JSON.stringify({ sessions: active }));
  } catch { /* best-effort */ }
}

async function loadPersistedSessions(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(DAEMON_STATE_FILE, "utf-8")) as { sessions: PersistedSession[] };
    if (!Array.isArray(data.sessions)) return;

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

    // Open one cloud WebSocket per (project, session) pair; alias entries share it
    const primaryForPair = new Map<string, SessionMapping>();
    for (const mapping of sessions.values()) {
      if (!mapping.project) continue;
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

    async fetch(req) {
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
          const checkRes = await fetch(`${serviceUrl}/projects/${body.project}`, { headers });
          if (!checkRes.ok) {
            if (checkRes.status === 404) {
              // Return existing project list so the caller can show a helpful error
              const listRes = await fetch(`${serviceUrl}/projects`, { headers });
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

          const mapping: SessionMapping = {
            ccSessionId: body.ccSessionId,
            project: body.project,
            session: sessionName,
            user: body.user,
            agent: agentId,
            profile,
            ws: null,
            pendingMapping: true, // waiting for hook event to map the real CC session ID
          };
          sessions.set(body.ccSessionId, mapping);

          // Evict stale alias entries that share this (project, session) pair.
          // After a reconnect the old CC session ID still has an entry with the
          // same pair; leaving it allows hook events from the old shell to
          // alias-claim a future pending session or send duplicate events.
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
            const projRes = await fetch(`${serviceUrl}/projects/${body.project}`, { headers });
            if (projRes.ok) {
              const projData = await projRes.json() as { slack_channel_name?: string };
              mapping.slackChannel = projData.slack_channel_name ?? undefined;
            }
          } catch {}

          // Connect to cloud WebSocket
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
        } catch {
          return error("Invalid JSON", 400);
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

          // Log with session context so backfill can filter by exact origin
          await logEvent("/events", body, undefined, { project: mapping.project, session: mapping.session, ccSessionId });

          // Determine sender: human for prompts, agent for everything else
          const hookEvent = body.hook_event_name as string | undefined;
          const sender = hookEvent === "UserPromptSubmit" ? mapping.user : mapping.agent;

          // Relay to cloud service; on network failure or upstream 5xx,
          // persist to the write-ahead outbox instead of dropping
          const serviceUrl = getServiceUrlForProfile(mapping.profile);
          const relayBody = { sender, payload: body };
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
            console.error(`polaris daemon: upstream relay failed (${res ? res.status : "network error"}) — queued to outbox`);
            await logEvent("/events", body, { status: res?.status ?? 0, body: "queued to outbox" }, { project: mapping.project, session: mapping.session, ccSessionId });
            await enqueueOutbox(mapping.project, mapping.session, mapping.profile, relayBody);
            // The event is durably accepted (outbox), so still drain injects
            if (hookEvent === "UserPromptSubmit") {
              const queue = injectQueues.get(mapping.ccSessionId);
              const pendingInjects = queue ? queue.splice(0, queue.length) : [];
              return json({ ok: true, pendingInjects, queued: true });
            }
            return json({ status: "queued" });
          }

          if (!res.ok) {
            const err = await res.text();
            await logEvent("/events", body, { status: res.status, body: err }, { project: mapping.project, session: mapping.session, ccSessionId });
            return new Response(err, { status: res.status });
          }

          // Write delivery checkpoint so reconnects can auto-backfill the exact gap
          try {
            const delivered = await res.json() as { id?: string; timestamp?: string };
            if (delivered.id && delivered.timestamp) {
              void writeCheckpoint(ccSessionId, delivered.id, delivered.timestamp, mapping.project, mapping.session);
            }
          } catch { /* best-effort — don't block the response */ }

          // UserPromptSubmit: drain queued advisor injects and hand them back
          // to the hook, which surfaces them via additionalContext
          if (hookEvent === "UserPromptSubmit") {
            const queue = injectQueues.get(mapping.ccSessionId);
            const pendingInjects = queue ? queue.splice(0, queue.length) : [];
            return json({ ok: true, pendingInjects });
          }
          return json({ status: "relayed" });
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

      // GET /status/:ccSessionId — status line queries this
      if (method === "GET" && pathname.startsWith("/status/")) {
        const ccSessionId = pathname.slice("/status/".length);
        const mapping = sessions.get(ccSessionId);
        if (!mapping || !mapping.project) {
          return json({ connected: false });
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
          lastEventAge,
        });
      }

      // GET /status — daemon health + all active sessions
      if (method === "GET" && pathname === "/status") {
        const active = Array.from(sessions.values())
          .filter((m) => m.project)
          .map((m) => ({
            ccSessionId: m.ccSessionId,
            project: m.project,
            session: m.session,
            user: m.user,
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

        const timeoutMs = Math.min(
          parseInt(new URL(req.url).searchParams.get("timeout") ?? "60") * 1000,
          120_000
        );
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
      if (method === "GET" && pathname === "/channels") {
        try {
          const serviceUrl = getServiceUrl();
          const res = await fetch(`${serviceUrl}/projects`, {
            headers: await authHeaders(),
          });
          if (!res.ok) return error("Failed to fetch channels", res.status);
          const projects = (await res.json()) as Array<{ name: string; slack_channel_name?: string }>;
          const channels = projects
            .filter((p) => p.name !== "_system")
            .map((p) => `#${p.slack_channel_name || p.name}`);
          return json({ channels });
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

  return {
    server,
    sessions,
    stop: () => {
      if (outboxTimer) {
        clearTimeout(outboxTimer);
        outboxTimer = null;
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
  const { server } = startDaemon();
  console.error(`Polaris daemon listening on http://127.0.0.1:${server.port}`);
  console.error(`  API endpoint: ${getServiceUrl()}`);
  if (getDaemonSecret()) {
    console.error("  Auth: x-polaris-daemon-secret required on all endpoints");
  }
}
