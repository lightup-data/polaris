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
  getEventById,
  getProjectEvents,
  getSessionEvents,
  getSessionEventsPage,
  getEventsSince,
  searchEvents,
  setSessionLabel,
  addAnnotation,
  listSessionAnnotations,
  listDecisions,
  deleteAnnotation,
  setProjectVisibility,
  addProjectMember,
  removeProjectMember,
  listProjectMembers,
  userCanAccessProject,
  type Sql,
} from "./db";
import { verifyToken, assertSecretConfigured, type TokenPayload } from "./auth";
import type { PolarisEvent, ParticipantId } from "../types";
import { AnnotationKind, HookPayload, ParticipantId as ParticipantIdSchema } from "../types";

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

// --- Realtime backbone: LISTEN/NOTIFY de-dup ---
// Events broadcast inline by a POST handler record their id here so the echoed NOTIFY
// (delivered via the LISTEN connection) is skipped. Module-level so in-process test
// servers share one de-dup horizon.
const recentlyBroadcast = new Map<string, number>(); // event id -> recorded-at ms
const RECENTLY_BROADCAST_TTL_MS = 30_000;

function markBroadcast(id: string) {
  const now = Date.now();
  recentlyBroadcast.set(id, now);
  for (const [k, ts] of recentlyBroadcast) {
    if (now - ts > RECENTLY_BROADCAST_TTL_MS) recentlyBroadcast.delete(k);
  }
}

// --- Rate limiting (tiny in-memory fixed window; lenient by design) ---

const RATE_WINDOW_MS = 60_000;
const INJECT_LIMIT_PER_WINDOW = 60; // per token (or per IP when anonymous)
const WRITE_LIMIT_PER_WINDOW = 600;
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

function rateLimited(key: string, limit: number): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(key, bucket);
    if (rateBuckets.size > 10_000) {
      for (const [k, b] of rateBuckets) {
        if (now - b.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(k);
      }
    }
  }
  bucket.count++;
  return bucket.count > limit;
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

