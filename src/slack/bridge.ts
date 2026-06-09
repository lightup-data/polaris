// --- Slack Bridge ---
// Connects a project's event stream to a Slack channel.
// Runs server-side, one bridge per org.
//
// Project → Slack: session events → formatted Slack posts
// Slack → Project: advisor messages → injected into target session

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createDb, getOrg, listProjects, getProjectEvents, getSession, createSession, pushEvent, type Sql, type Org } from "../service/db";
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

  // Skip events that originated from Slack (avoid re-posting)
  if (event.sender.startsWith("slack:")) return;

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
  sql: Sql,
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

  if (!projectName) {
    return;
  }

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

  // Inject directly into DB (bridge runs server-side with DB access)
  try {
    // Ensure session exists
    let session = await getSession(sql, orgId, projectName, targetSession);
    if (!session) {
      try { session = await createSession(sql, orgId, projectName, targetSession, null); } catch { /* exists */ }
      session = await getSession(sql, orgId, projectName, targetSession);
    }
    if (!session) {
      console.error(`[bridge] Session ${projectName}/${targetSession} not found`);
      await web.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `Session \`${targetSession}\` not found in project \`${projectName}\`.`,
      });
      return;
    }
    const injectEvent = {
      id: crypto.randomUUID(),
      project: projectName,
      session: targetSession,
      timestamp: new Date().toISOString(),
      source: "inject" as const,
      sender: senderName as `${"user" | "agent" | "slack"}:${string}`,
      payload: {
        type: "inject" as const,
        content,
        sender: senderName as `${"user" | "agent" | "slack"}:${string}`,
        target: targetSession,
      },
    };
    await pushEvent(sql, orgId, injectEvent);
    console.error(`[bridge] Injected into ${projectName}/${targetSession}: ${content.slice(0, 50)}`);
  } catch (e) {
    console.error(`[bridge] Failed to inject:`, e);
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
  socketMode.on("message", async ({ event, ack }: { event: Record<string, unknown>; ack: () => Promise<void> }) => {
    try {
      await ack();
      const msg = event as { text?: string; user?: string; channel?: string; ts?: string; subtype?: string };
      console.error(`[bridge] message: user=${msg.user} channel=${msg.channel} text=${msg.text?.slice(0, 80)}`);
      if (msg.subtype || !msg.channel || !msg.text || !msg.user) return;
      if (msg.user === botUserId) return;
      await handleSlackMessage(web, sql, opts.orgId, botUserId, msg as { text: string; user: string; channel: string; ts: string });
    } catch (e) {
      console.error(`[bridge] message handler error:`, e);
    }
  });

  // Poll for new events directly from DB (bridge runs server-side)
  const postedEventIds = new Set<string>();

  async function pollEvents() {
    try {
      const projects = await listProjects(sql, opts.orgId);

      for (const proj of projects) {
        if (proj.name === "_system") continue;

        const events = await getProjectEvents(sql, opts.orgId, proj.name);
        for (const event of events) {
          if (postedEventIds.has(event.id)) continue;
          postedEventIds.add(event.id);
          await postEventToSlack(web, event);
        }
      }
    } catch (e) {
      console.error("[bridge] Poll error:", e);
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
