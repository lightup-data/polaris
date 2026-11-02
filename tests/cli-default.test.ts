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
