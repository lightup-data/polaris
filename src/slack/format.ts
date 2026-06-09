// --- Event → Slack message formatting ---

import type { PolarisEvent } from "../types";

// Format a PolarisEvent into a Slack message.
// Returns null if the event should be skipped (e.g., tool calls).
export function formatEventForSlack(event: PolarisEvent): { text: string; blocks: Array<Record<string, unknown>> } | null {
  const payload = event.payload;

  // Hook events
  if ("hook_event_name" in payload) {
    switch (payload.hook_event_name) {
      case "UserPromptSubmit": {
        const sender = event.sender;
        const session = event.session;
        return slackMessage(
          `*${sender}* → _${session}_`,
          payload.prompt,
        );
      }
      case "Stop": {
        const session = event.session;
        const response = payload.stop_response || payload.last_assistant_message;
        if (!response) return null;
        return slackMessage(
          `_agent_ → *${event.sender}/${session}*`,
          response,
        );
      }
      case "PreToolUse":
      case "PostToolUse":
        // Skip tool calls to reduce noise
        return null;
    }
  }

  // Inject events (advisor messages)
  if ("type" in payload && payload.type === "inject") {
    return slackMessage(
      `*${event.sender}* → _${(payload as { target: string }).target}_`,
      (payload as { content: string }).content,
    );
  }

  // Reply events
  if ("type" in payload && payload.type === "reply") {
    return slackMessage(
      `*${event.sender}* replied`,
      (payload as { content: string }).content,
    );
  }

  return null;
}

function slackMessage(header: string, body: string): { text: string; blocks: Array<Record<string, unknown>> } {
  // Truncate long messages
  const maxLen = 2000;
  const truncated = body.length > maxLen ? body.slice(0, maxLen) + "..." : body;

  // Convert markdown bold/italic to Slack mrkdwn (mostly compatible)
  const mrkdwn = truncated
    .replace(/```(\w*)\n([\s\S]*?)```/g, "```$2```") // code blocks (strip language)
    .replace(/\*\*(.*?)\*\*/g, "*$1*")                // bold: ** → *
    .replace(/__(.*?)__/g, "*$1*");                   // bold: __ → *

  const text = `${header}\n${mrkdwn}`;

  return {
    text,
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: header }],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: mrkdwn },
      },
    ],
  };
}
