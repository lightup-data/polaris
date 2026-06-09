// --- Slack Bridge ---
// Connects a project's event stream to a Slack channel.
// Runs server-side, one bridge per org.
//
// Project → Slack: session events → formatted Slack posts
// Slack → Project: advisor messages → injected into target session

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createDb, getOrg, type Sql, type Org } from "../service/db";
import { formatEventForSlack } from "./format";
import type { PolarisEvent } from "../types";

// --- Channel management ---

// Map project name → Slack channel ID
const projectChannels = new Map<string, string>();

async function getOrCreateChannel(web: WebClient, projectName: string): Promise<string> {
  const cached = projectChannels.get(projectName);
  if (cached) return cached;

  // Channel name: project name, sanitized for Slack (lowercase, hyphens)
  const channelName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);

  // Try to create
  try {
    const result = await web.conversations.create({ name: channelName, is_private: false });
    if (result.ok && result.channel?.id) {
      projectChannels.set(projectName, result.channel.id);
      await web.conversations.setTopic({
        channel: result.channel.id,
        topic: `Polaris project: ${projectName}`,
      });
      return result.channel.id;
    }
  } catch {
    // name_taken — find and join
  }

  // Find existing channel
  let cursor: string | undefined;
  do {
    const list = await web.conversations.list({
      types: "public_channel",
      limit: 200,
      exclude_archived: true,
      cursor,
    });
    const found = list.channels?.find((c) => c.name === channelName);
    if (found?.id) {
      await web.conversations.join({ channel: found.id });
      projectChannels.set(projectName, found.id);
      return found.id;
    }
    cursor = list.response_metadata?.next_cursor || undefined;
  } while (cursor);

  throw new Error(`Could not create or find channel for project: ${projectName}`);
}

// --- Event → Slack posting ---

async function postEventToSlack(web: WebClient, event: PolarisEvent): Promise<void> {
  // Skip _system events (handled separately)
  if (event.project === "_system") return;

  const msg = formatEventForSlack(event);
  if (!msg) return;

  try {
    const channelId = await getOrCreateChannel(web, event.project);
    await web.chat.postMessage({
      channel: channelId,
      text: msg.text,
      blocks: msg.blocks,
    });
  } catch (e) {
    console.error(`[bridge] Failed to post to Slack for project ${event.project}:`, e);
  }
}

// --- Slack → Project injection ---

async function handleSlackMessage(
  web: WebClient,
  apiBaseUrl: string,
  orgId: string,
  botUserId: string,
  event: {
    text: string;
    user: string;
    channel: string;
    ts: string;
  }
): Promise<void> {
  // Ignore bot's own messages
  if (event.user === botUserId) return;

  // Find which project this channel belongs to
  let projectName: string | undefined;
  for (const [proj, chanId] of projectChannels) {
    if (chanId === event.channel) {
      projectName = proj;
      break;
    }
  }

  if (!projectName) {
    // Try to resolve from channel info
    try {
      const info = await web.conversations.info({ channel: event.channel });
      const chanName = info.channel?.name;
      if (chanName) {
        projectName = chanName;
        projectChannels.set(chanName, event.channel);
      }
    } catch {
      return; // Unknown channel, ignore
    }
  }

  if (!projectName) return;

  // Parse target session from message: @session-name or first word
  // Format: "@session message" or "session: message"
  const match = event.text.match(/^@(\S+)\s+(.+)$/s) || event.text.match(/^(\S+):\s+(.+)$/s);
  if (!match) {
    // No target specified — post a hint
    try {
      await web.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `To send a message to a session, use: \`@session-name your message\``,
      });
    } catch { /* ignore */ }
    return;
  }

  const targetSession = match[1];
  const content = match[2];

  // Look up Slack user to get display name
  let senderName = `slack:${event.user}`;
  try {
    const userInfo = await web.users.info({ user: event.user });
    if (userInfo.user?.profile?.display_name || userInfo.user?.real_name) {
      const name = (userInfo.user.profile?.display_name || userInfo.user.real_name || "")
        .toLowerCase().replace(/\s+/g, ".");
      senderName = `slack:${name}`;
    }
  } catch { /* use ID */ }

  // Inject into the session via the cloud API
  try {
    await fetch(`${apiBaseUrl}/projects/${projectName}/sessions/${targetSession}/inject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        sender: senderName,
      }),
    });
  } catch (e) {
    console.error(`[bridge] Failed to inject message into ${projectName}/${targetSession}:`, e);
  }
}

// --- Bridge startup ---

export async function startBridge(opts: {
  databaseUrl?: string;
  orgId: string;
  apiBaseUrl?: string;
}): Promise<{ stop: () => void }> {
  const sql = await createDb(opts.databaseUrl);
  const org = await getOrg(sql, opts.orgId);
  if (!org) throw new Error(`Org not found: ${opts.orgId}`);
  if (!org.slack_bot_token) throw new Error(`Org ${opts.orgId} has no Slack bot token`);

  const appToken = process.env.SLACK_APP_TOKEN;
  if (!appToken) throw new Error("SLACK_APP_TOKEN required for Socket Mode");

  const apiBaseUrl = opts.apiBaseUrl ?? process.env.POLARIS_API_URL ?? "http://localhost:4321";

  const web = new WebClient(org.slack_bot_token);
  const socketMode = new SocketModeClient({ appToken });

  // Get bot user ID to filter own messages
  let botUserId = "";
  try {
    const auth = await web.auth.test();
    botUserId = auth.user_id as string;
    console.error(`[bridge] Bot user ID: ${botUserId}`);
  } catch (e) {
    console.error("[bridge] Failed to get bot user ID:", e);
  }

  // Listen for Slack messages
  socketMode.on("message", async ({ event, ack }) => {
    await ack();
    if (event.subtype) return; // Skip edits, joins, etc.
    await handleSlackMessage(web, apiBaseUrl, opts.orgId, botUserId, event);
  });

  // Connect to cloud service via project-level WebSocket for all events
  // For now, use a simple polling approach to watch for new events
  // TODO: Replace with proper WebSocket connection to cloud API
  let lastTimestamp = new Date().toISOString();

  async function pollEvents() {
    try {
      const res = await fetch(`${apiBaseUrl}/projects?org_id=${opts.orgId}`);
      // The API doesn't have a list-projects endpoint yet, so we poll _system
      // and individual project events. For v1, just watch _system for new sessions
      // and known projects.
      const knownProjects = Array.from(projectChannels.keys());
      for (const proj of knownProjects) {
        const eventsRes = await fetch(`${apiBaseUrl}/projects/${proj}/messages?since=${lastTimestamp}`);
        if (!eventsRes.ok) continue;
        const events = (await eventsRes.json()) as PolarisEvent[];
        for (const event of events) {
          await postEventToSlack(web, event);
        }
        if (events.length > 0) {
          lastTimestamp = events[events.length - 1].timestamp;
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const pollInterval = setInterval(pollEvents, 5000);

  // Start Socket Mode
  await socketMode.start();
  console.error(`[bridge] Slack bridge started for org: ${org.name}`);
  console.error(`[bridge] Watching for messages in project channels`);

  return {
    stop: () => {
      clearInterval(pollInterval);
      socketMode.disconnect();
      sql.end();
    },
  };
}

// --- Run if executed directly ---
if (import.meta.main) {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error("Usage: bun run src/slack/bridge.ts <org-id>");
    process.exit(1);
  }
  await startBridge({ orgId });
}
