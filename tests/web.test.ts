import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { renderSetupView, renderActiveView, renderProfileView } from "../src/web/views";
import { nav } from "../src/web/layout";
import {
  mockUser,
  mockOrg,
  mockOrgNoSlack,
  mockProjects,
  mockActiveSessions,
  mockDevices,
} from "../src/web/fixtures";
import { createApp } from "../src/web/app";
import { createDb, createOrg, createUser, type Sql } from "../src/service/db";
import { createToken } from "../src/service/auth";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris";

// --- View context helpers ---

const base = { token: "test-token", userName: "Manu Bansal", orgName: "Lightup", email: "manu@lightup.ai" };
const fresh = { ...base, slackConnected: false, cliInstalled: false, hasConnectedSession: false };
const slackDone = { ...base, slackConnected: true, cliInstalled: false, hasConnectedSession: false };
const cliDone = { ...base, slackConnected: true, cliInstalled: true, hasConnectedSession: false };
const allDone = { ...base, slackConnected: true, cliInstalled: true, hasConnectedSession: true };

// --- Setup view ---

describe("renderSetupView", () => {
  test("fresh state: floor is highlighted, devices and sessions are grayed out", () => {
    const html = renderSetupView(fresh);
    // Floor section has active highlight
    expect(html).toContain("border-polaris-300");
    // Devices and sessions are wrapped with opacity
    expect(html).toContain("opacity-40");
    // Connect Slack button is present
    expect(html).toContain("Connect Slack");
    // Install CLI command is present
    expect(html).toContain("npx @lightup/polaris login");
    // Connect session command is present
    expect(html).toContain("/polaris join my-project my-session");
  });

  test("slack done: floor shows connected, devices is highlighted, sessions grayed", () => {
    const html = renderSetupView(slackDone);
    // Floor shows connected badge
    expect(html).toContain("Connected");
    // No Connect Slack button
    expect(html).not.toContain("Connect Slack");
    // Devices section has highlight (CLI not installed yet)
    const floorIdx = html.indexOf("Floor");
    const devicesIdx = html.indexOf("Devices");
    const highlightIdx = html.indexOf("border-polaris-300");
    expect(highlightIdx).toBeGreaterThan(devicesIdx);
    // Install CLI command present
    expect(html).toContain("npx @lightup/polaris login");
  });

  test("cli done: floor and devices done, sessions is highlighted", () => {
    const html = renderSetupView(cliDone, mockDevices);
    // Device list is shown (not install prompt)
    expect(html).toContain("Manu's MacBook Pro");
    // No install CLI command
    expect(html).not.toContain("npx @lightup/polaris login");
    // Session section has highlight
    const sessIdx = html.indexOf("Projects &amp; Sessions");
    const lastHighlight = html.lastIndexOf("border-polaris-300");
    expect(lastHighlight).toBeGreaterThan(sessIdx);
    // Connect session command present
    expect(html).toContain("/polaris join my-project my-session");
  });

  test("includes nav with user info", () => {
    const html = renderSetupView(fresh);
    expect(html).toContain("Manu Bansal");
    expect(html).toContain("Lightup");
  });
});

// --- Active view ---

describe("renderActiveView", () => {
  test("shows compact floor bar", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    expect(html).toContain("Live");
    // No Connect Slack button
    expect(html).not.toContain("Connect Slack");
  });

  test("shows session cards with roles", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    expect(html).toContain("polaris/auth");
    expect(html).toContain("polaris/slack-bridge");
    // Role badges are rendered (Advisor shown when participant ID derivation
    // from display name doesn't match fixture — expected for mock data)
    expect(html).toContain("Advisor");
  });

  test("shows session descriptions and event counts", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    expect(html).toContain("Google SSO + JWT auth");
    expect(html).toContain("42 events");
  });

  test("shows other participants in sessions", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    expect(html).toContain("agent:security-reviewer");
    expect(html).toContain("user:krishna");
  });

  test("shows project cards with slack channels", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    expect(html).toContain("#polaris");
    expect(html).toContain("#data-pipeline");
    expect(html).toContain("2 sessions");
    expect(html).toContain("1 session");
  });

  test("shows device list with online status", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    expect(html).toContain("Manu's MacBook Pro");
    expect(html).toContain("Manu's iMac");
    expect(html).toContain("Active now");
    expect(html).toContain("polaris/auth");
    expect(html).toContain("Last seen");
  });

  test("hides devices section when no devices", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, []);
    expect(html).not.toContain("Manu's MacBook Pro");
  });
});

// --- Profile view ---

describe("renderProfileView", () => {
  test("shows user identity", () => {
    const html = renderProfileView(allDone, "user:manu");
    expect(html).toContain("Manu Bansal");
    expect(html).toContain("manu@lightup.ai");
    expect(html).toContain("user:manu");
  });

  test("shows organization", () => {
    const html = renderProfileView(allDone, "user:manu");
    expect(html).toContain("Lightup");
  });

  test("shows API token", () => {
    const html = renderProfileView(allDone, "user:manu");
    expect(html).toContain("API token");
    expect(html).toContain("test-token");
  });

  test("shows avatar initial", () => {
    const html = renderProfileView(allDone, "user:manu");
    expect(html).toContain(">M</");
  });
});

