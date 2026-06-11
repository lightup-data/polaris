// APPROACH CHOSEN (per the tests contract): the daemon test harness (startDaemon +
// startServer) is usable exactly as in tests/daemon.test.ts, so this exercises the
// full /reply path rather than a db-level unit test. The contract under test:
// a daemon /reply must produce an event attributed to the session's AGENT identity
// (mapping.agent), not the human driver (mapping.user) — replies are authored by the
// agent on the user's behalf.
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
  // The daemon session registry is module-level state; clear any mappings left
  // behind by other test files so /reply routes only via our own ccSessionId.
  await post(daemonUrl, "/disconnect-all", {});
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

describe("daemon /reply attribution", () => {
  test("reply is attributed to the connected agent identity, not the user", async () => {
    const connectRes = await post(daemonUrl, "/connect", {
      ccSessionId: "cc-reply-attr",
      project: "pj-reply",
      session: "fx-reply",
      user: "user:manu",
      agent: "agent:replybot",
    });
    expect(connectRes.status).toBe(200);

    const replyRes = await post(daemonUrl, "/reply", {
      ccSessionId: "cc-reply-attr",
      message: "Deployed the fix to staging",
    });
    expect(replyRes.status).toBe(200);

    const messages = await get(serviceUrl, "/projects/pj-reply/sessions/fx-reply/messages");
    const body = await messages.json();
    expect(body).toHaveLength(1);
    expect(body[0].payload.stop_response).toBe("Deployed the fix to staging");
    expect(body[0].sender).toBe("agent:replybot"); // the agent identity from /connect
    expect(body[0].sender).not.toBe("user:manu"); // never the human driver
  });

  test("reply uses the default agent identity when none was given at connect", async () => {
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-reply-default",
      project: "pj-reply",
      session: "fx-reply-default",
      user: "user:krishna",
    });

    const replyRes = await post(daemonUrl, "/reply", {
      ccSessionId: "cc-reply-default",
      message: "Tests are green",
    });
    expect(replyRes.status).toBe(200);

    const messages = await get(serviceUrl, "/projects/pj-reply/sessions/fx-reply-default/messages");
    const body = await messages.json();
    expect(body).toHaveLength(1);
    expect(body[0].sender).toBe("agent:claude"); // daemon's default agent identity
    expect(body[0].sender).not.toBe("user:krishna");
  });
});
