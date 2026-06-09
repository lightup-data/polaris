#!/usr/bin/env bun
// hooks/capture-stop.ts — Extract the last assistant message from the transcript
// and POST it to the daemon as a Stop event with the full response.

const POLARIS_PORT = process.env.POLARIS_PORT ?? "4322";
const POLARIS_URL = `http://127.0.0.1:${POLARIS_PORT}/events`;

try {
  const input = JSON.parse(await Bun.stdin.text());

  if (input.hook_event_name !== "Stop") {
    // Not a Stop event — forward as-is
    await fetch(POLARIS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).catch(() => {});
    process.exit(0);
  }

  // Read the transcript to get the full last assistant message
  const transcriptPath = input.transcript_path;
  let fullResponse = input.last_assistant_message ?? "";

  if (transcriptPath) {
    try {
      const file = Bun.file(transcriptPath);
      const text = await file.text();
      const lines = text.trim().split("\n");

      // Find the last assistant message (walk backwards)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === "assistant" && entry.message?.content) {
            // Extract all text parts, skip tool_use parts
            const textParts = entry.message.content
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text: string }) => c.text)
              .filter(Boolean);

            if (textParts.length > 0) {
              fullResponse = textParts.join("\n\n");
              break;
            }
          }
        } catch {
          // Skip malformed lines
        }
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

  await fetch(POLARIS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
} catch {
  // Always exit 0 to avoid blocking the coding agent
}

process.exit(0);
