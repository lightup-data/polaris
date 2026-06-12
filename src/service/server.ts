import { type Server, type ServerWebSocket } from "bun";
import { z } from "zod";
import { postToSlackSystemChannel } from "../slack/system";
import {
  createDb,
  createOrg,
  getOrg,
  createProject,
  listProjects,
  getProject,
  renameProject,
  createSession,
  getSession,
  setDriver,
  clearDriver,
  pushEvent,
  getProjectEvents,
  getSessionEvents,
  getEventsSince,
  type Sql,
} from "./db";
import { verifyToken, type TokenPayload } from "./auth";
import type { PolarisEvent, ParticipantId } from "../types";
import { HookPayload, ParticipantId as ParticipantIdSchema } from "../types";

// --- WebSocket subscriber management ---

type WsData = { project: string; session?: string };
const projectSubs = new Map<string, Set<ServerWebSocket<WsData>>>();
const sessionSubs = new Map<string, Set<ServerWebSocket<WsData>>>();

function subKey(project: string, session?: string): string {
  return session ? `${project}/${session}` : project;
}

function addSub(ws: ServerWebSocket<WsData>) {
  const { project, session } = ws.data;
  if (session) {
    const key = subKey(project, session);
    if (!sessionSubs.has(key)) sessionSubs.set(key, new Set());
    sessionSubs.get(key)!.add(ws);
  } else {
    if (!projectSubs.has(project)) projectSubs.set(project, new Set());
    projectSubs.get(project)!.add(ws);
  }
}

function removeSub(ws: ServerWebSocket<WsData>) {
  const { project, session } = ws.data;
  if (session) {
    sessionSubs.get(subKey(project, session))?.delete(ws);
  } else {
    projectSubs.get(project)?.delete(ws);
  }
}

function broadcastEvent(event: PolarisEvent) {
  const msg = JSON.stringify(event);
  for (const ws of projectSubs.get(event.project) ?? []) {
    ws.send(msg);
  }
  const sessionKey = subKey(event.project, event.session);
  for (const ws of sessionSubs.get(sessionKey) ?? []) {
    if (!projectSubs.get(event.project)?.has(ws)) {
      ws.send(msg);
    }
  }
}

// --- SSE helpers ---

type SseController = ReadableStreamDefaultController<Uint8Array>;
const projectSseClients = new Map<string, Set<SseController>>();
const sessionSseClients = new Map<string, Set<SseController>>();

function addSse(controller: SseController, project: string, session?: string) {
  if (session) {
    const key = subKey(project, session);
    if (!sessionSseClients.has(key)) sessionSseClients.set(key, new Set());
    sessionSseClients.get(key)!.add(controller);
  } else {
    if (!projectSseClients.has(project)) projectSseClients.set(project, new Set());
    projectSseClients.get(project)!.add(controller);
  }
}

function removeSse(controller: SseController, project: string, session?: string) {
  if (session) {
    sessionSseClients.get(subKey(project, session))?.delete(controller);
  } else {
    projectSseClients.get(project)?.delete(controller);
  }
}

function broadcastSse(event: PolarisEvent) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  const bytes = new TextEncoder().encode(data);
  for (const ctrl of projectSseClients.get(event.project) ?? []) {
    try { ctrl.enqueue(bytes); } catch { /* client disconnected */ }
  }
  const sessionKey = subKey(event.project, event.session);
  for (const ctrl of sessionSseClients.get(sessionKey) ?? []) {
    if (!projectSseClients.get(event.project)?.has(ctrl)) {
      try { ctrl.enqueue(bytes); } catch { /* client disconnected */ }
    }
  }
}

// --- Route matching ---

type RouteParams = Record<string, string>;

function matchRoute(method: string, pathname: string, pattern: string, expectedMethod: string): RouteParams | null {
  if (method !== expectedMethod) return null;
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// --- Helpers ---

async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

// --- Auth helper ---

async function resolveOrgId(req: Request, defaultOrgId: string): Promise<string> {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const payload = await verifyToken(token);
    if (payload) return payload.org_id;
  }
  return defaultOrgId;
}

// --- Server factory ---

