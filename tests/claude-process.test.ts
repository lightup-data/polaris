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
