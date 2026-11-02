#!/usr/bin/env bun
// --- Polaris CLI ---
// Usage:
//   polaris                       — install + login (default onboarding)
//   polaris install               — install local components (no auth)
//   polaris update                — update to the latest version
//   polaris login                 — authenticate via Google SSO (production)
//   polaris login --local         — authenticate against localhost
//   polaris login --url <url>     — authenticate against a custom URL
//   polaris login --profile <name> — explicit profile key (default: email)
//   polaris login --token <token> — authenticate without a browser (SSH/headless)
//   polaris token                 — print active token for copy-paste to another machine
//   polaris use <email>           — switch active account (triggers login if not found)
//   polaris profiles              — list accounts
//   polaris daemon                — start the local daemon
//   polaris status                — show connection status
//   polaris recover               — re-POST locally logged events missing upstream
//   polaris recover --dry-run     — preview what would be restored without sending
//   polaris feedback              — report a bug or request a feature
//   polaris logout                — remove credentials

import { mkdir, writeFile, readFile, rm, copyFile, chmod, readdir } from "node:fs/promises";
import { DaemonClient } from "../core/daemon-client.js";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { POLARIS_DIR } from "../paths.js";

const CONFIG_FILE = join(POLARIS_DIR, "config.json");
const LEGACY_CREDENTIALS_FILE = join(POLARIS_DIR, "credentials.json");
const CLAUDE_DIR = join(homedir(), ".claude");

const DEFAULT_APP_URL = "https://app.withpolaris.ai";
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

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof payload.exp === "number" && Date.now() / 1000 > payload.exp;
  } catch { return false; }
}

// Returns the active profile, or prints a clear error and exits.
// Call this from any command that requires auth.
async function requireProfile(): Promise<Profile> {
  const config = await loadConfig();
  const profile = getActiveProfile(config);
  if (!profile) {
    console.error("Not logged in. Run: polaris login");
    process.exit(1);
  }
  if (isTokenExpired(profile.token)) {
    console.error("🚨 Token expired. Run: polaris login");
    process.exit(1);
  }
  return profile;
}

async function daemonClient(): Promise<DaemonClient> {
  const config = await loadConfig();
  const secret = resolveDaemonSecret(config);
  return new DaemonClient({ url: "http://127.0.0.1:4322", secret });
}

function deriveProfileName(appUrl: string): string {
  if (appUrl.includes("localhost") || appUrl.includes("127.0.0.1")) return "local";
  try {
    const host = new URL(appUrl).hostname;
    // app.withpolaris.ai → prod
    if (host.includes("withpolaris.ai")) return "prod";
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

// --- Daemon auto-restart (macOS: launchd, Linux: systemd user service) ---

// macOS: LaunchAgent
const LAUNCH_AGENT_LABEL = "ai.withpolaris.daemon";
const LAUNCH_AGENT_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);

async function installLaunchAgent(daemonSecret?: string): Promise<void> {
  const binDir = join(POLARIS_DIR, "bin");
  const runnerPath = join(binDir, "run-daemon.sh");
  const daemonTsPath = join(
    POLARIS_DIR, "mcp", "node_modules", "@lightupai", "polaris", "src", "daemon", "daemon.ts"
  );

  await mkdir(binDir, { recursive: true });
  // Runner searches common bun locations so launchd's minimal PATH is not an issue
  const runner = [
    "#!/bin/sh",
    `# Polaris daemon — managed by launchd (${LAUNCH_AGENT_LABEL})`,
    `for BUNPATH in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do`,
    `  [ -x "$BUNPATH" ] && break`,
    `done`,
    `exec "$BUNPATH" run "${daemonTsPath}"`,
  ].join("\n") + "\n";
  await writeFile(runnerPath, runner);
  await chmod(runnerPath, 0o755);

  const secretEnv = daemonSecret
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>POLARIS_DAEMON_SECRET</key>\n    <string>${daemonSecret}</string>\n  </dict>`
    : "";
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${runnerPath}</string>
  </array>${secretEnv}
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>/tmp/polaris-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/polaris-daemon.log</string>
</dict>
</plist>`;

  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(LAUNCH_AGENT_PLIST, plist);

  // Unload any existing instance, then load fresh (ignore errors if not loaded yet)
  Bun.spawnSync(["launchctl", "unload", "-w", LAUNCH_AGENT_PLIST], { stdout: "ignore", stderr: "ignore" });
  const load = Bun.spawnSync(["launchctl", "load", "-w", LAUNCH_AGENT_PLIST], { stdout: "pipe", stderr: "pipe" });
  if (load.exitCode !== 0) {
    console.error(`  Warning: could not register daemon with launchd: ${load.stderr.toString().trim()}`);
    console.error(`  Try manually: launchctl load -w ${LAUNCH_AGENT_PLIST}`);
  }
}

async function removeLaunchAgent(): Promise<void> {
  Bun.spawnSync(["launchctl", "unload", "-w", LAUNCH_AGENT_PLIST], { stdout: "ignore", stderr: "ignore" });
  try { await rm(LAUNCH_AGENT_PLIST); } catch { /* already gone */ }
}

// Linux: systemd user service
const SYSTEMD_SERVICE_NAME = "polaris-daemon";
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SYSTEMD_SERVICE_FILE = join(SYSTEMD_USER_DIR, `${SYSTEMD_SERVICE_NAME}.service`);

async function installSystemdService(daemonSecret?: string): Promise<void> {
  // Resolve bun's absolute path at install time so systemd's minimal PATH
  // doesn't matter. Bun.which() searches PATH; process.execPath is the
  // interpreter we're already running under.
  const resolvedBun = Bun.which("bun") ?? process.execPath;

  // Warn when bun resolved to an npx cache directory — that path is volatile
  // and will break the service if the cache is pruned or the hash changes.
  const isVolatile = resolvedBun.includes("/_npx/") || resolvedBun.includes("/npx_cache/");
  if (isVolatile) {
    console.error(`  Warning: bun was found at a volatile npm cache path:`);
    console.error(`    ${resolvedBun}`);
    console.error(`  The daemon service may break if npm cleans its cache.`);
    console.error(`  Install bun permanently for reliability: curl -fsSL https://bun.sh/install | bash`);
  }

  const binDir = join(POLARIS_DIR, "bin");
  const runnerPath = join(binDir, "run-daemon.sh");
  const daemonTsPath = join(
    POLARIS_DIR, "mcp", "node_modules", "@lightupai", "polaris", "src", "daemon", "daemon.ts"
  );

  await mkdir(binDir, { recursive: true });
  // Runner tries the baked-in path first (fast path), then falls back to
  // common stable install locations, then npx as a last resort — so the
  // service survives a cache prune or bun reinstall without needing
  // `polaris install` to be rerun.
  const runner = [
    "#!/bin/sh",
    `# Polaris daemon — managed by systemd (${SYSTEMD_SERVICE_NAME}.service)`,
    `DAEMONTS="${daemonTsPath}"`,
    `for BUNPATH in "${resolvedBun}" "$HOME/.bun/bin/bun" /usr/local/bin/bun /usr/bin/bun; do`,
    `  if [ -x "$BUNPATH" ]; then exec "$BUNPATH" run "$DAEMONTS"; fi`,
    `done`,
    `# npx fallback — slow but avoids exit-127 restart loops`,
    `exec npx --yes bun run "$DAEMONTS"`,
  ].join("\n") + "\n";
  await writeFile(runnerPath, runner);
  await chmod(runnerPath, 0o755);

  const secretLine = daemonSecret ? `Environment=POLARIS_DAEMON_SECRET=${daemonSecret}\n` : "";
  const unit = `[Unit]
Description=Polaris daemon
After=network.target

[Service]
Type=simple
ExecStart=${runnerPath}
Restart=always
RestartSec=5
${secretLine}Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;

  await mkdir(SYSTEMD_USER_DIR, { recursive: true });
  await writeFile(SYSTEMD_SERVICE_FILE, unit);

  // Stop any existing manually-started daemon so it releases port 4322
  // before systemd takes over
  await killExistingDaemon();

  // systemctl --user requires XDG_RUNTIME_DIR, which may not be set in SSH
  // sessions. Derive it from the UID so commands work without a login session.
  const uid = Bun.spawnSync(["id", "-u"], { stdout: "pipe" }).stdout.toString().trim();
  const xdgEnv = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}` };
  const sc = (args: string[]) =>
    Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "pipe", stderr: "pipe", env: xdgEnv });

  // Reload unit files, enable (start-at-login) and start/restart the service
  sc(["daemon-reload"]);
  sc(["enable", SYSTEMD_SERVICE_NAME]);
  sc(["restart", SYSTEMD_SERVICE_NAME]);

  // Verify the service came up
  const check = sc(["is-active", SYSTEMD_SERVICE_NAME]);
  const activeState = check.stdout.toString().trim();
  if (activeState !== "active") {
    // Check if it's a D-Bus connectivity issue (SSH without login session)
    const busError = check.stderr.toString().includes("No medium") ||
                     check.stderr.toString().includes("No such file") ||
                     check.exitCode === 1 && activeState === "";
    if (busError) {
      console.error(`  Warning: could not verify daemon status over SSH (no D-Bus session).`);
      console.error(`  The service was written and enabled — it should start automatically at next login.`);
      console.error(`  To start it now: export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user restart ${SYSTEMD_SERVICE_NAME}`);
    } else {
      console.error(`  Warning: daemon service did not start. Check logs:`);
      const journal = Bun.spawnSync(
        ["journalctl", "--user", "-u", SYSTEMD_SERVICE_NAME, "-n", "20", "--no-pager"],
        { stdout: "pipe", stderr: "ignore", env: xdgEnv }
      );
      console.error(journal.stdout.toString().trim());
      console.error(`  Try manually: systemctl --user restart ${SYSTEMD_SERVICE_NAME}`);
    }
  }

  // Enable lingering so the user service survives logout and starts at boot
  // (best-effort — requires sudo-less loginctl or appropriate privileges)
  Bun.spawnSync(["loginctl", "enable-linger"], { stdout: "ignore", stderr: "ignore", env: xdgEnv });
}

