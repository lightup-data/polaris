import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDaemon, pickToken } from "../src/daemon/daemon";
import { POLARIS_DIR } from "../src/paths";

// /polaris account: a session picks its account before joining. The daemon pairs the
// MCP request with the PreToolUse hook Claude Code sends first (which carries the real
// Claude session id), so the status line can show the choice before any join.

let daemonUrl: string;
let stop: () => void;
const configPath = join(POLARIS_DIR, "config.json");

beforeAll(async () => {
  await mkdir(POLARIS_DIR, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    active: "work",
    profiles: {
      work: { email: "me@work.com", api: "http://127.0.0.1:9", token: "" },
      personal: { email: "me@home.com", api: "http://127.0.0.1:9", token: "" },
    },
  }));
  process.env.POLARIS_SERVICE_URL = "http://127.0.0.1:9";
  const d = startDaemon(0);
  stop = d.stop;
  daemonUrl = `http://127.0.0.1:${d.server.port}`;
  // Session state is module-level: clear pending joins left by other test files,
  // which a hook event from an unjoined session would otherwise claim.
  await fetch(`${daemonUrl}/disconnect-all`, { method: "POST" });
});

afterAll(async () => {
  stop();
  await rm(configPath, { force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${daemonUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const status = async (id: string) => (await fetch(`${daemonUrl}/status/${id}`)).json() as Promise<{ connected: boolean; account: string | null }>;

describe("daemon /account", () => {
  test("binds the choice to the Claude session that called the tool, before any join", async () => {
    await post("/events", {
      session_id: "hook-A", hook_event_name: "PreToolUse",
      tool_name: "mcp__polaris__polaris_account", tool_input: { account: "me@home.com" },
    });
    const res = await post("/account", { ccSessionId: "mcp-A", account: "me@home.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profile: "personal", email: "me@home.com", paired: true });
    expect(await status("hook-A")).toMatchObject({ connected: false, account: "me@home.com" });
  });

  test("another session's choice doesn't leak into this one", async () => {
    await post("/events", {
      session_id: "hook-B", hook_event_name: "PreToolUse",
      tool_name: "mcp__polaris__polaris_account", tool_input: { account: "work" },
    });
    await post("/account", { ccSessionId: "mcp-B", account: "work" });
    expect((await status("hook-B")).account).toBe("me@work.com");
    expect((await status("hook-A")).account).toBe("me@home.com");
    expect((await status("hook-C")).account).toBeNull();
  });

  test("unknown account is rejected", async () => {
    const res = await post("/account", { ccSessionId: "mcp-X", account: "nobody@nowhere.com" });
    expect(res.status).toBe(404);
  });
});

describe("pickToken: never cross accounts", () => {
  const jwt = (email: string, expOffsetSec: number) =>
    `x.${btoa(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + expOffsetSec }))}.y`;
  const work = jwt("me@work.com", 3600);
  const workOld = jwt("me@work.com", -3600);
  const homeOld = jwt("me@home.com", -3600);
  const cfg = (profiles: Record<string, { email: string; token: string }>, active = "work") =>
    ({ active, profiles: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, { ...v, api: "" }])) });

  test("uses the session's own valid token", () => {
    expect(pickToken(cfg({ work: { email: "me@work.com", token: work }, home: { email: "me@home.com", token: jwt("me@home.com", 3600) } }), "home"))
      .not.toBe(work);
  });
  test("expired token, same account under another profile key: falls back to it", () => {
    expect(pickToken(cfg({ work: { email: "me@work.com", token: work }, "work-old": { email: "me@work.com", token: workOld } }), "work-old")).toBe(work);
  });
  test("expired token for a different account: no token, never the active account's", () => {
    expect(pickToken(cfg({ work: { email: "me@work.com", token: work }, home: { email: "me@home.com", token: homeOld } }), "home")).toBeNull();
  });
  test("legacy session with no profile uses the active account", () => {
    expect(pickToken(cfg({ work: { email: "me@work.com", token: work } }), "")).toBe(work);
  });
});

describe("daemon /channels", () => {
  test("unknown account is rejected instead of silently using the active one", async () => {
    const res = await fetch(`${daemonUrl}/channels?account=${encodeURIComponent("nobody@nowhere.com")}`);
    expect(res.status).toBe(404);
  });
});
