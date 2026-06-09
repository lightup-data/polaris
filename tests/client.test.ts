import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startServer } from "../src/service/server";
import { startDaemon } from "../src/daemon/daemon";
import type { Sql } from "../src/service/db";

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
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql`CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, domain TEXT, slack_team_id TEXT, slack_bot_token TEXT, slack_system_channel_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), participant_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS projects (name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), slack_channel_id TEXT, slack_channel_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, name))`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (name TEXT NOT NULL, project TEXT NOT NULL, org_id TEXT NOT NULL, driver TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, project, name), FOREIGN KEY (org_id, project) REFERENCES projects(org_id, name))`;
  await sql`CREATE TABLE IF NOT EXISTS events (id UUID PRIMARY KEY, org_id TEXT NOT NULL, project TEXT NOT NULL, session TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL, source TEXT NOT NULL, sender TEXT NOT NULL, payload JSONB NOT NULL)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_project ON events(org_id, project, timestamp)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_session ON events(org_id, project, session, timestamp)`;
  await sql`INSERT INTO orgs (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING`;
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

describe("end-to-end: daemon + cloud service", () => {
  test("connect → hook event → appears in cloud", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "e2e-1",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    await post(daemonUrl, "/events", {
      session_id: "e2e-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "build auth",
    });

    const res = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].payload.prompt).toBe("build auth");
    expect(body[0].sender).toBe("user:manu");
  });

  test("inject event reaches session WS via daemon", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "e2e-2",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const wsUrl = serviceUrl.replace("http", "ws");
    const ws = new WebSocket(`${wsUrl}/projects/pj/sessions/fxm/ws`);
    const received: unknown[] = [];
    await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
    ws.onmessage = (e) => received.push(JSON.parse(e.data as string));

    await post(serviceUrl, "/projects/pj/sessions/fxm/inject", {
      content: "Use RS256",
      sender: "user:krishna",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect((received[0] as { source: string }).source).toBe("inject");
    ws.close();
  });

  test("multiple sessions on same machine route independently", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "multi-1",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });
    await post(daemonUrl, "/connect", {
      ccSessionId: "multi-2",
      project: "pj",
      session: "fxk",
      user: "user:krishna",
    });

    await post(daemonUrl, "/events", {
      session_id: "multi-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "from fxm",
    });
    await post(daemonUrl, "/events", {
      session_id: "multi-2",
      hook_event_name: "UserPromptSubmit",
      prompt: "from fxk",
    });

    const fxmRes = await get(serviceUrl, "/projects/pj/sessions/fxm/messages");
    const fxmBody = await fxmRes.json();
    expect(fxmBody).toHaveLength(1);
    expect(fxmBody[0].payload.prompt).toBe("from fxm");
    expect(fxmBody[0].sender).toBe("user:manu");

    const fxkRes = await get(serviceUrl, "/projects/pj/sessions/fxk/messages");
    const fxkBody = await fxkRes.json();
    expect(fxkBody).toHaveLength(1);
    expect(fxkBody[0].payload.prompt).toBe("from fxk");
    expect(fxkBody[0].sender).toBe("user:krishna");
  });
});

describe("capture.sh with daemon", () => {
  test("script relays stdin to daemon", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "capture-1",
      project: "pj",
      session: "fxm",
      user: "user:manu",
    });

    const hookPayload = JSON.stringify({
      session_id: "capture-1",
      hook_event_name: "UserPromptSubmit",
      prompt: "test from capture.sh",
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
    expect(body[0].payload.prompt).toBe("test from capture.sh");
  });

  test("script exits 0 when daemon is down", async () => {
    const proc = Bun.spawn(["sh", "hooks/capture.sh"], {
      stdin: "pipe",
      env: { ...process.env, POLARIS_PORT: "59999" },
    });
    proc.stdin.write('{"session_id":"x","test":true}');
    proc.stdin.end();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
