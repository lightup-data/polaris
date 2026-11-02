import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Best-effort coverage of the `polaris recover` contract: read ~/.polaris/logs/*.jsonl,
// re-POST events missing upstream, print a scanned/missing/restored summary, and —
// crucially — never throw. The CLI runs as a subprocess with an isolated HOME so the
// real ~/.polaris is untouched. Until the cli agent's command is integrated, the
// tests detect its absence in src/cli/cli.ts and skip with a warning.

const CLI_PATH = join(import.meta.dir, "..", "src", "cli", "cli.ts");

let hasRecover = false;
try {
  hasRecover = /\brecover\b/.test(await readFile(CLI_PATH, "utf-8"));
} catch {
  // CLI missing entirely — skip.
}
if (!hasRecover) {
  console.warn("[recover.test] `polaris recover` not implemented yet — skipping (expected before cli-agent integration)");
}

const homes: string[] = [];

afterAll(async () => {
  for (const home of homes) {
    try { await rm(home, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

async function runRecover(
  jsonlLines: string[] | null,
  opts: { config?: unknown; logDate?: string; args?: string[]; history?: unknown[]; files?: Record<string, string> } = {}
): Promise<{ exitCode: number; output: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "polaris-recover-"));
  homes.push(home);
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const p = join(home, ".polaris", rel);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, content);
  }
  if (jsonlLines !== null) {
    const logDir = join(home, ".polaris", "logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, `daemon-${opts.logDate ?? "2026-06-01"}.jsonl`), jsonlLines.join("\n") + "\n");
  }
  if (opts.config) {
    await mkdir(join(home, ".polaris"), { recursive: true });
    await writeFile(join(home, ".polaris", "config.json"), JSON.stringify(opts.config));
  }
  if (opts.history) {
    await mkdir(join(home, ".polaris"), { recursive: true });
    await writeFile(join(home, ".polaris", "session-history.jsonl"), opts.history.map((h) => JSON.stringify(h)).join("\n") + "\n");
  }
  const env = { ...(process.env as Record<string, string>) };
  const proc = Bun.spawn([process.execPath, CLI_PATH, "recover", ...(opts.args ?? [])], {
    env: {
      ...env,
      HOME: home,
      POLARIS_HOME: join(home, ".polaris"),
      // Unreachable API: recover is best-effort and must still exit cleanly.
      POLARIS_SERVICE_URL: "http://127.0.0.1:9",
      POLARIS_AUTH_TOKEN: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr, home };
}

describe("polaris recover", () => {
  test.skipIf(!hasRecover)("exits cleanly with no logs present", async () => {
    const { exitCode } = await runRecover(null);
    expect(exitCode).toBe(0);
  }, 30000);

  test.skipIf(!hasRecover)("never throws on mixed/malformed log lines and an unreachable API", async () => {
    const { exitCode, output } = await runRecover([
      JSON.stringify({
        t: "2026-06-01T10:00:00.000Z",
        endpoint: "/events",
        payload: { session_id: "cc-r1", hook_event_name: "UserPromptSubmit", prompt: "recover me" },
      }),
      "this line is not json {{{",
      JSON.stringify({ t: "2026-06-01T10:01:00.000Z", endpoint: "/reply", payload: { ccSessionId: "cc-r1", message: "done" } }),
    ]);
    expect(exitCode).toBe(0);
    // Contract: print a summary (scanned / missing / restored). Soft-check only —
    // exact wording belongs to the cli agent.
    if (!/scan|missing|restor|recover/i.test(output)) {
      console.warn("[recover.test] no recognizable summary in output:", output.slice(0, 200));
    }
  }, 30000);
});

// Fake API: only project "real" exists. Failure modes are switchable per test.
type UpstreamEvent = { id: string; timestamp: string; payload: Record<string, unknown> };
const api = {
  projectsStatus: 200,
  messagesStatus: 200, // status for paginated event reads
  upstream: [] as UpstreamEvent[], // newest-first, like the server
  pageRequests: 0,
  posts: [] as string[],
  renames: [] as unknown[],
  missingSessions: [] as string[], // GET .../sessions/<name>/events → 404
};
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "GET" && path === "/projects") {
      return api.projectsStatus === 200 ? Response.json([{ name: "real" }]) : new Response("bad gateway", { status: api.projectsStatus });
    }
    if (req.method === "GET" && path === "/renames") return Response.json(api.renames);
    // The unpaginated full-history read can OOM prod — recover must never call it.
    if (path.endsWith("/messages")) return new Response("unpaginated read not allowed", { status: 500 });
    if (req.method === "GET" && path.endsWith("/events")) {
      if (!path.startsWith("/projects/real/")) return new Response("not found", { status: 404 });
      if (api.missingSessions.some((n) => path.includes(`/sessions/${n}/`))) return new Response("Session not found", { status: 404 });
      if (api.messagesStatus !== 200) return new Response("bad gateway", { status: api.messagesStatus });
      const limit = Number(url.searchParams.get("limit"));
      if (!(limit >= 1 && limit <= 500)) return new Response("limit required (1-500)", { status: 400 });
      api.pageRequests++;
      const before = url.searchParams.get("before");
      const start = before ? api.upstream.findIndex((e) => `${e.timestamp}|${e.id}` === before) + 1 : 0;
      const events = api.upstream.slice(start, start + limit);
      const last = events[events.length - 1];
      return Response.json({ events, nextCursor: events.length === limit && last ? `${last.timestamp}|${last.id}` : null });
    }
    if (req.method === "POST" && path.endsWith("/events")) {
      api.posts.push(path);
      return Response.json({ id: crypto.randomUUID(), timestamp: new Date().toISOString() }, { status: 201 });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => fake.stop(true));

const config = {
  active: "t",
  profiles: {
    t: { api: `http://127.0.0.1:${fake.port}`, app: "", token: "x.e30.x", email: "t@example.com", name: "t", org_id: "o", participant_id: "user:t" },
  },
};

function sessionLog(ccSessionId: string, project: string, session: string, prompts: string[]): string[] {
  return [
    JSON.stringify({ t: "2026-11-01T10:00:00.000Z", endpoint: "/connect", payload: { ccSessionId, project, session, user: "user:t", profile: "t" } }),
    ...prompts.map((prompt, i) => JSON.stringify({
      t: `2026-11-01T10:0${i + 1}:00.000Z`,
      endpoint: "/events",
      project, session, ccSessionId,
      payload: { session_id: ccSessionId, hook_event_name: "UserPromptSubmit", prompt },
    })),
  ];
}

const mixedLog = [
  ...sessionLog("cc-real", "real", "s1", ["a", "b"]),
  ...sessionLog("cc-junk1", "ir-junk-1", "main", ["x"]),
  ...sessionLog("cc-junk2", "pj", "fxm", ["y", "z"]),
];

describe("polaris recover: projects not on the server", () => {
  test("skips projects missing upstream and restores the rest", async () => {
    Object.assign(api, { projectsStatus: 200, messagesStatus: 200, posts: [] });
    const { exitCode, output } = await runRecover(mixedLog, { config, logDate: "2026-11-01" });
    expect(exitCode).toBe(0);
    expect(api.posts).toEqual(["/projects/real/sessions/s1/events", "/projects/real/sessions/s1/events"]);
    expect(output).toContain("Skipped 3 event(s) for 2 project(s) not on the server: ir-junk-1, pj");
    expect(output).toContain("2 restored");
  }, 30000);

  test("dry run lists only projects that exist upstream", async () => {
    Object.assign(api, { projectsStatus: 200, messagesStatus: 200, posts: [] });
    const { output } = await runRecover(mixedLog, { config, logDate: "2026-11-01", args: ["--dry-run"] });
    expect(output).toContain("real/s1");
    expect(output).not.toContain("ir-junk-1/");
    expect(output).toContain("2 event(s) missing upstream would be restored.");
    expect(api.posts).toHaveLength(0);
  }, 30000);

  test("project list unavailable: skips that account instead of guessing", async () => {
    Object.assign(api, { projectsStatus: 502, messagesStatus: 200, posts: [] });
    const { exitCode, output } = await runRecover(mixedLog, { config, logDate: "2026-11-01" });
    expect(exitCode).toBe(0);
    expect(api.posts).toHaveLength(0);
    expect(output).toContain("couldn't list projects for t@example.com (HTTP 502)");
  }, 30000);

  test("untagged events route only inside a recorded connect window", async () => {
    Object.assign(api, { projectsStatus: 200, messagesStatus: 200, posts: [] });
    const untagged = (t: string, prompt: string) =>
      JSON.stringify({ t, endpoint: "/events", payload: { session_id: "cc-h", hook_event_name: "UserPromptSubmit", prompt } });
    const { output } = await runRecover([
      // A connect attempt to a different session that never completed — must not route anything
      JSON.stringify({ t: "2026-11-01T09:00:00.000Z", endpoint: "/connect", payload: { ccSessionId: "cc-h", project: "real", session: "wrong", user: "user:t" } }),
      untagged("2026-11-01T09:30:00.000Z", "before connect"),
      untagged("2026-11-01T10:30:00.000Z", "after connect"),
    ], {
      config,
      logDate: "2026-11-01",
      history: [{ t: "2026-11-01T10:00:00.000Z", action: "connect", ccSessionId: "cc-h", project: "real", session: "s1", user: "user:t", agent: "agent:claude" }],
    });
    expect(api.posts).toEqual(["/projects/real/sessions/s1/events"]);
    expect(output).toContain("1 event(s) with no recoverable project/session mapping");
  }, 30000);

  test("tool events already upstream are not re-posted despite JSONB key reordering", async () => {
    const toolLine = (t: string, kind: string, id: string | undefined, input: Record<string, unknown>) =>
      JSON.stringify({
        t, endpoint: "/events", project: "real", session: "s1", ccSessionId: "cc-real",
        payload: { session_id: "cc-real", hook_event_name: kind, tool_name: "Bash", tool_input: input, ...(id ? { tool_use_id: id } : {}) },
      });
    const local = [
      JSON.stringify({ t: "2026-11-01T10:00:00.000Z", endpoint: "/connect", payload: { ccSessionId: "cc-real", project: "real", session: "s1", user: "user:t", profile: "t" } }),
      toolLine("2026-11-01T10:01:00.000Z", "PreToolUse", "toolu_1", { command: "ls", description: "list" }),
      toolLine("2026-11-01T10:01:01.000Z", "PostToolUse", "toolu_1", { command: "ls", description: "list" }),
      toolLine("2026-11-01T10:02:00.000Z", "PreToolUse", undefined, { command: "pwd", description: "where" }),
    ];
    // Same events as the real server returns them: tool_use_id stripped by the payload
    // schema, and object keys reordered by Postgres JSONB
    const up = (ts: string, kind: string, _id: string | undefined, input: Record<string, unknown>): UpstreamEvent => ({
      id: crypto.randomUUID(), timestamp: ts,
      payload: { tool_input: input, tool_name: "Bash", hook_event_name: kind, session_id: "cc-real" },
    });
    Object.assign(api, {
      projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0,
      upstream: [
        up("2026-11-01T10:02:00.000Z", "PreToolUse", undefined, { description: "where", command: "pwd" }),
        up("2026-11-01T10:01:01.000Z", "PostToolUse", "toolu_1", { description: "list", command: "ls" }),
        up("2026-11-01T10:01:00.000Z", "PreToolUse", "toolu_1", { description: "list", command: "ls" }),
      ],
    });
    const { output } = await runRecover(local, { config, logDate: "2026-11-01" });
    expect(api.posts).toHaveLength(0);
    expect(output).toContain("0 missing upstream");
  }, 30000);

  test("a repeated identical tool call is restored when upstream has fewer copies", async () => {
    // Real hook payloads carry a unique tool_use_id, so the two runs are distinct locally
    const line = (t: string) => JSON.stringify({
      t, endpoint: "/events", project: "real", session: "s1", ccSessionId: "cc-real",
      payload: { session_id: "cc-real", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, tool_use_id: `toolu_${t}` },
    });
    Object.assign(api, {
      projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0,
      upstream: [{ id: crypto.randomUUID(), timestamp: "2026-11-01T10:01:00.000Z",
        payload: { tool_input: { command: "git status" }, tool_name: "Bash", hook_event_name: "PreToolUse", session_id: "cc-real" } }],
    });
    const { output } = await runRecover([
      JSON.stringify({ t: "2026-11-01T10:00:00.000Z", endpoint: "/connect", payload: { ccSessionId: "cc-real", project: "real", session: "s1", user: "user:t", profile: "t" } }),
      line("2026-11-01T10:01:00.000Z"),
      line("2026-11-01T10:05:00.000Z"),
    ], { config, logDate: "2026-11-01" });
    expect(api.posts).toEqual(["/projects/real/sessions/s1/events"]);
    expect(output).toContain("1 restored");
  }, 30000);

  test("pages through upstream to find already-present events", async () => {
    // 450 upstream events (3 pages of 200); the local prompt "a" is the oldest, on the last page.
    const filler = Array.from({ length: 449 }, (_, i): UpstreamEvent => ({
      id: crypto.randomUUID(),
      timestamp: new Date(Date.parse("2026-11-01T10:00:30.000Z") + (449 - i) * 1000).toISOString(),
      payload: { session_id: "cc-real", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { n: i } },
    }));
    const a: UpstreamEvent = {
      id: crypto.randomUUID(),
      timestamp: "2026-11-01T10:01:00.000Z",
      payload: { session_id: "cc-real", hook_event_name: "UserPromptSubmit", prompt: "a" },
    };
    Object.assign(api, { projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, upstream: [...filler, a] });
    const { output } = await runRecover(sessionLog("cc-real", "real", "s1", ["a", "b"]), { config, logDate: "2026-11-01" });
    expect(api.pageRequests).toBe(3);
    expect(api.posts).toEqual(["/projects/real/sessions/s1/events"]); // only "b"
    expect(output).toContain("1 restored");
  }, 30000);

  test("stops paging once upstream is older than every local event", async () => {
    // 1000 upstream events from a day earlier: the first page already predates local events
    // by more than the skew margin, so recover must not read the rest of the history.
    const old = Array.from({ length: 1000 }, (_, i): UpstreamEvent => ({
      id: crypto.randomUUID(),
      timestamp: new Date(Date.parse("2026-10-31T10:00:00.000Z") - i * 1000).toISOString(),
      payload: { session_id: "old", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { n: i } },
    }));
    Object.assign(api, { projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, upstream: old });
    await runRecover(sessionLog("cc-real", "real", "s1", ["a", "b"]), { config, logDate: "2026-11-01" });
    expect(api.pageRequests).toBe(1);
    expect(api.posts).toHaveLength(2);
  }, 30000);

  test("upstream messages unreadable: never blindly re-POSTs (would duplicate)", async () => {
    Object.assign(api, { projectsStatus: 200, messagesStatus: 502, posts: [] });
    const { exitCode, output } = await runRecover(mixedLog, { config, logDate: "2026-11-01" });
    expect(exitCode).toBe(0);
    expect(api.posts).toHaveLength(0);
    expect(output).toContain("couldn't check upstream (HTTP 502)");
  }, 30000);
});

describe("polaris recover: watermarks and safety rules", () => {
  const today = new Date().toISOString().slice(0, 10);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const connect = JSON.stringify({ t: ago(600), endpoint: "/connect", payload: { ccSessionId: "cc-w", project: "real", session: "s1", user: "user:t", profile: "t" } });
  const prompt = (t: string, text: string) => JSON.stringify({
    t, endpoint: "/events", project: "real", session: "s1", ccSessionId: "cc-w",
    payload: { session_id: "cc-w", hook_event_name: "UserPromptSubmit", prompt: text },
  });
  const reset = (over: Partial<typeof api> = {}) =>
    Object.assign(api, { projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, upstream: [], ...over });
  const readState = async (home: string) =>
    JSON.parse(await readFile(join(home, ".polaris", "reconcile-state.json"), "utf-8").catch(() => "{}")) as Record<string, string>;

  test("leaves events from the last few minutes to the live relay, and records a watermark", async () => {
    reset();
    const { home } = await runRecover([connect, prompt(ago(30), "settled"), prompt(ago(1), "in flight")], { config, logDate: today });
    expect(api.posts).toHaveLength(1);
    const wm = Date.parse((await readState(home))["real/s1"]);
    expect(Math.abs(wm - (Date.now() - 5 * 60_000))).toBeLessThan(60_000);
  }, 30000);

  test("--reconcile only checks events after the watermark; a manual run checks everything", async () => {
    const lines = [connect, prompt(ago(180), "before watermark"), prompt(ago(30), "after watermark")];
    const files = { "reconcile-state.json": JSON.stringify({ "real/s1": ago(60) }) };
    reset();
    await runRecover(lines, { config, logDate: today, args: ["--reconcile"], files });
    expect(api.posts).toHaveLength(1);
    reset();
    await runRecover(lines, { config, logDate: today, files });
    expect(api.posts).toHaveLength(2);
  }, 30000);

  test("skips sessions with events still queued in the outbox and doesn't advance them", async () => {
    reset();
    const { output, home } = await runRecover([connect, prompt(ago(30), "x")], {
      config, logDate: today,
      files: { "outbox/1-abc.json": JSON.stringify({ t: ago(20), project: "real", session: "s1", profile: "t", body: {} }) },
    });
    expect(api.posts).toHaveLength(0);
    expect(output).toContain("still queued in the outbox");
    expect((await readState(home))["real/s1"]).toBeUndefined();
  }, 30000);

  test("a failed upstream check does not advance the watermark", async () => {
    reset({ messagesStatus: 502 });
    const before = ago(60);
    const { home } = await runRecover([connect, prompt(ago(30), "x")], {
      config, logDate: today, args: ["--reconcile"], files: { "reconcile-state.json": JSON.stringify({ "real/s1": before }) },
    });
    expect(api.posts).toHaveLength(0);
    expect((await readState(home))["real/s1"]).toBe(before);
  }, 30000);

  test("refuses to run while another recover holds the lock", async () => {
    reset();
    const { output } = await runRecover([connect, prompt(ago(30), "x")], {
      config, logDate: today, files: { "reconcile.lock": String(process.pid) }, // this test runner: alive
    });
    expect(api.posts).toHaveLength(0);
    expect(output).toContain("already running");
  }, 30000);

  test("a stale lock from a dead process is taken over", async () => {
    reset();
    await runRecover([connect, prompt(ago(30), "x")], { config, logDate: today, files: { "reconcile.lock": "999999" } });
    expect(api.posts).toHaveLength(1);
  }, 30000);
});

describe("polaris recover: renames", () => {
  test("events logged under old project/session names go to the current names", async () => {
    const line = (t: string, prompt: string) => JSON.stringify({
      t, endpoint: "/events", project: "oldproj", session: "s-old", ccSessionId: "cc-r",
      payload: { session_id: "cc-r", hook_event_name: "UserPromptSubmit", prompt },
    });
    Object.assign(api, {
      projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, upstream: [],
      renames: [
        { kind: "session", project: "real", old_name: "s-old", new_name: "s1", renamed_at: "2026-11-01T12:00:00.000Z" },
        { kind: "project", project: "real", old_name: "oldproj", new_name: "real", renamed_at: "2026-11-01T13:00:00.000Z" },
      ],
    });
    const { output } = await runRecover([
      JSON.stringify({ t: "2026-11-01T10:00:00.000Z", endpoint: "/connect", payload: { ccSessionId: "cc-r", project: "oldproj", session: "s-old", user: "user:t", profile: "t" } }),
      line("2026-11-01T10:01:00.000Z", "a"),
      line("2026-11-01T10:02:00.000Z", "b"),
    ], { config, logDate: "2026-11-01" });
    api.renames = [];
    expect(api.posts).toEqual(["/projects/real/sessions/s1/events", "/projects/real/sessions/s1/events"]);
    expect(output).toContain("Resolved 2 event(s) logged under since-renamed");
    expect(output).not.toContain("not on the server");
  }, 30000);
});

describe("polaris recover: dry run and late renames", () => {
  const line = (t: string, session: string, prompt: string) => JSON.stringify({
    t, endpoint: "/events", project: "real", session, ccSessionId: "cc-d",
    payload: { session_id: "cc-d", hook_event_name: "UserPromptSubmit", prompt },
  });
  const connect = (session: string) =>
    JSON.stringify({ t: "2026-11-01T10:00:00.000Z", endpoint: "/connect", payload: { ccSessionId: "cc-d", project: "real", session, user: "user:t", profile: "t" } });

  test("dry run reports only what is actually missing upstream, and posts nothing", async () => {
    Object.assign(api, {
      projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, renames: [], missingSessions: [],
      upstream: [{ id: crypto.randomUUID(), timestamp: "2026-11-01T10:01:00.000Z", payload: { session_id: "cc-d", hook_event_name: "UserPromptSubmit", prompt: "a" } }],
    });
    const { output } = await runRecover([connect("s1"), line("2026-11-01T10:01:00.000Z", "s1", "a"), line("2026-11-01T10:02:00.000Z", "s1", "b")],
      { config, logDate: "2026-11-01", args: ["--dry-run"] });
    expect(output).toContain("1 missing (of 2 logged)");
    expect(output).toContain("1 event(s) missing upstream would be restored.");
    expect(api.posts).toHaveLength(0);
  }, 30000);

  test("events logged under an old session name after the rename follow it when the old name is gone", async () => {
    Object.assign(api, {
      projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, upstream: [],
      renames: [{ kind: "session", project: "real", old_name: "s-old", new_name: "s1", renamed_at: "2026-11-01T09:00:00.000Z" }],
      missingSessions: ["s-old"],
    });
    // Captured at 10:01, an hour after the rename, but still tagged with the old name
    const { output } = await runRecover([connect("s-old"), line("2026-11-01T10:01:00.000Z", "s-old", "late")], { config, logDate: "2026-11-01" });
    Object.assign(api, { renames: [], missingSessions: [] });
    expect(api.posts).toEqual(["/projects/real/sessions/s1/events"]);
    expect(output).not.toContain("not found");
  }, 30000);

  test("a reused old name (still exists upstream) keeps its post-rename events", async () => {
    Object.assign(api, {
      projectsStatus: 200, messagesStatus: 200, posts: [], pageRequests: 0, upstream: [],
      renames: [{ kind: "session", project: "real", old_name: "s-old", new_name: "s1", renamed_at: "2026-11-01T09:00:00.000Z" }],
      missingSessions: [],
    });
    await runRecover([connect("s-old"), line("2026-11-01T10:01:00.000Z", "s-old", "new-life")], { config, logDate: "2026-11-01" });
    Object.assign(api, { renames: [] });
    expect(api.posts).toEqual(["/projects/real/sessions/s-old/events"]);
  }, 30000);
});
