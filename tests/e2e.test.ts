import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startServer } from "../src/service/server";
import { startDaemon } from "../src/daemon/daemon";
import type { Sql } from "../src/service/db";
import { resetTestData } from "./helpers";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

let serviceUrl: string;
let daemonUrl: string;
let sql: Sql;
let stopService: () => Promise<void>;
let stopDaemon: () => void;

beforeAll(async () => {
  const s = await startServer({ port: 0, databaseUrl: DATABASE_URL });
  sql = s.sql;
  stopService = s.stop;
  serviceUrl = `http://localhost:${s.server.port}`;

  process.env.POLARIS_SERVICE_URL = serviceUrl;
  process.env.POLARIS_AUTH_TOKEN = "";
  const d = startDaemon(0);
  stopDaemon = d.stop;
  daemonUrl = `http://127.0.0.1:${d.server.port}`;
});

afterAll(async () => {
  stopDaemon();
  await stopService();
});

beforeEach(async () => {
  await resetTestData(sql);
});

async function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(base: string, path: string) {
  return fetch(`${base}${path}`);
}

// --- Full stack: daemon + cloud service + hooks + WebSocket ---

describe("e2e: two drivers on same project", () => {
  test("connect two sessions, events route independently", async () => {
    // Manu connects to pj/fxm
    const manuRes = await post(daemonUrl, "/connect", {
      ccSessionId: "cc-manu",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });
    expect(manuRes.status).toBe(200);

    // Krishna connects to pj/fxk
    const krishnaRes = await post(daemonUrl, "/connect", {
      ccSessionId: "cc-krishna",
      project: "pj",
      session: "fxk",
      user: "user:krishna",
    });
    expect(krishnaRes.status).toBe(200);

    // Both send hook events
    await post(daemonUrl, "/events", {
      session_id: "cc-manu",
      hook_event_name: "UserPromptSubmit",
      prompt: "build the auth middleware",
    });
    await post(daemonUrl, "/events", {
      session_id: "cc-krishna",
      hook_event_name: "UserPromptSubmit",
      prompt: "set up the database schema",
    });

    // Verify isolation: fxm only has Manu's event
    const fxmRes = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const fxmBody = await fxmRes.json();
    expect(fxmBody).toHaveLength(1);
    expect(fxmBody[0].sender).toBe("user:manu");
    expect(fxmBody[0].payload.prompt).toBe("build the auth middleware");

    // Verify isolation: fxk only has Krishna's event
    const fxkRes = await get(serviceUrl, "/projects/pj/sessions/fxk/messages");
    const fxkBody = await fxkRes.json();
    expect(fxkBody).toHaveLength(1);
    expect(fxkBody[0].sender).toBe("user:krishna");
    expect(fxkBody[0].payload.prompt).toBe("set up the database schema");

    // Project-level view has both
    const projRes = await get(serviceUrl, "/projects/pj/messages");
    const projBody = await projRes.json();
    expect(projBody).toHaveLength(2);
  });
});

describe("e2e: advisor injection", () => {
  test("advisor message reaches the target session only", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-manu",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-krishna",
      project: "pj",
      session: "fxk",
      user: "user:krishna",
    });

    // Priya advises fxk only
    await post(serviceUrl, "/projects/pj/sessions/fxk/inject", {
      content: "Remember GDPR compliance on the users table",
      sender: "user:priya",
    });

    // fxk has the advisory message
    const fxkRes = await get(serviceUrl, "/projects/pj/sessions/fxk/messages");
    const fxkBody = await fxkRes.json();
    expect(fxkBody).toHaveLength(1);
    expect(fxkBody[0].source).toBe("inject");
    expect(fxkBody[0].payload.content).toBe("Remember GDPR compliance on the users table");

    // fxm does not
    const fxmRes = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const fxmBody = await fxmRes.json();
    expect(fxmBody).toHaveLength(0);
  });

  test("advisor injection broadcasts via WebSocket", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-ws",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    // Subscribe to session-level WS
    const wsUrl = serviceUrl.replace("http", "ws");
    const ws = new WebSocket(`${wsUrl}/projects/pj/sessions/fxm/ws`);
    const received: unknown[] = [];
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    ws.onmessage = (e) => received.push(JSON.parse(e.data as string));

    // Inject
    await post(serviceUrl, "/projects/pj/sessions/fxm/inject", {
      content: "Use RS256 for JWT",
      sender: "user:krishna",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect((received[0] as { source: string }).source).toBe("inject");
    expect((received[0] as { payload: { content: string } }).payload.content).toBe("Use RS256 for JWT");
    ws.close();
  });
});

describe("e2e: project-level WebSocket", () => {
  test("receives events from all sessions", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-proj-a",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-proj-b",
      project: "pj",
      session: "fxk",
      user: "user:krishna",
    });

    // Subscribe to project-level WS
    const wsUrl = serviceUrl.replace("http", "ws");
    const ws = new WebSocket(`${wsUrl}/projects/pj/ws`);
    const received: unknown[] = [];
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    ws.onmessage = (e) => received.push(JSON.parse(e.data as string));

    // Events from both sessions
    await post(daemonUrl, "/events", {
      session_id: "cc-proj-a",
      hook_event_name: "UserPromptSubmit",
      prompt: "from fxm",
    });
    await post(daemonUrl, "/events", {
      session_id: "cc-proj-b",
      hook_event_name: "UserPromptSubmit",
      prompt: "from fxk",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(2);
    const sessions = (received as Array<{ session: string }>).map((e) => e.session).sort();
    expect(sessions).toEqual(["fxk", "fxm"]);
    ws.close();
  });
});

