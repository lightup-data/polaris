import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renewTokenIfExpiring, RENEW_WITHIN_MS } from "../src/service/auth";
import { startServer } from "../src/service/server";
import { startDaemon } from "../src/daemon/daemon";
import { POLARIS_DIR } from "../src/paths";

const SECRET = new TextEncoder().encode(process.env.POLARIS_JWT_SECRET ?? "polaris-dev-secret-change-in-prod");
const DAY = 86_400;
const sign = (expInSec: number, claims: Record<string, unknown> = {}) =>
  new jose.SignJWT({ email: "me@work.com", name: "Me", org_id: "org1", participant_id: "user:me", ...claims })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("polaris").setSubject("u1")
    .setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + expInSec).sign(SECRET);
const exp = (t: string) => (jose.decodeJwt(t).exp ?? 0) * 1000;

describe("renewTokenIfExpiring", () => {
  test("renews a valid token inside the window with the same claims and a full 30 days", async () => {
    const fresh = await renewTokenIfExpiring(await sign(3 * DAY));
    expect(fresh).not.toBeNull();
    const c = jose.decodeJwt(fresh!);
    expect([c.email, c.org_id, c.participant_id, c.sub]).toEqual(["me@work.com", "org1", "user:me", "u1"]);
    expect(exp(fresh!) - Date.now()).toBeGreaterThan(29 * DAY * 1000);
  });
  test("does not renew far from expiry, expired, or invalid tokens", async () => {
    expect(await renewTokenIfExpiring(await sign(RENEW_WITHIN_MS / 1000 + DAY))).toBeNull();
    expect(await renewTokenIfExpiring(await sign(-60))).toBeNull();
    expect(await renewTokenIfExpiring("not.a.token")).toBeNull();
    const forged = await new jose.SignJWT({ email: "x" }).setProtectedHeader({ alg: "HS256" }).setIssuer("polaris")
      .setExpirationTime(Math.floor(Date.now() / 1000) + DAY).sign(new TextEncoder().encode("wrong-secret"));
    expect(await renewTokenIfExpiring(forged)).toBeNull();
  });
});

describe("server returns renewed tokens", () => {
  let base: string; let stop: () => Promise<void>;
  beforeAll(async () => {
    const s = await startServer({ port: 0, databaseUrl: process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test" });
    base = `http://localhost:${s.server.port}`; stop = s.stop;
  });
  afterAll(async () => { await stop(); });
  test("near expiry → x-polaris-token on the response; far from expiry → none", async () => {
    const near = await fetch(`${base}/projects`, { headers: { Authorization: `Bearer ${await sign(2 * DAY)}` } });
    expect(near.headers.get("x-polaris-token")).toBeTruthy();
    const far = await fetch(`${base}/projects`, { headers: { Authorization: `Bearer ${await sign(20 * DAY)}` } });
    expect(far.headers.get("x-polaris-token")).toBeNull();
  });
});

describe("daemon adopts renewed tokens", () => {
  // Unsigned look-alikes are enough: the daemon only decodes (the server verifies)
  const fake = (expAt: number, email = "me@work.com") =>
    `h.${Buffer.from(JSON.stringify({ email, org_id: "org1", exp: expAt })).toString("base64url")}.s`;
  const now = Math.floor(Date.now() / 1000);
  const OLD = fake(now + 2 * DAY), NEW = fake(now + 30 * DAY);
  const OLD2 = fake(now + 2 * DAY + 1), OTHER = fake(now + 30 * DAY, "someone@else.com");
  const seen: string[] = [];
  let api: ReturnType<typeof Bun.serve>; let daemonUrl: string; let stopDaemon: () => void;
  const saved = { url: process.env.POLARIS_SERVICE_URL, token: process.env.POLARIS_AUTH_TOKEN };
  const configPath = join(POLARIS_DIR, "config.json");

  beforeAll(async () => {
    api = Bun.serve({
      port: 0,
      fetch(req) {
        const auth = req.headers.get("Authorization") ?? "";
        seen.push(auth.slice(7));
        const headers = auth === `Bearer ${OLD}` ? { "x-polaris-token": NEW }
          : auth === `Bearer ${OLD2}` ? { "x-polaris-token": OTHER } // wrong account
          : undefined;
        if (req.method === "POST" && req.url.endsWith("/events")) return Response.json({ id: crypto.randomUUID(), timestamp: new Date().toISOString() }, { status: 201, headers });
        return Response.json({ name: "pj" }, { headers });
      },
    });
    await mkdir(POLARIS_DIR, { recursive: true });
    await writeFile(configPath, JSON.stringify({ active: "work", profiles: { work: { email: "me@work.com", api: `http://127.0.0.1:${api.port}`, token: OLD } } }));
    process.env.POLARIS_SERVICE_URL = `http://127.0.0.1:${api.port}`;
    delete process.env.POLARIS_AUTH_TOKEN; // use the profile's token, not test mode
    const d = startDaemon(0); stopDaemon = d.stop; daemonUrl = `http://127.0.0.1:${d.server.port}`;
    await fetch(`${daemonUrl}/disconnect-all`, { method: "POST" });
  });
  afterAll(async () => {
    stopDaemon(); api.stop(true); await rm(configPath, { force: true });
    process.env.POLARIS_SERVICE_URL = saved.url;
    if (saved.token !== undefined) process.env.POLARIS_AUTH_TOKEN = saved.token;
  });

  test("a renewed token replaces the old one in config and is used from then on", async () => {
    const post = (path: string, body: unknown) => fetch(`${daemonUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/connect", { ccSessionId: "cc-ren", claudeSessionId: true, project: "pj", session: "s1", user: "user:me", profile: "work" });
    await post("/events", { session_id: "cc-ren", hook_event_name: "UserPromptSubmit", prompt: "one" });
    for (let i = 0; i < 50 && JSON.parse(await readFile(configPath, "utf-8")).profiles.work.token !== NEW; i++) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(await readFile(configPath, "utf-8")).profiles.work.token).toBe(NEW);
    seen.length = 0;
    await post("/events", { session_id: "cc-ren", hook_event_name: "UserPromptSubmit", prompt: "two" });
    for (let i = 0; i < 50 && !seen.includes(NEW); i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain(NEW);
    expect(seen).not.toContain(OLD);
  });

  test("a renewal for a different account is ignored", async () => {
    // Own profile key: "work" is already in the daemon's token cache from the previous test
    await writeFile(configPath, JSON.stringify({ active: "work", profiles: {
      work: { email: "me@work.com", api: `http://127.0.0.1:${api.port}`, token: NEW },
      alt: { email: "me@work.com", api: `http://127.0.0.1:${api.port}`, token: OLD2 },
    } }));
    const post = (path: string, body: unknown) => fetch(`${daemonUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await post("/connect", { ccSessionId: "cc-ren2", claudeSessionId: true, project: "pj", session: "s2", user: "user:me", profile: "alt" });
    seen.length = 0;
    await post("/events", { session_id: "cc-ren2", hook_event_name: "UserPromptSubmit", prompt: "x" });
    for (let i = 0; i < 50 && !seen.includes(OLD2); i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContain(OLD2); // the daemon did talk to the server with this account
    expect(JSON.parse(await readFile(configPath, "utf-8")).profiles.alt.token).toBe(OLD2);
  });
});
