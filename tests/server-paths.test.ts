import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const patterns = readFileSync(join(ROOT, ".github/server-paths.regex"), "utf-8").split("\n").filter(Boolean).map((p) => new RegExp(p));
const isServerPath = (f: string) => patterns.some((r) => r.test(f));

// CD skips the server deploy when no file matching .github/server-paths.regex changed.
// That's only safe if everything the server runs is covered — trace its imports.
describe("server path list covers everything the server runs", () => {
  test("every file imported by the api, web and bridge entrypoints is a server path", () => {
    const entries = ["src/service/server.ts", "src/web/serve.ts", "src/slack/bridge.ts", "src/bridge-discover-org.ts"];
    const seen = new Set<string>();
    const stack = [...entries];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const src = readFileSync(join(ROOT, f), "utf-8");
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const base = normalize(join(dirname(f), m[1])).replace(/\.js$/, "");
        const hit = [`${base}.ts`, `${base}.tsx`, base, `${base}/index.ts`].find((c) => existsSync(join(ROOT, c)) && !c.endsWith("/"));
        if (hit && !hit.endsWith(".css")) stack.push(relative(ROOT, join(ROOT, hit)));
      }
    }
    const uncovered = [...seen].filter((f) => !isServerPath(f));
    expect(uncovered).toEqual([]);
  });
});

describe("scripts/needs-server-deploy.sh", () => {
  async function repo() {
    const dir = await mkdtemp(join(tmpdir(), "polaris-plan-"));
    const sh = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    await mkdir(join(dir, "scripts"), { recursive: true });
    await mkdir(join(dir, ".github"), { recursive: true });
    await copyFile(join(ROOT, "scripts/needs-server-deploy.sh"), join(dir, "scripts/needs-server-deploy.sh"));
    await copyFile(join(ROOT, ".github/server-paths.regex"), join(dir, ".github/server-paths.regex"));
    await mkdir(join(dir, "src/cli"), { recursive: true });
    await mkdir(join(dir, "src/service"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.0.0", dependencies: { a: "1" } }, null, 2) + "\n");
    await writeFile(join(dir, "src/cli/cli.ts"), "1\n");
    await writeFile(join(dir, "src/service/server.ts"), "1\n");
    sh("git init -q && git add -A && git commit -qm base");
    const head = () => sh("git rev-parse HEAD").stdout.toString().trim();
    const plan = (from: string) => sh(`bash scripts/needs-server-deploy.sh '${from}' HEAD`).stdout.toString().trim();
    return { dir, sh, head, plan };
  }

  test("client-only change plus a version bump → no deploy", async () => {
    const r = await repo();
    const base = r.head();
    await writeFile(join(r.dir, "src/cli/cli.ts"), "2\n");
    await writeFile(join(r.dir, "package.json"), JSON.stringify({ version: "1.0.1", dependencies: { a: "1" } }, null, 2) + "\n");
    r.sh("git commit -qam client");
    expect(r.plan(base)).toBe("false");
    await rm(r.dir, { recursive: true, force: true });
  });

  test("server file change → deploy", async () => {
    const r = await repo();
    const base = r.head();
    await writeFile(join(r.dir, "src/service/server.ts"), "2\n");
    r.sh("git commit -qam server");
    expect(r.plan(base)).toBe("true");
    await rm(r.dir, { recursive: true, force: true });
  });

  test("dependency change → deploy", async () => {
    const r = await repo();
    const base = r.head();
    await writeFile(join(r.dir, "package.json"), JSON.stringify({ version: "1.0.0", dependencies: { a: "2" } }, null, 2) + "\n");
    r.sh("git commit -qam deps");
    expect(r.plan(base)).toBe("true");
    await rm(r.dir, { recursive: true, force: true });
  });

  test("unknown deployed commit → deploy", async () => {
    const r = await repo();
    expect(r.plan("deadbeef")).toBe("true");
    expect(r.plan("")).toBe("true");
    await rm(r.dir, { recursive: true, force: true });
  });
});
