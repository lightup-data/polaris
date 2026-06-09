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
  test("formats UserPromptSubmit", () => {
    const result = formatEventForSlack(makeEvent());
    expect(result).not.toBeNull();
    expect(result!.text).toContain("user:manu");
    expect(result!.text).toContain("fxm");
    expect(result!.text).toContain("build auth middleware");
    expect(result!.blocks).toHaveLength(2);
  });

  test("formats Stop", () => {
    const result = formatEventForSlack(makeEvent({
      payload: {
        hook_event_name: "Stop",
        session_id: "s1",
        stop_response: "Created src/middleware/auth.ts",
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain("agent");
    expect(result!.text).toContain("Created src/middleware/auth.ts");
  });

  test("skips PreToolUse", () => {
    const result = formatEventForSlack(makeEvent({
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    }));
    expect(result).toBeNull();
  });

  test("skips PostToolUse", () => {
    const result = formatEventForSlack(makeEvent({
      payload: {
        hook_event_name: "PostToolUse",
        session_id: "s1",
        tool_name: "Read",
        tool_input: { file_path: "/tmp/test" },
        tool_result: { content: [{ type: "text", text: "file" }] },
      },
    }));
    expect(result).toBeNull();
  });

  test("formats inject message", () => {
    const result = formatEventForSlack(makeEvent({
      source: "inject",
      sender: "user:krishna",
      payload: {
        type: "inject" as const,
        content: "Use RS256 for the JWT",
        sender: "user:krishna",
        target: "fxm",
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain("user:krishna");
    expect(result!.text).toContain("fxm");
    expect(result!.text).toContain("Use RS256");
  });

  test("formats reply message", () => {
    const result = formatEventForSlack(makeEvent({
      source: "reply",
      sender: "user:manu",
      payload: {
        type: "reply" as const,
        content: "Done, switched to RS256",
        sender: "user:manu",
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.text).toContain("replied");
    expect(result!.text).toContain("Done, switched to RS256");
  });

  test("truncates long messages", () => {
    const longText = "x".repeat(3000);
    const result = formatEventForSlack(makeEvent({
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: longText,
      },
    }));
    expect(result).not.toBeNull();
    expect(result!.blocks[1].text).toBeDefined();
    const bodyText = (result!.blocks[1].text as { text: string }).text;
    expect(bodyText.length).toBeLessThan(2100);
    expect(bodyText).toContain("...");
  });

  test("converts markdown bold to mrkdwn", () => {
    const result = formatEventForSlack(makeEvent({
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: "This is **bold** text",
      },
    }));
    expect(result).not.toBeNull();
    const bodyText = (result!.blocks[1].text as { text: string }).text;
    expect(bodyText).toContain("*bold*");
    expect(bodyText).not.toContain("**bold**");
  });

  test("skips _system events", () => {
    const result = formatEventForSlack(makeEvent({ project: "_system", session: "_system" }));
    // _system filtering is done in the bridge, not the formatter
    // The formatter should still format it
    expect(result).not.toBeNull();
  });
});
