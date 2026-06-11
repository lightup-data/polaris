#!/usr/bin/env bun
// --- Polaris CLI ---
// Usage:
//   polaris              — install + login (default onboarding)
//   polaris install      — install local components (no auth)
//   polaris login        — authenticate via Google SSO (production)
//   polaris login --local — authenticate against localhost
//   polaris login --url <url> — authenticate against a custom URL
//   polaris login --profile <name> — explicit profile name
//   polaris use <profile> — switch active profile
//   polaris profiles     — list profiles
//   polaris daemon       — start the local daemon
//   polaris status       — show connection status
//   polaris recover      — re-POST locally logged events missing upstream
//   polaris logout       — remove credentials

import { mkdir, writeFile, readFile, rm, copyFile, chmod, readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

const POLARIS_DIR = join(homedir(), ".polaris");
const CONFIG_FILE = join(POLARIS_DIR, "config.json");
const LEGACY_CREDENTIALS_FILE = join(POLARIS_DIR, "credentials.json");
const CLAUDE_DIR = join(homedir(), ".claude");

const DEFAULT_APP_URL = "https://app.polaris.lightup.ai";
const LOCAL_APP_URL = "http://localhost:3000";

// --- Config ---

interface Profile {
  api: string;
  app: string;
  token: string;
  email: string;
  name: string;
  org_id: string;
  participant_id: string;
}

interface Config {
  active: string;
  profiles: Record<string, Profile>;
  daemonSecret?: string;
}

async function loadConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
  } catch {
    // Migrate from legacy credentials.json if it exists
    try {
      const legacy = JSON.parse(await readFile(LEGACY_CREDENTIALS_FILE, "utf-8"));
      if (legacy.token) {
        const appUrl = legacy.service_url ?? DEFAULT_APP_URL;
        const profileName = deriveProfileName(appUrl);
        const config: Config = {
          active: profileName,
          profiles: {
            [profileName]: {
              api: appToApi(appUrl),
              app: appUrl,
              token: legacy.token,
              email: legacy.email ?? "",
              name: legacy.name ?? "",
              org_id: legacy.org_id ?? "",
              participant_id: legacy.participant_id ?? "",
            },
          },
        };
        await saveConfig(config);
        return config;
      }
    } catch { /* no legacy file either */ }
    return { active: "", profiles: {} };
  }
}

async function saveConfig(config: Config): Promise<void> {
  await mkdir(POLARIS_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function getActiveProfile(config: Config): Profile | null {
  if (!config.active || !config.profiles[config.active]) return null;
  return config.profiles[config.active];
}

function deriveProfileName(appUrl: string): string {
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) return "local";
  try {
    const host = new URL(appUrl).hostname;
    // app.polaris.lightup.ai → prod
    if (host.includes("polaris.lightup.ai")) return "prod";
    // strip common prefixes
    return host.replace(/^app\./, "").replace(/\./g, "-");
  } catch {
    return "default";
  }
}

function appToApi(appUrl: string): string {
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) {
    return appUrl.replace(":3000", ":4321");
  }
  return appUrl.replace("app.", "api.");
}

// --- Daemon secret ---

// Shared local secret for daemon HTTP auth. Stored in ~/.polaris/config.json
// (`daemonSecret`); the daemon requires it as `x-polaris-daemon-secret` on all
// of its endpoints once a secret is resolved (env POLARIS_DAEMON_SECRET takes
// precedence over the config file). Reused across installs so previously
// registered MCP servers and hooks stay valid.
async function ensureDaemonSecret(): Promise<string> {
  const config = await loadConfig();
  const envSecret = process.env.POLARIS_DAEMON_SECRET;
  if (envSecret) {
    if (config.daemonSecret !== envSecret) {
      config.daemonSecret = envSecret;
      await saveConfig(config);
    }
    return envSecret;
  }
  if (config.daemonSecret) return config.daemonSecret;
  const secret = crypto.randomUUID();
  config.daemonSecret = secret;
  await saveConfig(config);
  return secret;
}

