// --- Event → Slack message formatting ---

import type { PolarisEvent } from "../types";

export interface SlackMessage {
  text: string;
  blocks?: Array<Record<string, unknown>>;
  attachments?: Array<Record<string, unknown>>;
  username?: string;
  icon_emoji?: string;
}

// Derive a display name from a participant ID
function displayName(participantId: string): string {
  const [type, name] = participantId.split(":", 2);
  if (!name) return participantId;
  const pretty = name.replace(/[._-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (type === "agent") return `Agent: ${pretty}`;
  return pretty;
}

function personaIcon(participantId: string): string {
  if (participantId.startsWith("agent:")) return ":robot_face:";
  if (participantId.startsWith("slack:")) return ":speech_balloon:";
  return ":bust_in_silhouette:";
}

// Format a PolarisEvent into a Slack message.
// Returns null if the event should be skipped (e.g., tool calls).
export function formatEventForSlack(event: PolarisEvent): SlackMessage | null {
  const payload = event.payload;

  if ("hook_event_name" in payload) {
    switch (payload.hook_event_name) {
      case "UserPromptSubmit":
        return formatUserPrompt(event.sender, event.session, payload.prompt);
      case "Stop": {
        const response = payload.stop_response || payload.last_assistant_message;
        if (!response) return null;
        return formatAgentResponse(event.session, response);
      }
      case "PreToolUse":
      case "PostToolUse":
        return null;
    }
  }

  if ("type" in payload && payload.type === "inject") {
    return formatAdvisorMessage(
      event.sender,
      (payload as { target: string }).target,
      (payload as { content: string }).content,
    );
  }

  if ("type" in payload && payload.type === "reply") {
    const body = (payload as { content: string }).content;
    if (!body) return null;
    return {
      text: toMrkdwn(body),
      blocks: [{ type: "section", text: { type: "mrkdwn", text: toMrkdwn(body) } }],
      username: displayName(event.sender),
      icon_emoji: personaIcon(event.sender),
    };
  }

  return null;
}

// --- User prompt ---

function formatUserPrompt(sender: string, session: string, prompt: string): SlackMessage | null {
  if (!prompt) return null;
  return {
    text: toMrkdwn(prompt),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: toMrkdwn(prompt) } }],
    username: `${displayName(sender)} (${session})`,
    icon_emoji: personaIcon(sender),
  };
}

// --- Agent response ---

function formatAgentResponse(session: string, response: string): SlackMessage | null {
  if (!response) return null;
  return {
    text: toMrkdwn(response),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: toMrkdwn(response) } }],
    username: `Agent (${session})`,
    icon_emoji: ":robot_face:",
  };
}

// --- Advisor message ---

function formatAdvisorMessage(sender: string, target: string, content: string): SlackMessage | null {
  if (!content) return null;
  const body = toMrkdwn(content);
  return {
    text: body,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `→ _${target}_:  ${body}` } }],
    username: displayName(sender),
    icon_emoji: personaIcon(sender),
  };
}

// --- Markdown → Slack mrkdwn ---

function toMrkdwn(text: string): string {
  const maxLen = 2000;
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
  return truncated
    .replace(/```(\w*)\n([\s\S]*?)```/g, "```$2```")
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/__(.*?)__/g, "*$1*");
}
