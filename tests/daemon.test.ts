import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startDaemon } from "../src/daemon/daemon";
import { startServer } from "../src/service/server";
import type { Sql } from "../src/service/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris";

let daemonUrl: string;
let serviceUrl: string;
let sql: Sql;
let stopDaemon: () => void;
let stopService: () => Promise<void>;

beforeAll(async () => {
  // Start cloud service
  const s = await startServer({ port: 0, databaseUrl: DATABASE_URL });
  sql = s.sql;
  stopService = s.stop;
  serviceUrl = `http://localhost:${s.server.port}`;

  // Start daemon pointed at the cloud service
  process.env.POLARIS_SERVICE_URL = serviceUrl;
  const d = startDaemon(0);
  stopDaemon = d.stop;
  daemonUrl = `http://127.0.0.1:${d.server.port}`;
});

afterAll(async () => {
  stopDaemon();
  await stopService();
});

beforeEach(async () => {
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (name TEXT NOT NULL, project TEXT NOT NULL REFERENCES projects(name), driver TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (project, name))`;
  await sql`CREATE TABLE IF NOT EXISTS events (id UUID PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL, source TEXT NOT NULL, sender TEXT NOT NULL, payload JSONB NOT NULL)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_project ON events(project, timestamp)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_session ON events(project, session, timestamp)`;
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

describe("daemon /register", () => {
  test("registers a CC session", async () => {
    const res = await post(daemonUrl, "/register", { ccSessionId: "cc-1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("registered");
  });

  test("rejects missing ccSessionId", async () => {
    const res = await post(daemonUrl, "/register", {});
    expect(res.status).toBe(400);
  });
});

describe("daemon /connect", () => {
  test("connects a CC session to a polaris project/session", async () => {
    const res = await post(daemonUrl, "/connect", {
      ccSessionId: "cc-2",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("connected");
    expect(body.project).toBe("pj");

    // Verify project and session were created on cloud
    const projRes = await get(serviceUrl, "/projects/pj");
    expect(projRes.status).toBe(200);

    const sessRes = await get(serviceUrl, "/projects/pj/sessions/fxm");
    expect(sessRes.status).toBe(200);
    const sess = await sessRes.json();
    expect(sess.driver).toBe("user:manu");
  });

  test("rejects missing fields", async () => {
    const res = await post(daemonUrl, "/connect", { ccSessionId: "cc-3" });
    expect(res.status).toBe(400);
  });

  test("connecting twice switches sessions", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-4",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const res = await post(daemonUrl, "/connect", {
      ccSessionId: "cc-4",
      project: "pj",
      session: "fxk",
      user: "user:manu",
    });
    expect(res.status).toBe(200);

    const status = await get(daemonUrl, "/status/cc-4");
    const body = await status.json();
    expect(body.session).toBe("fxk");
  });
});

describe("daemon /disconnect", () => {
  test("disconnects a CC session", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-5",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const res = await post(daemonUrl, "/disconnect", { ccSessionId: "cc-5" });
    expect(res.status).toBe(200);

    const status = await get(daemonUrl, "/status/cc-5");
    const body = await status.json();
    expect(body.connected).toBe(false);
  });
});

describe("daemon /events (hook relay)", () => {
  test("relays hook events to cloud service", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-6",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const res = await post(daemonUrl, "/events", {
      session_id: "cc-6",
      hook_event_name: "UserPromptSubmit",
      prompt: "build auth middleware",
    });
    expect(res.status).toBe(200);

    // Verify event reached cloud
    const messages = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const body = await messages.json();
    expect(body).toHaveLength(1);
    expect(body[0].payload.prompt).toBe("build auth middleware");
  });

  test("discards events for unconnected sessions", async () => {
    const res = await post(daemonUrl, "/events", {
      session_id: "cc-unknown",
      hook_event_name: "UserPromptSubmit",
      prompt: "hello",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("not_connected");
  });
});

describe("daemon /status", () => {
  test("returns session-specific status", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-7",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const res = await get(daemonUrl, "/status/cc-7");
    const body = await res.json();
    expect(body.connected).toBe(true);
    expect(body.project).toBe("pj");
    expect(body.session).toBe("fxm");
    expect(body.user).toBe("user:manu");
  });

  test("returns not connected for unknown session", async () => {
    const res = await get(daemonUrl, "/status/cc-nonexistent");
    const body = await res.json();
    expect(body.connected).toBe(false);
  });

  test("returns daemon health with all active sessions", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-8a",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-8b",
      project: "pj",
      session: "fxk",
      user: "user:krishna",
    });

    const res = await get(daemonUrl, "/status");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);
  });
});
