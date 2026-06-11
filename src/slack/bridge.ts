// --- Slack Bridge ---
// Connects a project's event stream to a Slack channel.
// Runs server-side, one bridge per org (startAllBridges runs one per Slack-connected org).
//
// Project → Slack: session events (LISTEN 'polaris_event' + slow backfill) → formatted Slack posts
// Slack → Project: advisor messages → injected into target session

import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createDb, getOrg, listProjects, getEventById, getOrgEventsSince, getSession, createSession, pushEvent, setProjectSlackChannel, type Sql, type Org } from "../service/db";
import { discoverBridgeOrgs } from "../bridge-discover-org";
import { formatEventForSlack, toMrkdwn, THREAD_THRESHOLD } from "./format";
import type { PolarisEvent } from "../types";

// --- Channel management ---

// Per-bridge in-memory cache: project name → Slack channel ID
// (instantiated per org so same-named projects in different orgs don't collide)
type ChannelCache = Map<string, string>;

async function getOrCreateChannel(web: WebClient, sql: Sql, orgId: string, projectName: string, channelCache: ChannelCache): Promise<string> {
  // 1. Check in-memory cache
  const cached = channelCache.get(projectName);
  if (cached) return cached;

  // 2. Check DB for stored channel ID (survives renames and restarts)
  const projects = await listProjects(sql, orgId);
  const project = projects.find((p) => p.name === projectName);
  if (project?.slack_channel_id) {
    channelCache.set(projectName, project.slack_channel_id);
    // Ensure bot is in the channel (might have been removed)
    try { await web.conversations.join({ channel: project.slack_channel_id }); } catch {}
    return project.slack_channel_id;
  }

  // 3. Create or find channel by name
  const channelName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
  let channelId: string | undefined;

  try {
    const result = await web.conversations.create({ name: channelName, is_private: false });
    if (result.ok && result.channel?.id) {
      channelId = result.channel.id;
      await web.conversations.setTopic({
        channel: channelId,
        topic: `Polaris project: ${projectName}`,
      });
    }
  } catch {
    // name_taken — find and join
  }

  if (!channelId) {
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
        channelId = found.id;
        await web.conversations.join({ channel: channelId });
        break;
      }
      cursor = list.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  if (!channelId) {
    throw new Error(`Could not create or find channel for project: ${projectName}`);
  }

  // 4. Persist the channel ID in DB (resilient to renames)
  channelCache.set(projectName, channelId);
  // Resolve and store channel name (for status line display)
  let resolvedName: string | undefined;
  try {
    const info = await web.conversations.info({ channel: channelId });
    resolvedName = info.channel?.name ?? undefined;
  } catch {}
  await setProjectSlackChannel(sql, orgId, projectName, channelId, resolvedName);
  return channelId;
}

// --- Event → Slack posting ---

