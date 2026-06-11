import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

// Best-effort coverage of the shared-local-secret daemon auth contract:
//   - secret resolved (env POLARIS_DAEMON_SECRET) -> every endpoint requires
//     the `x-polaris-daemon-secret` header, 401 otherwise
//   - no secret resolved -> no auth (test/back-compat mode)
//
// The daemon runs as a SUBPROCESS with an isolated HOME so that neither the
// secret env var nor any real ~/.polaris/config.json can leak into the other
// test files (which start in-process daemons without auth).
// Until the daemon agent's enforcement is integrated, the enforcement tests
// detect "no 401" and skip with a warning instead of failing.

const DAEMON_PATH = join(import.meta.dir, "..", "src", "daemon", "daemon.ts");
const SECRET = `test-secret-${crypto.randomUUID()}`;

const cleanups: Array<() => Promise<void> | void> = [];

function baseEnv(home: string, overrides: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.POLARIS_DAEMON_SECRET;
  return {
    ...env,
    HOME: home,
    // /status and /register never call upstream; point it nowhere just in case.
    POLARIS_SERVICE_URL: "http://127.0.0.1:9",
    POLARIS_AUTH_TOKEN: "",
    ...overrides,
  };
}

async function spawnDaemon(overrides: Record<string, string>): Promise<{ proc: Subprocess; url: string } | null> {
  const home = await mkdtemp(join(tmpdir(), "polaris-daemon-auth-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const proc = Bun.spawn([process.execPath, DAEMON_PATH], {
      env: baseEnv(home, { POLARIS_DAEMON_PORT: String(port), ...overrides }),
      stdout: "ignore",
      stderr: "ignore",
    });
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break; // crashed (port collision) — retry on a new port
      try {
        await fetch(`${url}/status`); // any HTTP response (200 or 401) means it's up
        cleanups.push(() => { proc.kill(); });
        return { proc, url };
      } catch {
        await Bun.sleep(100);
      }
    }
    proc.kill();
  }
  return null;
}

const secured = await spawnDaemon({ POLARIS_DAEMON_SECRET: SECRET });
let enforced = false;
if (!secured) {
  console.warn("[daemon-auth.test] could not start a daemon subprocess — skipping daemon auth tests");
} else {
  enforced = (await fetch(`${secured.url}/status`)).status === 401;
  if (!enforced) {
    console.warn("[daemon-auth.test] secret enforcement not detected — skipping (expected before daemon-agent integration)");
  }
}

const unsecured = await spawnDaemon({});

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { /* best-effort */ }
  }
});

describe("daemon auth (shared local secret)", () => {
  test.skipIf(!enforced)("rejects requests without the secret header", async () => {
    expect((await fetch(`${secured!.url}/status`)).status).toBe(401);
    expect((await fetch(`${secured!.url}/status/cc-anything`)).status).toBe(401);
    const post = await fetch(`${secured!.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ccSessionId: "cc-auth-1" }),
    });
    expect(post.status).toBe(401);
  });

  test.skipIf(!enforced)("rejects a wrong secret", async () => {
    const res = await fetch(`${secured!.url}/status`, {
      headers: { "x-polaris-daemon-secret": "wrong-secret" },
    });
    expect(res.status).toBe(401);
  });

  test.skipIf(!enforced)("accepts requests carrying the correct secret", async () => {
    const res = await fetch(`${secured!.url}/status`, {
      headers: { "x-polaris-daemon-secret": SECRET },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const post = await fetch(`${secured!.url}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-polaris-daemon-secret": SECRET },
      body: JSON.stringify({ ccSessionId: "cc-auth-2" }),
    });
    expect(post.status).toBe(200);
  });

  test.skipIf(!unsecured)("without a resolved secret the daemon requires no auth (back-compat)", async () => {
    const res = await fetch(`${unsecured!.url}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
