import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Not-connected status line must always say which account a join would use.
const SCRIPT = join(import.meta.dir, "..", "hooks", "statusline.sh");
let reply: unknown = {};
const stub = Bun.serve({ port: 0, fetch: () => Response.json(reply) });
afterAll(() => stub.stop(true));

async function render(opts: { reply?: unknown; port?: number; config?: unknown }) {
  const home = await mkdtemp(join(tmpdir(), "polaris-sl-"));
  if (opts.config) {
    await mkdir(join(home, ".polaris"), { recursive: true });
    await writeFile(join(home, ".polaris", "config.json"), JSON.stringify(opts.config));
  }
  reply = opts.reply ?? {};
  const proc = Bun.spawn(["sh", SCRIPT], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s1" })),
    env: { ...process.env, HOME: home, POLARIS_DAEMON_PORT: String(opts.port ?? stub.port), POLARIS_DAEMON_SECRET: "" },
    stdout: "pipe", stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).replace(/\x1b\[[0-9;]*m/g, "");
  await rm(home, { recursive: true, force: true });
  return out.trim();
}

describe("status line: account when not connected", () => {
  test("chosen with /polaris account", async () => {
    expect(await render({ reply: { connected: false, account: "me@home.com", accountSource: "selected" } }))
      .toStartWith("polaris: not connected · account: me@home.com");
  });
  test("nothing chosen → the default, labelled", async () => {
    expect(await render({ reply: { connected: false, account: "me@work.com", accountSource: "default" } }))
      .toStartWith("polaris: not connected · account: me@work.com (default)");
  });
  test("no account at all", async () => {
    expect(await render({ reply: { connected: false, account: null, accountSource: null } }))
      .toStartWith("polaris: not connected · no account — run: polaris login");
  });
  test("daemon unreachable → default read from config", async () => {
    const config = { active: "w", profiles: { w: { email: "me@work.com", api: "", token: "" } } };
    expect(await render({ port: 9, config })).toStartWith("polaris: not connected · account: me@work.com (default)");
  });
});