async function removeSystemdService(): Promise<void> {
  Bun.spawnSync(["systemctl", "--user", "disable", "--now", SYSTEMD_SERVICE_NAME], { stdout: "ignore", stderr: "ignore" });
  try { await rm(SYSTEMD_SERVICE_FILE); } catch { /* already gone */ }
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stdout: "ignore", stderr: "ignore" });
}

// Platform dispatcher
// --- Session state migration ---
//
// When upgrading from a pre-0.0.109 daemon (which never wrote daemon-state.json),
// the new daemon would start with an empty session map and drop every connected
// session. This function fetches the running daemon's session list via GET /status
// and writes daemon-state.json before the daemon is stopped, so the new daemon
// can restore the map and reconnect cloud WebSockets without any user action.
// Best-effort: failures are silent (daemon may not be running, or already migrated).
async function migrateSessionState(): Promise<void> {
  const stateFile = join(POLARIS_DIR, "sessions", "daemon-state.json");
  // If a 0.0.109+ daemon already wrote the file, its state is more complete
  // (includes learned hook aliases) — don't overwrite it.
  try { await readFile(stateFile); return; } catch { /* doesn't exist — proceed */ }

  try {
    const config = await loadConfig();
    const secret = resolveDaemonSecret(config);
    const headers: Record<string, string> = {};
    if (secret) headers["x-polaris-daemon-secret"] = secret;
    const res = await fetch("http://127.0.0.1:4322/status", {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    const data = await res.json() as { sessions?: Array<{ ccSessionId: string; project: string; session: string; user: string }> };
    if (!data.sessions || data.sessions.length === 0) return;

    const activeProfile = config?.active || "";
    const sessions = data.sessions.map((s) => ({
      ccSessionId: s.ccSessionId,
      project: s.project,
      session: s.session,
      user: s.user,
      agent: "agent:claude",
      profile: activeProfile,
    }));

    await mkdir(join(POLARIS_DIR, "sessions"), { recursive: true });
    await writeFile(stateFile, JSON.stringify({ sessions }));
    console.log(`  ✓ Migrated ${sessions.length} active session(s) to persistent state`);
  } catch { /* best-effort — daemon not running or unreachable */ }
}

async function installDaemonService(daemonSecret?: string): Promise<void> {
  // Migrate session state from older daemon before it is stopped
  await migrateSessionState();
  if (process.platform === "darwin") return installLaunchAgent(daemonSecret);
  if (process.platform === "linux") return installSystemdService(daemonSecret);
  // Windows and others: no managed service; daemon is started manually
}

async function removeDaemonService(): Promise<void> {
  if (process.platform === "darwin") return removeLaunchAgent();
  if (process.platform === "linux") return removeSystemdService();
}

function daemonServiceLabel(): string {
  if (process.platform === "darwin") return "launchd (auto-restarts on crash, starts at login)";
  if (process.platform === "linux") return "systemd user service (auto-restarts on crash, starts at login)";
  return "background process";
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
    ["npm", "install", "--prefix", mcpDir, "@lightupai/polaris@latest"],
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
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename polaris_rename_session polaris_update
argument-hint: [join #channel [session-name] | rename <new-name> | rename-session <name> | disconnect | update | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**\`/polaris join #channel-name [session-name]\`** — Connect to a channel:
1. Call \`polaris_connect\` with the given project, user identity ${identity}, and optional \`session\` name (e.g. \`auth-feature\`, \`bugfix-154\`)
2. A session name is auto-generated if not provided
3. Report the connection status including the session name

**\`/polaris rename <new-name>\`** — Rename the current **project** (and its Slack channel):
1. Call \`polaris_rename\` with the new name
2. Report the result

**\`/polaris rename-session <new-name>\`** — Rename this **session thread** only (not the project):
1. Call \`polaris_rename_session\` with the new name
2. Report the result

**\`/polaris update\`** — Update Polaris to the latest version:
1. Call \`polaris_update\`
2. Report what changed and remind the user to restart Claude Code if the MCP server was updated

**\`/polaris disconnect\`** — Disconnect:
1. Call \`polaris_disconnect\`
2. Confirm disconnection

**\`/polaris\`** (no arguments) — Show status:
1. Call \`polaris_status\`
2. Display the current connection state

### Daemon

The Polaris daemon runs locally and is managed automatically — do NOT manually configure launchd or systemd. If the user reports the daemon is down or not starting at login, tell them to run \`polaris install\` which sets up auto-restart (launchd on macOS, systemd user service on Linux).

### Arguments: $ARGUMENTS
`;
  await writeFile(join(skillDir, "SKILL.md"), skillContent);
  console.log("  ✓ /polaris skill written");

  // Add ~/.polaris/mcp/node_modules/.bin to PATH in shell rc files so
  // `polaris login` works without specifying the full path (especially on Linux
  // where npm global bin is often not in PATH).
  await ensureInPath(join(mcpDir, "node_modules", ".bin"));
  console.log("  ✓ polaris added to PATH (open a new shell or run: source ~/.bashrc)");
}

async function ensureInPath(binDir: string): Promise<void> {
  const marker = "# Added by polaris install";
  const snippet = `\n${marker}\nexport PATH="${binDir}:$PATH"\n`;

  const rcFiles: string[] = [];
  if (process.platform === "darwin") {
    rcFiles.push(join(homedir(), ".zshrc"), join(homedir(), ".bash_profile"));
  } else {
    rcFiles.push(join(homedir(), ".bashrc"), join(homedir(), ".profile"));
  }

  for (const rc of rcFiles) {
    try {
      let existing = "";
      try { existing = await readFile(rc, "utf-8"); } catch { /* file may not exist */ }
      if (existing.includes(marker)) continue; // already added
      await writeFile(rc, existing + snippet, "utf-8");
    } catch { /* non-fatal */ }
  }
}

// --- Login ---

// Validate a raw token against the server, save it to config, and write the
// legacy credentials file. Called by both the browser OAuth flow and
// `polaris login --token <value>`.
async function saveAuthToken(token: string, appUrl: string, profileName?: string) {
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

  // Save to profile — keyed by email unless an explicit --profile name was given
  const config = await loadConfig();
  const profileKey = profileName ?? userInfo.email;
  config.profiles[profileKey] = {
    api: appToApi(appUrl),
    app: appUrl,
    token,
    email: userInfo.email,
    name: userInfo.name,
    org_id: userInfo.org_id,
    participant_id: userInfo.participant_id,
  };
  config.active = profileKey;
  await saveConfig(config);

  // Also write legacy credentials.json for backward compat (daemon reads it)
  await writeFile(LEGACY_CREDENTIALS_FILE, JSON.stringify({
    token,
    ...userInfo,
    service_url: appUrl,
  }, null, 2));

  console.log(`  ✓ Logged in as ${userInfo.email}`);
  return userInfo;
}

async function login(appUrl: string, profileName?: string, loginHint?: string) {
  // Profile key is determined after auth (we use the email). profileName is an
  // explicit override (e.g. --profile flag); otherwise we'll use userInfo.email.

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
  let authUrl = `${appUrl}/auth/cli?port=${callbackPort}`;
  if (loginHint) authUrl += `&login_hint=${encodeURIComponent(loginHint)}`;

  console.log(`  Opening browser for Google sign-in...`);
  console.log(`  If the browser doesn't open, visit:\n  ${authUrl}\n`);

  Bun.spawn(
    process.platform === "darwin" ? ["open", authUrl] :
    process.platform === "win32" ? ["cmd", "/c", "start", authUrl] :
    ["xdg-open", authUrl],
    { stdout: "ignore", stderr: "ignore" }
  );

  // Race: automatic callback delivery (same machine) vs. manual token paste.
  // The browser page shows the token prominently when delivery fails (e.g. SSH).
  process.stdout.write("  Waiting for browser… (if the browser shows a token, paste it here and press Enter)\n  > ");
  let resolveStdin!: (token: string) => void;
  const stdinPromise = new Promise<string>((resolve) => { resolveStdin = resolve; });
  const stdinBuf: string[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    stdinBuf.push(chunk);
    const full = stdinBuf.join("");
    const nl = full.indexOf("\n");
    if (nl !== -1) {
      const t = full.slice(0, nl).trim();
      if (t) resolveStdin(t);
    }
  });

  const token = await Promise.race([tokenPromise, stdinPromise]);
  process.stdin.removeAllListeners("data");
  process.stdin.pause();
  callbackServer.stop(true);

  const userInfo = await saveAuthToken(token, appUrl, profileName);

  // Re-install skill with personalized participant ID
  await mkdir(join(CLAUDE_DIR, "skills", "polaris"), { recursive: true });
  const identity = `\`${userInfo.participant_id}\``;
  const skillDir = join(CLAUDE_DIR, "skills", "polaris");
  const skillContent = `---
name: polaris
description: Connect to a Polaris multiplayer collaboration session
allowed-tools: polaris_connect polaris_disconnect polaris_status polaris_reply polaris_context polaris_rename polaris_rename_session polaris_update
argument-hint: [join #channel [session-name] | rename <new-name> | rename-session <name> | disconnect | update | (no args for status)]
---

## Polaris — Multiplayer Collaboration

Manage your connection to a Polaris collaboration session.

### Commands

Based on the arguments provided, do ONE of the following:

**\`/polaris join #channel-name [session-name]\`** — Connect to a channel:
1. Call \`polaris_connect\` with the given project, user identity ${identity}, and optional \`session\` name (e.g. \`auth-feature\`, \`bugfix-154\`)
2. A session name is auto-generated if not provided
3. Report the connection status including the session name

**\`/polaris rename <new-name>\`** — Rename the current **project** (and its Slack channel):
1. Call \`polaris_rename\` with the new name
2. Report the result

**\`/polaris rename-session <new-name>\`** — Rename this **session thread** only (not the project):
1. Call \`polaris_rename_session\` with the new name
2. Report the result

**\`/polaris update\`** — Update Polaris to the latest version:
1. Call \`polaris_update\`
2. Report what changed and remind the user to restart Claude Code if the MCP server was updated

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

// Accepts an email address or a legacy profile key. If the account isn't
// found locally, starts the login flow (with login_hint pre-filled).
async function use(arg: string) {
  const config = await loadConfig();

  // 1. Direct key match (backward compat with old "prod" / "local" style names)
  let matchedKey: string | undefined;
  if (config.profiles[arg]) {
    matchedKey = arg;
  } else {
    // 2. Search by email field
    const entry = Object.entries(config.profiles).find(([, p]) => p.email === arg);
    if (entry) matchedKey = entry[0];
  }

  if (matchedKey) {
    config.active = matchedKey;
    await saveConfig(config);
    const profile = config.profiles[matchedKey];
    // Update legacy credentials.json for daemon
    await writeFile(LEGACY_CREDENTIALS_FILE, JSON.stringify({
      token: profile.token,
      email: profile.email,
      name: profile.name,
      org_id: profile.org_id,
      participant_id: profile.participant_id,
      service_url: profile.app,
    }, null, 2));
    console.log(`Active account: ${profile.email}`);
    console.log("Restart the daemon for this to take effect.");
    return;
  }

  // 3. Not found locally — start auth (pre-fill email hint when it looks like
  //    an email address so Google can skip account selection)
  console.log(`Account "${arg}" not found locally. Starting authentication...\n`);
  const isEmail = arg.includes("@");
  await login(DEFAULT_APP_URL, undefined, isEmail ? arg : undefined);
  console.log("\n✓ Login complete!");
  // Replace daemon so new credentials are picked up immediately
  await killExistingDaemon();
  const daemonPath = join(import.meta.dir, "..", "daemon", "daemon.ts");
  Bun.spawn(["bun", "run", daemonPath], {
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env },
  }).unref?.();
  console.log("  ✓ Daemon started in background");
}

// --- Profiles ---

async function profiles() {
  const config = await loadConfig();
  const keys = Object.keys(config.profiles);
  if (keys.length === 0) {
    console.log("No accounts configured. Run: polaris login");
    return;
  }
  console.log("Accounts:\n");
  for (const key of keys) {
    const p = config.profiles[key];
    const active = key === config.active ? " (active)" : "";
    // Use email as the primary label; show key only when it differs (legacy style)
    const label = p.email || key;
    const keyHint = p.email && key !== p.email ? ` [key: ${key}]` : "";
    console.log(`  ${label}${active}${keyHint}`);
    if (p.name) console.log(`    Name: ${p.name}`);
    console.log(`    API:  ${p.api}`);
    console.log("");
  }
  console.log(`Use \`polaris use <email>\` to switch accounts.`);
}

// --- Daemon ---

async function killExistingDaemon(): Promise<void> {
  // Ask the running daemon to shut down gracefully via the HTTP API, then
  // wait briefly for the port to free up. Falls back silently if no daemon
  // is running or the port is already free.
  try {
    const secret = await ensureDaemonSecret();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["x-polaris-daemon-secret"] = secret;
    await fetch("http://127.0.0.1:4322/shutdown", { method: "POST", headers }).catch(() => {});
  } catch { /* no daemon running */ }
  // Give it a moment to exit, then kill any straggler by port
  await new Promise((r) => setTimeout(r, 500));
  try {
    Bun.spawnSync(["sh", "-c", "lsof -ti :4322 | xargs kill -9 2>/dev/null || true"]);
  } catch { /* best-effort */ }
}

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
  const config = await loadConfig();
  const profile = getActiveProfile(config);
  if (!profile) {
    console.log("Not logged in. Run: polaris login");
  } else if (isTokenExpired(profile.token)) {
    console.log(`Profile: ${config.active} (${profile.api})`);
    console.log(`User: ${profile.name} (${profile.email})`);
    console.log("🚨 Token expired. Run: polaris login");
  } else {
    console.log(`Profile: ${config.active} (${profile.api})`);
    console.log(`User: ${profile.name} (${profile.email})`);
    console.log("Token: valid");
  }

  // Daemon (send the shared local secret when configured — the daemon
  // requires it on all endpoints once one is resolved)
  try {
    const secret = resolveDaemonSecret(config);
    const res = await fetch("http://127.0.0.1:4322/status", {
      headers: secret ? { "x-polaris-daemon-secret": secret } : undefined,
    });
    const data = (await res.json()) as { ok: boolean; sessions?: Array<{ ccSessionId: string; project: string; session: string; user: string; profile?: string; wsState?: string }> };
    if (data.ok) {
      console.log("\nDaemon: running");
      if (data.sessions && data.sessions.length > 0) {
        const allProfiles = config.profiles ?? {};
        console.log(`Active sessions (${data.sessions.length}):`);
        for (const s of data.sessions) {
          const profileEmail = s.profile ? (allProfiles[s.profile]?.email ?? s.profile) : undefined;
          const acct = profileEmail ? ` [${profileEmail}]` : "";
          const ws = s.wsState ? ` ws:${s.wsState}` : "";
          console.log(`  ${s.project}/${s.session} as ${s.user}${acct}${ws}`);
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

interface RecoverRoute {
  project: string;
  session: string;
  user: string;
  agent: string;
  profileKey: string; // which account owns this session
}

interface RecoverCandidate {
  project: string;
  session: string;
  profileKey: string;
  sender: string;
  payload: Record<string, unknown>;
  ts?: string; // ISO timestamp from the log entry
}

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

async function recover(dryRun = false, debug = false) {
  try {
    const logDir = join(POLARIS_DIR, "logs");
    // Only scan logs from v0.0.105+ (2026-10-13), when project/session context
    // fields were added. Older entries can never be routed to a session.
    const RECOVER_CUTOFF = "2026-10-13";
    let files: string[] = [];
    try {
      files = (await readdir(logDir))
        .filter((f) => f.endsWith(".jsonl") && f >= `daemon-${RECOVER_CUTOFF}.jsonl`)
        .sort();
    } catch { /* no log dir */ }
    if (files.length === 0) {
      console.log("No local logs found in ~/.polaris/logs — nothing to recover.");
      return;
    }

    // Load all profiles so we can use the right token for each session's account.
    const config = await loadConfig();
    const allProfiles = config.profiles ?? {} as Record<string, Profile>;
    // Active profile is the fallback when a session's account can't be determined.
    // May be null when running in a sandboxed environment with no credentials.
    const activeProfile = getActiveProfile(config);
    const activeKey = config.active || "";

    // --- Pass 1: walk logs chronologically, learning routes and collecting candidates ---
    //
    // Route-learning strategy (in priority order):
    //   1. /connect entry with explicit session name -> full route (project, session, user, agent, profile)
    //   2. /connect entry with auto-generated session -> partial (user, agent, project, profile); session learned later
    //   3. /events entry with explicit context fields (project, session, ccSessionId) ->
    //      complete any matching partial route; or construct route using profile participant_id as fallback

    const routes = new Map<string, RecoverRoute>(); // keyed by any known ccSessionId / hook session_id
    const routeByPair = new Map<string, RecoverRoute>(); // secondary index keyed by "project/session"

    // Partial routes from /connect entries where session was auto-generated.
    // Keyed by MCP UUID. Session name is learned later from event context fields.
    interface PartialRoute { user: string; agent: string; project: string; profileKey: string }
    const partials = new Map<string, PartialRoute>(); // keyed by MCP UUID

    const addRoute = (key: string, route: RecoverRoute) => {
      routes.set(key, route);
      routeByPair.set(`${route.project}/${route.session}`, route);
    };

    // Resolve a route for an event. entryProject/entrySession come from the daemon's
    // explicit context fields (written since v0.0.105) and handle multi-session + auto-generated names.
    const routeFor = (sessionId: string, entryProject?: string, entrySession?: string): RecoverRoute | undefined => {
      // 1. Exact ccSessionId / hook session_id match
      const exact = routes.get(sessionId);
      if (exact) return exact;

      // 2. Single-session fallback (MCP UUID != hook session_id, only one session active)
      if (routes.size === 1 && !entryProject) return routes.values().next().value;

      // 3. Context-based lookup: daemon wrote project/session into the log entry
      if (entryProject && entrySession) {
        const byPair = routeByPair.get(`${entryProject}/${entrySession}`);
        if (byPair) return byPair;

        // 4. Auto-generated session: find a partial /connect for this project and
        //    construct the route using the session name from the event context.
        for (const [, partial] of partials) {
          if (partial.project === entryProject) {
            const route: RecoverRoute = {
              project: entryProject,
              session: entrySession,
              user: partial.user,
              agent: partial.agent,
              profileKey: partial.profileKey,
            };
            addRoute(sessionId, route);
            return route;
          }
        }

        // 5. Last resort: project/session are known from context but we have no /connect
        //    entry for this session (e.g. very old logs). Use the active profile's identity.
        if (!activeProfile) return undefined;
        const route: RecoverRoute = {
          project: entryProject,
          session: entrySession,
          user: activeProfile.participant_id,
          agent: "agent:claude",
          profileKey: activeKey,
        };
        addRoute(sessionId, route);
        return route;
      }

      return undefined;
    };

    const candidates: RecoverCandidate[] = [];
    const seen = new Set<string>();
    let scanned = 0;
    let unroutable = 0;

    if (!dryRun) {
      console.log(`Scanning ${files.length} log file(s) (from ${RECOVER_CUTOFF})...`);
    }

    for (const [fileIdx, file] of files.entries()) {
      if (!dryRun) {
        process.stdout.write(`  [${fileIdx + 1}/${files.length}] ${file}\n`);
      }
      let text: string;
      try {
        text = await readFile(join(logDir, file), "utf-8");
      } catch { continue; }

      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let entry: { endpoint?: string; payload?: Record<string, unknown>; project?: string; session?: string; ccSessionId?: string; t?: string; ts?: string };
        try { entry = JSON.parse(line); } catch { continue; }
        const payload = entry.payload;
        if (!payload || typeof payload !== "object") continue;

        if (entry.endpoint === "/connect") {
          const c = payload as { ccSessionId?: string; project?: string; session?: string; user?: string; agent?: string; profile?: string };
          if (!c.ccSessionId || !c.project || !c.user) continue;
          // profile in /connect body is the profile key (email / active name).
          // Skip profiles with expired tokens — fall back to the active profile so
          // recover still works even when the session's original profile is stale.
          const profileKey =
            c.profile && allProfiles[c.profile] && !isTokenExpired(allProfiles[c.profile].token)
              ? c.profile
              : activeKey;
          if (c.session) {
            // Explicit session name -- full route learned immediately
            addRoute(c.ccSessionId, {
              project: c.project,
              session: c.session,
              user: c.user,
              agent: c.agent || "agent:claude",
              profileKey,
            });
          } else {
            // Auto-generated session -- session name is assigned by the daemon after
            // this log entry is written. Save partial info; session is learned from
            // the first event entry that carries explicit context fields.
            partials.set(c.ccSessionId, {
              user: c.user,
              agent: c.agent || "agent:claude",
              project: c.project,
              profileKey,
            });
          }
          continue;
        }

        if (entry.endpoint === "/events") {
          const hookEvent = payload.hook_event_name;
          const sessionId = payload.session_id;
          if (typeof hookEvent !== "string" || typeof sessionId !== "string") continue;
          // Skip error-response duplicates (relay failures are logged twice)
          if ((entry as Record<string, unknown>).response !== undefined) continue;
          const key = `events:${JSON.stringify(payload)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          scanned++;

          const route = routeFor(sessionId, entry.project, entry.session);
          if (!route) { unroutable++; continue; }

          const sender = hookEvent === "UserPromptSubmit" ? route.user : route.agent;
          candidates.push({ project: route.project, session: route.session, profileKey: route.profileKey, sender, payload, ts: entry.t ?? entry.ts });
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
          if (!route) { unroutable++; continue; }
          candidates.push({
            project: route.project,
            session: route.session,
            profileKey: route.profileKey,
            sender: route.agent,
            payload: { hook_event_name: "Stop", session_id: r.ccSessionId, stop_response: r.message },
            ts: entry.t ?? entry.ts,
          });
        }
      }
    }

    // --- Pass 2: per session, fetch upstream and re-POST what's missing ---
    // Group by (project, session, profileKey) so each group uses the right account.
    const groups = new Map<string, RecoverCandidate[]>();
    for (const c of candidates) {
      const key = `${c.project}\x00${c.session}\x00${c.profileKey}`;
      const group = groups.get(key) ?? [];
      if (!groups.has(key)) groups.set(key, group);
      group.push(c);
    }

    let totalMissing = 0;
    let totalRestored = 0;
    let notFoundSessions = 0;

    const hr = "─".repeat(45);

    if (dryRun) {
      console.log(`Polaris Recover (dry run)`);
      console.log(hr);
      console.log(`Scanning ${files.length} log file(s)... ${scanned} event(s) across ${groups.size} session(s)\n`);
    } else {
      console.log(`\nFound ${scanned} event(s) across ${groups.size} session(s). Checking upstream...`);
    }

    let groupIdx = 0;
    for (const group of groups.values()) {
      groupIdx++;
      const { project, session, profileKey } = group[0];
      const profileData = allProfiles[profileKey] ?? activeProfile;
      if (!profileData) {
        unroutable += group.length;
        continue;
      }
      const apiHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${profileData.token}`,
      };
      const apiUrl = profileData.api;

      if (dryRun) {
        // In dry-run mode, count candidates without fetching upstream —
        // show worst-case (all in log, may already be upstream).
        const account = profileData.email ?? profileKey ?? "unknown account";
        const timestamps = group.map(c => c.ts).filter((t): t is string => !!t).sort();
        let dateRange = "";
        if (timestamps.length > 0) {
          const fmt = (iso: string) => {
            const d = new Date(iso);
            return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
          };
          const oldest = timestamps[0];
          const newest = timestamps[timestamps.length - 1];
          dateRange = oldest === newest ? fmt(oldest) : `${fmt(oldest)} – ${fmt(newest)}`;
        }
        const label = `  ${project} / ${session}`;
        const acct = `[${account}]`;
        const pad = Math.max(1, 46 - label.length - acct.length);
        console.log(`${label}${" ".repeat(pad)}${acct}`);
        const detail = `  ${group.length} event(s)${dateRange ? `  ·  ${dateRange}` : ""}`;
        console.log(detail + "\n");
        totalMissing += group.length;
        continue;
      }

      const linePrefix = `  [${groupIdx}/${groups.size}] ${project}/${session}`;
      process.stdout.write(`${linePrefix}...`);

      const messagesUrl = `${apiUrl}/projects/${project}/sessions/${session}/messages`;
      let upstream: Array<{ id?: string; payload?: Record<string, unknown> }> = [];
      let sessionExistsUpstream = true;
      try {
        const res = await fetch(messagesUrl, { headers: apiHeaders });
        if (res.ok) {
          upstream = (await res.json()) as typeof upstream;
        } else if (res.status === 404) {
          // Session doesn't exist upstream — test artifact or deleted session. Skip quietly.
          sessionExistsUpstream = false;
          if (debug) {
            const body = await res.text().catch(() => "(unreadable)");
            process.stdout.write(`\n  DEBUG GET ${messagesUrl} → 404 ${body.slice(0, 300)}\n`);
          }
        } else if (debug) {
          const body = await res.text().catch(() => "(unreadable)");
          process.stdout.write(`\n  DEBUG GET ${messagesUrl} → ${res.status} ${body.slice(0, 300)}\n`);
        }
        // Other HTTP errors: proceed with empty upstream and try to re-POST
      } catch (err) {
        if (debug) process.stdout.write(`\n  DEBUG GET ${messagesUrl} → network error: ${err}\n`);
        /* network error: proceed with empty upstream */
      }

      if (!sessionExistsUpstream) {
        process.stdout.write(` not found\n`);
        notFoundSessions++;
        continue;
      }

      const PROGRESS_BATCH = 50; // emit a progress tick every N posts
      let sessionMissing = 0;
      let sessionRestored = 0;
      const sessionErrors = new Map<string, number>(); // status -> count
      for (const c of group) {
        if (isPresentUpstream(c.payload, upstream)) continue;
        sessionMissing++;
        try {
          const res = await fetch(`${apiUrl}/projects/${project}/sessions/${session}/events`, {
            method: "POST",
            headers: apiHeaders,
            body: JSON.stringify({ sender: c.sender, payload: c.payload, ...(c.ts ? { at: c.ts } : {}) }),
          });
          if (res.ok) {
            sessionRestored++;
          } else {
            const key = String(res.status);
            sessionErrors.set(key, (sessionErrors.get(key) ?? 0) + 1);
          }
        } catch (err) {
          const key = err instanceof Error ? err.message.split("\n")[0] : "network error";
          sessionErrors.set(key, (sessionErrors.get(key) ?? 0) + 1);
        }
        if (sessionMissing % PROGRESS_BATCH === 0) {
          process.stdout.write(`\r${linePrefix}... ${sessionMissing} posted`);
        }
      }
      totalMissing += sessionMissing;
      totalRestored += sessionRestored;
      if (sessionErrors.size > 0) {
        const errSummary = [...sessionErrors.entries()].map(([k, n]) => `${n}×${k}`).join(", ");
        process.stdout.write(`\r${linePrefix}... ${sessionRestored}/${sessionMissing} restored (${errSummary})\n`);
      } else if (sessionMissing > 0) {
        process.stdout.write(`\r${linePrefix}... ${sessionMissing} restored\n`);
      } else {
        process.stdout.write(`\r${linePrefix}... in sync\n`);
      }
    }

    if (dryRun) {
      console.log(hr);
      console.log(`Up to ${totalMissing} event(s) would be restored.`);
      console.log(`Events already in sync are filtered out at run time.`);
      if (unroutable > 0) console.log(`${unroutable} event(s) had no session match and will be skipped.`);
      console.log(`\nRun \`polaris recover\` to restore.`);
    } else {
      console.log(`\nRecover: ${scanned} scanned, ${totalMissing} missing upstream, ${totalRestored} restored.`);
      if (notFoundSessions > 0) console.log(`${notFoundSessions} session(s) not found upstream (test artifacts or deleted sessions — skipped).`);
      if (unroutable > 0) console.log(`Skipped ${unroutable} event(s) with no recoverable project/session mapping.`);
      if (totalMissing > totalRestored) console.log(`${totalMissing - totalRestored} event(s) could not be restored (API unreachable or rejected).`);
    }
  } catch (err) {
    console.error(`Recover failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Logout ---

async function logout(all = false) {
  if (all) {
    await removeDaemonService();
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

// --- Feedback ---

const GITHUB_ISSUES_URL = "https://github.com/lightup-data/polaris/issues/new";

function openUrl(url: string): void {
  Bun.spawn(
    process.platform === "darwin" ? ["open", url] :
    process.platform === "win32" ? ["cmd", "/c", "start", url] :
    ["xdg-open", url],
    { stdout: "ignore", stderr: "ignore" }
  ).unref?.();
}

async function feedback(text?: string, label?: "bug" | "enhancement") {
  let version = "";
  try {
    const pkgPath = join(import.meta.dir, "..", "..", "package.json");
    ({ version } = JSON.parse(await readFile(pkgPath, "utf-8")) as { version: string });
  } catch { /* non-fatal */ }

  const params: Record<string, string> = {};
  if (text) {
    params.title = text;
    const versionLine = version ? `**polaris version:** ${version}\n\n` : "";
    params.body = `${versionLine}${text}`;
  }
  if (label) params.labels = label;

  const qs = new URLSearchParams(params).toString();
  const url = qs ? `${GITHUB_ISSUES_URL}?${qs}` : GITHUB_ISSUES_URL;

  openUrl(url);
  if (text) {
    console.log(`Opening GitHub with your feedback: "${text}"`);
  } else {
    console.log("Opening GitHub issues page...");
  }
  console.log(`\nIf the browser didn't open: ${url}`);
}

// --- Update check ---
// Warn if a newer version is available on npm. Best-effort: never blocks startup.

async function checkForUpdate(): Promise<void> {
  try {
    // Prefer the MCP local install version (the authoritative copy that `polaris update`
    // manages). Fall back to the running binary's package.json for legacy global installs.
    const mcpPkg = join(POLARIS_DIR, "mcp", "node_modules", "@lightupai", "polaris", "package.json");
    const runningPkg = join(import.meta.dir, "..", "..", "package.json");
    let current = "";
    for (const p of [mcpPkg, runningPkg]) {
      try { ({ version: current } = JSON.parse(await readFile(p, "utf-8")) as { version: string }); break; } catch { /* try next */ }
    }
    if (!current) return;
    const res = await fetch("https://registry.npmjs.org/@lightupai/polaris/latest", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const { version: latest } = await res.json() as { version: string };
    if (latest !== current) {
      console.error(`\n⚠  A newer version of Polaris is available: ${latest} (you have ${current})`);
      console.error("   Run: polaris update\n");
    }
  } catch { /* best-effort — network may be unavailable */ }
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

// No point warning about an update when the user is already running `polaris update`
if (command !== "update") void checkForUpdate();

switch (command) {
  case "install":
    console.log("Polaris — installing local components\n");
    await install();
    await installDaemonService(await ensureDaemonSecret());
    console.log(`  ✓ Daemon registered with ${daemonServiceLabel()}`);
    console.log("\nInstall complete.");
    break;

  case "login": {
    const appUrl = hasFlag("local") ? LOCAL_APP_URL : (getFlag("url") ?? DEFAULT_APP_URL);
    const profileName = getFlag("profile");
    const pastedToken = getFlag("token");
    console.log("Polaris — authenticating\n");
    if (pastedToken) {
      // Headless path: token was copy-pasted from another machine via `polaris token`
      await saveAuthToken(pastedToken, appUrl, profileName);
    } else {
      await login(appUrl, profileName);
    }
    console.log("\n✓ Login complete!");
    await installDaemonService(await ensureDaemonSecret());
    console.log(`  ✓ Daemon registered with ${daemonServiceLabel()}`);

    console.log("\nNext: restart Claude Code, then run `/polaris join #channel-name` in your AI agent.");
    break;
  }

  case "token": {
    // Print the active token for copy-paste to another machine.
    // Usage: polaris token   (on source machine)
    //        polaris login --token <paste>  (on target machine, no browser needed)
    const profile = await requireProfile();
    console.log(profile.token);
    break;
  }

  case "use":
    if (!args[1]) {
      console.error("Usage: polaris use <email>");
      process.exit(1);
    }
    await use(args[1]);
    break;

  case "profiles":
    await profiles();
    break;

  case "daemon":
    await killExistingDaemon();
    await daemon();
    break;

  case "status":
    await status();
    break;

  case "recover":
    await recover(hasFlag("dry-run") || hasFlag("dry"), hasFlag("debug"));
    break;

  case "update": {
    console.log("Polaris — updating\n");
    const mcpDir = join(POLARIS_DIR, "mcp");

    // Version of the running global binary
    // Check the local MCP install version (this is the authoritative binary —
    // ~/.polaris/mcp/node_modules/.bin/polaris is wired to PATH by `polaris install`).
    let mcpVersion = "";
    try {
      const pkg = JSON.parse(await readFile(join(mcpDir, "node_modules", "@lightupai", "polaris", "package.json"), "utf-8")) as { version: string };
      mcpVersion = pkg.version ?? "";
    } catch { /* not installed yet */ }

    let latestVersion = "";
    try {
      const res = await fetch("https://registry.npmjs.org/@lightupai/polaris/latest", { signal: AbortSignal.timeout(5000) });
      if (res.ok) ({ version: latestVersion } = await res.json() as { version: string });
    } catch { /* network unavailable */ }

    if (!latestVersion) {
      console.error("  ✗ Could not reach npm. Check your network connection.");
      process.exit(1);
    }

    if (latestVersion === mcpVersion) {
      console.log(`  Already up to date (v${mcpVersion}).`);
      break;
    }

    console.log(`  Updating v${mcpVersion || "?"} → v${latestVersion}...`);

    // Retry up to 4 times with backoff — npm registry can take a minute to propagate
    // a freshly published version to all mirrors (ETARGET = version not found yet).
    let npmResult: ReturnType<typeof Bun.spawnSync> | undefined;
    for (let attempt = 1; attempt <= 4; attempt++) {
      npmResult = Bun.spawnSync(
        ["npm", "install", "--prefer-online", "--prefix", mcpDir, `@lightupai/polaris@${latestVersion}`],
        { stdout: "ignore", stderr: "pipe" }
      );
      if (npmResult.exitCode === 0) break;
      const stderr = npmResult.stderr.toString();
      if (!stderr.includes("ETARGET") && !stderr.includes("notarget")) {
        // Not a propagation error — fail immediately
        console.error("  ✗ Update failed:\n" + stderr.trim());
        process.exit(1);
      }
      if (attempt < 4) {
        const wait = attempt * 15;
        console.log(`  Registry hasn't propagated v${latestVersion} yet — retrying in ${wait}s... (attempt ${attempt}/4)`);
        await Bun.sleep(wait * 1000);
      }
    }
    if (npmResult!.exitCode !== 0) {
      console.error(`  ✗ Update failed after 4 attempts — v${latestVersion} may still be propagating. Try again in a minute.`);
      process.exit(1);
    }

    console.log(`  ✓ Updated to v${latestVersion}`);
    console.log("  Re-wiring local components...\n");
    await install();
    await installDaemonService(await ensureDaemonSecret());

    console.log(`\n✓ Polaris updated to v${latestVersion}.`);
    console.log(`  Claude Code should restart the MCP server automatically. If tools seem stale, restart Claude Code.`);

    // If the running binary is a legacy global install (not the MCP bin), the PATH
    // change takes effect in the next shell. Don't remove the global binary — removing
    // it while the current shell still depends on it leaves the user stranded.
    const runningBin = process.execPath === Bun.which("bun") ? process.argv[1] : process.execPath;
    const runningViaMcp = runningBin.includes(join(".polaris", "mcp"));
    if (!runningViaMcp) {
      console.log(`  Open a new shell to switch to the updated binary at ~/.polaris/mcp/node_modules/.bin/polaris`);
    }
    break;
  }

  case "feedback": {
    const isBug = hasFlag("bug");
    const isFeature = hasFlag("feature");
    const label = isBug ? "bug" : isFeature ? "enhancement" : undefined;
    const text = args.slice(1).find(a => !a.startsWith("--"));
    await feedback(text, label);
    break;
  }

  case "logout":
    await logout(hasFlag("all"));
    break;

  case "connect": {
    const project = (args[1] ?? "").replace(/^#/, "");
    if (!project) {
      console.error("Usage: polaris connect <project> [session]");
      process.exit(1);
    }
    const profile = await requireProfile();
    const d = await daemonClient();
    const session = args[2];
    const result = await d.connect({
      ccSessionId: "cli",
      project,
      user: profile.participant_id,
      profile: profile.token,
      ...(session ? { session } : {}),
      ...(hasFlag("create") ? { create: true } : {}),
    });
    if (result.ok) {
      console.log(`Connected to #${result.project ?? project}/${result.session ?? session ?? ""} as ${profile.participant_id}`);
    } else if (result.httpStatus === 404 && result.error === "project_not_found") {
      console.error(`Project "#${project}" not found. Use --create to create it.`);
      if (result.existing?.length) console.error(`Available: ${result.existing.map(p => `#${p}`).join(", ")}`);
    } else if (result.httpStatus === 409 && result.error === "session_conflict") {
      const conflicting = (result as unknown as { conflicting?: string }).conflicting ?? "another session";
      console.error(`Session conflict: ${conflicting} is already active on #${project}/${result.session ?? session}.\nUse a different session name or disconnect the other instance.`);
    } else {
      console.error(`Failed to connect: ${result.error ?? "unknown error"}`);
    }
    break;
  }

  case "disconnect": {
    const d = await daemonClient();
    await d.disconnect("cli");
    console.log("Disconnected.");
    break;
  }

  case "send": {
    const targetSession = args[1];
    const message = args.slice(2).join(" ");
    if (!targetSession || !message) {
      console.error("Usage: polaris send <session> <message>");
      process.exit(1);
    }
    const d = await daemonClient();
    const result = await d.send("cli", targetSession, message);
    if (result.ok) {
      console.log(`Sent to ${result.to ?? targetSession}`);
    } else {
      console.error(`Failed to send: ${result.error ?? result.httpStatus}`);
    }
    break;
  }

  case "reply": {
    const message = args.slice(1).join(" ");
    if (!message) {
      console.error("Usage: polaris reply <message>");
      process.exit(1);
    }
    const d = await daemonClient();
    const ok = await d.reply("cli", message);
    console.log(ok ? "Reply sent." : "Failed to send reply.");
    break;
  }

  case "rename": {
    const oldName = args[1];
    const newName = args[2];
    if (!oldName || !newName) {
      console.error("Usage: polaris rename <old-name> <new-name>");
      process.exit(1);
    }
    const d = await daemonClient();
    const result = await d.rename(oldName, newName);
    console.log(result.ok ? `Renamed "${oldName}" to "${newName}".` : `Failed: ${result.error}`);
    break;
  }

  case "rename-session": {
    const newName = args[1];
    if (!newName) {
      console.error("Usage: polaris rename-session <new-name>");
      process.exit(1);
    }
    const d = await daemonClient();
    const result = await d.renameSession("cli", newName);
    console.log(result.ok ? `Session renamed to "${newName}".` : `Failed: ${result.error}`);
    break;
  }

  case "context": {
    const targetSession = args[1];
    if (!targetSession) {
      console.error("Usage: polaris context <session>");
      process.exit(1);
    }
    const d = await daemonClient();
    try {
      const events = await d.context("cli", targetSession);
      if (events.length === 0) { console.log("(no activity yet)"); break; }
      for (const e of events) {
        const p = e.payload as { prompt?: string; stop_response?: string; content?: string };
        const text = p.prompt ?? p.stop_response ?? p.content ?? JSON.stringify(p);
        console.log(`[${e.sender}] ${text}`);
      }
    } catch (err) {
      console.error(`Could not fetch context: ${err instanceof Error ? err.message : err}`);
    }
    break;
  }

  case "team": {
    const d = await daemonClient();
    try {
      const members = await d.team();
      if (members.length === 0) { console.log("No team members found."); break; }
      const taggable = members.filter((m) => m.slack_id && m.slack_handle);
      for (const m of taggable) {
        const alias = m.alias && m.alias !== m.slack_handle ? `@${m.alias} ` : "";
        console.log(`  ${alias}@${m.slack_handle} — ${m.name}${m.polaris_user ? " ✓" : ""}`);
      }
      const notTaggable = members.filter((m) => !m.slack_id);
      if (notTaggable.length) console.log(`\nNot on Slack: ${notTaggable.map(m => m.name).join(", ")}`);
    } catch {
      console.error("Failed to fetch team — is the daemon running?");
    }
    break;
  }

  case undefined:
    // Default: install + login
    console.log("Polaris — setting up your machine\n");
    console.log("[1/2] Installing local components...\n");
    await install();
    console.log("\n  Install complete. Run `polaris install` to repeat this step independently.\n");
    console.log("[2/2] Authenticating...\n");
    await login(DEFAULT_APP_URL);
    console.log("\n✓ Polaris is set up on this machine!");
    await installDaemonService(await ensureDaemonSecret());
    console.log(`  ✓ Daemon registered with ${daemonServiceLabel()}`);

    console.log("\nNext: restart Claude Code, then run `/polaris join #channel-name` in your AI agent.");
    break;

  default:
    console.log("Polaris CLI\n");
    console.log("Usage:");
    console.log("  polaris                        — install + login (default setup)");
    console.log("  polaris install                — install local components (no auth)");
    console.log("  polaris update                 — update to the latest version");
    console.log("  polaris login                  — authenticate (production)");
    console.log("  polaris login --local          — authenticate (local dev)");
    console.log("  polaris login --token <token>  — authenticate without a browser (SSH/headless)");
    console.log("  polaris token                  — print token for copy-paste to another machine");
    console.log("  polaris use <email>            — switch active account (triggers login if needed)");
    console.log("  polaris profiles               — list all accounts");
    console.log("  polaris daemon                 — start the local daemon");
    console.log("  polaris status                 — show connection status");
    console.log("  polaris connect <project> [session] [--create]  — connect to a project");
    console.log("  polaris disconnect             — disconnect current session");
    console.log("  polaris send <session> <msg>   — send a message to a session");
    console.log("  polaris reply <msg>            — reply to the floor in Slack");
    console.log("  polaris rename <old> <new>     — rename a project");
    console.log("  polaris rename-session <name>  — rename current session");
    console.log("  polaris context <session>      — show recent activity for a session");
    console.log("  polaris team                   — list team members");
    console.log("  polaris recover                — re-POST locally logged events missing upstream");
    console.log("  polaris feedback               — report a bug or request a feature");
    console.log("  polaris logout                 — remove active profile");
    console.log("  polaris logout --all           — remove all credentials");
}