async function authOrgId(req: Request, defaultOrgId: string): Promise<{ orgId: string; participantId: string | null } | Response> {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    const payload = await verifyToken(token);
    if (payload) return { orgId: payload.org_id, participantId: payload.participant_id };
  }
  // No/invalid token: fall back to the default org outside production
  if (process.env.NODE_ENV !== "production") {
    return { orgId: defaultOrgId, participantId: null };
  }
  return error("Unauthorized", 401);
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
  assertSecretConfigured();
  const sql = await createDb(opts.databaseUrl);
  const port = opts.port ?? Number(process.env.PORT ?? 4321);
  const defaultOrgId = opts.defaultOrgId ?? "default";

  // Ensure default org exists for backward compat (tests, daemon without auth)
  try {
    await createOrg(sql, defaultOrgId, "Default", undefined);
  } catch {
    // Already exists
  }

  // One dedicated LISTEN connection per process. Delivers events not already broadcast
  // inline (e.g. bridge-origin Slack injects) to WS/SSE subscribers, and enables
  // multi-replica fan-out.
  await sql.listen("polaris_event", (id) => {
    if (!id || recentlyBroadcast.has(id)) return;
    markBroadcast(id);
    (async () => {
      const found = await getEventById(sql, id);
      if (!found) return;
      const { org_id: _orgId, ...event } = found;
      broadcastEvent(event);
      broadcastSse(event);
    })().catch((e) => {
      console.error("[server] polaris_event listener failed:", e);
    });
  });

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

      if (method === "GET" && pathname === "/status") {
        return json({ ok: true, version: "0.0.1" });
      }

      // Resolve org from auth token; falls back to default org outside production,
      // returns 401 in production without a valid token
      const a = await authOrgId(req, defaultOrgId);
      if (a instanceof Response) return a;
      const orgId = a.orgId;
      const participantId = a.participantId;

      // --- Rate limiting (write endpoints; per token, per IP when anonymous) ---
      if (method !== "GET") {
        const rateKey = participantId ?? `ip:${server.requestIP(req)?.address ?? "unknown"}`;
        const isInject = /^\/projects\/[^/]+\/sessions\/[^/]+\/inject$/.test(pathname);
        if (isInject) {
          if (rateLimited(`inject:${rateKey}`, INJECT_LIMIT_PER_WINDOW)) {
            return error("Rate limit exceeded: too many injects", 429);
          }
        } else if (rateLimited(`write:${rateKey}`, WRITE_LIMIT_PER_WINDOW)) {
          return error("Rate limit exceeded", 429);
        }
      }

      // --- Per-project ACL ---
      // 403 non-members on project-scoped endpoints. Anonymous callers (null participant,
      // dev/tests) and the ACL-admin endpoints (visibility/members) are exempt — so you
      // can still add members after flipping a project to 'members'.
      const aclMatch = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
      if (aclMatch && participantId) {
        const aclRest = aclMatch[2] ?? "";
        const isAclAdmin = aclRest === "/visibility" || aclRest === "/members" || aclRest.startsWith("/members/");
        if (!isAclAdmin && !(await userCanAccessProject(sql, orgId, aclMatch[1], participantId))) {
          return error("Forbidden: project is restricted to members", 403);
        }
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

      // --- Project ACL endpoints (visibility & members) ---

      params = matchRoute(method, pathname, "/projects/:proj/visibility", "POST");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const body = await jsonBody(req);
        const parsed = z.object({ visibility: z.enum(["org", "members"]) }).safeParse(body);
        if (!parsed.success) return error("Invalid body: visibility must be 'org' or 'members'", 400);
        await setProjectVisibility(sql, orgId, params.proj, parsed.data.visibility);
        return json({ ok: true, visibility: parsed.data.visibility });
      }

      params = matchRoute(method, pathname, "/projects/:proj/members", "POST");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({ participant_id: z.string().min(1), role: z.string().optional() })
          .safeParse(body);
        if (!parsed.success) return error("Invalid body: participant_id is required", 400);
        await addProjectMember(sql, orgId, params.proj, parsed.data.participant_id, parsed.data.role);
        return json({ ok: true });
      }

      params = matchRoute(method, pathname, "/projects/:proj/members", "GET");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        const members = await listProjectMembers(sql, orgId, params.proj);
        return json({ members });
      }

      params = matchRoute(method, pathname, "/projects/:proj/members/:pid", "DELETE");
      if (params) {
        const project = await getProject(sql, orgId, params.proj);
        if (!project) return error("Project not found", 404);
        // Participant ids contain ':' which clients often percent-encode in paths
        await removeProjectMember(sql, orgId, params.proj, decodeURIComponent(params.pid));
        return json({ ok: true });
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
        // Record before pushEvent so our own NOTIFY echo is de-duped (we broadcast inline below).
        markBroadcast(event.id);
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
        // Paginated event history when limit/before is present; SSE stream otherwise
        if (url.searchParams.has("limit") || url.searchParams.has("before")) {
          const limitParam = url.searchParams.get("limit");
          const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
          const limit = Number.isFinite(parsedLimit) ? parsedLimit : undefined;
          const before = url.searchParams.get("before") ?? undefined;
          const { events, nextCursor } = await getSessionEventsPage(sql, orgId, params.proj, params.sess, { limit, before });
          return json({ events, nextCursor });
        }
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
          .object({ content: z.string().min(1), sender: ParticipantIdSchema.optional() })
          .safeParse(body);
        if (!parsed.success) return error(`Invalid body: ${parsed.error.message}`, 400);
        // Authenticated callers always inject as themselves; anonymous (non-prod) callers must supply a sender
        const sender = participantId ?? parsed.data.sender;
        if (!sender) return error("Invalid body: sender is required", 400);
        const event: PolarisEvent = {
          id: crypto.randomUUID(),
          project: params.proj,
          session: params.sess,
          timestamp: new Date().toISOString(),
          source: "inject",
          sender,
          payload: {
            type: "inject" as const,
            content: parsed.data.content,
            sender,
            target: params.sess,
          },
        };
        // Record before pushEvent so our own NOTIFY echo is de-duped (we broadcast inline below).
        markBroadcast(event.id);
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

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/label", "POST");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const body = await jsonBody(req);
        const parsed = z.object({ label: z.string() }).safeParse(body);
        if (!parsed.success) return error("Invalid body: label is required", 400);
        await setSessionLabel(sql, orgId, params.proj, params.sess, parsed.data.label);
        return json({ ok: true });
      }

      // --- Annotations (curation: stars, tags, decisions) ---

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/annotations", "POST");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const body = await jsonBody(req);
        const parsed = z
          .object({
            event_id: z.string().uuid().optional(),
            kind: AnnotationKind,
            value: z.string().optional(),
          })
          .safeParse(body);
        if (!parsed.success) return error(`Invalid body: ${parsed.error.message}`, 400);
        const { id } = await addAnnotation(sql, orgId, {
          event_id: parsed.data.event_id ?? null,
          project: params.proj,
          session: params.sess,
          participant_id: participantId,
          kind: parsed.data.kind,
          value: parsed.data.value ?? null,
        });
        return json({ id }, 201);
      }

      params = matchRoute(method, pathname, "/projects/:proj/sessions/:sess/annotations", "GET");
      if (params) {
        const session = await getSession(sql, orgId, params.proj, params.sess);
        if (!session) return error("Session not found", 404);
        const annotations = await listSessionAnnotations(sql, orgId, params.proj, params.sess);
        return json({ annotations });
      }

      params = matchRoute(method, pathname, "/annotations/:id", "DELETE");
      if (params) {
        await deleteAnnotation(sql, orgId, params.id);
        return json({ ok: true });
      }

      if (method === "GET" && pathname === "/decisions") {
        const project = url.searchParams.get("project") ?? undefined;
        if (project && !(await userCanAccessProject(sql, orgId, project, participantId))) {
          return error("Forbidden: project is restricted to members", 403);
        }
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
        const decisions = await listDecisions(sql, orgId, {
          project,
          limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
          participantId,
        });
        return json({ decisions });
      }

      // --- Search ---

      if (method === "GET" && pathname === "/search") {
        const q = url.searchParams.get("q");
        if (!q || !q.trim()) return error("q is required", 400);
        const project = url.searchParams.get("project") ?? undefined;
        if (project && !(await userCanAccessProject(sql, orgId, project, participantId))) {
          return error("Forbidden: project is restricted to members", 403);
        }
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
        const { results } = await searchEvents(sql, orgId, {
          q,
          project,
          session: url.searchParams.get("session") ?? undefined,
          sender: url.searchParams.get("sender") ?? undefined,
          source: url.searchParams.get("source") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
          participantId,
        });
        return json({ results });
      }

      // GET /team — list org members with Slack identities
      if (method === "GET" && pathname === "/team") {
        const { listUsers, getOrg: getOrgFn } = await import("./db");
        const users = await listUsers(sql, orgId);
        const org = await getOrgFn(sql, orgId);

        // Resolve Slack user info if bot token available (paginate through all members)
        let slackMembers: Array<{ id: string; name: string; display_name: string; email: string; username: string }> = [];
        if (org?.slack_bot_token) {
          try {
            type SlackMember = { id: string; name: string; real_name?: string; profile?: { display_name?: string; email?: string }; deleted?: boolean; is_bot?: boolean };
            type SlackResponse = { ok?: boolean; members?: SlackMember[]; response_metadata?: { next_cursor?: string } };
            let cursor = "";
            do {
              const url = `https://slack.com/api/users.list?limit=200${cursor ? `&cursor=${cursor}` : ""}`;
              const slackRes = await fetch(url, {
                headers: { Authorization: `Bearer ${org.slack_bot_token}` },
              });
              if (!slackRes.ok) break;
              const slackData = (await slackRes.json()) as SlackResponse;
              for (const m of slackData.members ?? []) {
                if (m.deleted || m.is_bot) continue;
                slackMembers.push({
                  id: m.id,
                  name: m.real_name ?? "",
                  display_name: m.profile?.display_name ?? "",
                  email: m.profile?.email ?? "",
                  username: m.name ?? "",
                });
              }
              cursor = slackData.response_metadata?.next_cursor ?? "";
            } while (cursor);
          } catch { /* Slack API unavailable */ }
        }

        // Build team from ALL Slack workspace members, annotate with Polaris identity
        const matchedEmails = new Set<string>();
        const team = slackMembers.map((m) => {
          const polarisUser = users.find((u) => u.email.toLowerCase() === m.email.toLowerCase())
            ?? users.find((u) => u.name.toLowerCase() === m.name.toLowerCase());
          if (polarisUser) matchedEmails.add(polarisUser.email.toLowerCase());
          return {
            name: m.name || m.display_name || m.username,
            slack_id: m.id,
            slack_handle: m.username,
            slack_display: m.display_name || m.name,
            participant_id: polarisUser?.participant_id ?? null,
            polaris_user: !!polarisUser,
          };
        });

        // Add Polaris users not in Slack (e.g., synthetic test users)
        for (const u of users) {
          if (!matchedEmails.has(u.email.toLowerCase())) {
            team.push({
              name: u.name,
              slack_id: null,
              slack_handle: null,
              slack_display: null,
              participant_id: u.participant_id,
              polaris_user: true,
            });
          }
        }

        // Generate short aliases: prefer display_name, fall back to name, then handle
        // Filter out slackbot
        const filtered = team.filter((m) => m.slack_handle !== "slackbot");
        team.length = 0;
        team.push(...filtered);

        function deriveAlias(m: typeof team[0]): string {
          // Best source: display name (what the person chose)
          const displayName = m.slack_display?.trim();
          if (displayName) {
            const first = displayName.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
            if (first.length >= 2) return first;
          }
          // Next: real name, but skip short/initial-only first names
          const parts = m.name.split(/\s+/);
          for (const part of parts) {
            const clean = part.toLowerCase().replace(/[^a-z]/g, "");
            if (clean.length >= 2) return clean;
          }
          // Fall back to slack handle
          return m.slack_handle || "";
        }

        const aliasCounts = new Map<string, number>();
        for (const m of team) {
          const alias = deriveAlias(m);
          if (alias) aliasCounts.set(alias, (aliasCounts.get(alias) ?? 0) + 1);
        }
        for (const m of team) {
          const alias = deriveAlias(m);
          if (!alias) {
            (m as Record<string, unknown>).alias = null;
          } else if ((aliasCounts.get(alias) ?? 0) > 1) {
            // Collision — append first letter of last name or use handle
            const parts = m.name.split(/\s+/);
            const lastInitial = parts.length > 1 ? parts[parts.length - 1]?.[0]?.toLowerCase() ?? "" : "";
            (m as Record<string, unknown>).alias = lastInitial ? `${alias}${lastInitial}` : m.slack_handle || alias;
          } else {
            (m as Record<string, unknown>).alias = alias;
          }
        }

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
