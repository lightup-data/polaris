#!/usr/bin/env bun
// --- Polaris CLI ---
// Usage:
//   polaris login    — authenticate via Google SSO, install local components
//   polaris daemon   — start the local daemon
//   polaris status   — show daemon health and active sessions
//   polaris logout   — remove credentials and local config

import { mkdir, writeFile, readFile, rm, exists } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const POLARIS_DIR = join(homedir(), ".polaris");
const CREDENTIALS_FILE = join(POLARIS_DIR, "credentials.json");
const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_SETTINGS_DIR = join(CLAUDE_DIR);

const SERVICE_URL = process.env.POLARIS_SERVICE_URL ?? "https://app.polaris.lightup.ai";

// --- Install local components (no auth required) ---

async function installComponents(participantId?: string) {
  // MCP server config
  await mkdir(CLAUDE_DIR, { recursive: true });

  const clientPath = join(import.meta.dir, "..", "client", "client.ts");
  const mcpConfig = {
    mcpServers: {
      polaris: {
        command: "npx",
        args: ["bun", clientPath],
        env: {
          POLARIS_DAEMON_URL: "http://127.0.0.1:4322",
        },
      },
    },
  };

  const mcpConfigPath = join(CLAUDE_DIR, ".mcp.json");
  let existingMcp: Record<string, unknown> = {};
  try {
    const existing = await readFile(mcpConfigPath, "utf-8");
    existingMcp = JSON.parse(existing);
  } catch { /* doesn't exist yet */ }

  const mergedMcp = {
    ...existingMcp,
    mcpServers: {
      ...(existingMcp as { mcpServers?: Record<string, unknown> }).mcpServers,
      ...mcpConfig.mcpServers,
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mergedMcp, null, 2));
  console.log(`MCP server config written to ${mcpConfigPath}`);

  // Hooks
  const captureShPath = join(import.meta.dir, "..", "..", "hooks", "capture.sh");
  const hooksConfig = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: captureShPath }] }],
    Stop: [{ hooks: [{ type: "command", command: captureShPath }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: captureShPath }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: captureShPath }] }],
  };

  const settingsPath = join(CLAUDE_DIR, "settings.json");
  let existingSettings: Record<string, unknown> = {};
  try {
    const existing = await readFile(settingsPath, "utf-8");
    existingSettings = JSON.parse(existing);
  } catch { /* doesn't exist yet */ }

  const mergedSettings = {
    ...existingSettings,
    hooks: {
      ...(existingSettings as { hooks?: Record<string, unknown> }).hooks,
      ...hooksConfig,
    },
  };

  // Status line
  const statusLinePath = join(import.meta.dir, "..", "..", "hooks", "statusline.sh");
  const mergedSettingsWithStatusLine = {
    ...mergedSettings,
    statusLine: {
      type: "command",
      command: statusLinePath,
    },
  };
  await writeFile(settingsPath, JSON.stringify(mergedSettingsWithStatusLine, null, 2));
  console.log(`Hooks + status line config written to ${settingsPath}`);

  // /polaris skill
  const skillDir = join(CLAUDE_DIR, "skills", "polaris");
  await mkdir(skillDir, { recursive: true });
  const identity = participantId ? `\`${participantId}\`` : "the user's participant ID (ask them if unknown)";
  const skillContent = `---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename
argument-hint: [join <project> <session> | rename <new-name> | disconnect | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**\`/polaris join <project> <session>\`** — Connect to a session:
1. Call \`polaris_connect\` with the given project, session, and user identity ${identity}
2. Report the connection status

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
  console.log(`/polaris skill written to ${skillDir}/SKILL.md`);
}

// --- Login ---

async function login() {
  console.log("Polaris — setting up your machine\n");

  // Step 1: Install local components (no auth needed)
  console.log("Installing local components...\n");
  await installComponents();
  console.log("");

  // Step 2: Browser OAuth
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
  const authUrl = `${SERVICE_URL}/auth/cli?port=${callbackPort}`;

  console.log("Opening browser for Google sign-in...");
  console.log(`If the browser doesn't open, visit: ${authUrl}\n`);

  const proc = Bun.spawn(
    process.platform === "darwin" ? ["open", authUrl] :
    process.platform === "win32" ? ["cmd", "/c", "start", authUrl] :
    ["xdg-open", authUrl],
    { stdout: "ignore", stderr: "ignore" }
  );
  await proc.exited;

  // Step 3: Wait for the token
  console.log("Waiting for authentication...");
  const token = await tokenPromise;
  setTimeout(() => callbackServer.stop(true), 3000);

  // Step 4: Validate token and get user info
  const res = await fetch(`${SERVICE_URL}/auth/token?token=${token}`);
  if (!res.ok) {
    console.error("Failed to validate token. Please try again.");
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

  console.log(`\nAuthenticated as ${userInfo.name} (${userInfo.email})`);
  console.log(`Organization: ${orgName}`);
  console.log(`Participant ID: ${userInfo.participant_id}\n`);

  // Step 5: Save credentials
  await mkdir(POLARIS_DIR, { recursive: true });
  await writeFile(CREDENTIALS_FILE, JSON.stringify({
    token,
    ...userInfo,
    service_url: SERVICE_URL,
  }, null, 2));
  console.log(`Credentials saved to ${CREDENTIALS_FILE}`);

  // Step 6: Re-install skill with personalized participant ID
  await installComponents(userInfo.participant_id);

  // Step 7: Post system event (device connected)
  const hostname = (await import("node:os")).hostname();
  const apiUrl = SERVICE_URL.includes("localhost") ? SERVICE_URL.replace(":3000", ":4321") : SERVICE_URL.replace("app.", "api.");
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
          stop_response: `Device connected: ${hostname} (${process.platform})`,
        },
      }),
    });
  } catch { /* non-fatal */ }

  console.log("\n✓ Polaris is set up on this machine!");
  console.log("\nNext steps:");
  console.log("  1. Start the daemon:  polaris daemon");
  console.log("  2. Open your AI agent and run:  /polaris join <project> <session>");
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
  try {
    const res = await fetch("http://127.0.0.1:4322/status");
    const data = (await res.json()) as { ok: boolean; sessions?: Array<{ ccSessionId: string; project: string; session: string; user: string }> };
    if (data.ok) {
      console.log("Daemon: running");
      if (data.sessions && data.sessions.length > 0) {
        console.log(`Active sessions (${data.sessions.length}):`);
        for (const s of data.sessions) {
          console.log(`  ${s.project}/${s.session} as ${s.user} (cc: ${s.ccSessionId})`);
        }
      } else {
        console.log("No active sessions");
      }
    }
  } catch {
    console.log("Daemon: not running");
  }

  // Check credentials
  try {
    const creds = JSON.parse(await readFile(CREDENTIALS_FILE, "utf-8"));
    console.log(`\nLogged in as: ${creds.name} (${creds.email})`);
    console.log(`Org: ${creds.org_id}`);
    console.log(`Service: ${creds.service_url}`);
  } catch {
    console.log("\nNot logged in. Run: polaris login");
  }
}

// --- Logout ---

async function logout() {
  try {
    await rm(POLARIS_DIR, { recursive: true });
    console.log("Credentials removed.");
  } catch { /* already gone */ }
  console.log("Logged out. MCP config and hooks are still installed — remove them manually if needed.");
}

// --- Main ---

const command = process.argv[2];

switch (command) {
  case "login":
    await login();
    break;
  case "daemon":
    await daemon();
    break;
  case "status":
    await status();
    break;
  case "logout":
    await logout();
    break;
  default:
    console.log("Polaris CLI");
    console.log("");
    console.log("Usage:");
    console.log("  polaris login    — authenticate and set up this machine");
    console.log("  polaris daemon   — start the local daemon");
    console.log("  polaris status   — show connection status");
    console.log("  polaris logout   — remove credentials");
}
