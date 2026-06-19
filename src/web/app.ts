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
  getSessionEvents,
  listProjects,
  listSessions,
  getSessionPromptCounts,
  getProjectEvents,
  getRecentSignups,
  listUsers,
  setOrgPlan,
  getDailyPromptCounts,
  type Sql,
} from "../service/db";
import { layout, nav } from "./layout";
import {
  renderSetupView,
  renderActiveView,
  renderProfileView,
  renderErrorView,
  renderTranscriptView,
  renderSearchView,
  renderDecisionsView,
  renderProjectSettingsView,
  type TranscriptEvent,
  type SearchResult,
  type ProjectMemberView,
} from "./views";
import { AnnotationKind, type Annotation } from "../types";
import { renderLandingPage } from "./pages";
import { createSystemChannel, postSystemEvent } from "../slack/system";
import {
  mockUser,
  mockOrg,
  mockOrgNoSlack,
  mockProjects,
  mockActiveSessions,
  mockEmptySessions,
  mockDevices,
} from "./fixtures";

// --- Signup notifications ---

const SIGNUP_CHANNEL = "#alerts-mql-stream";

function notifySignup(opts: { name: string; email: string; domain: string; orgName: string; isNewOrg: boolean; plan?: string }): void {
  const botToken = process.env.SIGNUP_SLACK_BOT_TOKEN;
  if (!botToken) return;

  const emoji = opts.isNewOrg ? ":tada:" : ":wave:";
  const action = opts.isNewOrg ? "signed up (new org)" : "joined";
  const planTag = opts.plan ? ` [${opts.plan}]` : "";
  const text = `${emoji} *${opts.name}* (${opts.email}) ${action} — ${opts.orgName} (${opts.domain})${planTag}`;

  fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: SIGNUP_CHANNEL, text }),
  }).catch(() => {});
}

export function notifyPlanChange(opts: { name: string; email: string; orgName: string; fromPlan: string; toPlan: string }): void {
  const botToken = process.env.SIGNUP_SLACK_BOT_TOKEN;
  if (!botToken) return;

  const emoji = opts.toPlan === "free" ? ":arrow_down:" : ":arrow_up:";
  const text = `${emoji} *${opts.name}* (${opts.email}) changed plan: ${opts.fromPlan} → ${opts.toPlan} — ${opts.orgName}`;

  fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: SIGNUP_CHANNEL, text }),
  }).catch(() => {});
}

function startSignupRollup(sql: Sql): void {
  const HOUR = 60 * 60 * 1000;

  async function postRollup(): Promise<void> {
    const botToken = process.env.SIGNUP_SLACK_BOT_TOKEN;
    if (!botToken) return;

    const since = new Date(Date.now() - HOUR);
    const signups = await getRecentSignups(sql, since, 10);
    if (signups.length === 0) return;

    const lines = signups.map((s) => `• *${s.name}* (${s.email}) — ${s.org_name}`);
    const text = `:chart_with_upwards_trend: *${signups.length} signup${signups.length === 1 ? "" : "s"} in the last hour*\n${lines.join("\n")}`;

    fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: SIGNUP_CHANNEL, text }),
    }).catch(() => {});
  }

  setInterval(postRollup, HOUR);
}

// --- Google OAuth ---

function getGoogle(): Google {
  return new Google(
    process.env.GOOGLE_CLIENT_ID ?? "",
    process.env.GOOGLE_CLIENT_SECRET ?? "",
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/auth/google/callback"
  );
}

const oauthStates = new Map<string, { type: "login" | "signup"; codeVerifier: string; timestamp: number; plan?: string }>();
const cliCallbackPorts = new Map<string, number>(); // state → CLI local server port

// If this auth flow was initiated by the CLI, redirect the token to the CLI's local server.
// Otherwise redirect to the dashboard.
function authRedirect(c: { redirect: (url: string) => Response }, state: string, token: string): Response {
  const cliPort = cliCallbackPorts.get(state);
  if (cliPort) {
    cliCallbackPorts.delete(state);
    return c.redirect(`http://127.0.0.1:${cliPort}/callback?token=${token}`);
  }
  return c.redirect(`/dashboard?token=${token}`);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthStates) {
    if (now - val.timestamp > 10 * 60 * 1000) oauthStates.delete(key);
  }
}, 10 * 60 * 1000);

