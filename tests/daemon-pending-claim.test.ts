import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { startDaemon } from "../src/daemon/daemon";
import { startServer } from "../src/service/server";
import { resetTestData } from "./helpers";

// Incident: an unrelated Claude session's SessionEnd claimed another session's pending
// join and showed up as connected to its project. Joins must only bind to the session
// that made them.
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";
let daemonUrl: string;
let stopDaemon: () => void;
let stopService: () => Promise<void>;

beforeAll(async () => {
  const s = await startServer({ port: 0, databaseUrl: DATABASE_URL });
  stopService = s.stop;
  await resetTestData(s.sql);
  process.env.POLARIS_SERVICE_URL = `http://localhost:${s.server.port}`;
  process.env.POLARIS_AUTH_TOKEN = "";
  const d = startDaemon(0);
  stopDaemon = d.stop;
  daemonUrl = `http://127.0.0.1:${d.server.port}`;
  await fetch(`${daemonUrl}/disconnect-all`, { method: "POST" }); // module-level state
});
afterAll(async () => { stopDaemon(); await stopService(); });

const post = (path: string, body: unknown) =>
  fetch(`${daemonUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const status = async (id: string) => (await (await fetch(`${daemonUrl}/status/${id}`)).json()) as { connected: boolean; project?: string };

describe("pending joins only bind to the session that made them", () => {
  test("join with Claude's real session id is exact: another session can't claim it", async () => {
    await post("/connect", { ccSessionId: "real-A", claudeSessionId: true, project: "pa", user: "user:manu", create: true });
    const res = await post("/events", { session_id: "other-1", hook_event_name: "UserPromptSubmit", prompt: "unrelated" });
    expect((await res.json()).status).toBe("not_connected");
    expect((await status("other-1")).connected).toBe(false);
    expect((await status("real-A")).project).toBe("pa");
  });

  test("an exact-match event clears pending, so a later unrelated event can't claim it", async () => {
    await post("/connect", { ccSessionId: "same-B", project: "pb", user: "user:manu", create: true }); // no flag (older client)
    await post("/events", { session_id: "same-B", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} });
    await post("/events", { session_id: "other-2", hook_event_name: "UserPromptSubmit", prompt: "unrelated" });
    expect((await status("other-2")).connected).toBe(false);
  });

  test("SessionEnd / SessionStart from an unmapped session never claim a pending join", async () => {
    await post("/connect", { ccSessionId: "mcp-C", project: "pc", user: "user:manu", create: true }); // made-up id, pending
    for (const ev of ["SessionEnd", "SessionStart"]) {
      const res = await post("/events", { session_id: "other-3", hook_event_name: ev });
      expect((await res.json()).status).toBe("not_connected");
    }
    expect((await status("other-3")).connected).toBe(false);
    // The legacy fallback still works for the joining shell's real activity
    await post("/events", { session_id: "hook-C", hook_event_name: "UserPromptSubmit", prompt: "mine" });
    expect((await status("hook-C")).project).toBe("pc");
  });
});

describe("MCP server", () => {
  test("exits when its stdio is closed", async () => {
    const proc = Bun.spawn([process.execPath, `${import.meta.dir}/../src/client/client.ts`], {
      stdin: "pipe", stdout: "ignore", stderr: "ignore",
      env: { ...process.env, POLARIS_DAEMON_URL: "http://127.0.0.1:9" },
    });
    await new Promise((r) => setTimeout(r, 1500));
    proc.stdin.end();
    const code = await Promise.race([proc.exited, new Promise<string>((r) => setTimeout(() => r("still running"), 5000))]);
    if (code === "still running") proc.kill();
    expect(code).toBe(0);
  }, 15000);
});