async function postEventToSlack(web: WebClient, sql: Sql, orgId: string, event: PolarisEvent, channelCache: ChannelCache): Promise<void> {
  // Skip _system events (handled separately)
  if (event.project === "_system") return;

  // Skip events that originated from Slack (avoid re-posting)
  if (event.sender.startsWith("slack:")) return;

  const msg = formatEventForSlack(event);
  if (!msg) return;

  try {
    const channelId = await getOrCreateChannel(web, sql, orgId, event.project, channelCache);
    const isLong = msg.text.length > THREAD_THRESHOLD;
    // POLARIS_LONG_MSG controls how messages longer than THREAD_THRESHOLD are posted:
    //   "snippet" (default) — 500-char preview + full content as expandable text snippet
    //   "thread"  — 500-char preview in channel, full content in a thread reply
    //   "inline"  — post the full message directly in the channel (may be very long)
    const longMode = process.env.POLARIS_LONG_MSG ?? "snippet";

    if (!isLong || longMode === "inline") {
      await web.chat.postMessage({
        channel: channelId,
        text: msg.text,
        ...(msg.blocks ? { blocks: msg.blocks } : {}),
        ...(msg.username ? { username: msg.username } : {}),
        ...(msg.icon_emoji ? { icon_emoji: msg.icon_emoji } : {}),
      });
    } else if (longMode === "thread") {
      const preview = msg.text.slice(0, 500).trimEnd();
      const summaryText = `${preview}...\n\n_Full response in thread_ :thread:`;
      const summary = await web.chat.postMessage({
        channel: channelId,
        text: summaryText,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: summaryText } }],
        ...(msg.username ? { username: msg.username } : {}),
        ...(msg.icon_emoji ? { icon_emoji: msg.icon_emoji } : {}),
      });
      if (summary.ok && summary.ts) {
        await web.chat.postMessage({
          channel: channelId,
          thread_ts: summary.ts,
          text: msg.text,
          ...(msg.username ? { username: msg.username } : {}),
          ...(msg.icon_emoji ? { icon_emoji: msg.icon_emoji } : {}),
        });
      }
    } else {
      // snippet mode — preview + expandable file attachment
      // Requires files:write scope on the Slack bot token
      const preview = msg.text.slice(0, 500).trimEnd();
      const summaryText = `${preview}...`;
      await web.chat.postMessage({
        channel: channelId,
        text: summaryText,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: summaryText } }],
        ...(msg.username ? { username: msg.username } : {}),
        ...(msg.icon_emoji ? { icon_emoji: msg.icon_emoji } : {}),
      });
      const sender = msg.username ?? "agent";
      await web.filesUploadV2({
        channel_id: channelId,
        content: msg.text,
        filename: `${sender.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${event.session}-${Date.now()}.md`,
        title: `${sender} — full response`,
        initial_comment: `_Expand to read the full response from ${sender}_`,
      });
    }
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
  },
  channelCache: ChannelCache
): Promise<void> {
  // Ignore bot's own messages
  if (event.user === botUserId) return;

  // Find which project this channel belongs to
  let projectName: string | undefined;

  // Check in-memory cache
  for (const [proj, chanId] of channelCache) {
    if (chanId === event.channel) {
      projectName = proj;
      break;
    }
  }

  // Check DB
  if (!projectName) {
    const projects = await listProjects(sql, orgId);
    for (const proj of projects) {
      if (proj.slack_channel_id === event.channel) {
        projectName = proj.name;
        channelCache.set(proj.name, event.channel);
        break;
      }
    }
  }

  // Fall back to channel name lookup
  if (!projectName) {
    try {
      const info = await web.conversations.info({ channel: event.channel });
      const chanName = info.channel?.name;
      if (chanName) {
        projectName = chanName;
        channelCache.set(chanName, event.channel);
      }
    } catch {
      return;
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

interface OrgBridge {
  orgId: string;
  handleEvent: (event: PolarisEvent) => Promise<void>;
  stop: () => void;
}

// One independent bridge for one org: its own WebClient (org bot token), its own
// SocketModeClient, its own channel cache and posted-event dedupe. Realtime delivery
// is driven by the caller via handleEvent (fed from LISTEN 'polaris_event'); a slow
// 30s backfill poll catches anything the LISTEN path missed (e.g. during reconnects).
async function startOrgBridge(sql: Sql, org: Org): Promise<OrgBridge> {
  if (!org.slack_bot_token) throw new Error(`Org ${org.id} has no Slack bot token`);

  // Socket Mode needs an app-level token (not stored in the orgs table). Per-org
  // override via SLACK_APP_TOKEN_<team id>, falling back to the shared SLACK_APP_TOKEN.
  const appToken =
    (org.slack_team_id ? process.env[`SLACK_APP_TOKEN_${org.slack_team_id}`] : undefined) ??
    process.env.SLACK_APP_TOKEN;
  if (!appToken) throw new Error("SLACK_APP_TOKEN required for Socket Mode");

  const web = new WebClient(org.slack_bot_token);
  const socketMode = new SocketModeClient({ appToken });
  const channelCache: ChannelCache = new Map();

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
      const msg = event as { text?: string; user?: string; channel?: string; ts?: string; subtype?: string; name?: string };
      console.error(`[bridge] message: user=${msg.user} channel=${msg.channel} subtype=${msg.subtype} text=${msg.text?.slice(0, 80)}`);

      // Handle channel rename system messages
      if (msg.subtype === "channel_name" && msg.channel && msg.name) {
        console.error(`[bridge] channel renamed: ${msg.channel} → ${msg.name}`);
        const projects = await listProjects(sql, org.id);
        for (const proj of projects) {
          if (proj.slack_channel_id === msg.channel) {
            channelCache.set(proj.name, msg.channel);
            await setProjectSlackChannel(sql, org.id, proj.name, msg.channel, msg.name);
            // Notify local daemon so status line updates immediately
            try {
              await fetch(`http://127.0.0.1:${process.env.POLARIS_DAEMON_PORT ?? 4322}/channel-update`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ project: proj.name, slackChannel: msg.name }),
              });
            } catch { /* daemon may not be running */ }
            console.error(`[bridge] Updated channel name for project ${proj.name}: ${msg.name}`);
          }
        }
        return;
      }

      if (msg.subtype || !msg.channel || !msg.text || !msg.user) return;
      if (msg.user === botUserId) return;
      await handleSlackMessage(web, sql, org.id, botUserId, msg as { text: string; user: string; channel: string; ts: string }, channelCache);
    } catch (e) {
      console.error(`[bridge] message handler error:`, e);
    }
  });

  // De-dupe between the realtime LISTEN path and the safety backfill poll
  const postedEventIds = new Set<string>();

  async function handleEvent(event: PolarisEvent): Promise<void> {
    if (event.project === "_system") return;
    if (postedEventIds.has(event.id)) return;
    postedEventIds.add(event.id);
    await postEventToSlack(web, sql, org.id, event, channelCache);
  }

  // Safety backfill: slow poll catching anything the LISTEN path missed
  let lastPollTime = new Date().toISOString();

  async function pollEvents() {
    try {
      const since = lastPollTime;
      const events = await getOrgEventsSince(sql, org.id, since);
      const now = new Date().toISOString();

      for (const event of events) {
        await handleEvent(event);
      }

      lastPollTime = now;
    } catch (e) {
      console.error("[bridge] Poll error:", e);
    }
  }

  const pollInterval = setInterval(pollEvents, 30_000);

  // Start Socket Mode
  await socketMode.start();
  console.error(`[bridge] Slack bridge started for org: ${org.name}`);
  console.error(`[bridge] Watching for messages in project channels`);

  return {
    orgId: org.id,
    handleEvent,
    stop: () => {
      clearInterval(pollInterval);
      socketMode.disconnect();
    },
  };
}

