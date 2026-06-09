import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { renderSetupView, renderActiveView, renderProfileView, renderErrorView } from "../src/web/views";
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
import { resetTestData } from "./helpers";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// --- View context helpers ---

const base = { token: "test-token", userName: "Manu Bansal", orgName: "Lightup", orgSlug: "lightup-data" as string | null, email: "manu@lightup.ai" };
const fresh = { ...base, orgSlug: null, slackConnected: false, cliInstalled: false, hasConnectedSession: false, totalPrompts: 0 };
const slackDone = { ...base, slackConnected: true, cliInstalled: false, hasConnectedSession: false, totalPrompts: 0 };
const cliDone = { ...base, slackConnected: true, cliInstalled: true, hasConnectedSession: false, totalPrompts: 0 };
const allDone = { ...base, slackConnected: true, cliInstalled: true, hasConnectedSession: true, totalPrompts: 42 };

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
    expect(html).toContain("npx @lightupai/polaris login");
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
    expect(html).toContain("npx @lightupai/polaris login");
  });

  test("cli done: floor and devices done, sessions is highlighted", () => {
    const html = renderSetupView(cliDone, mockDevices);
    // Device list is shown with "add another" tray
    expect(html).toContain("Manu's MacBook Pro");
    expect(html).toContain("Add another device");
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
    expect(html).toContain("Connected");
    // No Connect Slack button
    expect(html).not.toContain("Connect Slack");
  });

  test("shows sessions nested under projects", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
    // Session names shown within project cards
    expect(html).toContain("auth");
    expect(html).toContain("slack-bridge");
    // Project names as card headers
    expect(html).toContain("polaris");
    expect(html).toContain("data-pipeline");
  });

  test("shows driver info in session rows", () => {
    const html = renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices);
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
    expect(html).toContain("Online");
    expect(html).toContain("polaris/auth");
    expect(html).toContain("Offline");
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

// --- Error view ---

describe("renderErrorView", () => {
  test("renders error message", () => {
    const html = renderErrorView("Something went wrong.");
    expect(html).toContain("Something went wrong.");
  });

  test("renders with action link", () => {
    const html = renderErrorView("Auth failed.", "Try again", "/login");
    expect(html).toContain("Auth failed.");
    expect(html).toContain("Try again");
    expect(html).toContain('href="/login"');
  });

  test("renders without action link when not provided", () => {
    const html = renderErrorView("Oops.");
    // The error card itself should not contain an action link (nav has its own links)
    const cardHtml = html.split("bg-red-100")[1] ?? "";
    expect(cardHtml).not.toContain("Try again");
  });

  test("renders warning icon", () => {
    const html = renderErrorView("Error");
    expect(html).toContain("bg-red-100");
    expect(html).toContain("text-red-600");
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
    await resetTestData(sql);

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

  test("GET /auth/token without token returns 400", async () => {
    const res = await app.request("/auth/token");
    expect(res.status).toBe(400);
  });

  // --- Slack routes ---

  test("GET /slack/install without SLACK_CLIENT_ID shows error", async () => {
    const origId = process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_ID;
    const res = await app.request(`/slack/install?token=${validToken}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Slack integration not configured");
    if (origId) process.env.SLACK_CLIENT_ID = origId;
  });

  test("GET /slack/install with SLACK_CLIENT_ID redirects to Slack", async () => {
    process.env.SLACK_CLIENT_ID = "fake-client-id";
    const res = await app.request(`/slack/install?token=${validToken}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack.com/oauth");
    expect(location).toContain("fake-client-id");
    delete process.env.SLACK_CLIENT_ID;
  });

  test("GET /slack/callback without code/state shows error", async () => {
    const res = await app.request("/slack/callback");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Missing code or state");
  });

  test("GET /slack/callback with invalid token redirects to login", async () => {
    const res = await app.request("/slack/callback?code=test&state=bad-token");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  // --- Unified auth ---

  test("GET /signup redirects to Google OAuth", async () => {
    const res = await app.request("/signup");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("accounts.google.com");
  });

  test("GET /login redirects to Google OAuth", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("accounts.google.com");
  });

  test("GET /auth/google/callback without params shows error", async () => {
    const res = await app.request("/auth/google/callback");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Missing code or state");
  });

  test("GET /auth/google/callback with invalid state shows error", async () => {
    const res = await app.request("/auth/google/callback?code=test&state=bad-state");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Invalid or expired OAuth state");
  });
});