export async function startServer(opts: {
  port?: number;
  databaseUrl?: string;
  defaultOrgId?: string;
} = {}): Promise<{
  server: Server;
  sql: Sql;
  defaultOrgId: string;
  stop: () => Promise<void>;
}> {
  const sql = await createDb(opts.databaseUrl);
  const port = opts.port ?? Number(process.env.PORT ?? 4321);
  const defaultOrgId = opts.defaultOrgId ?? "default";

  // Ensure default org exists for backward compat (tests, daemon without auth)
  try {
    await createOrg(sql, defaultOrgId, "Default", undefined);
  } catch {
    // Already exists
  }

  const server = Bun.serve<WsData>({
    port,
    hostname: "0.0.0.0",

    websocket: {
      open(ws) { addSub(ws); },
      close(ws) { removeSub(ws); },
      message() {},
    },

    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;
      let params: RouteParams | null;

      // Resolve org from auth token or use default
      const orgId = await resolveOrgId(req, defaultOrgId);

      // --- WebSocket upgrade ---
      params = matchRoute(method, pathname, "/projects/:proj/ws", "GET");
      if (params) {
        const upgraded = server.upgrade(req, { data: { project: params.proj } });
        return upgraded ? undefined : error("WebSocket upgrade failed", 400);
      }
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/ws", "GET");
      if (params) {
        const upgraded = server.upgrade(req, { data: { project: params.proj, session: params.sess } });
        return upgraded ? undefined : error("WebSocket upgrade failed", 400);
      }

      // --- Project endpoints ---

      if (method === "GET" && pathname === "/projects") {
        const projects = await listProjects(sql, orgId);
        return json(projects);
      }

      params = matchRoute(method, pathname, "/projects", "POST");
      if (params) {
        const body = await jsonBody(req);
        const parsed = z.object({ name: z.string().min(1) }).safeParse(body);
        if (!parsed.success) return error("Invalid body: name is required", 400);
        try {
          const project = await createProject(sql, orgId, parsed.data.name);
          return json(project, 201);
        } catch {
          return error("Project already exists", 409);
        }
      }

      params = matchRoute(method, pathname, "/projects/:proj", "GET");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        return json(project);
      }

      params = matchRoute(method, pathname, "/projects/:proj/rename", "POST");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const body = await req.json() as { name?: string };
        if (!body.name) return error("name is required", 400);
        const existing = await getProject(sql, orgId, body.name);
        if (existing) return error("A project with that name already exists", 409);
        await renameProject(sql, orgId, params.proj, body.name);

        // Rename Slack channel if one is linked
        if (project.slack_channel_id) {
          try {
            const org = await getOrg(sql, orgId);
            if (org?.slack_bot_token) {
              const { WebClient } = await import("@slack/web-api");
              const web = new WebClient(org.slack_bot_token);
              await web.conversations.rename({
                channel: project.slack_channel_id,
                name: body.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80),
              });
            }
          } catch (e) {
            // Non-fatal — DB rename succeeded, Slack rename is best-effort
            console.error("[server] Slack channel rename failed:", e);
          }
        }

        return json({ status: "renamed", oldName: params.proj, newName: body.name });
      }

      params = matchRoute(method, pathname, "/projects/:proj/messages", "GET");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const since = url.searchParams.get("since");
        const events = since
          ? await getEventsSince(sql, orgId, params.proj, since)
          : await getProjectEvents(sql, orgId, params.proj);
        return json(events);
      }

      params = matchRoute(method, pathname, "/projects/:proj/events", "GET");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const proj = params.proj;
        let controller: SseController;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) { controller = ctrl; addSse(controller, proj); },
          cancel() { removeSse(controller, proj); },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      // --- Session endpoints ---

      params = matchRoute(method, pathname, "/projects/:proj/sessions", "POST");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({ name: z.string().min(1), driver: ParticipantIdSchema.nullable().default(null) })
          .safeParse(body);
        if (!parsed.success) return error("Invalid body: name is required", 400);
        try {
          const session = await createSession(sql, orgId, params.proj, parsed.data.name, parsed.data.driver);
          return json(session, 201);
        } catch {
          return error("Session already exists in this project", 409);
        }
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess", "GET");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        return json(session);
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/events", "POST");
      if (params) {
        let session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session && params.proj === "_system") {
          // Auto-create _system project and session
          try { await createProject(sql, orgId, "_system"); } catch { /* exists */ }
          try { session = await createSession(sql, orgId, "_system", "_system", null); } catch { session = await getSession(sql, orgId, "_system", "_system"); }
        }
        if (!session) return error("Session not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({ sender: ParticipantIdSchema, payload: HookPayload })
          .safeParse(body);
        if (!parsed.success) return error(`Invalid body: ${parsed.error.message}`, 400);
        const event: PolarisEvent = {
          id: crypto.randomUUID(),
          project: params.proj,
          session: params.sess,
          timestamp: new Date().toISOString(),
          source: "hook",
          sender: parsed.data.sender,
          payload: parsed.data.payload,
        };
        await pushEvent(sql, orgId, event);
        broadcastEvent(event);
        broadcastSse(event);

        // Notify web dashboard on all events (best-effort, different process)
        const authHeader = req.headers.get("Authorization");
        if (authHeader) {
          fetch(`http://${process.env.WEB_HOST ?? "localhost"}:${Number(process.env.WEB_PORT ?? 3000)}/api/notify-dashboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader },
          }).catch(() => {});
        }

        // Forward _system events to Slack
        if (params.proj === "_system") {
          const text = (parsed.data.payload as { stop_response?: string; prompt?: string }).stop_response
            ?? (parsed.data.payload as { prompt?: string }).prompt
            ?? "System event";
          await postToSlackSystemChannel(sql, orgId, `:computer: *${parsed.data.sender}*: ${text}`);
        }

        return json(event, 201);
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/events", "GET");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const proj = params.proj;
        const sess = params.sess;
        let controller: SseController;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) { controller = ctrl; addSse(controller, proj, sess); },
          cancel() { removeSse(controller, proj, sess); },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/inject", "POST");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({ content: z.string().min(1), sender: ParticipantIdSchema })
          .safeParse(body);
        if (!parsed.success) return error(`Invalid body: ${parsed.error.message}`, 400);
        const event: PolarisEvent = {
          id: crypto.randomUUID(),
          project: params.proj,
          session: params.sess,
          timestamp: new Date().toISOString(),
          source: "inject",
          sender: parsed.data.sender,
          payload: {
            type: "inject" as const,
            content: parsed.data.content,
            sender: parsed.data.sender,
            target: params.sess,
          },
        };
        await pushEvent(sql, orgId, event);
        broadcastEvent(event);
        broadcastSse(event);
        return json(event, 201);
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/messages", "GET");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const events = await getSessionEvents(sql, orgId, params.proj, params.sess);
        return json(events);
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/handoff", "POST");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        if (!session.driver) return error("Session has no driver to hand off", 400);
        await clearDriver(sql, orgId, params.proj, params.sess);
        return json({ status: "open", session: params.sess });
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/driver", "POST");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        if (session.driver) return error(`Session already has driver: ${session.driver}`, 409);
        const body = await jsonBody(req);
        const parsed = z.object({ driver: ParticipantIdSchema }).safeParse(body);
        if (!parsed.success) return error("Invalid body: driver is required", 400);
        await setDriver(sql, orgId, params.proj, params.sess, parsed.data.driver);
        return json({ status: "claimed", driver: parsed.data.driver, session: params.sess });
      }

      // GET /team — list org members with Slack identities
      if (method === "GET" && pathname === "/team") {
        const { listUsers, getOrg: getOrgFn } = await import("./db");
        const users = await listUsers(sql, orgId);
        const org = await getOrgFn(sql, orgId);

        // Resolve Slack user info if bot token available
        let slackMembers: Array<{ id: string; name: string; display_name: string }> = [];
        if (org?.slack_bot_token) {
          try {
            const slackRes = await fetch("https://slack.com/api/users.list?limit=200", {
              headers: { Authorization: `Bearer ${org.slack_bot_token}` },
            });
            if (slackRes.ok) {
              const slackData = (await slackRes.json()) as { members?: Array<{ id: string; real_name?: string; profile?: { display_name?: string }; deleted?: boolean; is_bot?: boolean }> };
              slackMembers = (slackData.members ?? [])
                .filter((m) => !m.deleted && !m.is_bot)
                .map((m) => ({
                  id: m.id,
                  name: m.real_name ?? "",
                  display_name: m.profile?.display_name ?? "",
                }));
            }
          } catch { /* Slack API unavailable */ }
        }

        // Join Polaris users with Slack members by email match or name match
        const team = users.map((u) => {
          const slack = slackMembers.find((m) =>
            m.name.toLowerCase() === u.name.toLowerCase() ||
            m.display_name.toLowerCase() === u.name.toLowerCase().replace(/\s+/g, ".")
          );
          return {
            name: u.name,
            participant_id: u.participant_id,
            email: u.email,
            slack_id: slack?.id ?? null,
            slack_display: slack?.display_name || slack?.name || null,
          };
        });

        return json({ members: team });
      }

      if (method === "GET" && pathname === "/status") {
        return json({ ok: true, version: "0.0.1" });
      }

      return error("Not found", 404);
    },
  });

  return {
    server,
    sql,
    defaultOrgId,
    stop: async () => {
      server.stop(true);
      await sql.end();
    },
  };
}

if (import.meta.main) {
  const { server } = await startServer();
  console.error(`Polaris server listening on port ${server.port}`);
}
