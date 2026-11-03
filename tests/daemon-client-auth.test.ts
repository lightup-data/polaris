import { describe, expect, test, afterAll } from "bun:test";
import { daemonFetch, DaemonClient, DAEMON_AUTH_ERROR } from "../src/core/daemon-client";

// Incident: an MCP server started without POLARIS_DAEMON_SECRET got the daemon's
// bare {"error":"Unauthorized"} on every tool, which read as "your account isn't
// logged in". It must recover from config when it can, and say what's wrong when not.
const SECRET = "s3cret";
let calls = 0;
const stub = Bun.serve({
  port: 0,
  fetch(req) {
    calls++;
    return req.headers.get("x-polaris-daemon-secret") === SECRET ? Response.json({ ok: true }) : Response.json({ error: "Unauthorized" }, { status: 401 });
  },
});
afterAll(() => stub.stop(true));
const url = `http://127.0.0.1:${stub.port}/status`;

describe("daemonFetch", () => {
  test("missing secret: re-reads it (from config) and succeeds", async () => {
    calls = 0;
    const res = await daemonFetch(url, {}, () => null, () => SECRET);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("wrong secret that can't be fixed: a clear daemon-auth error, not 'Unauthorized'", async () => {
    const res = await daemonFetch(url, {}, () => "stale", () => "stale");
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe(DAEMON_AUTH_ERROR);
    expect(body.error).toContain("not your account login");
  });

  test("correct secret: one request, no retry", async () => {
    calls = 0;
    expect((await daemonFetch(url, {}, () => SECRET, () => SECRET)).status).toBe(200);
    expect(calls).toBe(1);
  });

  test("DaemonClient uses the same recovery", async () => {
    const c = new DaemonClient({ url: `http://127.0.0.1:${stub.port}`, secret: () => null, refreshSecret: () => SECRET });
    expect((await c.get("/status")).status).toBe(200);
  });
});
