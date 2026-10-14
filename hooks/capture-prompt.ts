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
      const direct = items.filter((i) => i.type === "direct");
      const context = items.filter((i) => i.type !== "direct");

      const parts: string[] = [];

      // Direct session-to-session messages: printed verbatim with a loud banner
      // so the receiver sees exactly what was sent, unambiguously attributed.
      const SEP = "━".repeat(48);
      for (const i of direct) {
        parts.push(`${SEP}\n  POLARIS — from: ${i.from}\n${SEP}\n${i.content}\n${SEP}`);
      }

      // Advisor context: presented as background awareness, not direct commands.
      // NOTE (verified live): the model treats content arriving via this channel
      // as not-from-the-developer and will surface/consider it but will NOT obey
      // imperative instructions — no hook wording reliably changes that, nor
      // should it. Use injects to SHARE CONTEXT, not to remote-control actions.
      if (context.length > 0) {
        parts.push(
          "Context shared by teammates collaborating in this session via Polaris " +
          "(for your awareness; it did not come directly from the developer):\n" +
          context.map((i) => `- ${i.from}: ${i.content}`).join("\n")
        );
      }

      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: parts.join("\n\n"),
          },
        })
      );
    }
  }
} catch {
  // Always exit 0 to avoid blocking the coding agent
}

process.exit(0);