// Realtime backbone: one dedicated LISTEN('polaris_event') subscription. NOTIFY carries
// the event id only; fetch the full event via getEventById (carries org_id) and route it.
async function listenForEvents(
  sql: Sql,
  route: (event: PolarisEvent & { org_id: string }) => Promise<void>
): Promise<() => Promise<void>> {
  const { unlisten } = await sql.listen("polaris_event", (id) => {
    void (async () => {
      try {
        const event = await getEventById(sql, id);
        if (event) await route(event);
      } catch (e) {
        console.error("[bridge] LISTEN handler error:", e);
      }
    })();
  });
  return unlisten;
}

// Single-org bridge (back-compat: docker/bridge-entrypoint.sh passes one org id).
export async function startBridge(opts: {
  databaseUrl?: string;
  orgId: string;
  apiBaseUrl?: string;
}): Promise<{ stop: () => void }> {
  const sql = await createDb(opts.databaseUrl);
  const org = await getOrg(sql, opts.orgId);
  if (!org) throw new Error(`Org not found: ${opts.orgId}`);
  if (!org.slack_bot_token) throw new Error(`Org ${opts.orgId} has no Slack bot token`);

  const bridge = await startOrgBridge(sql, org);
  const unlisten = await listenForEvents(sql, async (event) => {
    if (event.org_id === org.id) await bridge.handleEvent(event);
  });

  return {
    stop: () => {
      void unlisten().catch(() => {});
      bridge.stop();
      sql.end();
    },
  };
}

