import { type Server, type ServerWebSocket } from "bun";
import { z } from "zod";
import {
  createDb,
  createProject,
  getProject,
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
import type { CollabEvent, ParticipantId } from "../types";
import { HookPayload, InjectMessage, ParticipantId as ParticipantIdSchema } from "../types";

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
    // Session-level: only receives events for this session
    const key = subKey(project, session);
    if (!sessionSubs.has(key)) sessionSubs.set(key, new Set());
    sessionSubs.get(key)!.add(ws);
  } else {
    // Project-level: receives events from all sessions
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

function broadcastEvent(event: CollabEvent) {
  const msg = JSON.stringify(event);
  // Broadcast to project-level subscribers
  for (const ws of projectSubs.get(event.project) ?? []) {
    ws.send(msg);
  }
  // Broadcast to session-level subscribers (skip if already sent via project sub)
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

function broadcastSse(event: CollabEvent) {
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

// --- Request body helpers ---

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

// --- Server factory ---

export async function startServer(opts: { port?: number; databaseUrl?: string } = {}): Promise<{
  server: Server;
  sql: Sql;
  stop: () => Promise<void>;
}> {
  const sql = await createDb(opts.databaseUrl);
  const port = opts.port ?? Number(process.env.PORT ?? 4321);

  const server = Bun.serve<WsData>({
    port,
    hostname: "0.0.0.0",

    websocket: {
      open(ws) {
        addSub(ws);
      },
      close(ws) {
        removeSub(ws);
      },
      message(_ws, _message) {
        // Future: handle inbound WS messages from clients
      },
    },

    async fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;
      let params: RouteParams | null;

      // --- WebSocket upgrade ---
      // Project-level: /projects/:proj/ws
      params = matchRoute(method, pathname, "/projects/:proj/ws", "GET");
      if (params) {
        const upgraded = server.upgrade(req, { data: { project: params.proj } });
        return upgraded ? undefined : error("WebSocket upgrade failed", 400);
      }
      // Session-level: /projects/:proj/sessions/:sess/ws
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/ws", "GET");
      if (params) {
        const upgraded = server.upgrade(req, { data: { project: params.proj, session: params.sess } });
        return upgraded ? undefined : error("WebSocket upgrade failed", 400);
      }

      // --- Project endpoints ---

      // POST /projects
      params = matchRoute(method, pathname, "/projects", "POST");
      if (params) {
        const body = await jsonBody(req);
        const parsed = z.object({ name: z.string().min(1) }).safeParse(body);
        if (!parsed.success) return error("Invalid body: name is required", 400);
        try {
          const project = await createProject(sql, parsed.data.name);
          return json(project, 201);
        } catch {
          return error("Project already exists", 409);
        }
      }

      // GET /projects/:proj
      params = matchRoute(method, pathname, "/projects/:proj", "GET");
      if (params) {
        const project = await getProject(sql, params.proj);
        if (!project) return error("Project not found", 404);
        return json(project);
      }

      // GET /projects/:proj/messages
      params = matchRoute(method, pathname, "/projects/:proj/messages", "GET");
      if (params) {
        const project = await getProject(sql, params.proj);
        if (!project) return error("Project not found", 404);
        const since = url.searchParams.get("since");
        const events = since
          ? await getEventsSince(sql, params.proj, since)
          : await getProjectEvents(sql, params.proj);
        return json(events);
      }

      // GET /projects/:proj/events (SSE)
      params = matchRoute(method, pathname, "/projects/:proj/events", "GET");
      if (params) {
        const project = await getProject(sql, params.proj);
        if (!project) return error("Project not found", 404);
        const proj = params.proj;
        let controller: SseController;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            controller = ctrl;
            addSse(controller, proj);
          },
          cancel() {
            removeSse(controller, proj);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // --- Session endpoints ---

      // POST /projects/:proj/sessions
      params = matchRoute(method, pathname, "/projects/:proj/sessions", "POST");
      if (params) {
        const project = await getProject(sql, params.proj);
        if (!project) return error("Project not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({
            name: z.string().min(1),
            driver: ParticipantIdSchema.nullable().default(null),
          })
          .safeParse(body);
        if (!parsed.success) return error("Invalid body: name is required", 400);
        try {
          const session = await createSession(sql, params.proj, parsed.data.name, parsed.data.driver);
          return json(session, 201);
        } catch {
          return error("Session already exists in this project", 409);
        }
      }

      // GET /projects/:proj/sessions/:sess
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess", "GET");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        return json(session);
      }

      // POST /projects/:proj/sessions/:sess/events
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/events", "POST");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({
            sender: ParticipantIdSchema,
            payload: HookPayload,
          })
          .safeParse(body);
        if (!parsed.success) return error(`Invalid body: ${parsed.error.message}`, 400);
        const event: CollabEvent = {
          id: crypto.randomUUID(),
          project: params.proj,
          session: params.sess,
          timestamp: new Date().toISOString(),
          source: "hook",
          sender: parsed.data.sender,
          payload: parsed.data.payload,
        };
        await pushEvent(sql, event);
        broadcastEvent(event);
        broadcastSse(event);
        return json(event, 201);
      }

      // GET /projects/:proj/sessions/:sess/events (SSE)
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/events", "GET");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const proj = params.proj;
        const sess = params.sess;
        let controller: SseController;
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            controller = ctrl;
            addSse(controller, proj, sess);
          },
          cancel() {
            removeSse(controller, proj, sess);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // POST /projects/:proj/sessions/:sess/inject
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/inject", "POST");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({
            content: z.string().min(1),
            sender: ParticipantIdSchema,
          })
          .safeParse(body);
        if (!parsed.success) return error(`Invalid body: ${parsed.error.message}`, 400);
        const event: CollabEvent = {
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
        await pushEvent(sql, event);
        broadcastEvent(event);
        broadcastSse(event);
        return json(event, 201);
      }

      // GET /projects/:proj/sessions/:sess/messages
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/messages", "GET");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const events = await getSessionEvents(sql, params.proj, params.sess);
        return json(events);
      }

      // POST /projects/:proj/sessions/:sess/handoff
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/handoff", "POST");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        if (!session.driver) return error("Session has no driver to hand off", 400);
        await clearDriver(sql, params.proj, params.sess);
        return json({ status: "open", session: params.sess });
      }

      // POST /projects/:proj/sessions/:sess/driver
      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/driver", "POST");
      if (params) {
        const session = await getSession(sql, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        if (session.driver) return error(`Session already has driver: ${session.driver}`, 409);
        const body = await jsonBody(req);
        const parsed = z.object({ driver: ParticipantIdSchema }).safeParse(body);
        if (!parsed.success) return error("Invalid body: driver is required", 400);
        await setDriver(sql, params.proj, params.sess, parsed.data.driver);
        return json({ status: "claimed", driver: parsed.data.driver, session: params.sess });
      }

      // GET /status
      if (method === "GET" && pathname === "/status") {
        return json({ ok: true, version: "0.0.1" });
      }

      return error("Not found", 404);
    },
  });

  return {
    server,
    sql,
    stop: async () => {
      server.stop(true);
      await sql.end();
    },
  };
}

// --- Run if executed directly ---
if (import.meta.main) {
  const { server } = await startServer();
  console.error(`Collab server listening on port ${server.port}`);
}
