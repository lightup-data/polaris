import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Configuration ---

const DAEMON_URL = process.env.POLARIS_DAEMON_URL ?? "http://127.0.0.1:4322";

// Generate a stable session ID for this MCP server instance
const CC_SESSION_ID = process.env.POLARIS_CC_SESSION_ID ?? crypto.randomUUID();

// --- Daemon communication ---

async function daemonPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${DAEMON_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function daemonGet(path: string): Promise<Response> {
  return fetch(`${DAEMON_URL}${path}`);
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
          project: { type: "string", description: "Project name" },
          user: { type: "string", description: "Your participant ID (e.g., user:manu)" },
          session: { type: "string", description: "Session name (optional — auto-generated if omitted)" },
          agent: { type: "string", description: "Agent identity (optional — defaults to agent:claude)" },
        },
        required: ["project", "user"],
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "polaris_connect") {
    const { project, user, session, agent } = args as { project: string; user: string; session?: string; agent?: string };
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
        return { content: [{ type: "text", text: `Connected to ${currentProject}/${currentSession} as ${user}.` }] };
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

  // Poll daemon for advisor messages and inject into MCP session
  setInterval(async () => {
    if (!currentProject) return;
    // The daemon's cloud WS forwards inject events to the mcpCallbacks map,
    // but since we're in a separate process, we use HTTP polling as a fallback.
    // In production, this would use IPC (Unix socket or named pipe).
  }, 5000);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error(`Polaris MCP client started (session: ${CC_SESSION_ID})`);
}

if (import.meta.main) {
  await main();
}

export { mcp, CC_SESSION_ID, main as startClient };
