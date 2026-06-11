import type { Server, ServerWebSocket } from "bun";
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Session registry ---

interface SessionMapping {
  ccSessionId: string;
  project: string;
  session: string;
  user: string;
  agent: string;
  slackChannel?: string;
  ws: WebSocket | null;
}

function generateSessionName(): string {
  return `s-${crypto.randomUUID().slice(0, 4)}`;
}

const sessions = new Map<string, SessionMapping>(); // keyed by ccSessionId

// Advisor injects queued for delivery via the UserPromptSubmit hook
const injectQueues = new Map<string, Array<{ from: string; content: string; timestamp: string }>>(); // keyed by ccSessionId

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

function getServiceUrl(): string {
  // 1. Env var override (Makefile uses this for local dev)
  if (process.env.POLARIS_SERVICE_URL) return process.env.POLARIS_SERVICE_URL;
  // 2. Active profile (read synchronously from cache — loaded at startup)
  if (cachedConfig?.active && cachedConfig.profiles[cachedConfig.active]) {
    return cachedConfig.profiles[cachedConfig.active].api;
  }
  // 3. Fallback
  return "https://api.polaris.lightup.ai";
}

let cachedToken: string | null | undefined = undefined;
async function getAuthToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  // 1. Env var (for testing). Empty string means "no auth".
  if (process.env.POLARIS_AUTH_TOKEN !== undefined) {
    cachedToken = process.env.POLARIS_AUTH_TOKEN || null;
    return cachedToken;
  }
  // 2. Active profile in config.json
  const config = await loadConfig();
  if (config?.active && config.profiles[config.active]?.token) {
    cachedToken = config.profiles[config.active].token;
    return cachedToken;
  }
  // 3. Legacy credentials.json
  try {
    const credsPath = join(homedir(), ".polaris", "credentials.json");
    const creds = JSON.parse(await readFile(credsPath, "utf-8"));
    cachedToken = creds.token ?? null;
    return cachedToken;
  } catch {
    cachedToken = null;
    return null;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  if (token) return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return { "Content-Type": "application/json" };
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
  const serviceUrl = getServiceUrl();
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
    // Reconnect if still registered
    if (sessions.has(mapping.ccSessionId) && sessions.get(mapping.ccSessionId)!.project === mapping.project) {
      setTimeout(() => {
        if (sessions.has(mapping.ccSessionId)) {
          connectCloudWs(sessions.get(mapping.ccSessionId)!);
        }
      }, 3000);
    }
  };

  ws.onerror = () => {
    // Will trigger onclose
  };

  mapping.ws = ws;
}