function resolveDaemonSecret(config: Config): string | undefined {
  return process.env.POLARIS_DAEMON_SECRET || config.daemonSecret || undefined;
}

// --- Install ---

// Wire Claude Code hooks + status line into ~/.claude/settings.json.
// UserPromptSubmit/Stop run bun scripts (prompt-time inject delivery and full
// Stop transcript capture); PreToolUse/PostToolUse use the plain curl relay.
// Hooks are copied to ~/.polaris/hooks/ — a stable path that survives package
// upgrades/relocations — and re-copied on every install so they stay fresh.
async function wireHooks(daemonSecret?: string): Promise<void> {
  const srcHooksDir = join(import.meta.dir, "..", "..", "hooks");
  const hooksDir = join(POLARIS_DIR, "hooks");
  await mkdir(hooksDir, { recursive: true });
  for (const file of ["capture.sh", "capture-prompt.ts", "capture-stop.ts", "statusline.sh"]) {
    await copyFile(join(srcHooksDir, file), join(hooksDir, file));
    if (file.endsWith(".sh")) await chmod(join(hooksDir, file), 0o755);
  }

  const captureShPath = join(hooksDir, "capture.sh");
  const capturePromptPath = join(hooksDir, "capture-prompt.ts");
  const captureStopPath = join(hooksDir, "capture-stop.ts");
  const statusLinePath = join(hooksDir, "statusline.sh");

  // Pass the shared daemon secret to hook processes via the command env so
  // they can authenticate with the daemon (x-polaris-daemon-secret header).
  const env = daemonSecret ? `POLARIS_DAEMON_SECRET=${daemonSecret} ` : "";
  const hooksConfig = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `${env}npx bun "${capturePromptPath}"` }] }],
    Stop: [{ hooks: [{ type: "command", command: `${env}npx bun "${captureStopPath}"` }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: `${env}"${captureShPath}"` }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: `${env}"${captureShPath}"` }] }],
  };

  const settingsPath = join(CLAUDE_DIR, "settings.json");
  let existingSettings: Record<string, unknown> = {};
  try {
    existingSettings = JSON.parse(await readFile(settingsPath, "utf-8"));
  } catch { /* doesn't exist yet */ }

  const mergedSettings = {
    ...existingSettings,
    hooks: {
      ...(existingSettings as { hooks?: Record<string, unknown> }).hooks,
      ...hooksConfig,
    },
    statusLine: {
      type: "command",
      command: `${env}"${statusLinePath}"`,
    },
  };
  await writeFile(settingsPath, JSON.stringify(mergedSettings, null, 2));
}

