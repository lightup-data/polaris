import { describe, expect, test } from "bun:test";
import { findOwner, ownerAlive, processTable, watchOwner, type Proc } from "../src/claude-process";

describe("claude-process", () => {
  test("ownerAlive: this test process matches its own start time; a different start time doesn't", () => {
    const me = processTable()?.get(process.pid);
    expect(me).toBeDefined();
    expect(ownerAlive({ pid: process.pid, start: me!.start })).toBe(true);
    expect(ownerAlive({ pid: process.pid, start: "Thu Jan 1 00:00:00 1970" })).toBe(false); // pid reused
    expect(ownerAlive({ pid: 2 ** 22 + 7, start: me!.start })).toBe(false); // no such process
  });

  test("watchOwner fires once when the owner goes away, not before", async () => {
    let alive = true;
    let gone = 0;
    watchOwner({ pid: 1, start: "x" }, () => gone++, { intervalMs: 10, isAlive: () => alive });
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(0);
    alive = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(1);
  });

  test("MCP server under npm exec resolves to the session's claude process", () => {
    const t = new Map<number, Proc>([
      [300, { ppid: 200, start: "a", args: "bun /home/u/.polaris/mcp/node_modules/@lightupai/polaris/src/client/client.ts" }],
      [200, { ppid: 100, start: "a", args: "npm exec bun /home/u/.polaris/mcp/node_modules/@lightupai/polaris/src/client/client.ts" }],
      [100, { ppid: 1, start: "b", args: "claude --resume prelight" }],
    ]);
    expect(findOwner(300, t)).toEqual({ pid: 100, start: "b" });
    t.set(200, { ppid: 1, start: "a", args: "npm exec bun client.ts" }); // orphaned: claude is gone
    expect(findOwner(300, t)).toBeNull();
  });
});

describe("owner detection across Claude Code surfaces", () => {
  test("desktop app: executable path with spaces, stream-json flags", () => {
    const exe = "/Users/u/Library/Application Support/Claude/claude-code/2.1.260/claude.app/Contents/MacOS/claude";
    const t = new Map<number, Proc>([
      [30, { ppid: 20, start: "a", args: "bun /Users/u/.polaris/mcp/node_modules/@lightupai/polaris/src/client/client.ts", comm: "bun" }],
      [20, { ppid: 10, start: "a", args: "bash /Users/u/.polaris/mcp/node_modules/.bin/polaris-mcp", comm: "/bin/bash" }],
      [10, { ppid: 5, start: "s", args: `${exe} --output-format stream-json --verbose`, comm: exe }],
      [5, { ppid: 1, start: "a", args: "/Applications/Claude.app/Contents/MacOS/Claude", comm: "/Applications/Claude.app/Contents/MacOS/Claude" }],
    ]);
    expect(findOwner(30, t)).toEqual({ pid: 10, start: "s" });
  });

  test("helpers are skipped by their retitled name; a daemon orphaned from its session yields none", () => {
    const t = new Map<number, Proc>([
      [40, { ppid: 41, start: "a", args: "/bin/sh hook.sh", comm: "/bin/sh" }],
      [41, { ppid: 42, start: "a", args: "claude bg-spare --bg-spare /tmp/x", comm: "claude bg-spare" }],
      [42, { ppid: 43, start: "a", args: "claude bg-pty-host --bg-pty-host /tmp/y", comm: "claude bg-pty-host" }],
      [43, { ppid: 1, start: "a", args: "/opt/claude-code/2.1.309/claude daemon run --origin transient", comm: "/opt/claude-code/2.1.309/claude" }],
    ]);
    expect(findOwner(40, t)).toBeNull();
  });

  test("terminal session found by executable path", () => {
    const t = new Map<number, Proc>([
      [50, { ppid: 51, start: "a", args: "bun client.ts", comm: "bun" }],
      [51, { ppid: 1, start: "s", args: "/opt/homebrew/Caskroom/claude-code/2.1.309/claude --resume prelight", comm: "/opt/homebrew/Caskroom/claude-code/2.1.309/claude" }],
    ]);
    expect(findOwner(50, t)).toEqual({ pid: 51, start: "s" });
  });
});
