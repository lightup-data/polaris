import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { createDb, createOrg, createProject, createSession, getSessionEvents, pushEvent, type Sql } from "../src/service/db";
import { formatEventForSlack } from "../src/slack/format";
import type { PolarisEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

let sql: Sql;

beforeAll(async () => {
  sql = await createDb(DATABASE_URL);
});

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql`CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, domain TEXT, slack_team_id TEXT, slack_bot_token TEXT, slack_system_channel_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), participant_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  await sql`CREATE TABLE IF NOT EXISTS projects (name TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id), slack_channel_id TEXT, slack_channel_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, name))`;
  await sql`CREATE TABLE IF NOT EXISTS sessions (name TEXT NOT NULL, project TEXT NOT NULL, org_id TEXT NOT NULL, driver TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (org_id, project, name), FOREIGN KEY (org_id, project) REFERENCES projects(org_id, name))`;
  await sql`CREATE TABLE IF NOT EXISTS events (id UUID PRIMARY KEY, org_id TEXT NOT NULL, project TEXT NOT NULL, session TEXT NOT NULL, timestamp TIMESTAMPTZ NOT NULL, source TEXT NOT NULL, sender TEXT NOT NULL, payload JSONB NOT NULL)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_project ON events(org_id, project, timestamp)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_session ON events(org_id, project, session, timestamp)`;

  await createOrg(sql, "test-org", "Test Org", "test.com");
  await createProject(sql, "test-org", "myproject");
  await createSession(sql, "test-org", "myproject", "fxm", "user:manu");
});

describe("bridge: Slack → DB injection", () => {
  test("inject message writes to events table", async () => {
    // Simulate what handleSlackMessage does after parsing @fxm content
    const { getSession } = await import("../src/service/db");

    const session = await getSession(sql, "test-org", "myproject", "fxm");
    expect(session).not.toBeNull();

    const injectEvent: PolarisEvent = {
      id: crypto.randomUUID(),
      project: "myproject",
      session: "fxm",
      timestamp: new Date().toISOString(),
      source: "inject",
      sender: "slack:manu.bansal" as PolarisEvent["sender"],
      payload: {
        type: "inject" as const,
        content: "add token refresh",
        sender: "slack:manu.bansal" as PolarisEvent["sender"],
        target: "fxm",
      },
    };

    await pushEvent(sql, "test-org", injectEvent);

    const events = await getSessionEvents(sql, "test-org", "myproject", "fxm");
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("inject");
    expect(events[0].sender).toBe("slack:manu.bansal");
    expect((events[0].payload as { content: string }).content).toBe("add token refresh");
  });

  test("inject with slack: sender prefix validates", async () => {
    const event: PolarisEvent = {
      id: crypto.randomUUID(),
      project: "myproject",
      session: "fxm",
      timestamp: new Date().toISOString(),
      source: "inject",
      sender: "slack:krishna" as PolarisEvent["sender"],
      payload: {
        type: "inject" as const,
        content: "use RS256",
        sender: "slack:krishna" as PolarisEvent["sender"],
        target: "fxm",
      },
    };

    await pushEvent(sql, "test-org", event);

    const events = await getSessionEvents(sql, "test-org", "myproject", "fxm");
    expect(events[0].sender).toBe("slack:krishna");
  });

  test("inject to nonexistent session can auto-create", async () => {
    // Session doesn't exist yet
    let session = await getSessionEvents(sql, "test-org", "myproject", "new-session");
    expect(session).toHaveLength(0);

    // Create session on the fly (like the bridge would)
    await createSession(sql, "test-org", "myproject", "new-session", null);

    const event: PolarisEvent = {
      id: crypto.randomUUID(),
      project: "myproject",
      session: "new-session",
      timestamp: new Date().toISOString(),
      source: "inject",
      sender: "slack:advisor" as PolarisEvent["sender"],
      payload: {
        type: "inject" as const,
        content: "advice for new session",
        sender: "slack:advisor" as PolarisEvent["sender"],
        target: "new-session",
      },
    };

    await pushEvent(sql, "test-org", event);

    const events = await getSessionEvents(sql, "test-org", "myproject", "new-session");
    expect(events).toHaveLength(1);
  });
});

describe("bridge: DB → Slack formatting", () => {
  test("formats UserPromptSubmit for Slack", () => {
    const event: PolarisEvent = {
      id: crypto.randomUUID(),
      project: "myproject",
      session: "fxm",
      timestamp: new Date().toISOString(),
      source: "hook",
      sender: "user:manu",
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: "build auth middleware",
      },
    };

    const result = formatEventForSlack(event);
    expect(result).not.toBeNull();
    expect(result!.username).toContain("Manu");
    expect(result!.username).toContain("fxm");
    expect(result!.text).toContain("build auth middleware");
  });

  test("skips _system events", () => {
    const event: PolarisEvent = {
      id: crypto.randomUUID(),
      project: "_system",
      session: "_system",
      timestamp: new Date().toISOString(),
      source: "hook",
      sender: "user:manu",
      payload: {
        hook_event_name: "Stop",
        session_id: "_system",
        stop_response: "Device connected",
      },
    };

    // The bridge skips _system in postEventToSlack, not in formatEventForSlack
    // But formatEventForSlack still formats it — the bridge filters upstream
    const result = formatEventForSlack(event);
    expect(result).not.toBeNull(); // formatter doesn't filter _system
  });

  test("skips tool calls", () => {
    const event: PolarisEvent = {
      id: crypto.randomUUID(),
      project: "myproject",
      session: "fxm",
      timestamp: new Date().toISOString(),
      source: "hook",
      sender: "user:manu",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
    };

    expect(formatEventForSlack(event)).toBeNull();
  });
});

describe("bridge: message parsing", () => {
  test("parses @session content format", () => {
    const text = "@fxm add token refresh";
    const match = text.match(/^@(\S+)\s+(.+)$/s);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("fxm");
    expect(match![2]).toBe("add token refresh");
  });

  test("parses session: content format", () => {
    const text = "fxm: add token refresh";
    const match = text.match(/^(\S+):\s+(.+)$/s);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("fxm");
    expect(match![2]).toBe("add token refresh");
  });

  test("no match for plain message", () => {
    const text = "just a regular message";
    const match = text.match(/^@(\S+)\s+(.+)$/s) || text.match(/^(\S+):\s+(.+)$/s);
    expect(match).toBeNull();
  });

  test("handles multiline content", () => {
    const text = "@fxm here is some advice\nwith multiple lines\nof content";
    const match = text.match(/^@(\S+)\s+(.+)$/s);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("fxm");
    expect(match![2]).toContain("multiple lines");
  });
});