// In-process guard: orgs this process is already bridging
const startedOrgIds = new Set<string>();

// Multi-org mode: discover every Slack-connected org and start one independent bridge
// per org. Double-start is guarded twice: the in-process startedOrgIds set, plus a
// session-scoped Postgres advisory lock (held on a reserved connection for the bridge's
// lifetime) so two processes never bridge the same org. pg_try_advisory_lock (not the
// blocking pg_advisory_lock) so a second process skips the org instead of hanging.
export async function startAllBridges(opts: {
  databaseUrl?: string;
  apiBaseUrl?: string;
} = {}): Promise<{ stop: () => void }> {
  const sql = await createDb(opts.databaseUrl);
  const bridges = new Map<string, OrgBridge>();
  const cleanups: Array<() => void> = [];

  const orgIds = await discoverBridgeOrgs(sql);
  if (orgIds.length === 0) {
    console.error("[bridge] No Slack-connected orgs found");
  }

  for (const orgId of orgIds) {
    if (startedOrgIds.has(orgId)) {
      console.error(`[bridge] Org ${orgId} already bridged in this process, skipping`);
      continue;
    }

    // Cross-process guard: advisory lock on a hash of the org id, held for the life of
    // the bridge on a dedicated (reserved) connection.
    const lock = await sql.reserve();
    let locked = false;
    try {
      const [row] = await lock`SELECT pg_try_advisory_lock(hashtext('polaris_bridge'), hashtext(${orgId})) AS locked`;
      locked = row?.locked === true;
    } catch (e) {
      console.error(`[bridge] Advisory lock check failed for org ${orgId}:`, e);
    }
    if (!locked) {
      lock.release();
      console.error(`[bridge] Org ${orgId} is already bridged by another process, skipping`);
      continue;
    }

    try {
      const org = await getOrg(sql, orgId);
      if (!org?.slack_bot_token) throw new Error("org missing or has no Slack bot token");
      const bridge = await startOrgBridge(sql, org);
      startedOrgIds.add(orgId);
      bridges.set(orgId, bridge);
      cleanups.push(() => {
        bridge.stop();
        bridges.delete(orgId);
        startedOrgIds.delete(orgId);
        void lock`SELECT pg_advisory_unlock(hashtext('polaris_bridge'), hashtext(${orgId}))`
          .then(() => lock.release(), () => lock.release());
      });
    } catch (e) {
      console.error(`[bridge] Failed to start bridge for org ${orgId}:`, e);
      try { await lock`SELECT pg_advisory_unlock(hashtext('polaris_bridge'), hashtext(${orgId}))`; } catch { /* lock dies with the session */ }
      lock.release();
    }
  }

  // ONE LISTEN subscription fans events out to the right org's bridge by org_id
  const unlisten = await listenForEvents(sql, async (event) => {
    const bridge = bridges.get(event.org_id);
    if (bridge) await bridge.handleEvent(event);
  });

  console.error(`[bridge] Multi-org bridge running for ${bridges.size} org(s)`);

  return {
    stop: () => {
      void unlisten().catch(() => {});
      for (const cleanup of cleanups) cleanup();
      sql.end();
    },
  };
}

// --- Run if executed directly ---
if (import.meta.main) {
  const orgId = process.argv[2];
  if (orgId) {
    // Back-compat: explicit org id → single-org bridge (docker/bridge-entrypoint.sh)
    await startBridge({ orgId });
  } else {
    // No args → bridge every Slack-connected org
    await startAllBridges();
  }
}