async function install(participantId?: string) {
  await mkdir(CLAUDE_DIR, { recursive: true });

  // Shared local secret for daemon auth (generated once, reused thereafter)
  const daemonSecret = await ensureDaemonSecret();

  // Install package to ~/.polaris/mcp/ (user-local, no sudo needed, persistent)
  const mcpDir = join(POLARIS_DIR, "mcp");
  await mkdir(mcpDir, { recursive: true });

  console.log("  Installing MCP server to ~/.polaris/mcp/...");
  const npmInstall = Bun.spawnSync(
    ["npm", "install", "--prefix", mcpDir, "@lightupai/polaris"],
    { stdout: "ignore", stderr: "pipe" }
  );
  if (npmInstall.exitCode !== 0) {
    console.error("  Warning: MCP server install failed.");
    console.error("  " + npmInstall.stderr.toString().trim());
  }

  // The binary is at ~/.polaris/mcp/node_modules/.bin/polaris-mcp
  const mcpBin = join(mcpDir, "node_modules", ".bin", "polaris-mcp");

  // Register MCP server with Claude Code via `claude mcp add`
  // This writes to the correct config location that Claude Code reads
  // Remove first to avoid duplicates, then add with user scope
  Bun.spawnSync(["claude", "mcp", "remove", "polaris", "-s", "user"], {
    stdout: "ignore", stderr: "ignore",
  });
  const mcpAdd = Bun.spawnSync(
    [
      "claude", "mcp", "add", "polaris", "-s", "user",
      "-e", "POLARIS_DAEMON_URL=http://127.0.0.1:4322",
      "-e", `POLARIS_DAEMON_SECRET=${daemonSecret}`,
      "--", mcpBin,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (mcpAdd.exitCode === 0) {
    console.log("  ✓ MCP server registered with Claude Code");
  } else {
    console.error("  Warning: could not register MCP server with Claude Code.");
    console.error("  " + mcpAdd.stderr.toString().trim());
    console.error(`  Run manually: claude mcp add -s user -e POLARIS_DAEMON_URL=http://127.0.0.1:4322 -e POLARIS_DAEMON_SECRET=${daemonSecret} polaris -- ${mcpBin}`);
  }

  // Hooks (copied to ~/.polaris/hooks/ with the daemon secret in their env)
  await wireHooks(daemonSecret);
  console.log("  ✓ Hooks + status line config written");

  // /polaris skill
  const skillDir = join(CLAUDE_DIR, "skills", "polaris");
  await mkdir(skillDir, { recursive: true });
  const identity = participantId ? `\`${participantId}\`` : "the user's participant ID (ask them if unknown)";
  const skillContent = `---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename
argument-hint: [join <project> | rename <new-name> | disconnect | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**\`/polaris join <project>\`** — Connect to a session:
1. Call \`polaris_connect\` with the given project and user identity ${identity}
2. A session name is auto-generated
3. Report the connection status including the session name

**\`/polaris rename <new-name>\`** — Rename the current project:
1. Call \`polaris_rename\` with the new name
2. Report the result

**\`/polaris disconnect\`** — Disconnect:
1. Call \`polaris_disconnect\`
2. Confirm disconnection

**\`/polaris\`** (no arguments) — Show status:
1. Call \`polaris_status\`
2. Display the current connection state

### Arguments: $ARGUMENTS
`;
  await writeFile(join(skillDir, "SKILL.md"), skillContent);
  console.log("  ✓ /polaris skill written");
}

// --- Login ---

async function login(appUrl: string, profileName?: string) {
  const derivedName = profileName ?? deriveProfileName(appUrl);

  // Browser OAuth
  let resolveToken: (token: string) => void;
  const tokenPromise = new Promise<string>((resolve) => { resolveToken = resolve; });

  const callbackServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        if (token) {
          resolveToken!(token);
          return new Response(
            `<!DOCTYPE html><html><head><title>Polaris</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#1a1a1a;}</style></head><body><div style="text-align:center"><h2>Authenticated!</h2><p>You can close this tab and return to the terminal.</p></div></body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  const callbackPort = callbackServer.port;
  const authUrl = `${appUrl}/auth/cli?port=${callbackPort}`;

  console.log(`  Opening browser for Google sign-in (${derivedName})...`);
  console.log(`  If the browser doesn't open, visit: ${authUrl}\n`);

  const proc = Bun.spawn(
    process.platform === "darwin" ? ["open", authUrl] :
    process.platform === "win32" ? ["cmd", "/c", "start", authUrl] :
    ["xdg-open", authUrl],
    { stdout: "ignore", stderr: "ignore" }
  );
  await proc.exited;

  console.log("  Waiting for authentication...");
  const token = await tokenPromise;
  setTimeout(() => callbackServer.stop(true), 3000);

  // Validate token
  const res = await fetch(`${appUrl}/auth/token?token=${token}`);
  if (!res.ok) {
    console.error("  ✗ Failed to validate token. Please try again.");
    process.exit(1);
  }
  const userInfo = (await res.json()) as {
    sub: string;
    email: string;
    name: string;
    org_id: string;
    participant_id: string;
  };

  let orgName = userInfo.email.split("@")[1].split(".")[0];
  orgName = orgName.charAt(0).toUpperCase() + orgName.slice(1);

  console.log(`\n  Authenticated as ${userInfo.name} (${userInfo.email})`);
  console.log(`  Organization: ${orgName}`);
  console.log(`  Participant ID: ${userInfo.participant_id}`);

  // Save to profile
  const config = await loadConfig();
  config.profiles[derivedName] = {
    api: appToApi(appUrl),
    app: appUrl,
    token,
    email: userInfo.email,
    name: userInfo.name,
    org_id: userInfo.org_id,
    participant_id: userInfo.participant_id,
  };
  config.active = derivedName;
  await saveConfig(config);

  // Also write legacy credentials.json for backward compat (daemon reads it)
  await writeFile(LEGACY_CREDENTIALS_FILE, JSON.stringify({
    token,
    ...userInfo,
    service_url: appUrl,
  }, null, 2));

  console.log(`  ✓ Profile "${derivedName}" saved and set as active`);

  // Re-install skill with personalized participant ID
  await mkdir(join(CLAUDE_DIR, "skills", "polaris"), { recursive: true });
  const identity = `\`${userInfo.participant_id}\``;
  const skillDir = join(CLAUDE_DIR, "skills", "polaris");
  const skillContent = `---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename
argument-hint: [join <project> | rename <new-name> | disconnect | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**\`/polaris join <project>\`** — Connect to a session:
1. Call \`polaris_connect\` with the given project and user identity ${identity}
2. A session name is auto-generated
3. Report the connection status including the session name

**\`/polaris rename <new-name>\`** — Rename the current project:
1. Call \`polaris_rename\` with the new name
2. Report the result

**\`/polaris disconnect\`** — Disconnect:
1. Call \`polaris_disconnect\`
2. Confirm disconnection

**\`/polaris\`** (no arguments) — Show status:
1. Call \`polaris_status\`
2. Display the current connection state

### Arguments: $ARGUMENTS
`;
  await writeFile(join(skillDir, "SKILL.md"), skillContent);

  // Hooks (same wiring as install — keeps hook commands up to date)
  await wireHooks(await ensureDaemonSecret());
  console.log("  ✓ Hooks + status line config written");

  // Post system event (device connected)
  const apiUrl = appToApi(appUrl);
  try {
    await fetch(`${apiUrl}/projects/_system/sessions/_system/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        sender: userInfo.participant_id,
        payload: {
          hook_event_name: "Stop",
          session_id: "_system",
          stop_response: `Device connected: ${hostname()} (${process.platform})`,
        },
      }),
    });
  } catch { /* non-fatal */ }
}

// --- Use ---

async function use(profileName: string) {
  const config = await loadConfig();
  if (!config.profiles[profileName]) {
    console.error(`Profile "${profileName}" not found.`);
    const names = Object.keys(config.profiles);
    if (names.length > 0) {
      console.error(`Available profiles: ${names.join(", ")}`);
    } else {
      console.error("No profiles configured. Run: polaris login");
    }
    process.exit(1);
  }
  config.active = profileName;
  await saveConfig(config);

  // Update legacy credentials.json for daemon
  const profile = config.profiles[profileName];
  await writeFile(LEGACY_CREDENTIALS_FILE, JSON.stringify({
    token: profile.token,
    email: profile.email,
    name: profile.name,
    org_id: profile.org_id,
    participant_id: profile.participant_id,
    service_url: profile.app,
  }, null, 2));

  console.log(`Active profile: ${profileName} (${profile.api})`);
  console.log("Restart the daemon for this to take effect.");
}

// --- Profiles ---

async function profiles() {
  const config = await loadConfig();
  const names = Object.keys(config.profiles);
  if (names.length === 0) {
    console.log("No profiles configured. Run: polaris login");
    return;
  }
  console.log("Profiles:\n");
  for (const name of names) {
    const p = config.profiles[name];
    const active = name === config.active ? " (active)" : "";
    console.log(`  ${name}${active}`);
    console.log(`    API: ${p.api}`);
    console.log(`    User: ${p.name} (${p.email})`);
    console.log("");
  }
}

// --- Daemon ---

async function daemon() {
  const daemonPath = join(import.meta.dir, "..", "daemon", "daemon.ts");
  console.log("Starting Polaris daemon...");
  const proc = Bun.spawn(["bun", "run", daemonPath], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
    },
  });
  await proc.exited;
}

// --- Status ---

async function status() {
  // Active profile
  const config = await loadConfig();
  const profile = getActiveProfile(config);
  if (profile) {
    console.log(`Profile: ${config.active} (${profile.api})`);
    console.log(`User: ${profile.name} (${profile.email})`);
  } else {
    console.log("Not logged in. Run: polaris login");
  }

  // Daemon (send the shared local secret when configured — the daemon
  // requires it on all endpoints once one is resolved)
  try {
    const secret = resolveDaemonSecret(config);
    const res = await fetch("http://127.0.0.1:4322/status", {
      headers: secret ? { "x-polaris-daemon-secret": secret } : undefined,
    });
    const data = (await res.json()) as { ok: boolean; sessions?: Array<{ ccSessionId: string; project: string; session: string; user: string }> };
    if (data.ok) {
      console.log("\nDaemon: running");
      if (data.sessions && data.sessions.length > 0) {
        console.log(`Active sessions (${data.sessions.length}):`);
        for (const s of data.sessions) {
          console.log(`  ${s.project}/${s.session} as ${s.user}`);
        }
      } else {
        console.log("No active sessions");
      }
    }
  } catch {
    console.log("\nDaemon: not running");
  }
}

// --- Recover ---

// Replay locally logged daemon events (~/.polaris/logs/*.jsonl) that never
// made it upstream. Presence is determined by fetching each session's
// messages (GET /projects/:p/sessions/:s/messages) and diffing: by event id
// when the logged payload carries one, otherwise by the payload's identifying
// fields (hook ids are assigned server-side at ingest, so hook log entries
// have no id of their own). Missing events are re-POSTed via the normal
// events ingest path. Best-effort: failures are skipped, never throws.

interface RecoverRoute { project: string; session: string; user: string; agent: string }
interface RecoverCandidate { project: string; session: string; sender: string; payload: Record<string, unknown> }

function isPresentUpstream(
  payload: Record<string, unknown>,
  upstream: Array<{ id?: string; payload?: Record<string, unknown> }>
): boolean {
  const id = payload.id;
  if (typeof id === "string" && upstream.some((e) => e.id === id)) return true;
  const kind = payload.hook_event_name;
  return upstream.some((e) => {
    const p = e.payload;
    if (!p || p.hook_event_name !== kind || p.session_id !== payload.session_id) return false;
    switch (kind) {
      case "UserPromptSubmit":
        return p.prompt === payload.prompt;
      case "Stop":
        return (p.stop_response ?? p.last_assistant_message) === (payload.stop_response ?? payload.last_assistant_message);
      case "PreToolUse":
      case "PostToolUse":
        return p.tool_name === payload.tool_name && JSON.stringify(p.tool_input) === JSON.stringify(payload.tool_input);
      default:
        return JSON.stringify(p) === JSON.stringify(payload);
    }
  });
}

async function recover() {
  try {
    const config = await loadConfig();
    const profile = getActiveProfile(config);
    if (!profile) {
      console.log("Not logged in. Run: polaris login");
      return;
    }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.token}`,
    };

    const logDir = join(POLARIS_DIR, "logs");
    let files: string[] = [];
    try {
      files = (await readdir(logDir)).filter((f) => f.endsWith(".jsonl")).sort();
    } catch { /* no log dir */ }
    if (files.length === 0) {
      console.log("No local logs found in ~/.polaris/logs — nothing to recover.");
      return;
    }

    // Pass 1: walk logs chronologically (files are daemon-YYYY-MM-DD.jsonl),
    // learning session routing from /connect entries and collecting candidate
    // events. Failed relays are logged twice (with/without a response field),
    // so dedupe identical payloads.
    const routes = new Map<string, RecoverRoute>(); // keyed by cc session id
    const candidates: RecoverCandidate[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let unroutable = 0;

    const routeFor = (sessionId: string): RecoverRoute | undefined => {
      // Exact match first; like the daemon, fall back to the single known
      // session when only one mapping exists (MCP and hook session ids differ)
      const route = routes.get(sessionId);
      if (route) return route;
      if (routes.size === 1) return routes.values().next().value;
      return undefined;
    };

    for (const file of files) {
      let text: string;
      try {
        text = await readFile(join(logDir, file), "utf-8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let entry: { endpoint?: string; payload?: Record<string, unknown> };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const payload = entry.payload;
        if (!payload || typeof payload !== "object") continue;

        if (entry.endpoint === "/connect") {
          // Routing is only learnable for explicit session names; generated
          // names are assigned by the daemon after logging
          const c = payload as { ccSessionId?: string; project?: string; session?: string; user?: string; agent?: string };
          if (c.ccSessionId && c.project && c.session && c.user) {
            routes.set(c.ccSessionId, { project: c.project, session: c.session, user: c.user, agent: c.agent || "agent:claude" });
          }
          continue;
        }

        if (entry.endpoint === "/events") {
          const hookEvent = payload.hook_event_name;
          const sessionId = payload.session_id;
          if (typeof hookEvent !== "string" || typeof sessionId !== "string") continue;
          const key = `events:${JSON.stringify(payload)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          scanned++;
          const route = routeFor(sessionId);
          if (!route) {
            unroutable++;
            continue;
          }
          const sender = hookEvent === "UserPromptSubmit" ? route.user : route.agent;
          candidates.push({ project: route.project, session: route.session, sender, payload });
          continue;
        }

        if (entry.endpoint === "/reply") {
          const r = payload as { ccSessionId?: string; message?: string };
          if (!r.ccSessionId || !r.message) continue;
          const key = `reply:${JSON.stringify(payload)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          scanned++;
          const route = routeFor(r.ccSessionId);
          if (!route) {
            unroutable++;
            continue;
          }
          // Reconstruct the same Stop payload the daemon relays for replies
          candidates.push({
            project: route.project,
            session: route.session,
            sender: route.agent,
            payload: { hook_event_name: "Stop", session_id: r.ccSessionId, stop_response: r.message },
          });
        }
      }
    }

    // Pass 2: per session, fetch upstream messages and re-POST what's missing
    const groups = new Map<string, RecoverCandidate[]>();
    for (const c of candidates) {
      const key = `${c.project} ${c.session}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(c);
    }

    let missing = 0;
    let restored = 0;
    for (const group of groups.values()) {
      const { project, session } = group[0];
      let upstream: Array<{ id?: string; payload?: Record<string, unknown> }> = [];
      try {
        const res = await fetch(`${profile.api}/projects/${project}/sessions/${session}/messages`, { headers });
        if (res.ok) upstream = (await res.json()) as typeof upstream;
      } catch { /* unreachable — treat as empty */ }

      for (const c of group) {
        if (isPresentUpstream(c.payload, upstream)) continue;
        missing++;
        try {
          const res = await fetch(`${profile.api}/projects/${project}/sessions/${session}/events`, {
            method: "POST",
            headers,
            body: JSON.stringify({ sender: c.sender, payload: c.payload }),
          });
          if (res.ok) restored++;
        } catch { /* leave as missing */ }
      }
    }

    console.log(`Recover: ${scanned} logged events scanned, ${missing} missing upstream, ${restored} restored.`);
    if (unroutable > 0) {
      console.log(`Skipped ${unroutable} event(s) with no recoverable project/session mapping.`);
    }
    if (missing > restored) {
      console.log(`${missing - restored} event(s) could not be restored (API unreachable or rejected).`);
    }
  } catch (err) {
    // Best-effort: report and exit cleanly, never throw
    console.error(`Recover failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Logout ---

async function logout(all = false) {
  if (all) {
    try {
      await rm(POLARIS_DIR, { recursive: true });
      console.log("All profiles and credentials removed.");
    } catch { /* already gone */ }
  } else {
    const config = await loadConfig();
    if (!config.active || !config.profiles[config.active]) {
      console.log("No active profile to remove.");
      return;
    }
    const name = config.active;
    delete config.profiles[name];
    // Set active to first remaining profile, or empty
    const remaining = Object.keys(config.profiles);
    config.active = remaining.length > 0 ? remaining[0] : "";
    await saveConfig(config);
    console.log(`Profile "${name}" removed.`);
    if (config.active) {
      console.log(`Active profile switched to: ${config.active}`);
    }
  }
  console.log("MCP config and hooks are still installed — run `polaris install` to reset them.");
}

// --- Main ---

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

switch (command) {
  case "install":
    console.log("Polaris — installing local components\n");
    await install();
    console.log("\nInstall complete.");
    break;

  case "login": {
    const appUrl = hasFlag("local") ? LOCAL_APP_URL : (getFlag("url") ?? DEFAULT_APP_URL);
    const profileName = getFlag("profile");
    console.log("Polaris — authenticating\n");
    await login(appUrl, profileName);
    console.log("\n✓ Login complete!");
    // Auto-start daemon in background
    const daemonPath = join(import.meta.dir, "..", "daemon", "daemon.ts");
    Bun.spawn(["bun", "run", daemonPath], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    }).unref?.();
    console.log("  ✓ Daemon started in background");

    console.log("\nNext: restart Claude Code, then run `/polaris join <project>` in your AI agent.");
    break;
  }

  case "use":
    if (!args[1]) {
      console.error("Usage: polaris use <profile>");
      process.exit(1);
    }
    await use(args[1]);
    break;

  case "profiles":
    await profiles();
    break;

  case "daemon":
    await daemon();
    break;

  case "status":
    await status();
    break;

  case "recover":
    await recover();
    break;

  case "logout":
    await logout(hasFlag("all"));
    break;

  case undefined:
    // Default: install + login
    console.log("Polaris — setting up your machine\n");
    console.log("[1/2] Installing local components...\n");
    await install();
    console.log("\n  Install complete. Run `polaris install` to repeat this step independently.\n");
    console.log("[2/2] Authenticating...\n");
    await login(DEFAULT_APP_URL);
    console.log("\n✓ Polaris is set up on this machine!");
    // Auto-start daemon in background
    const daemonPath = join(import.meta.dir, "..", "daemon", "daemon.ts");
    Bun.spawn(["bun", "run", daemonPath], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    }).unref?.();
    console.log("  ✓ Daemon started in background");

    console.log("\nNext: restart Claude Code, then run `/polaris join <project>` in your AI agent.");
    break;

  default:
    console.log("Polaris CLI\n");
    console.log("Usage:");
    console.log("  polaris                — install + login (default setup)");
    console.log("  polaris install        — install local components (no auth)");
    console.log("  polaris login          — authenticate (production)");
    console.log("  polaris login --local  — authenticate (local dev)");
    console.log("  polaris use <profile>  — switch active profile");
    console.log("  polaris profiles       — list all profiles");
    console.log("  polaris daemon         — start the local daemon");
    console.log("  polaris status         — show connection status");
    console.log("  polaris recover        — re-POST locally logged events missing upstream");
    console.log("  polaris logout         — remove active profile");
    console.log("  polaris logout --all   — remove all credentials");
}
