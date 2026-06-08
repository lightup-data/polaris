import { Hono } from "hono";
import { Google } from "arctic";
import { createToken, verifyToken } from "../service/auth";
import {
  createOrg,
  getOrg,
  getOrgByDomain,
  createUser,
  getUserByEmail,
  upsertUser,
  setOrgSlack,
  type Sql,
} from "../service/db";
import { layout, nav } from "./layout";
import { renderSetupView, renderActiveView, renderProfileView, renderErrorView } from "./views";
import { renderLandingPage } from "./pages";
import {
  mockUser,
  mockOrg,
  mockOrgNoSlack,
  mockProjects,
  mockActiveSessions,
  mockEmptySessions,
  mockDevices,
} from "./fixtures";

// --- Google OAuth ---

function getGoogle(): Google {
  return new Google(
    process.env.GOOGLE_CLIENT_ID ?? "",
    process.env.GOOGLE_CLIENT_SECRET ?? "",
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/auth/google/callback"
  );
}

const oauthStates = new Map<string, { type: "login" | "signup"; codeVerifier: string; timestamp: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (now - val.timestamp > 10 * 60 * 1000) oauthStates.delete(key);
  }
}, 10 * 60 * 1000);

// --- App ---

export function createApp(sql: Sql) {
  const app = new Hono();

  // --- Landing page ---

  app.get("/", (c) => {
    return layout(renderLandingPage());
  });

  // --- Auth: single Google SSO flow for both signup and login ---

  function startGoogleAuth(c: { redirect: (url: string) => Response }) {
    const google = getGoogle();
    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomUUID();
    oauthStates.set(state, { type: "login", codeVerifier, timestamp: Date.now() });
    const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
    return c.redirect(url.toString());
  }

  app.get("/signup", async (c) => startGoogleAuth(c));
  app.get("/login", async (c) => startGoogleAuth(c));

  app.get("/auth/google/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return layout(renderErrorView("Missing code or state.", "Try again", "/login"));

    const stateData = oauthStates.get(state);
    if (!stateData) return layout(renderErrorView("Invalid or expired OAuth state.", "Try again", "/login"));
    oauthStates.delete(state);

    const google = getGoogle();
    let tokens;
    try {
      tokens = await google.validateAuthorizationCode(code, stateData.codeVerifier);
    } catch {
      return layout(renderErrorView("Authentication failed.", "Try again", "/login"));
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokens.accessToken()}` },
    });
    const userInfo = (await userInfoRes.json()) as { sub: string; email: string; name: string };
    const { email, name } = userInfo;
    const domain = email.split("@")[1];

    // 1. Existing user → log in
    const existingUser = await getUserByEmail(sql, email);
    if (existingUser) {
      const token = await createToken({
        sub: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
        org_id: existingUser.org_id,
        participant_id: existingUser.participant_id,
      });
      return c.redirect(`/dashboard?token=${token}`);
    }

    // 2. Existing org for this domain → auto-join
    const existingOrg = await getOrgByDomain(sql, domain);
    if (existingOrg) {
      const userId = crypto.randomUUID();
      const participantId = `user:${name.toLowerCase().replace(/\s+/g, ".")}`;
      await createUser(sql, userId, email, name, existingOrg.id, participantId);
      const token = await createToken({ sub: userId, email, name, org_id: existingOrg.id, participant_id: participantId });
      return c.redirect(`/dashboard?token=${token}`);
    }

    // 3. No org → auto-create from email domain
    const orgName = domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
    const orgId = crypto.randomUUID();
    try {
      await createOrg(sql, orgId, orgName, domain);
    } catch {
      return layout(renderErrorView("Failed to create team. Please try again.", "Try again", "/login"));
    }
    const userId = crypto.randomUUID();
    const participantId = `user:${name.toLowerCase().replace(/\s+/g, ".")}`;
    await createUser(sql, userId, email, name, orgId, participantId);
    const token = await createToken({ sub: userId, email, name, org_id: orgId, participant_id: participantId });
    return c.redirect(`/dashboard?token=${token}`);
  });

  // --- Dashboard ---

  app.get("/dashboard", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    // TODO: detect cliInstalled (check if user has ever hit /auth/token from CLI)
    // TODO: detect hasConnectedSession (check if user has any sessions as driver in DB)
    const ctx = {
      token,
      userName: payload.name,
      orgName: org.name,
      email: payload.email,
      slackConnected: !!org.slack_team_id,
      cliInstalled: false,
      hasConnectedSession: false,
    };

    // TODO: query cloud service for active sessions for this user
    const activeSessions: unknown[] = [];

    if (activeSessions.length > 0) {
      return layout(renderActiveView(ctx, [], []), "Polaris");
    }
    return layout(renderSetupView(ctx), "Polaris");
  });

  // --- Profile ---

  app.get("/profile", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    const ctx = {
      token,
      userName: payload.name,
      orgName: org.name,
      email: payload.email,
      slackConnected: !!org.slack_team_id,
      cliInstalled: false,
      hasConnectedSession: false,
    };

    return layout(renderProfileView(ctx, payload.participant_id), "Polaris - Profile");
  });

  // --- Preview (dev only — all view states on one page) ---

  app.get("/preview", (c) => {
    const mockToken = "preview-token";
    const base = { token: mockToken, userName: mockUser.name, orgName: mockOrg.name, email: mockUser.email };

    const fresh       = { ...base, slackConnected: false, cliInstalled: false, hasConnectedSession: false };
    const slackDone   = { ...base, slackConnected: true,  cliInstalled: false, hasConnectedSession: false };
    const cliDone     = { ...base, slackConnected: true,  cliInstalled: true,  hasConnectedSession: false };
    const allDone     = { ...base, slackConnected: true,  cliInstalled: true,  hasConnectedSession: true };

    return layout(`
      <div class="max-w-5xl mx-auto px-6 py-12">
        <h1 class="text-3xl font-bold text-gray-900 mb-2">View Preview</h1>
        <p class="text-gray-500 mb-12">All dashboard states rendered on one page for visual testing.</p>

        <div class="space-y-16">
          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Setup: fresh (nothing done)</h2>
            <p class="text-sm text-gray-400 mb-4">Brand new user, no steps completed.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderSetupView(fresh)}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Setup: Slack connected</h2>
            <p class="text-sm text-gray-400 mb-4">Floor is live, CLI not installed yet.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderSetupView(slackDone)}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Setup: Slack + CLI done</h2>
            <p class="text-sm text-gray-400 mb-4">Waiting for first session connection.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderSetupView(cliDone, mockDevices)}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Active view (multiple sessions)</h2>
            <p class="text-sm text-gray-400 mb-4">User is driver in one session, advisor in others.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderActiveView(allDone, mockActiveSessions, mockProjects, mockDevices)}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Profile view</h2>
            <p class="text-sm text-gray-400 mb-4">User identity, participant ID, API token.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderProfileView(allDone, mockUser.participant_id)}
            </div>
          </section>
          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Error: auth failed</h2>
            <p class="text-sm text-gray-400 mb-4">Google OAuth rejected or expired.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderErrorView("Authentication failed.", "Try again", "/login")}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Error: expired OAuth state</h2>
            <p class="text-sm text-gray-400 mb-4">Stale or replayed OAuth callback.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderErrorView("Invalid or expired OAuth state.", "Try again", "/login")}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Error: team creation failed</h2>
            <p class="text-sm text-gray-400 mb-4">Database error during org creation.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderErrorView("Failed to create team. Please try again.", "Try again", "/login")}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Error: Slack not configured</h2>
            <p class="text-sm text-gray-400 mb-4">Missing SLACK_CLIENT_ID env var.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderErrorView("Slack integration not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.", "Back to dashboard", "/dashboard")}
            </div>
          </section>

          <section>
            <h2 class="text-lg font-bold text-gray-700 mb-1">Error: Slack OAuth failed</h2>
            <p class="text-sm text-gray-400 mb-4">Slack rejected the OAuth flow.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderErrorView("Slack connection failed: invalid_code", "Back to dashboard", "/dashboard")}
            </div>
          </section>
        </div>
      </div>
    `, "Polaris - Preview");
  });

  // --- Slack OAuth ---

  app.get("/slack/install", async (c) => {
    const token = c.req.query("token");
    const slackClientId = process.env.SLACK_CLIENT_ID;
    if (!slackClientId) {
      return layout(renderErrorView("Slack integration not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.", "Back to dashboard", `/dashboard?token=${token}`));
    }
    const state = `${token}`;
    const scopes = "channels:manage,channels:join,chat:write,channels:read,users:read,users:read.email";
    const url = `https://slack.com/oauth/v2/authorize?client_id=${slackClientId}&scope=${scopes}&state=${state}&redirect_uri=${encodeURIComponent(process.env.SLACK_REDIRECT_URI ?? "http://localhost:3000/slack/callback")}`;
    return c.redirect(url);
  });

  app.get("/slack/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return layout(renderErrorView("Missing code or state.", "Back to dashboard", "/login"));

    const payload = await verifyToken(state);
    if (!payload) return c.redirect("/login");

    const slackRes = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID ?? "",
        client_secret: process.env.SLACK_CLIENT_SECRET ?? "",
        code,
        redirect_uri: process.env.SLACK_REDIRECT_URI ?? "http://localhost:3000/slack/callback",
      }),
    });
    const slackData = (await slackRes.json()) as { ok: boolean; team?: { id: string }; access_token?: string; error?: string };

    if (!slackData.ok) {
      return layout(renderErrorView(`Slack connection failed: ${slackData.error}`, "Back to dashboard", `/dashboard?token=${state}`));
    }

    await setOrgSlack(sql, payload.org_id, slackData.team!.id, slackData.access_token!);
    return c.redirect(`/dashboard?token=${state}`);
  });

  // --- CLI token endpoint ---

  app.get("/auth/token", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "No token" }, 400);
    const payload = await verifyToken(token);
    if (!payload) return c.json({ error: "Invalid token" }, 401);
    return c.json(payload);
  });

  return app;
}