describe("e2e: handoff", () => {
  test("driver releases, new driver claims, log is continuous", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-handoff-manu",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    // Manu works
    await post(daemonUrl, "/events", {
      session_id: "cc-handoff-manu",
      hook_event_name: "UserPromptSubmit",
      prompt: "build auth middleware",
    });

    // Manu hands off
    const handoffRes = await post(serviceUrl, "/projects/pj/sessions/fxm/handoff", {});
    expect(handoffRes.status).toBe(200);

    // Verify session is open
    const sessRes = await get(serviceUrl, "/projects/pj/sessions/fxm");
    const sessBody = await sessRes.json();
    expect(sessBody.driver).toBeNull();

    // Krishna claims
    const claimRes = await post(serviceUrl, "/projects/pj/sessions/fxm/driver", {
      driver: "user:krishna",
    });
    expect(claimRes.status).toBe(200);

    // Krishna connects via daemon
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-handoff-krishna",
      project: "pj",
      session: "fxm",
      user: "user:krishna",
    });

    // Krishna works
    await post(daemonUrl, "/events", {
      session_id: "cc-handoff-krishna",
      hook_event_name: "UserPromptSubmit",
      prompt: "add token refresh endpoint",
    });

    // Full log shows continuous history
    const messages = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const body = await messages.json();
    expect(body).toHaveLength(2);
    expect(body[0].sender).toBe("user:manu");
    expect(body[0].payload.prompt).toBe("build auth middleware");
    expect(body[1].sender).toBe("user:krishna");
    expect(body[1].payload.prompt).toBe("add token refresh endpoint");
  });
});

describe("e2e: status line", () => {
  test("returns connected state per CC session", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-status-1",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const connRes = await get(daemonUrl, "/status/cc-status-1");
    const connBody = await connRes.json();
    expect(connBody.connected).toBe(true);
    expect(connBody.project).toBe("pj");
    expect(connBody.session).toBe("fxm");
    expect(connBody.user).toBe("user:manu");

    const unknownRes = await get(daemonUrl, "/status/cc-nobody");
    const unknownBody = await unknownRes.json();
    expect(unknownBody.connected).toBe(false);
  });

  test("reflects disconnect", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-status-2",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    await post(daemonUrl, "/disconnect", { ccSessionId: "cc-status-2" });

    const res = await get(daemonUrl, "/status/cc-status-2");
    const body = await res.json();
    expect(body.connected).toBe(false);
  });
});

describe("e2e: capture.sh through daemon", () => {
  test("hook script relays to correct session via daemon", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-capture",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const hookPayload = JSON.stringify({
      session_id: "cc-capture",
      hook_event_name: "Stop",
      stop_response: "Auth middleware is ready",
    });

    const proc = Bun.spawn(["sh", "hooks/capture.sh"], {
      stdin: "pipe",
      env: { ...process.env, POLARIS_PORT: String(new URL(daemonUrl).port) },
    });
    proc.stdin.write(hookPayload);
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    await new Promise((r) => setTimeout(r, 200));

    const res = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].payload.stop_response).toBe("Auth middleware is ready");
    expect(body[0].sender).toBe("agent:claude"); // Stop events are sent by the agent
  });

  test("hook script exits 0 when daemon is down", async () => {
    const proc = Bun.spawn(["sh", "hooks/capture.sh"], {
      stdin: "pipe",
      env: { ...process.env, POLARIS_PORT: "59999" },
    });
    proc.stdin.write('{"session_id":"x","hook_event_name":"Stop","stop_response":"test"}');
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("hook events for unconnected sessions are silently discarded", async () => {
    await post(daemonUrl, "/disconnect-all", {});
    const res = await post(daemonUrl, "/events", {
      session_id: "cc-nobody",
      hook_event_name: "UserPromptSubmit",
      prompt: "this should go nowhere",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("not_connected");
  });
});

describe("e2e: session switching", () => {
  test("same CC session can switch polaris sessions", async () => {
    // Connect to fxm first
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-switch",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    await post(daemonUrl, "/events", {
      session_id: "cc-switch",
      hook_event_name: "UserPromptSubmit",
      prompt: "working on fxm",
    });

    // Switch to fxk
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-switch",
      project: "pj",
      session: "fxk",
      user: "user:manu",
    });

    await post(daemonUrl, "/events", {
      session_id: "cc-switch",
      hook_event_name: "UserPromptSubmit",
      prompt: "now working on fxk",
    });

    // Verify events went to correct sessions
    const fxmRes = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const fxmBody = await fxmRes.json();
    expect(fxmBody).toHaveLength(1);
    expect(fxmBody[0].payload.prompt).toBe("working on fxm");

    const fxkRes = await get(serviceUrl, "/projects/pj/sessions/fxk/messages");
    const fxkBody = await fxkRes.json();
    expect(fxkBody).toHaveLength(1);
    expect(fxkBody[0].payload.prompt).toBe("now working on fxk");

    // Status reflects the new session
    const statusRes = await get(daemonUrl, "/status/cc-switch");
    const statusBody = await statusRes.json();
    expect(statusBody.session).toBe("fxk");
  });
});
