import { describe, expect, test } from "bun:test";
import { formatEventForSlack } from "../src/slack/format";
import type { PolarisEvent } from "../src/types";

function makeEvent(overrides: Partial<PolarisEvent> = {}): PolarisEvent {
  return {
    id: crypto.randomUUID(),
    project: "pj",
    session: "fxm",
    timestamp: new Date().toISOString(),
    source: "hook",
    sender: "user:manu",
    payload: {
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "build auth middleware",
    },
    ...overrides,
  };
}

describe("formatEventForSlack", () => {
  test("user prompt: persona with session, plain message", () => {
    const result = formatEventForSlack(makeEvent());
    expect(result).not.toBeNull();
    expect(result!.username).toBe("Manu (fxm)");
    expect(result!.icon_emoji).toBe(":bust_in_silhouette:");
    expect(result!.text).toContain("build auth middleware");
    expect(result!.blocks).toHaveLength(1);
  });

  test("agent response: robot persona with session", () => {
    const result = formatEventForSlack(makeEvent({
      payload: { hook_event_name: "Stop", session_id: "s1", stop_response: "Created auth.ts" },
    }));
    expect(result).not.toBeNull();
    expect(result!.username).toBe("Agent (fxm)");
    expect(result!.icon_emoji).toBe(":robot_face:");
    expect(result!.text).toContain("Created auth.ts");
  });

  test("skips PreToolUse", () => {
    expect(formatEventForSlack(makeEvent({
      payload: { hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } },
    }))).toBeNull();
  });

  test("skips PostToolUse", () => {
    expect(formatEventForSlack(makeEvent({
      payload: { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Read", tool_input: { file_path: "/tmp" }, tool_result: {} },
    }))).toBeNull();
  });

  test("advisor: persona + target in message", () => {
    const result = formatEventForSlack(makeEvent({
      source: "inject",
      sender: "user:krishna",
      payload: { type: "inject" as const, content: "Use RS256", sender: "user:krishna", target: "fxm" },
    }));
    expect(result).not.toBeNull();
    expect(result!.username).toBe("Krishna");
    expect(result!.text).toContain("Use RS256");
  });

  test("reply: persona", () => {
    const result = formatEventForSlack(makeEvent({
      source: "reply",
      sender: "user:manu",
      payload: { type: "reply" as const, content: "Done", sender: "user:manu" },
    }));
    expect(result).not.toBeNull();
    expect(result!.username).toBe("Manu");
    expect(result!.text).toContain("Done");
  });

  test("truncates long messages", () => {
    const result = formatEventForSlack(makeEvent({
      payload: { hook_event_name: "Stop", session_id: "s1", stop_response: "x".repeat(3000) },
    }));
    expect(result).not.toBeNull();
    expect(result!.text!.length).toBeLessThan(2100);
    expect(result!.text).toContain("...");
  });

  test("converts markdown bold to mrkdwn", () => {
    const result = formatEventForSlack(makeEvent({
      payload: { hook_event_name: "Stop", session_id: "s1", stop_response: "This is **bold** text" },
    }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain("*bold*");
    expect(result!.text).not.toContain("**bold**");
  });

  test("agent: sender persona for agent participants", () => {
    const result = formatEventForSlack(makeEvent({
      sender: "agent:test-writer",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "write tests" },
    }));
    expect(result).not.toBeNull();
    expect(result!.username).toBe("Agent: Test Writer (fxm)");
    expect(result!.icon_emoji).toBe(":robot_face:");
  });
});
