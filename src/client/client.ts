import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

// --- Configuration ---

const DAEMON_URL = process.env.POLARIS_DAEMON_URL ?? "http://127.0.0.1:4322";

// Shared local daemon-auth secret (installed by `polaris install`); sent as
// x-polaris-daemon-secret when present, else the daemon runs unauthenticated.
const DAEMON_SECRET = process.env.POLARIS_DAEMON_SECRET || null;

// Stable session ID for this MCP instance: explicit override, else Claude Code's
// session id if it exposes one, else a generated UUID (daemon learns the hook id as an alias).
const CC_SESSION_ID =
  process.env.POLARIS_CC_SESSION_ID ??
  process.env.CLAUDE_SESSION_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  crypto.randomUUID();

// --- Daemon communication ---

function daemonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (DAEMON_SECRET) headers["x-polaris-daemon-secret"] = DAEMON_SECRET;
  return headers;
}

async function daemonPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: daemonHeaders(),
    body: JSON.stringify(body),
  });
}

async function daemonGet(path: string): Promise<Response> {
  return fetch(`${DAEMON_URL}${path}`, { headers: daemonHeaders() });
}

// --- Session state persistence ---

function sessionStatePath(): string {
  const hash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  return `${homedir()}/.polaris/sessions/${hash}.json`;
}

async function saveSessionState(project: string, session: string, user: string, profile: string): Promise<void> {
  try {
    await mkdir(`${homedir()}/.polaris/sessions`, { recursive: true });
    await writeFile(sessionStatePath(), JSON.stringify({ project, session, user, profile, cwd: process.cwd() }));
  } catch { /* best-effort */ }
}

async function clearSessionState(): Promise<void> {
  try {
    await rm(sessionStatePath(), { force: true });
  } catch { /* best-effort */ }
}

async function loadSessionState(): Promise<{ project: string; session: string; user: string; profile: string } | null> {
  try {
    const data = JSON.parse(await readFile(sessionStatePath(), "utf-8"));
    if (data.project && data.session && data.user) return { ...data, profile: data.profile ?? "" };
  } catch { /* no saved state */ }
  return null;
}

async function loadActiveProfile(): Promise<string> {
  try {
    const data = JSON.parse(await readFile(`${homedir()}/.polaris/config.json`, "utf-8"));
    return data.active ?? "";
  } catch {
    return "";
  }
}

// --- Current connection state ---

let currentProject = "";
let currentSession = "";
let currentUser = "";
let currentProfile = "";

// --- MCP Server ---

const mcp = new Server(
  { name: "polaris", version: "0.0.1" },
  {
    capabilities: {
      // claude/channel push delivery is off by default — injects reach the
      // agent via the UserPromptSubmit hook (see daemon injectQueues). See
      // deliverInjectViaChannel below for the opt-in push scaffold.
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to Polaris — a multiplayer collaboration system. Messages from advisors and teammates may arrive as <channel source="polaris" from="..."> tags. Use /polaris commands to manage your session, or call the polaris tools directly.

If the user reports the Polaris daemon is not running or keeps crashing, tell them to run \`polaris install\` — it registers the daemon with launchd on macOS or a systemd user service on Linux for auto-restart on crash and at login. Do NOT suggest manually configuring launchd or systemd — \`polaris install\` handles it.`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "polaris_connect",
      description: "Connect this session to an existing Polaris project. Use create:true to create a new project.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Project workspace to join (e.g., #my-project). Omit to list existing projects." },
          user: { type: "string", description: "Your participant ID (e.g., user:manu)" },
          session: { type: "string", description: "Session name (optional — auto-generated if omitted)" },
          agent: { type: "string", description: "Agent identity (optional — defaults to agent:claude)" },
          create: { type: "boolean", description: "Create the project if it doesn't exist (default: false). Only set true when explicitly starting a new project." },
        },
        required: ["user"],
      },
    },
    {
      name: "polaris_disconnect",
      description: "Disconnect from the current Polaris session.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "polaris_status",
      description: "Show current Polaris connection status.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "polaris_reply",
      description: "Send a message to the project floor (visible to all advisors, and to the linked Slack channel if a floor is connected).",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: { type: "string", description: "Message to send" },
        },
        required: ["message"],
      },
    },
    {
      name: "polaris_rename",
      description: "Rename the current project. Also renames the linked Slack channel if a floor is connected.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "New project name" },
        },
        required: ["name"],
      },
    },
    {
      name: "polaris_context",
      description: "Fetch activity from a sibling session in this project. Use this to see what other drivers have been doing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session: { type: "string", description: "Name of the sibling session to fetch context from" },
        },
        required: ["session"],
      },
    },
    {
      name: "polaris_team",
      description: "List team members with their Slack identities. Use this to resolve @mentions before posting to Slack.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "polaris_backfill",
      description: "Recover lost events from local daemon logs. Use when events were lost due to disconnection or API downtime.",
      inputSchema: {
        type: "object" as const,
        properties: {
          duration: { type: "string", description: "Time range to backfill (e.g., '2h', '30m', '1d'). Auto-detects if omitted." },
          from: { type: "string", description: "ISO timestamp to backfill from. Overrides duration." },
        },
      },
    },
  ],
}));

