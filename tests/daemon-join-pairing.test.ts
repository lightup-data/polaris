import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startDaemon } from "../src/daemon/daemon";
import { startServer } from "../src/service/server";
import type { Sql } from "../src/service/db";
import { resetTestData, waitForMessages } from "./helpers";

// `/polaris join` must bind the MCP server's random id to the exact Claude Code session
// that called polaris_connect (its PreToolUse hook carries the real session id), not to
// whichever unmapped session sends the next hook event.

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";
let daemonUrl: string;
let serviceUrl: string;
let sql: Sql;
let stopDaemon: () => void;
let stopService: () => Promise<void>;

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

const post = (path: string, body: unknown) =>
  fetch(`${daemonUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  await resetTestData(sql);
  // Session state is module-level and shared across test files: clear pending joins
  await post("/disconnect-all", {});
});

const preToolUse = (hookId: string, channel: string) =>
  post("/events", { session_id: hookId, hook_event_name: "PreToolUse", tool_name: "mcp__polaris__polaris_connect", tool_input: { channel, user: "user:manu" } });
const prompt = (hookId: string, text: string) =>
  post("/events", { session_id: hookId, hook_event_name: "UserPromptSubmit", prompt: text });
const join = (mcpId: string, project: string) =>
  post("/connect", { ccSessionId: mcpId, project, session: "s1", user: "user:manu", create: true });

describe("join pairing", () => {
  test("two windows joining at once each land in their own project", async () => {
    // Claude B's tool call is noted first, but A's join reaches the daemon first, and A
    // prompts first. The old rule (next unmapped hook claims the most recent pending
    // join) would route A's prompt into B's project.
    await preToolUse("hook-B", "#proj-b");
    await preToolUse("hook-A", "#proj-a");
    expect((await join("mcp-A", "proj-a")).status).toBe(200);
    expect((await join("mcp-B", "proj-b")).status).toBe(200);
    await prompt("hook-A", "from A");
    await prompt("hook-B", "from B");

    const a = await waitForMessages(`${serviceUrl}/projects/proj-a/sessions/s1/messages`, 1);
    const b = await waitForMessages(`${serviceUrl}/projects/proj-b/sessions/s1/messages`, 1);
    expect(a.map((e) => e.payload.prompt)).toEqual(["from A"]);
    expect(b.map((e) => e.payload.prompt)).toEqual(["from B"]);
  });

  test("without a PreToolUse (e.g. CLI connect) the pending-claim fallback still works", async () => {
    expect((await join("mcp-C", "proj-c")).status).toBe(200);
    await prompt("hook-C", "from C");
    const c = await waitForMessages(`${serviceUrl}/projects/proj-c/sessions/s1/messages`, 1);
    expect(c.map((e) => e.payload.prompt)).toEqual(["from C"]);
  });
});
