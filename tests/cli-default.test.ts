import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bare `polaris` must be read-only: it used to run install + login.
const CLI = join(import.meta.dir, "..", "src", "cli", "cli.ts");

async function run(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), "polaris-cli-"));
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, HOME: home, POLARIS_HOME: join(home, ".polaris"), POLARIS_SERVICE_URL: "http://127.0.0.1:9" },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const written = await readdir(home);
  await rm(home, { recursive: true, force: true });
  return { out: out + err, code, written };
}

describe("polaris CLI defaults", () => {
  test("bare `polaris` prints usage and changes nothing", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("polaris setup");
    expect(r.out).not.toContain("setting up your machine");
    // Nothing of Polaris's own (Bun may create its runtime cache under ~/Library)
    expect(r.written).not.toContain(".polaris");
    expect(r.written).not.toContain(".claude");
  }, 30000);

  test("`polaris version` prints the package version", async () => {
    const r = await run(["version"]);
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(r.out).toContain(pkg.version);
  }, 30000);

  test("unknown command fails instead of doing something", async () => {
    const r = await run(["instal"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Unknown command: instal");
  }, 30000);
});

describe("polaris accounts", () => {
  test("lists every account on the machine with its login state, without the daemon", async () => {
    const home = await mkdtemp(join(tmpdir(), "polaris-acct-"));
    const jwt = (expOffsetSec: number) => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSec })).toString("base64url")}.y`;
    await Bun.write(join(home, ".polaris", "config.json"), JSON.stringify({
      active: "work",
      profiles: {
        work: { email: "me@work.com", name: "Me", api: "https://api.example.com", token: jwt(10 * 86400) },
        dev: { email: "me@home.com", name: "Me", api: "http://localhost:4321", token: jwt(-86400) },
      },
    }));
    for (const cmd of ["accounts", "account", "profiles"]) {
      const proc = Bun.spawn([process.execPath, CLI, cmd], {
        env: { ...process.env, HOME: home, POLARIS_HOME: join(home, ".polaris") }, stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain("Accounts on this machine (2)");
      expect(out).toContain("me@work.com  ← default for new sessions");
      expect(out).toContain("login valid, expires in 10d");
      expect(out).toContain("login EXPIRED 24h ago — run: polaris login --local --profile dev");
    }
    await rm(home, { recursive: true, force: true });
  }, 30000);
});