// --- App ---

export function createApp(sql: Sql) {
  const app = new Hono();

  // Polaris API service (same convention as slack/bridge.ts)
  const apiUrl = process.env.POLARIS_API_URL ?? "http://localhost:4321";

  // Start hourly signup rollup
  startSignupRollup(sql);

  // --- Static assets ---

  app.get("/styles.css", async (c) => {
    const file = Bun.file(new URL("./styles/output.css", import.meta.url).pathname);
    return new Response(await file.arrayBuffer(), {
      headers: { "Content-Type": "text/css", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  });

  app.get("/favicon.svg", async (c) => {
    const file = Bun.file(new URL("../../favicon.svg", import.meta.url).pathname);
    return new Response(await file.arrayBuffer(), {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  });

  app.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

  // --- SEO ---

  app.get("/og-image.png", async (c) => {
    const file = Bun.file(new URL("../../og-image.png", import.meta.url).pathname);
    return new Response(await file.arrayBuffer(), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
    });
  });

  app.get("/robots.txt", (c) => {
    return new Response(
      `User-agent: *\nAllow: /\n\nSitemap: https://app.withpolaris.ai/sitemap.xml`,
      { headers: { "Content-Type": "text/plain" } }
    );
  });

  app.get("/sitemap.xml", (c) => {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://app.withpolaris.ai</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`,
      { headers: { "Content-Type": "application/xml" } }
    );
  });

  // --- Landing page ---

  app.get("/", (c) => {
    return layout(renderLandingPage(), "Polaris — It's like Gong for Claude Code sessions", {
      title: "Polaris — It's like Gong for Claude Code sessions",
      description: "Capture every AI coding session. Stream prompts, responses, and tool calls to Slack in real time. Collaborate across agents. Nothing is lost.",
      canonical: "https://app.withpolaris.ai",
    });
  });

  // --- Auth: single Google SSO flow for both signup and login ---

  function startGoogleAuth(c: { req: { query: (k: string) => string | undefined }; redirect: (url: string) => Response }) {
    const google = getGoogle();
    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomUUID();
    const plan = c.req.query("plan");
    oauthStates.set(state, { type: "login", codeVerifier, timestamp: Date.now(), plan });
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
      // Upgrade org plan if signing up for a higher tier
      if (stateData.plan && stateData.plan !== "free") {
        const userOrg = await getOrg(sql, existingUser.org_id);
        if (userOrg && userOrg.plan === "free") {
          await setOrgPlan(sql, existingUser.org_id, "free", stateData.plan, existingUser.id);
        }
      }

      const token = await createToken({
        sub: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
        org_id: existingUser.org_id,
        participant_id: existingUser.participant_id,
      });
      return authRedirect(c, state, token);
    }

    // 2. Existing org for this domain → auto-join
    const existingOrg = await getOrgByDomain(sql, domain);
    if (existingOrg) {
      const userId = crypto.randomUUID();
      const participantId = `user:${name.toLowerCase().replace(/\s+/g, ".")}`;
      await createUser(sql, userId, email, name, existingOrg.id, participantId);

      // Upgrade org plan if signing up for a higher tier
      if (stateData.plan && stateData.plan !== "free" && existingOrg.plan === "free") {
        await setOrgPlan(sql, existingOrg.id, "free", stateData.plan, userId);
      }

      // Notify org's Slack system channel
      postSystemEvent({
        sql,
        orgId: existingOrg.id,
        sender: participantId,
        text: `:wave: *${name}* (${email}) joined the team`,
        botToken: existingOrg.slack_bot_token ?? undefined,
        channelId: existingOrg.slack_system_channel_id ?? undefined,
      }).catch(() => {});

      // Notify internal team
      notifySignup({ name, email, domain, orgName: existingOrg.name, isNewOrg: false, plan: stateData.plan });

      const token = await createToken({ sub: userId, email, name, org_id: existingOrg.id, participant_id: participantId });
      return authRedirect(c, state, token);
    }

    // 3. No org → auto-create from email domain
    const orgName = domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
    const orgId = crypto.randomUUID();
    try {
      await createOrg(sql, orgId, orgName, domain, stateData.plan);
    } catch {
      return layout(renderErrorView("Failed to create team. Please try again.", "Try again", "/login"));
    }
    const userId = crypto.randomUUID();
    const participantId = `user:${name.toLowerCase().replace(/\s+/g, ".")}`;
    await createUser(sql, userId, email, name, orgId, participantId);

    // Notify internal team
    notifySignup({ name, email, domain, orgName, isNewOrg: true, plan: stateData.plan });

    const token = await createToken({ sub: userId, email, name, org_id: orgId, participant_id: participantId });
    return authRedirect(c, state, token);
  });

  // --- Dashboard ---

  app.get("/dashboard", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    // Detect setup status from system events
    let cliInstalled = false;
    const devices: Array<{ name: string; lastSeen: string; os: string; activeSession?: string }> = [];
    try {
      const systemEvents = await getSessionEvents(sql, payload.org_id, "_system", "_system");
      for (const e of systemEvents) {
        const text = (e.payload as { stop_response?: string }).stop_response ?? "";
        const match = text.match(/^Device connected: (.+) \((.+)\)$/);
        if (match) {
          cliInstalled = true;
          // Deduplicate by device name, keep latest
          const existing = devices.findIndex((d) => d.name === match[1]);
          const device = { name: match[1], os: match[2], lastSeen: e.timestamp };
          if (existing >= 0) devices[existing] = device;
          else devices.push(device);
        }
      }
    } catch { /* _system project may not exist yet */ }

    // Query team members, projects, sessions, prompt counts, and daily activity
    const teamMembers = await listUsers(sql, payload.org_id);
    const dailyPrompts = await getDailyPromptCounts(sql, payload.org_id);
    const projects = (await listProjects(sql, payload.org_id)).filter((p) => p.name !== "_system");
    const allSessions = (await listSessions(sql, payload.org_id)).filter((s) => s.project !== "_system");
    const promptCounts = await getSessionPromptCounts(sql, payload.org_id);
    const participantId = payload.participant_id;

    function buildSessionFixture(s: typeof allSessions[0]): import("./fixtures").SessionFixture {
      return {
        name: s.name,
        project: s.project,
        driver: s.driver ?? "",
        role: (s.driver === participantId ? "driver" : "advisor") as "driver" | "advisor",
        description: "",
        participants: s.driver ? [{ id: s.driver, role: "driver" as const }] : [],
        eventCount: promptCounts.get(`${s.project}/${s.name}`) ?? 0,
        connectedSince: s.created_at,
      };
    }

    const sessionFixtures = allSessions.map(buildSessionFixture);

    const projectFixtures: import("./fixtures").ProjectFixture[] = projects.map((p) => ({
      name: p.name,
      slackChannel: p.slack_channel_name ? `#${p.slack_channel_name}` : "",
      sessions: allSessions.filter((s) => s.project === p.name).map(buildSessionFixture),
    }));

    const hasConnectedSession = allSessions.length > 0;

    const ctx = {
      token,
      userName: payload.name,
      orgName: org.name,
      orgSlug: org.slug,
      email: payload.email,
      slackConnected: !!org.slack_team_id,
      cliInstalled,
      hasConnectedSession,
      totalPrompts: Array.from(promptCounts.values()).reduce((a, b) => a + b, 0),
      teamMembers: teamMembers.map((u) => ({ name: u.name, email: u.email })),
      plan: org.plan,
      dailyPrompts,
    };

    if (hasConnectedSession) {
      return layout(renderActiveView(ctx, sessionFixtures, projectFixtures, devices), "Dashboard — Polaris");
    }
    return layout(renderSetupView(ctx, devices), "Setup — Polaris");
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
      orgSlug: org.slug,
      email: payload.email,
      slackConnected: !!org.slack_team_id,
      cliInstalled: false,
      hasConnectedSession: false,
      totalPrompts: 0,
    };

    return layout(renderProfileView(ctx, payload.participant_id), "Polaris - Profile");
  });

  // --- Session transcript ---

  app.get("/sessions/:proj/:sess", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    const proj = c.req.param("proj");
    const sess = c.req.param("sess");
    const before = c.req.query("before");

    const eventsUrl = new URL(`${apiUrl}/projects/${encodeURIComponent(proj)}/sessions/${encodeURIComponent(sess)}/events`);
    eventsUrl.searchParams.set("limit", "200");
    if (before) eventsUrl.searchParams.set("before", before);

    let events: TranscriptEvent[];
    let nextCursor: string | null;
    try {
      const res = await fetch(eventsUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const message = res.status === 404 ? "Session not found." : `Failed to load transcript (${res.status}).`;
        return layout(renderErrorView(message, "Back to dashboard", `/dashboard?token=${token}`));
      }
      const data = (await res.json()) as { events: TranscriptEvent[]; nextCursor: string | null };
      events = data.events ?? [];
      nextCursor = data.nextCursor ?? null;
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to dashboard", `/dashboard?token=${token}`));
    }

    // Annotations are progressive enhancement — render the transcript even if they fail to load.
    let annotations: Annotation[] = [];
    try {
      const annRes = await fetch(
        `${apiUrl}/projects/${encodeURIComponent(proj)}/sessions/${encodeURIComponent(sess)}/annotations`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (annRes.ok) {
        annotations = ((await annRes.json()) as { annotations: Annotation[] }).annotations ?? [];
      }
    } catch { /* transcript still renders without annotations */ }

    const ctx = { token, userName: payload.name, orgName: org.name, email: payload.email };
    const title = `Polaris - ${proj}/${sess}`.replace(/[<>&"]/g, "");
    return layout(renderTranscriptView(ctx, proj, sess, events, nextCursor, before, annotations), title);
  });

  // Proxies to the API inject endpoint; the API derives the sender from the bearer token.
  app.post("/sessions/:proj/:sess/inject", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const proj = c.req.param("proj");
    const sess = c.req.param("sess");
    const transcriptUrl = `/sessions/${encodeURIComponent(proj)}/${encodeURIComponent(sess)}?token=${token}`;

    const body = await c.req.parseBody();
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) return c.redirect(transcriptUrl);

    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(proj)}/sessions/${encodeURIComponent(sess)}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        return layout(renderErrorView(`Inject failed (${res.status}).`, "Back to transcript", transcriptUrl));
      }
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to transcript", transcriptUrl));
    }

    return c.redirect(transcriptUrl);
  });

  // --- Annotations (star / tag / decision curation) ---
  // Proxies to the API annotations endpoints; the API derives the participant from the bearer token.

  app.post("/sessions/:proj/:sess/annotations", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const proj = c.req.param("proj");
    const sess = c.req.param("sess");
    const transcriptUrl = `/sessions/${encodeURIComponent(proj)}/${encodeURIComponent(sess)}?token=${token}`;

    const body = await c.req.parseBody();
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!AnnotationKind.safeParse(kind).success) return c.redirect(transcriptUrl);
    const eventId = typeof body.event_id === "string" && body.event_id ? body.event_id : undefined;
    const value = typeof body.value === "string" && body.value.trim() ? body.value.trim() : undefined;

    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(proj)}/sessions/${encodeURIComponent(sess)}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ event_id: eventId, kind, value }),
      });
      if (!res.ok) {
        return layout(renderErrorView(`Annotation failed (${res.status}).`, "Back to transcript", transcriptUrl));
      }
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to transcript", transcriptUrl));
    }

    return c.redirect(transcriptUrl);
  });

  app.post("/sessions/:proj/:sess/annotations/:id/delete", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const proj = c.req.param("proj");
    const sess = c.req.param("sess");
    const id = c.req.param("id");
    const transcriptUrl = `/sessions/${encodeURIComponent(proj)}/${encodeURIComponent(sess)}?token=${token}`;

    try {
      const res = await fetch(`${apiUrl}/annotations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return layout(renderErrorView(`Failed to remove annotation (${res.status}).`, "Back to transcript", transcriptUrl));
      }
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to transcript", transcriptUrl));
    }

    return c.redirect(transcriptUrl);
  });

  // --- Decisions (org-wide curation feed) ---

  app.get("/decisions", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    const project = (c.req.query("project") ?? "").trim();

    let decisions: Annotation[] | null = null;
    let decisionsError: string | undefined;
    const decisionsUrl = new URL(`${apiUrl}/decisions`);
    if (project) decisionsUrl.searchParams.set("project", project);
    decisionsUrl.searchParams.set("limit", "100");
    try {
      const res = await fetch(decisionsUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        decisions = ((await res.json()) as { decisions: Annotation[] }).decisions ?? [];
      } else {
        decisionsError = `Failed to load decisions (${res.status}).`;
      }
    } catch {
      decisionsError = "Could not reach the Polaris API.";
    }

    const ctx = { token, userName: payload.name, orgName: org.name, email: payload.email };
    return layout(renderDecisionsView(ctx, project, decisions, decisionsError), "Polaris - Decisions");
  });

  // --- Project settings (visibility + members) ---

  app.get("/projects/:proj/settings", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    const proj = c.req.param("proj");
    const projects = await listProjects(sql, payload.org_id);
    const project = projects.find((p) => p.name === proj);
    if (!project) {
      return layout(renderErrorView("Project not found.", "Back to dashboard", `/dashboard?token=${token}`));
    }

    let members: ProjectMemberView[] = [];
    let membersError: string | undefined;
    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(proj)}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = (await res.json()) as ProjectMemberView[] | { members?: ProjectMemberView[] };
        members = Array.isArray(data) ? data : data.members ?? [];
      } else {
        membersError = `Failed to load members (${res.status}).`;
      }
    } catch {
      membersError = "Could not reach the Polaris API.";
    }

    const ctx = { token, userName: payload.name, orgName: org.name, email: payload.email };
    const title = `Polaris - ${proj} settings`.replace(/[<>&"]/g, "");
    return layout(renderProjectSettingsView(ctx, proj, project.visibility ?? "org", members, membersError), title);
  });

  app.post("/projects/:proj/visibility", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const proj = c.req.param("proj");
    const settingsUrl = `/projects/${encodeURIComponent(proj)}/settings?token=${token}`;

    const body = await c.req.parseBody();
    const visibility = typeof body.visibility === "string" ? body.visibility : "";
    if (visibility !== "org" && visibility !== "members") return c.redirect(settingsUrl);

    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(proj)}/visibility`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ visibility }),
      });
      if (!res.ok) {
        return layout(renderErrorView(`Failed to update visibility (${res.status}).`, "Back to settings", settingsUrl));
      }
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to settings", settingsUrl));
    }

    return c.redirect(settingsUrl);
  });

  app.post("/projects/:proj/members", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const proj = c.req.param("proj");
    const settingsUrl = `/projects/${encodeURIComponent(proj)}/settings?token=${token}`;

    const body = await c.req.parseBody();
    const participantId = typeof body.participant_id === "string" ? body.participant_id.trim() : "";
    if (!participantId) return c.redirect(settingsUrl);
    const role = typeof body.role === "string" && body.role.trim() ? body.role.trim() : undefined;

    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(proj)}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ participant_id: participantId, role }),
      });
      if (!res.ok) {
        return layout(renderErrorView(`Failed to add member (${res.status}).`, "Back to settings", settingsUrl));
      }
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to settings", settingsUrl));
    }

    return c.redirect(settingsUrl);
  });

  app.post("/projects/:proj/members/:pid/delete", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const proj = c.req.param("proj");
    const pid = c.req.param("pid");
    const settingsUrl = `/projects/${encodeURIComponent(proj)}/settings?token=${token}`;

    try {
      const res = await fetch(`${apiUrl}/projects/${encodeURIComponent(proj)}/members/${encodeURIComponent(pid)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return layout(renderErrorView(`Failed to remove member (${res.status}).`, "Back to settings", settingsUrl));
      }
    } catch {
      return layout(renderErrorView("Could not reach the Polaris API.", "Back to settings", settingsUrl));
    }

    return c.redirect(settingsUrl);
  });

  // --- Search ---

  app.get("/search", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.redirect("/login");

    const payload = await verifyToken(token);
    if (!payload) return c.redirect("/login");

    const org = await getOrg(sql, payload.org_id);
    if (!org) return c.redirect("/login");

    const query = {
      q: (c.req.query("q") ?? "").trim(),
      project: c.req.query("project") ?? "",
      sender: c.req.query("sender") ?? "",
      source: c.req.query("source") ?? "",
      tag: (c.req.query("tag") ?? "").trim(),
    };

    let results: SearchResult[] | null = null;
    let searchError: string | undefined;
    if (query.q) {
      const searchUrl = new URL(`${apiUrl}/search`);
      searchUrl.searchParams.set("q", query.q);
      if (query.project) searchUrl.searchParams.set("project", query.project);
      if (query.sender) searchUrl.searchParams.set("sender", query.sender);
      if (query.source) searchUrl.searchParams.set("source", query.source);
      if (query.tag) searchUrl.searchParams.set("tag", query.tag);
      try {
        const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          results = ((await res.json()) as { results: SearchResult[] }).results ?? [];
        } else {
          searchError = `Search failed (${res.status}).`;
        }
      } catch {
        searchError = "Could not reach the Polaris API.";
      }
    }

    const ctx = { token, userName: payload.name, orgName: org.name, email: payload.email };
    return layout(renderSearchView(ctx, query, results, searchError), "Polaris - Search");
  });

  // --- Preview (dev only — all view states on one page) ---

  app.get("/preview", (c) => {
    const mockToken = "preview-token";
    const base = { token: mockToken, userName: mockUser.name, orgName: mockOrg.name, orgSlug: "lightup-data" as string | null, email: mockUser.email };

    const mockTeam = [{ name: mockUser.name, email: mockUser.email }, { name: "Alice Chen", email: "alice@lightup.ai" }, { name: "Laura Mowry", email: "laura@lightup.ai" }];
    const mockSenders = ["user:manu.bansal", "user:alice.chen", "user:laura.mowry"];
    const mockDailyPrompts = mockSenders.flatMap((sender) =>
      Array.from({ length: 14 }, (_, i) => {
        const d = new Date(); d.setDate(d.getDate() - 13 + i);
        return { date: d.toISOString().slice(0, 10), sender, count: Math.floor(Math.random() * 12) + 1 };
      })
    );
    const fresh       = { ...base, orgSlug: null, slackConnected: false, cliInstalled: false, hasConnectedSession: false, totalPrompts: 0 };
    const slackDone   = { ...base, slackConnected: true,  cliInstalled: false, hasConnectedSession: false, totalPrompts: 0, teamMembers: mockTeam, dailyPrompts: mockDailyPrompts };
    const cliDone     = { ...base, slackConnected: true,  cliInstalled: true,  hasConnectedSession: false, totalPrompts: 0, teamMembers: mockTeam, dailyPrompts: mockDailyPrompts };
    const allDone     = { ...base, slackConnected: true,  cliInstalled: true,  hasConnectedSession: true,  totalPrompts: 127, teamMembers: mockTeam, dailyPrompts: mockDailyPrompts };
    const teamPlan    = { ...fresh, plan: "pro" };

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
            <h2 class="text-lg font-bold text-gray-700 mb-1">Team plan signup</h2>
            <p class="text-sm text-gray-400 mb-4">User signed up via the Team pricing CTA.</p>
            <div class="border border-gray-200 rounded-xl overflow-hidden shadow-sm">
              ${renderSetupView(teamPlan)}
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
    const slackData = (await slackRes.json()) as { ok: boolean; team?: { id: string; name?: string }; access_token?: string; error?: string };

    if (!slackData.ok) {
      // Check if Slack is already connected (e.g., stale callback reload)
      const org = await getOrg(sql, payload.org_id);
      if (org?.slack_team_id) {
        return c.redirect(`/dashboard?token=${state}`);
      }
      return layout(renderErrorView(`Slack connection failed: ${slackData.error}`, "Try again", `/slack/install?token=${state}`));
    }

    // Create the #polaris system channel
    let systemChannelId: string | undefined;
    try {
      systemChannelId = await createSystemChannel(slackData.access_token!, payload.email);
      await postSystemEvent({
        sql,
        orgId: payload.org_id,
        sender: payload.participant_id,
        text: `:star: *${payload.name}* connected this Slack workspace to Polaris`,
        context: `Organization: ${payload.org_id}`,
        botToken: slackData.access_token!,
        channelId: systemChannelId,
      });
    } catch {
      // Non-fatal — Slack is connected even if channel creation fails
    }

    // Set org slug from Slack workspace name if not already set
    const currentOrg = await getOrg(sql, payload.org_id);
    const slug = currentOrg?.slug ? undefined : (slackData.team?.name?.toLowerCase().replace(/\s+/g, "-") ?? undefined);
    await setOrgSlack(sql, payload.org_id, slackData.team!.id, slackData.access_token!, systemChannelId, slug);
    notifyDashboard(payload.org_id);
    return c.redirect(`/dashboard?token=${state}`);
  });

  // --- Dashboard SSE (real-time status updates) ---

  const dashboardListeners = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>(); // orgId → controllers

  function notifyDashboard(orgId: string) {
    const controllers = dashboardListeners.get(orgId);
    if (!controllers) return;
    const data = `data: refresh\n\n`;
    const bytes = new TextEncoder().encode(data);
    for (const ctrl of controllers) {
      try { ctrl.enqueue(bytes); } catch { controllers.delete(ctrl); }
    }
  }

  // Expose notifyDashboard so other parts of the app can trigger it
  (app as unknown as { notifyDashboard: typeof notifyDashboard }).notifyDashboard = notifyDashboard;

  app.get("/api/dashboard-events", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "No token" }, 400);
    const payload = await verifyToken(token);
    if (!payload) return c.json({ error: "Invalid token" }, 401);

    const orgId = payload.org_id;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
        if (!dashboardListeners.has(orgId)) dashboardListeners.set(orgId, new Set());
        dashboardListeners.get(orgId)!.add(controller);
      },
      cancel() {
        dashboardListeners.get(orgId)?.delete(controller);
      },
    });

    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  });

  app.post("/api/notify-dashboard", async (c) => {
    const auth = c.req.header("Authorization");
    if (!auth?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
    const payload = await verifyToken(auth.slice(7));
    if (!payload) return c.json({ error: "Invalid token" }, 401);
    notifyDashboard(payload.org_id);
    return c.json({ ok: true });
  });

  app.get("/api/dashboard-status", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "No token" }, 400);
    const payload = await verifyToken(token);
    if (!payload) return c.json({ error: "Invalid token" }, 401);

    const org = await getOrg(sql, payload.org_id);
    const slackConnected = !!org?.slack_team_id;

    let cliInstalled = false;
    try {
      const systemEvents = await getSessionEvents(sql, payload.org_id, "_system", "_system");
      cliInstalled = systemEvents.some((e) =>
        (e.payload as { stop_response?: string }).stop_response?.startsWith("Device connected:")
      );
    } catch { /* _system may not exist */ }

    const hasConnectedSession = false; // TODO

    return c.json({ slackConnected, cliInstalled, hasConnectedSession });
  });

  // --- CLI auth flow ---

  // CLI calls this with a local callback port. We redirect to Google SSO
  // with state that encodes the CLI callback URL.
  app.get("/auth/cli", async (c) => {
    const port = c.req.query("port");
    if (!port) return c.json({ error: "port is required" }, 400);

    const google = getGoogle();
    const state = crypto.randomUUID();
    const codeVerifier = crypto.randomUUID();
    oauthStates.set(state, { type: "login", codeVerifier, timestamp: Date.now() });
    // Store CLI callback port in a separate map
    cliCallbackPorts.set(state, Number(port));
    const url = google.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
    return c.redirect(url.toString());
  });

  // After Google SSO, if state has a CLI callback port, redirect token there
  // (This is handled in the main /auth/google/callback by checking cliCallbackPorts)

  // --- Token validation endpoint ---

  app.get("/auth/token", async (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ error: "No token" }, 400);
    const payload = await verifyToken(token);
    if (!payload) return c.json({ error: "Invalid token" }, 401);
    return c.json(payload);
  });

  // --- 404 ---

  app.notFound((c) => {
    return layout(renderErrorView("Page not found.", "Back to home", "/"), "Not Found — Polaris");
  });

  return app;
}
