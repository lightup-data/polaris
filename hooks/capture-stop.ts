#!/usr/bin/env bun
// hooks/capture-stop.ts — Extract the full assistant turn from the transcript
// and POST it to the daemon as a Stop event with the complete response.
//
// A single Claude turn can span multiple assistant entries in the transcript
// (text → tool_use → tool_result → text → tool_use → ...). We collect ALL
// assistant text parts since the last user message.

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

  if (input.hook_event_name !== "Stop") {
    // Not a Stop event — forward as-is
    await fetch(POLARIS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    }).catch(() => {});
    process.exit(0);
  }

  // Read the transcript to get the full assistant turn
  const transcriptPath = input.transcript_path;
  let fullResponse = input.last_assistant_message ?? "";

  if (transcriptPath) {
    try {
      const file = Bun.file(transcriptPath);
      const text = await file.text();
      const lines = text.trim().split("\n");

      // Walk backwards to find the last user message, then collect all
      // assistant text parts between that user message and the end.
      let userIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if ((entry.type === "user" || entry.type === "human") && typeof entry.message?.content === "string") {
            userIdx = i;
            break;
          }
        } catch {}
      }

      // Collect everything since the last user message:
      // 1. rawTurn: full structured data for zero-loss DB logging
      // 2. displayResponse: formatted text for Slack display
      const rawTurn: unknown[] = [];
      const displayParts: string[] = [];
      const startIdx = userIdx >= 0 ? userIdx + 1 : 0;

      for (let i = startIdx; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          // Capture raw entries for full fidelity
          if (entry.type === "assistant" || (entry.type === "user" && Array.isArray(entry.message?.content))) {
            rawTurn.push(entry);
          }
          // Build display text
          if (entry.type === "assistant" && entry.message?.content) {
            for (const c of entry.message.content) {
              if (c.type === "text" && c.text) {
                displayParts.push(c.text);
              } else if (c.type === "tool_use" && c.name) {
                const inputSummary = c.input?.command?.slice(0, 80)
                  ?? c.input?.file_path?.slice(0, 80)
                  ?? c.input?.pattern?.slice(0, 80)
                  ?? "";
                displayParts.push(`> _\`${c.name}\`${inputSummary ? ": " + inputSummary : ""}_`);
              }
            }
          }
        } catch {}
      }

      if (displayParts.length > 0) {
        fullResponse = displayParts.join("\n\n");
      }

      // Attach raw turn data to the payload for zero-loss storage
      if (rawTurn.length > 0) {
        // Sanitize: strip null bytes and invalid Unicode surrogates
        const sanitized = JSON.parse(
          JSON.stringify(rawTurn).replace(/\\u0000/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
        );
        (input as Record<string, unknown>).raw_turn = sanitized;
      }
    } catch {
      // Fall back to last_assistant_message
    }
  }

  // POST the Stop event with the full response
  const payload = {
    ...input,
    stop_response: fullResponse,
    last_assistant_message: fullResponse,
  };

  const res = await fetch(POLARIS_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }).catch(() => null);

  // If the POST failed (e.g., Unicode issue in raw_turn), retry without it
  if (!res || !res.ok) {
    delete (payload as Record<string, unknown>).raw_turn;
    await fetch(POLARIS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
} catch {
  // Always exit 0 to avoid blocking the coding agent
}

process.exit(0);
