import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startDaemon, checkLiveness, findOwner, processTable, setProcessTableSource } from "../src/daemon/daemon";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/service/server";
import type { Sql } from "../src/service/db";
import { resetTestData, waitForMessages } from "./helpers";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

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
      create: true,
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
      create: true,
    });

    const res = await post(daemonUrl, "/connect", {
      ccSessionId: "cc-4",
      project: "pj",
      session: "fxk",
      user: "user:manu",
      create: true,
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
      create: true,
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
      create: true,
    });

    const res = await post(daemonUrl, "/events", {
      session_id: "cc-6",
      hook_event_name: "UserPromptSubmit",
      prompt: "build auth middleware",
    });
    expect(res.status).toBe(200);

    // Verify event reached cloud
    const body = await waitForMessages(`${serviceUrl}/projects/pj/sessions/fxm/messages`, 1);
    expect(body).toHaveLength(1);
    expect(body[0].payload.prompt).toBe("build auth middleware");
  });

  test("discards events when no sessions are connected", async () => {
    await post(daemonUrl, "/disconnect-all", {});
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
      create: true,
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
      create: true,
    });
    await post(daemonUrl, "/connect", {
      ccSessionId: "cc-8b",
      project: "pj",
      session: "fxk",
      user: "user:krishna",
      create: true,
    });

    const res = await get(daemonUrl, "/status");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("daemon session liveness", () => {
  const listed = async (id: string) =>
    ((await (await get(daemonUrl, "/status")).json()) as { sessions: Array<{ ccSessionId: string; dormant: boolean; wsState: string }> })
      .sessions.find((s) => s.ccSessionId === id);
  // Mirrors Claude Code 2.1: hook → bg-spare → bg-pty-host → claude daemon → claude (session) → shell
  const START = "Mon Nov 2 10:00:00 2026";
  const tree = (ownerStart: string | null) => {
    const t = new Map<number, { ppid: number; start: string; args: string }>([
      [9104, { ppid: 9103, start: START, args: "/bin/sh /home/u/.polaris/hooks/capture.sh" }],
      [9103, { ppid: 9102, start: START, args: "claude bg-spare --bg-spare /tmp/x.sock" }],
      [9102, { ppid: 9101, start: START, args: "claude bg-pty-host --bg-pty-host /tmp/y" }],
      [9101, { ppid: 9000, start: START, args: "/opt/claude-code/claude daemon run --origin transient" }],
      [10, { ppid: 1, start: START, args: "-zsh" }],
    ]);
    if (ownerStart) t.set(9000, { ppid: 10, start: ownerStart, args: "/opt/claude-code/claude --resume abc" });
    return t;
  };
  const hook = (session_id: string, extra: Record<string, unknown> = {}) =>
    fetch(`${daemonUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-polaris-hook-pid": "9104" },
      body: JSON.stringify({ session_id, ...extra }),
    });

  test("findOwner walks past Claude Code's helper processes to the session process", () => {
    expect(findOwner(9104, tree(START))).toEqual({ pid: 9000, start: START });
    expect(findOwner(10, tree(START))).toBeNull(); // no Claude process above a plain shell
  });

  test("owner alive keeps the session live (no timer); owner gone or pid reused → dormant; next event wakes it", async () => {
    setProcessTableSource(() => tree(START));
    await post(daemonUrl, "/connect", { ccSessionId: "cc-own", project: "pj", session: "own1", user: "user:manu", create: true });
    await hook("cc-own", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    checkLiveness(tree(START));
    expect((await listed("cc-own"))?.dormant).toBe(false);
    checkLiveness(tree("Tue Nov 3 09:00:00 2026")); // same pid, different process
    expect((await listed("cc-own"))?.dormant).toBe(true);
    await hook("cc-own", { hook_event_name: "SessionStart", source: "resume" });
    expect((await listed("cc-own"))?.dormant).toBe(false);
    checkLiveness(tree(null)); // owner exited
    expect((await listed("cc-own"))?.dormant).toBe(true);
    setProcessTableSource(processTable);
  });

  test("SessionEnd → dormant; the waking prompt carries messages sent while dormant", async () => {
    await post(daemonUrl, "/connect", { ccSessionId: "cc-wake", project: "pj", session: "wake1", user: "user:manu", create: true });
    await post(daemonUrl, "/events", { session_id: "cc-wake", hook_event_name: "UserPromptSubmit", prompt: "first" });
    await waitForMessages(`${serviceUrl}/projects/pj/sessions/wake1/messages`, 1);
    await new Promise((r) => setTimeout(r, 100)); // delivery checkpoint written

    expect((await (await post(daemonUrl, "/events", { session_id: "cc-wake", hook_event_name: "SessionEnd", reason: "exit" })).json()).status).toBe("ended");
    expect((await listed("cc-wake"))?.wsState).toBe("NONE");
    await post(serviceUrl, "/projects/pj/sessions/wake1/inject", { content: "sent while you were away", sender: "user:krishna" });

    const res = await post(daemonUrl, "/events", { session_id: "cc-wake", hook_event_name: "UserPromptSubmit", prompt: "back" });
    const body = await res.json() as { pendingInjects?: Array<{ content: string }> };
    expect(body.pendingInjects?.map((i) => i.content)).toContain("sent while you were away");
  });

  test("a dormant session is forgotten only once its transcript is gone", async () => {
    const transcript = join(tmpdir(), `polaris-transcript-${Date.now()}.jsonl`);
    await writeFile(transcript, "{}\n");
    await post(daemonUrl, "/connect", { ccSessionId: "cc-gone", project: "pj", session: "gone1", user: "user:manu", create: true });
    await post(daemonUrl, "/events", { session_id: "cc-gone", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, transcript_path: transcript });
    await post(daemonUrl, "/events", { session_id: "cc-gone", hook_event_name: "SessionEnd" });
    checkLiveness(tree(START));
    expect(await listed("cc-gone")).toBeDefined(); // dormant but resumable
    await rm(transcript);
    checkLiveness(tree(START));
    expect(await listed("cc-gone")).toBeUndefined();
  });
});