function disconnectCloudWs(ccSessionId: string) {
  const mapping = sessions.get(ccSessionId);
  if (mapping?.ws) {
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

async function logEvent(endpoint: string, payload: unknown, response?: { status: number; body?: unknown }): Promise<void> {
  try {
    await ensureLogDir();
    const entry: Record<string, unknown> = { t: new Date().toISOString(), endpoint, payload };
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

async function enqueueOutbox(project: string, session: string, body: unknown): Promise<void> {
  try {
    await ensureOutboxDir();
    const entry: OutboxEntry = { t: new Date().toISOString(), project, session, body };
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
  const serviceUrl = getServiceUrl();
  let hadFailure = false;
  for (const file of Array.from(pendingOutbox)) {
    try {
      const entry = JSON.parse(await readFile(file, "utf-8")) as OutboxEntry;
      const res = await fetch(
        `${serviceUrl}/projects/${entry.project}/sessions/${entry.session}/events`,
        { method: "POST", headers: await authHeaders(), body: JSON.stringify(entry.body) }
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
          };
          await logEvent("/connect", body);
          if (!body.ccSessionId || !body.project || !body.user) {
            return error("ccSessionId, project, and user are required", 400);
          }

          // Generate session name if not provided
          const sessionName = body.session || generateSessionName();
          const agentId = body.agent || "agent:claude";

          // Disconnect existing cloud WS if switching sessions
          disconnectCloudWs(body.ccSessionId);

          const mapping: SessionMapping = {
            ccSessionId: body.ccSessionId,
            project: body.project,
            session: sessionName,
            user: body.user,
            agent: agentId,
            ws: null,
          };
          sessions.set(body.ccSessionId, mapping);

          // Ensure the project exists on the cloud service (create if not)
          const serviceUrl = getServiceUrl();
          await fetch(`${serviceUrl}/projects`, {
            method: "POST",
            headers: await authHeaders(),
            body: JSON.stringify({ name: body.project }),
          }); // Ignore 409 (already exists)

          // Ensure the session exists (create if not, claim driver)
          // Retry with new name on 409 (collision with generated name)
          let attempts = 0;
          let created = false;
          while (!created && attempts < 3) {
            const sessionRes = await fetch(`${serviceUrl}/projects/${body.project}/sessions`, {
              method: "POST",
              headers: await authHeaders(),
              body: JSON.stringify({ name: mapping.session, driver: body.user }),
            });
            if (sessionRes.ok) {
              created = true;
            } else if (sessionRes.status === 409) {
              if (body.session) {
                // Explicit session name — claim driver instead of retrying
                await fetch(`${serviceUrl}/projects/${body.project}/sessions/${mapping.session}/driver`, {
                  method: "POST",
                  headers: await authHeaders(),
                  body: JSON.stringify({ driver: body.user }),
                });
                created = true;
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
            const projRes = await fetch(`${serviceUrl}/projects/${body.project}`, {
              headers: await authHeaders(),
            });
            if (projRes.ok) {
              const projData = await projRes.json() as { slack_channel_name?: string };
              mapping.slackChannel = projData.slack_channel_name ?? undefined;
            }
          } catch {}

          // Connect to cloud WebSocket
          connectCloudWs(mapping);

          return json({
            status: "connected",
            project: mapping.project,
            session: mapping.session,
            user: mapping.user,
            agent: mapping.agent,
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
          if (mapping) {
            mapping.project = "";
            mapping.session = "";
            mapping.user = "";
          }
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
        }
        sessions.clear();
        injectQueues.clear();
        return json({ status: "all_disconnected" });
      }

      // POST /events — hook events arrive here, routed by session_id in the payload
      if (method === "POST" && pathname === "/events") {
        try {
          const body = (await req.json()) as { session_id?: string; [key: string]: unknown };
          await logEvent("/events", body);
          const ccSessionId = body.session_id;
          if (!ccSessionId) return error("session_id required in hook payload", 400);

          // Session routing (deterministic, in priority order):
          // 1. Exact match: session_id is a known mapping (registered via
          //    MCP, connected via /connect, or a previously learned alias) —
          //    always routed by that match, regardless of how many other
          //    sessions are connected. A matchable event is never dropped.
          // 2. No match + exactly one connected session: route to it and
          //    remember session_id as an alias of that mapping (the MCP
          //    client's generated UUID differs from CC's hook session_id),
          //    so later events route by rule 1 even once more sessions join.
          // 3. No match + multiple connected sessions: truly unmatchable —
          //    drop, but loudly (console warning + JSONL log entry).
          // 4. No match + nothing connected: not_connected (existing).
          let mapping = sessions.get(ccSessionId);
          if (!mapping || !mapping.project) {
            const connectedSessions = Array.from(sessions.values()).filter((m) => m.project);
            if (connectedSessions.length === 1) {
              // Only one active session — route to it and remember the mapping
              mapping = connectedSessions[0];
              sessions.set(ccSessionId, { ...mapping, ccSessionId, slackChannel: undefined });
              // Share the inject queue between the original ccSessionId (where
              // the cloud WS enqueues) and this CC hook session_id alias
              let queue = injectQueues.get(mapping.ccSessionId);
              if (!queue) {
                queue = [];
                injectQueues.set(mapping.ccSessionId, queue);
              }
              injectQueues.set(ccSessionId, queue);
            } else if (connectedSessions.length > 1) {
              // Multiple sessions and session_id matches none of them (nor any
              // learned alias) — can't determine which one. Drop with a clear
              // warning, never silently.
              const candidates = connectedSessions.map((m) => `${m.project}/${m.session}`).join(", ");
              console.error(
                `polaris daemon: dropping ${String(body.hook_event_name ?? "hook")} event — ` +
                `session_id ${ccSessionId} matches no known mapping and ${connectedSessions.length} ` +
                `sessions are connected (${candidates}). ` +
                `Reconnect with polaris_connect in the affected Claude session to re-establish routing.`
              );
              await logEvent("/events", body, { status: 0, body: `dropped: ambiguous across ${connectedSessions.length} sessions (${candidates})` });
              return json({ status: "ambiguous" });
            } else {
              return json({ status: "not_connected" });
            }
          }

          // Determine sender: human for prompts, agent for everything else
          const hookEvent = body.hook_event_name as string | undefined;
          const sender = hookEvent === "UserPromptSubmit" ? mapping.user : mapping.agent;

          // Relay to cloud service; on network failure or upstream 5xx,
          // persist to the write-ahead outbox instead of dropping
          const serviceUrl = getServiceUrl();
          const relayBody = { sender, payload: body };
          let res: Response | null = null;
          try {
            res = await fetch(
              `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/events`,
              {
                method: "POST",
                headers: await authHeaders(),
                body: JSON.stringify(relayBody),
              }
            );
          } catch {
            res = null; // network failure
          }

          if (!res || res.status >= 500) {
            console.error(`polaris daemon: upstream relay failed (${res ? res.status : "network error"}) — queued to outbox`);
            await logEvent("/events", body, { status: res?.status ?? 0, body: "queued to outbox" });
            await enqueueOutbox(mapping.project, mapping.session, relayBody);
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
            await logEvent("/events", body, { status: res.status, body: err });
            return new Response(err, { status: res.status });
          }

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

          // Call cloud API to rename in DB
          const serviceUrl = getServiceUrl();
          const res = await fetch(`${serviceUrl}/projects/${body.oldName}/rename`, {
            method: "POST",
            headers: await authHeaders(),
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

          return json({ status: "renamed", oldName: body.oldName, newName: body.newName });
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
        return json({
          connected: true,
          project: mapping.project,
          session: mapping.session,
          user: mapping.user,
          slackChannel,
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

          const serviceUrl = getServiceUrl();
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
                headers: await authHeaders(),
                body: JSON.stringify(relayBody),
              }
            );
          } catch {
            res = null; // network failure
          }
          if (!res || res.status >= 500) {
            console.error(`polaris daemon: upstream reply relay failed (${res ? res.status : "network error"}) — queued to outbox`);
            await logEvent("/reply", body, { status: res?.status ?? 0, body: "queued to outbox" });
            await enqueueOutbox(mapping.project, mapping.session, relayBody);
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

      // GET /context/:ccSessionId/:session — proxy context fetch from cloud API
      if (method === "GET" && pathname.match(/^\/context\/[^/]+\/[^/]+$/)) {
        const parts = pathname.split("/");
        const ccSessionId = parts[2];
        const targetSession = parts[3];
        const mapping = sessions.get(ccSessionId);
        if (!mapping || !mapping.project) return error("Not connected", 400);

        const serviceUrl = getServiceUrl();
        const res = await fetch(
          `${serviceUrl}/projects/${mapping.project}/sessions/${targetSession}/messages`,
          { headers: await authHeaders() }
        );
        if (!res.ok) {
          const err = await res.text();
          return new Response(err, { status: res.status });
        }
        const data = await res.json();
        return json(data);
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
  // Replay any events left in the outbox by a previous daemon run
  await scanOutbox();
  const { server } = startDaemon();
  console.error(`Polaris daemon listening on http://127.0.0.1:${server.port}`);
  console.error(`  API endpoint: ${getServiceUrl()}`);
  if (getDaemonSecret()) {
    console.error("  Auth: x-polaris-daemon-secret required on all endpoints");
  }
}