// --- Navigation ---

describe("nav", () => {
  test("logged out: shows sign in link", () => {
    const html = nav();
    expect(html).toContain("Sign in");
    expect(html).not.toContain("Dashboard");
    expect(html).not.toContain("Log out");
  });

  test("logged in: shows user dropdown with name and org", () => {
    const html = nav("tok123", { userName: "Manu Bansal", orgName: "Lightup", email: "manu@lightup.ai" });
    expect(html).toContain("Manu Bansal");
    expect(html).toContain("Lightup");
    expect(html).toContain("manu@lightup.ai");
    expect(html).toContain("Dashboard");
    expect(html).toContain("Profile");
    expect(html).toContain("Log out");
  });

  test("logged in: polaris logo links to dashboard", () => {
    const html = nav("tok123");
    expect(html).toContain('href="/dashboard?token=tok123"');
  });

  test("logged out: polaris logo links to home", () => {
    const html = nav();
    expect(html).toContain('href="/"');
  });
});

// --- Fixture integrity ---

describe("fixtures", () => {
  test("mock sessions reference existing projects", () => {
    const projectNames = mockProjects.map((p) => p.name);
    for (const session of mockActiveSessions) {
      expect(projectNames).toContain(session.project);
    }
  });

  test("mock devices have required fields", () => {
    for (const device of mockDevices) {
      expect(device.name).toBeTruthy();
      expect(device.os).toBeTruthy();
      expect(device.lastSeen).toBeTruthy();
    }
  });

  test("mock user participant_id matches format", () => {
    expect(mockUser.participant_id).toMatch(/^user:[a-z]/);
  });

  test("mockActiveSessions only includes sessions where mockUser participates", () => {
    for (const session of mockActiveSessions) {
      const userInSession = session.participants.some((p) => p.id === mockUser.participant_id);
      expect(userInSession).toBe(true);
    }
  });
});

// --- Route behavior ---

describe("routes", () => {
  let sql: Sql;
  let app: ReturnType<typeof createApp>;
  let validToken: string;

  beforeAll(async () => {
    sql = await createDb(DATABASE_URL);
    app = createApp(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DROP TABLE IF EXISTS events`;
    await sql`DROP TABLE IF EXISTS sessions`;
    await sql`DROP TABLE IF EXISTS projects`;
    await sql`DROP TABLE IF EXISTS users`;
    await sql`DROP TABLE IF EXISTS orgs`;
    await sql`CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, slack_team_id TEXT, slack_bot_token TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), participant_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    await sql`CREATE TABLE IF NOT EXISTS projects (name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, name))`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (name TEXT NOT NULL, project TEXT NOT NULL, org_id TEXT NOT NULL, driver TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, project, name), FOREIGN KEY (org_id, project) REFERENCES projects(org_id, name))`;
    await sql`CREATE TABLE IF NOT EXISTS events (id UUID PRIMARY KEY, org_id TEXT NOT NULL, project TEXT NOT NULL, session TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL, source TEXT NOT NULL, sender TEXT NOT NULL, payload JSONB NOT NULL)`;

    await createOrg(sql, "test-org", "Test Org", "test.com");
    await createUser(sql, "user-1", "test@test.com", "Test User", "test-org", "user:test");
    validToken = await createToken({
      sub: "user-1",
      email: "test@test.com",
      name: "Test User",
      org_id: "test-org",
      participant_id: "user:test",
    });
  });

  test("GET / returns 200", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Multiplayer AI collaboration");
  });

  test("GET /preview returns 200", async () => {
    const res = await app.request("/preview");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("View Preview");
  });

  test("GET /dashboard without token redirects to /login", async () => {
    const res = await app.request("/dashboard");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("GET /dashboard with invalid token redirects to /login", async () => {
    const res = await app.request("/dashboard?token=bad-token");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("GET /dashboard with valid token returns 200", async () => {
    const res = await app.request(`/dashboard?token=${validToken}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Floor");
    expect(body).toContain("Devices");
  });

  test("GET /profile without token redirects to /login", async () => {
    const res = await app.request("/profile");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("GET /profile with valid token returns 200", async () => {
    const res = await app.request(`/profile?token=${validToken}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Test User");
    expect(body).toContain("test@test.com");
    expect(body).toContain("user:test");
  });

  test("GET /auth/token with valid token returns user info", async () => {
    const res = await app.request(`/auth/token?token=${validToken}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("test@test.com");
    expect(body.org_id).toBe("test-org");
  });

  test("GET /auth/token with invalid token returns 401", async () => {
    const res = await app.request("/auth/token?token=bad");
    expect(res.status).toBe(401);
  });
});
