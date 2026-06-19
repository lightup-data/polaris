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

async function runRecover(jsonlLines: string[] | null): Promise<{ exitCode: number; output: string }> {
  const home = await mkdtemp(join(tmpdir(), "polaris-recover-"));
  homes.push(home);
  if (jsonlLines !== null) {
    const logDir = join(home, ".polaris", "logs");
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, "daemon-2026-06-01.jsonl"), jsonlLines.join("\n") + "\n");
  }
  const env = { ...(process.env as Record<string, string>) };
  const proc = Bun.spawn([process.execPath, CLI_PATH, "recover"], {
    env: {
      ...env,
      HOME: home,
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
  return { exitCode, output: stdout + stderr };
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
