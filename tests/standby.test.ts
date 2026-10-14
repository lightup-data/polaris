import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startDaemon } from "../src/daemon/daemon";
import { startServer } from "../src/service/server";
import type { Sql } from "../src/service/db";
import { resetTestData } from "./helpers";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

let daemonUrl: string;
let sql: Sql;
let stopDaemon: () => void;
let stopService: () => Promise<void>;

// Unique suffix per test to prevent in-memory state (channelPushQueues,
// standbyWaiters, sessions) from bleeding across tests. The daemon map is
// never cleared between tests, so each test must use distinct identifiers.
let testSeq = 0;
function uid() { return `t${++testSeq}`; }

beforeAll(async () => {
  const s = await startServer({ port: 0, databaseUrl: DATABASE_URL });
  sql = s.sql;
  stopService = s.stop;
  const serviceUrl = `http://localhost:${s.server.port}`;

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

async function post(path: string, body: unknown) {
  return fetch(`${daemonUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string, timeoutMs = 5000) {
  return fetch(`${daemonUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
}

/** Connect two sessions in an isolated project; returns the IDs used. */
async function connectTwo() {
  const id = uid();
  const proj = `bedrock-${id}`;
  const mainId = `main-${id}`;
  const subId = `sub-${id}`;

  await post("/connect", { ccSessionId: mainId, project: proj, session: "main", user: "user:alice", create: true });
  await post("/connect", { ccSessionId: subId,  project: proj, session: "sub",  user: "user:bob" });
  return { mainId, subId, proj };
}

// ---------------------------------------------------------------------------
// /send
// ---------------------------------------------------------------------------

describe("daemon /send", () => {
  test("rejects when sender is not connected", async () => {
    const res = await post("/send", { ccSessionId: `nobody-${uid()}`, targetSession: "sub", message: "hello" });
    expect(res.status).toBe(400);
  });

  test("rejects when target session is not connected in the project", async () => {
    const { mainId } = await connectTwo();
    const res = await post("/send", { ccSessionId: mainId, targetSession: "nobody", message: "hello" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("not connected");
  });

  test("returns delivered status with from/to", async () => {
    const { mainId } = await connectTwo();
    const res = await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "release port 3000" });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; from: string; to: string };
    expect(body.status).toBe("delivered");
    expect(body.from).toBe("main");
    expect(body.to).toBe("sub");
  });

  test("delivers message to channel push queue when no standby waiter", async () => {
    const { mainId, proj } = await connectTwo();
    await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "release port 3000" });

    const drain = await get(`/channel-push/${proj}/sub`);
    const body = await drain.json() as { pushes: Array<{ from: string; content: string }> };
    expect(body.pushes).toHaveLength(1);
    expect(body.pushes[0].from).toBe(`${proj}/main`);
    expect(body.pushes[0].content).toBe("release port 3000");
  });

  test("rejects missing fields", async () => {
    const res = await post("/send", { ccSessionId: `x-${uid()}` });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// /channel-push drain endpoint
// ---------------------------------------------------------------------------

describe("daemon /channel-push", () => {
  test("returns empty array when no pushes queued for this session", async () => {
    // Use a unique project that has never received a push
    const id = uid();
    await post("/connect", { ccSessionId: `sole-${id}`, project: `solo-${id}`, session: "main", user: "user:alice", create: true });
    const res = await get(`/channel-push/solo-${id}/main`);
    expect(res.status).toBe(200);
    const body = await res.json() as { pushes: unknown[] };
    expect(body.pushes).toHaveLength(0);
  });

  test("drains all pending pushes and clears the queue", async () => {
    const { mainId, proj } = await connectTwo();
    await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "msg-1" });
    await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "msg-2" });

    const first = await get(`/channel-push/${proj}/sub`);
    const firstBody = await first.json() as { pushes: Array<{ content: string }> };
    expect(firstBody.pushes).toHaveLength(2);
    expect(firstBody.pushes.map((p) => p.content)).toEqual(["msg-1", "msg-2"]);

    // Second drain should be empty — queue was cleared
    const second = await get(`/channel-push/${proj}/sub`);
    const secondBody = await second.json() as { pushes: unknown[] };
    expect(secondBody.pushes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// /standby long-poll
// ---------------------------------------------------------------------------

describe("daemon /standby", () => {
  test("returns 400 when session not connected", async () => {
    const res = await get(`/standby/nobody-${uid()}?timeout=1`);
    expect(res.status).toBe(400);
  });

  test("returns immediately with already-queued pushes", async () => {
    const { mainId, subId, proj } = await connectTwo();

    // Queue a push before entering standby
    await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "queued already" });

    const res = await get(`/standby/${subId}?timeout=5`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; pushes: Array<{ content: string }> };
    expect(body.status).toBe("message");
    expect(body.pushes).toHaveLength(1);
    expect(body.pushes[0].content).toBe("queued already");
  });

  test("wakes immediately when polaris_send delivers while in standby", async () => {
    const { mainId, subId } = await connectTwo();

    // Start standby, then send a message after a short delay
    const standbyPromise = get(`/standby/${subId}?timeout=10`, 15_000);
    const sendPromise = (async () => {
      await Bun.sleep(200);
      await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "wake up!" });
    })();

    const [res] = await Promise.all([standbyPromise, sendPromise]);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; pushes: Array<{ from: string; content: string }> };
    expect(body.status).toBe("message");
    expect(body.pushes).toHaveLength(1);
    expect(body.pushes[0].content).toBe("wake up!");
  });

  test("returns timeout status when no message arrives within the window", async () => {
    const id = uid();
    await post("/connect", { ccSessionId: `lone-${id}`, project: `solo-${id}`, session: "main", user: "user:alice", create: true });

    const start = Date.now();
    const res = await get(`/standby/lone-${id}?timeout=1`, 10_000);
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; pushes: unknown[] };
    expect(body.status).toBe("timeout");
    expect(body.pushes).toHaveLength(0);
    // Should have waited approximately 1 second (allow wide window for CI)
    expect(elapsed).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(4000);
  });

  test("send bypasses channel push queue when standby waiter is registered", async () => {
    const { mainId, subId, proj } = await connectTwo();

    // Register standby, then send — the message should go directly to the waiter
    const standbyPromise = get(`/standby/${subId}?timeout=10`, 15_000);
    await Bun.sleep(150); // give standby time to register
    await post("/send", { ccSessionId: mainId, targetSession: "sub", message: "direct wake" });

    const res = await standbyPromise;
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; pushes: Array<{ content: string }> };
    expect(body.status).toBe("message");
    expect(body.pushes[0].content).toBe("direct wake");

    // Channel push queue must be empty — message bypassed it
    const drain = await get(`/channel-push/${proj}/sub`);
    const drainBody = await drain.json() as { pushes: unknown[] };
    expect(drainBody.pushes).toHaveLength(0);
  });
});
