import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

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

// --- Current connection state ---

let currentProject = "";
let currentSession = "";
let currentUser = "";

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
    instructions: `You are connected to Polaris — a multiplayer collaboration system. Messages from advisors and teammates may arrive as <channel source="polaris" from="..."> tags. Use /polaris commands to manage your session, or call the polaris tools directly.`,
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "polaris_connect",
      description: "Connect this session to a Polaris project and session. Creates the session if it doesn't exist.",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: "Channel name (e.g., #polaris-dev). Omit to list available channels." },
          user: { type: "string", description: "Your participant ID (e.g., user:manu)" },
          session: { type: "string", description: "Session name (optional — auto-generated if omitted)" },
          agent: { type: "string", description: "Agent identity (optional — defaults to agent:claude)" },
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
      description: "Send a message to the project floor (visible to all advisors and the Slack/WhatsApp channel).",
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
      description: "Rename the current project. Also renames the Slack channel.",
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
    const { channel, user, session, agent } = args as { channel?: string; user: string; session?: string; agent?: string };

    // If no channel specified, list available channels
    if (!channel) {
      try {
        const res = await daemonGet("/channels");
        if (res.ok) {
          const body = await res.json() as { channels: string[] };
          if (body.channels.length === 0) {
            return { content: [{ type: "text", text: "No channels found. Create one by joining: `/polaris join #channel-name`" }] };
          }
          return { content: [{ type: "text", text: `Available channels:\n${body.channels.map(c => `  ${c}`).join("\n")}\n\nJoin one with: /polaris join #channel-name` }] };
        }
      } catch { /* fall through */ }
      return { content: [{ type: "text", text: "Specify a channel: `/polaris join #channel-name`" }] };
    }

    const project = channel.replace(/^#/, ""); // strip leading # if present
    try {
      const res = await daemonPost("/connect", {
        ccSessionId: CC_SESSION_ID,
        project,
        user,
        ...(session ? { session } : {}),
        ...(agent ? { agent } : {}),
      });
      const body = await res.json() as { status?: string; project?: string; session?: string; user?: string; agent?: string; error?: string };
      if (res.ok) {
        currentProject = body.project ?? project;
        currentSession = body.session ?? session ?? "";
        currentUser = user;
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
      return { content: [{ type: "text", text: "Disconnected from Polaris." }] };
    } catch {
      return { content: [{ type: "text", text: "Failed to disconnect — daemon may not be running." }] };
    }
  }

  if (name === "polaris_status") {
    try {
      const res = await daemonGet(`/status/${CC_SESSION_ID}`);
      const body = (await res.json()) as { connected: boolean; project?: string; session?: string; user?: string };
      if (body.connected) {
        return { content: [{ type: "text", text: `Connected: ${body.project}/${body.session} as ${body.user}` }] };
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
  // Register with daemon (best-effort — daemon might not be running yet)
  try {
    await daemonPost("/register", { ccSessionId: CC_SESSION_ID });
  } catch {
    console.error("Warning: Polaris daemon not reachable. Start it with `bun run src/daemon/daemon.ts`.");
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
