#!/usr/bin/env bun
// hooks/capture-prompt.ts — Forward UserPromptSubmit hook events to the daemon
// and deliver any queued advisor injects to the agent via additionalContext.
//
// The daemon queues inject events arriving over its cloud WebSocket (see
// injectQueues in src/daemon/daemon.ts); the /events response for a
// UserPromptSubmit hook drains that queue as pendingInjects, which we surface
// to Claude Code as hookSpecificOutput. Always exits 0; never blocks.

const POLARIS_PORT = process.env.POLARIS_PORT ?? "4322";
const POLARIS_URL = `http://127.0.0.1:${POLARIS_PORT}/events`;

// Daemon auth: include the shared local secret when provided (wired into the
// hook command env by `polaris install`)
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.POLARIS_DAEMON_SECRET) {
  headers["x-polaris-daemon-secret"] = process.env.POLARIS_DAEMON_SECRET;
}

try {
  const input = JSON.parse(await Bun.stdin.text());

  const res = await fetch(POLARIS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  }).catch(() => null);

  if (res && res.ok) {
    const body = (await res.json().catch(() => null)) as {
      pendingInjects?: Array<{ from: string; content: string; timestamp: string }>;
    } | null;
    const items = body?.pendingInjects;
    if (Array.isArray(items) && items.length > 0) {
      // Present injects with honest provenance and let the model apply its own
      // judgment. NOTE (verified live): the model treats content arriving via
      // this channel as not-from-the-developer and will surface/consider it but
      // will NOT obey imperative instructions through it — no hook wording
      // reliably changes that, nor should it. Use injects to SHARE CONTEXT with
      // the agent, not to remote-control its actions. (For trusted imperative
      // steering, the claude/channel path is the right mechanism — deferred.)
      const formatted =
        "Context shared by teammates collaborating in this session via Polaris " +
        "(for your awareness; it did not come directly from the developer):\n" +
        items.map((i) => `- ${i.from}: ${i.content}`).join("\n");
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: formatted,
          },
        })
      );
    }
  }
} catch {
  // Always exit 0 to avoid blocking the coding agent
}

process.exit(0);
