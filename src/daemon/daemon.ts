import type { Server, ServerWebSocket } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// --- Session registry ---

interface SessionMapping {
  ccSessionId: string;
  project: string;
  session: string;
  user: string;
  slackChannel?: string;
  ws: WebSocket | null;
}

const sessions = new Map<string, SessionMapping>(); // keyed by ccSessionId

// IPC callbacks for MCP servers to receive advisor messages
const mcpCallbacks = new Map<string, (event: unknown) => void>(); // keyed by ccSessionId

function getServiceUrl(): string {
  return process.env.POLARIS_SERVICE_URL ?? "http://localhost:4321";
}

let cachedToken: string | null | undefined = undefined;
async function getAuthToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  // Check env var first (for testing). Empty string means "no auth".
  if (process.env.POLARIS_AUTH_TOKEN !== undefined) {
    cachedToken = process.env.POLARIS_AUTH_TOKEN || null;
    return cachedToken;
  }
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

export function startDaemon(port = Number(process.env.POLARIS_DAEMON_PORT ?? 4321)): {
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
            session: string;
            user: string;
          };
          if (!body.ccSessionId || !body.project || !body.session || !body.user) {
            return error("ccSessionId, project, session, and user are required", 400);
          }

          // Disconnect existing cloud WS if switching sessions
          disconnectCloudWs(body.ccSessionId);

          const mapping: SessionMapping = {
            ccSessionId: body.ccSessionId,
            project: body.project,
            session: body.session,
            user: body.user,
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
          const sessionRes = await fetch(`${serviceUrl}/projects/${body.project}/sessions`, {
            method: "POST",
            headers: await authHeaders(),
            body: JSON.stringify({ name: body.session, driver: body.user }),
          });
          if (!sessionRes.ok && sessionRes.status !== 409) {
            const err = await sessionRes.text();
            return error(`Failed to create session: ${err}`, 500);
          }

          // If session already existed, try to claim driver
          if (sessionRes.status === 409) {
            await fetch(`${serviceUrl}/projects/${body.project}/sessions/${body.session}/driver`, {
              method: "POST",
              headers: await authHeaders(),
              body: JSON.stringify({ driver: body.user }),
            }); // Ignore errors (might already be driver)
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
            project: body.project,
            session: body.session,
            user: body.user,
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
          const ccSessionId = body.session_id;
          if (!ccSessionId) return error("session_id required in hook payload", 400);

          let mapping = sessions.get(ccSessionId);
          if (!mapping || !mapping.project) {
            // CC session_id doesn't match any registered MCP client.
            // Try to find a connected session to route to (the MCP client
            // generates its own UUID, which differs from CC's session_id).
            const connectedSessions = Array.from(sessions.values()).filter((m) => m.project);
            if (connectedSessions.length === 1) {
              // Only one active session — route to it and remember the mapping
              mapping = connectedSessions[0];
              sessions.set(ccSessionId, { ...mapping, ccSessionId });
            } else if (connectedSessions.length > 1) {
              // Multiple sessions — can't determine which one. Discard.
              return json({ status: "ambiguous" });
            } else {
              return json({ status: "not_connected" });
            }
          }

          // Relay to cloud service
          const serviceUrl = getServiceUrl();
          const res = await fetch(
            `${serviceUrl}/projects/${mapping.project}/sessions/${mapping.session}/events`,
            {
              method: "POST",
              headers: await authHeaders(),
              body: JSON.stringify({ sender: mapping.user, payload: body }),
            }
          );

          if (!res.ok) {
            const err = await res.text();
            return new Response(err, { status: res.status });
          }
          return json({ status: "relayed" });
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
        return json({
          connected: true,
          project: mapping.project,
          session: mapping.session,
          user: mapping.user,
          slackChannel: mapping.slackChannel ?? null,
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

      return error("Not found", 404);
    },
  });

  return { server, sessions, mcpCallbacks, stop: () => server.stop(true) };
}

// --- Run if executed directly ---
if (import.meta.main) {
  const { server } = startDaemon();
  console.error(`Polaris daemon listening on http://127.0.0.1:${server.port}`);
}