// --- claude/channel push adapter (SCAFFOLD — off by default) ---
// With POLARIS_ENABLE_CHANNEL=1, push an inject to Claude Code in real time via an
// experimental claude/channel notification instead of waiting for the next
// UserPromptSubmit hook. Off by default (needs Claude Code to allowlist the channel);
// the hook path stays the primary delivery mechanism. Best-effort -> returns false.
export async function deliverInjectViaChannel(
  content: string,
  meta: Record<string, unknown> = {}
): Promise<boolean> {
  if (process.env.POLARIS_ENABLE_CHANNEL !== "1") return false;
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
    return true;
  } catch {
    return false; // hook-based delivery still applies
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "polaris_connect") {
    const { channel, user, session, agent, create } = args as { channel?: string; user: string; session?: string; agent?: string; create?: boolean };

    // If no channel specified, list available channels
    if (!channel) {
      try {
        const res = await daemonGet("/channels");
        if (res.ok) {
          const body = await res.json() as { channels: string[] };
          if (body.channels.length === 0) {
            return { content: [{ type: "text", text: "No projects found. Create one with: `/polaris join #my-project` with create:true" }] };
          }
          return { content: [{ type: "text", text: `Available projects:\n${body.channels.map(c => `  ${c}`).join("\n")}\n\nJoin one with: /polaris join #project-name` }] };
        }
      } catch { /* fall through */ }
      return { content: [{ type: "text", text: "Specify a project: `/polaris join #my-project`" }] };
    }

    const project = channel.replace(/^#/, ""); // strip leading # if present
    const activeProfile = await loadActiveProfile();
    try {
      const res = await daemonPost("/connect", {
        ccSessionId: CC_SESSION_ID,
        project,
        user,
        profile: activeProfile,
        ...(session ? { session } : {}),
        ...(agent ? { agent } : {}),
        ...(create ? { create: true } : {}),
      });
      const body = await res.json() as { status?: string; project?: string; session?: string; user?: string; agent?: string; error?: string; existing?: string[]; account?: string };
      if (res.status === 404 && body.error === "project_not_found") {
        const accountLine = body.account ? ` in ${body.account}` : "";
        const list = body.existing && body.existing.length > 0
          ? `\n\nAvailable projects:\n${body.existing.map(p => `  #${p}`).join("\n")}`
          : "\n\nNo projects exist yet in this account.";
        return { content: [{ type: "text", text: `Project "#${project}" not found${accountLine}.${list}\n\nTo create it: polaris_connect with create:true` }] };
      }
      if (res.ok) {
        currentProject = body.project ?? project;
        currentSession = body.session ?? session ?? "";
        currentUser = user;
        currentProfile = activeProfile;
        await saveSessionState(currentProject, currentSession, currentUser, currentProfile);
        return { content: [{ type: "text", text: `Connected to #${currentProject}/${currentSession} as ${user}.` }] };
      }
      return { content: [{ type: "text", text: `Failed to connect: ${body.error ?? "unknown error"}` }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to connect — is the Polaris daemon running? Start it with `polaris daemon` or `bun run src/daemon/daemon.ts`." }] };
    }
  }

  if (name === "polaris_disconnect") {
    try {
      await daemonPost("/disconnect", { ccSessionId: CC_SESSION_ID });
      currentProject = "";
      currentSession = "";
      currentUser = "";
      currentProfile = "";
      await clearSessionState();
      return { content: [{ type: "text", text: "Disconnected from Polaris." }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to disconnect — daemon may not be running." }] };
    }
  }

  if (name === "polaris_status") {
    try {
      const res = await daemonGet(`/status/${CC_SESSION_ID}`);
      const body = (await res.json()) as { connected: boolean; project?: string; session?: string; user?: string; account?: string; slackChannel?: string };
      if (body.connected) {
        const accountTag = body.account ? ` [${body.account}]` : "";
        const slackTag = body.slackChannel ? ` #${body.slackChannel}` : "";
        return { content: [{ type: "text", text: `Connected: ${body.project}/${body.session} as ${body.user}${accountTag}${slackTag}` }] };
      }
      return { content: [{ type: "text", text: "Not connected to any Polaris session." }] };
    } catch {
      return { content: [{ type: "text", text: "Polaris daemon not reachable." }] };
    }
  }

  if (name === "polaris_reply") {
    if (!currentProject) {
      return { content: [{ type: "text", text: "Not connected to a Polaris session. Use polaris_connect first." }] };
    }
    const message = (args as { message: string }).message;
    try {
      const res = await daemonPost("/reply", { ccSessionId: CC_SESSION_ID, message });
      if (res.ok) {
        return { content: [{ type: "text", text: "Reply sent to the floor." }] };
      }
      const body = await res.json();
      return { content: [{ type: "text", text: `Failed to send reply: ${(body as { error?: string }).error ?? res.status}` }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to reach the daemon." }] };
    }
  }

  if (name === "polaris_rename") {
    if (!currentProject) {
      return { content: [{ type: "text", text: "Not connected to a Polaris session. Use polaris_connect first." }] };
    }
    const newName = (args as { name: string }).name;
    try {
      const res = await daemonPost("/rename", { oldName: currentProject, newName });
      const body = await res.json();
      if (res.ok) {
        const oldName = currentProject;
        currentProject = newName;
        return { content: [{ type: "text", text: `Renamed project "${oldName}" to "${newName}".` }] };
      }
      return { content: [{ type: "text", text: `Failed to rename: ${(body as { error?: string }).error ?? "unknown error"}` }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to rename — is the Polaris daemon running?" }] };
    }
  }

  if (name === "polaris_context") {
    if (!currentProject) {
      return { content: [{ type: "text", text: "Not connected to a Polaris session. Use polaris_connect first." }] };
    }
    const targetSession = (args as { session: string }).session;
    try {
      const res = await daemonGet(`/context/${CC_SESSION_ID}/${targetSession}`);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Could not fetch session "${targetSession}": ${res.status}` }] };
      }
      const events = (await res.json()) as Array<{
        sender: string;
        payload: { prompt?: string; stop_response?: string; content?: string };
      }>;
      const summary = events
        .map((e) => {
          const p = e.payload;
          const text = p.prompt ?? p.stop_response ?? p.content ?? JSON.stringify(p);
          return `[${e.sender}] ${text}`;
        })
        .join("\n");
      return { content: [{ type: "text", text: summary || "(no activity yet)" }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to reach the daemon." }] };
    }
  }

  if (name === "polaris_team") {
    try {
      const res = await daemonGet("/team");
      if (res.ok) {
        const body = await res.json() as { members: Array<{ name: string; participant_id: string | null; slack_id: string | null; slack_handle: string | null; slack_display: string | null; polaris_user: boolean; alias: string | null }> };
        if (body.members.length === 0) {
          return { content: [{ type: "text", text: "No team members found." }] };
        }
        const taggable = body.members.filter((m) => m.slack_id && m.slack_handle);
        const list = taggable
          .map((m) => {
            const shortAlias = m.alias && m.alias !== m.slack_handle ? `@${m.alias}` : "";
            const handle = `@${m.slack_handle}`;
            const display = shortAlias ? `${shortAlias} (${handle})` : handle;
            return `  ${display} — ${m.name}${m.polaris_user ? " ✓" : ""} [${m.slack_id}]`;
          })
          .join("\n");
        const notTaggable = body.members.filter((m) => !m.slack_id);
        const note = notTaggable.length > 0 ? `\n\nNot on Slack: ${notTaggable.map(m => m.name).join(", ")}` : "";
        return { content: [{ type: "text", text: `Team (use @alias or @handle to tag, ✓ = Polaris user):\n${list}${note}` }] };
      }
      return { content: [{ type: "text", text: "Failed to fetch team list." }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to reach the daemon." }] };
    }
  }

  if (name === "polaris_backfill") {
    if (!currentProject) {
      return { content: [{ type: "text", text: "Not connected to a Polaris session. Use polaris_connect first." }] };
    }
    const { duration, from } = (args ?? {}) as { duration?: string; from?: string };
    try {
      const res = await daemonPost("/backfill", {
        ccSessionId: CC_SESSION_ID,
        ...(duration ? { duration } : {}),
        ...(from ? { from } : {}),
      });
      const body = await res.json() as { recovered: number; source: string; gaps: string[] };
      if (res.ok) {
        const gapInfo = body.gaps.length > 0 ? `\nGaps: ${body.gaps.join(", ")}` : "";
        return { content: [{ type: "text", text: `Backfill complete: ${body.recovered} events recovered from ${body.source}.${gapInfo}` }] };
      }
      return { content: [{ type: "text", text: `Backfill failed: ${(body as unknown as { error?: string }).error ?? "unknown error"}` }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to reach the daemon." }] };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Register with daemon and connect stdio ---

async function main() {
  const activeProfile = await loadActiveProfile();

  // Register with daemon (best-effort — daemon might not be running yet)
  try {
    await daemonPost("/register", { ccSessionId: CC_SESSION_ID, profile: activeProfile });
  } catch {
    console.error("Warning: Polaris daemon not reachable. Start it with `bun run src/daemon/daemon.ts`.");
  }

  // Auto-reconnect if a previous session was active in this workspace
  const saved = await loadSessionState();
  if (saved) {
    const reconnectProfile = saved.profile || activeProfile;
    try {
      const res = await daemonPost("/connect", {
        ccSessionId: CC_SESSION_ID,
        project: saved.project,
        session: saved.session,
        user: saved.user,
        profile: reconnectProfile,
      });
      const body = await res.json() as { status?: string; project?: string; session?: string; user?: string; error?: string };
      if (res.ok) {
        currentProject = body.project ?? saved.project;
        currentSession = body.session ?? saved.session;
        currentUser = saved.user;
        currentProfile = reconnectProfile;
        // Show email when it looks like one; fall back to profile key or "default"
        const accountLabel = reconnectProfile.includes("@") ? reconnectProfile : (reconnectProfile || "default");
        console.error(`Polaris auto-reconnected to #${currentProject}/${currentSession} [${accountLabel}]`);
      } else {
        // Session or project no longer exists — clear stale state
        await clearSessionState();
      }
    } catch {
      // Daemon not running — keep state file for next startup when daemon is available
    }
  }

  // inject delivery is handled via the UserPromptSubmit hook (see daemon injectQueues); claude/channel push deferred

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(`Polaris MCP client started (session: ${CC_SESSION_ID})`);
}

if (import.meta.main) {
  await main();
}

export { mcp, CC_SESSION_ID, main as startClient };
