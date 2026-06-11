import type { Server, ServerWebSocket } from "bun";
import { readFile, appendFile, mkdir } from "node:fs/promises";
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
  pendingMapping?: boolean; // true until a hook event maps the real CC session ID
}

function generateSessionName(): string {
  return `s-${crypto.randomUUID().slice(0, 4)}`;
}

const sessions = new Map<string, SessionMapping>(); // keyed by ccSessionId

// IPC callbacks for MCP servers to receive advisor messages
const mcpCallbacks = new Map<string, (event: unknown) => void>(); // keyed by ccSessionId

// --- Config resolution (env var > config.json > legacy credentials.json > defaults) ---

interface PolarisConfig {
  active: string;
  profiles: Record<string, { api: string; token: string; [key: string]: unknown }>;
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
  return "https://api.withpolaris.ai";
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

// --- Cloud WebSocket management ---

function connectCloudWs(mapping: SessionMapping) {
  const serviceUrl = getServiceUrl();
  const wsUrl = serviceUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsUrl}/projects/${mapping.project}/sessions/${mapping.session}/ws`);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string);
      // Forward inject events to the registered MCP callback
      if (data.source === "inject") {
        const callback = mcpCallbacks.get(mapping.ccSessionId);
        if (callback) callback(data);
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
  mcpCallbacks: Map<string, (event: unknown) => void>;
  stop: () => void;
} {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",

    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

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
            pendingMapping: true, // waiting for hook event to map the real CC session ID
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
        return json({ status: "all_disconnected" });
      }

      // POST /events — hook events arrive here, routed by session_id in the payload
      if (method === "POST" && pathname === "/events") {
        try {
          const body = (await req.json()) as { session_id?: string; [key: string]: unknown };
          await logEvent("/events", body);
          const ccSessionId = body.session_id;
          if (!ccSessionId) return error("session_id required in hook payload", 400);

          let mapping = sessions.get(ccSessionId);
          if (!mapping || !mapping.project) {
            // CC session_id doesn't match any registered MCP client.
            // The MCP server uses a different UUID than CC's session_id.
            // Match to a session with pendingMapping (most recent first).
            const pending = Array.from(sessions.values()).filter((m) => m.project && m.pendingMapping);
            if (pending.length > 0) {
              // Map the CC session ID to the most recently connected pending session
              mapping = pending[pending.length - 1];
              mapping.pendingMapping = false;
              // Register under the real CC session ID for future events
              sessions.set(ccSessionId, { ...mapping, ccSessionId });
              console.error(`[daemon] Mapped CC session ${ccSessionId.slice(0, 8)} → ${mapping.project}/${mapping.session}`);
            } else {
              // No pending sessions — try single-session fallback
              const connectedSessions = Array.from(sessions.values()).filter((m) => m.project);
              if (connectedSessions.length === 1) {
                mapping = connectedSessions[0];
                sessions.set(ccSessionId, { ...mapping, ccSessionId });
              } else {
                return json({ status: connectedSessions.length > 0 ? "ambiguous" : "not_connected" });
              }
            }
          }

          // Determine sender: human for prompts, agent for everything else
          const hookEvent = body.hook_event_name as string | undefined;
          const sender = hookEvent === "UserPromptSubmit" ? mapping.user : mapping.agent;

          // Relay to cloud service
          const serviceUrl = getServiceUrl();
          const res = await fetch(
            `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/events`,
            {
              method: "POST",
              headers: await authHeaders(),
              body: JSON.stringify({ sender, payload: body }),
            }
          );

          if (!res.ok) {
            const err = await res.text();
            await logEvent("/events", body, { status: res.status, body: err });
            return new Response(err, { status: res.status });
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
          const res = await fetch(
            `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/events`,
            {
              method: "POST",
              headers: await authHeaders(),
              body: JSON.stringify({
                sender: mapping.user,
                payload: {
                  hook_event_name: "Stop",
                  session_id: body.ccSessionId,
                  stop_response: body.message,
                },
              }),
            }
          );
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

  return { server, sessions, mcpCallbacks, stop: () => server.stop(true) };
}

// --- Run if executed directly ---
if (import.meta.main) {
  // Load config before starting so getServiceUrl() has the active profile
  await loadConfig();
  const { server } = startDaemon();
  console.error(`Polaris daemon listening on http://127.0.0.1:${server.port}`);
  console.error(`  API endpoint: ${getServiceUrl()}`);
}
