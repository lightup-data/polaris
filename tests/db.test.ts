import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  createDb,
  createProject,
  getProject,
  createSession,
  getSession,
  setDriver,
  clearDriver,
  pushEvent,
  getProjectEvents,
  getSessionEvents,
  getEventsSince,
  type Sql,
} from "../src/service/db";
import type { CollabEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://collab:collab@localhost:5432/collab";

let sql: Sql;

beforeEach(async () => {
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
});

afterAll(async () => {
  await sql.end();
});

function makeEvent(overrides: Partial<CollabEvent> = {}): CollabEvent {
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
      prompt: "hello",
    },
    ...overrides,
  };
}

describe("projects", () => {
  test("create and retrieve a project", async () => {
    const project = await createProject(sql, "pj");
    expect(project.name).toBe("pj");
    expect(project.created_at).toBeDefined();

    const retrieved = await getProject(sql, "pj");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("pj");
  });

  test("duplicate project name throws", async () => {
    await createProject(sql, "pj");
    expect(createProject(sql, "pj")).rejects.toThrow();
  });

  test("get nonexistent project returns null", async () => {
    expect(await getProject(sql, "nope")).toBeNull();
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    await createProject(sql, "pj");
  });

  test("create and retrieve a session", async () => {
    const session = await createSession(sql, "pj", "fxm", "user:manu");
    expect(session.name).toBe("fxm");
    expect(session.project).toBe("pj");
    expect(session.driver).toBe("user:manu");

    const retrieved = await getSession(sql, "pj", "fxm");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.driver).toBe("user:manu");
  });

  test("create session with null driver", async () => {
    const session = await createSession(sql, "pj", "open-session", null);
    expect(session.driver).toBeNull();
  });

  test("duplicate session name in same project throws", async () => {
    await createSession(sql, "pj", "fxm", "user:manu");
    expect(createSession(sql, "pj", "fxm", "user:krishna")).rejects.toThrow();
  });

  test("same session name in different projects is fine", async () => {
    await createProject(sql, "pj2");
    await createSession(sql, "pj", "fxm", "user:manu");
    const s2 = await createSession(sql, "pj2", "fxm", "user:krishna");
    expect(s2.driver).toBe("user:krishna");
  });

  test("get nonexistent session returns null", async () => {
    expect(await getSession(sql, "pj", "nope")).toBeNull();
  });

  test("set driver", async () => {
    await createSession(sql, "pj", "fxm", "user:manu");
    await setDriver(sql, "pj", "fxm", "user:krishna");
    const session = await getSession(sql, "pj", "fxm");
    expect(session!.driver).toBe("user:krishna");
  });

  test("clear driver", async () => {
    await createSession(sql, "pj", "fxm", "user:manu");
    await clearDriver(sql, "pj", "fxm");
    const session = await getSession(sql, "pj", "fxm");
    expect(session!.driver).toBeNull();
  });
});

describe("events", () => {
  beforeEach(async () => {
    await createProject(sql, "pj");
    await createSession(sql, "pj", "fxm", "user:manu");
    await createSession(sql, "pj", "fxk", "user:krishna");
  });

  test("push and retrieve events by project", async () => {
    const e1 = makeEvent({ session: "fxm", timestamp: "2026-06-05T10:00:00.000Z" });
    const e2 = makeEvent({ session: "fxk", sender: "user:krishna", timestamp: "2026-06-05T10:01:00.000Z" });
    await pushEvent(sql, e1);
    await pushEvent(sql, e2);

    const events = await getProjectEvents(sql, "pj");
    expect(events).toHaveLength(2);
    expect(events[0].session).toBe("fxm");
    expect(events[1].session).toBe("fxk");
  });

  test("retrieve events by session", async () => {
    await pushEvent(sql, makeEvent({ session: "fxm" }));
    await pushEvent(sql, makeEvent({ session: "fxk", sender: "user:krishna" }));
    await pushEvent(sql, makeEvent({ session: "fxm" }));

    const fxmEvents = await getSessionEvents(sql, "pj", "fxm");
    expect(fxmEvents).toHaveLength(2);

    const fxkEvents = await getSessionEvents(sql, "pj", "fxk");
    expect(fxkEvents).toHaveLength(1);
  });

  test("events are ordered by timestamp", async () => {
    await pushEvent(sql, makeEvent({ session: "fxm", timestamp: "2026-06-05T10:02:00.000Z" }));
    await pushEvent(sql, makeEvent({ session: "fxm", timestamp: "2026-06-05T10:00:00.000Z" }));
    await pushEvent(sql, makeEvent({ session: "fxm", timestamp: "2026-06-05T10:01:00.000Z" }));

    const events = await getSessionEvents(sql, "pj", "fxm");
    expect(events[0].timestamp).toBe("2026-06-05T10:00:00.000Z");
    expect(events[1].timestamp).toBe("2026-06-05T10:01:00.000Z");
    expect(events[2].timestamp).toBe("2026-06-05T10:02:00.000Z");
  });

  test("getEventsSince filters by timestamp", async () => {
    await pushEvent(sql, makeEvent({ timestamp: "2026-06-05T10:00:00.000Z" }));
    await pushEvent(sql, makeEvent({ timestamp: "2026-06-05T10:01:00.000Z" }));
    await pushEvent(sql, makeEvent({ timestamp: "2026-06-05T10:02:00.000Z" }));

    const events = await getEventsSince(sql, "pj", "2026-06-05T10:00:30.000Z");
    expect(events).toHaveLength(2);
    expect(events[0].timestamp).toBe("2026-06-05T10:01:00.000Z");
  });

  test("payload round-trips through JSONB", async () => {
    const event = makeEvent({
      source: "inject",
      payload: {
        type: "inject" as const,
        content: "Use RS256",
        sender: "user:krishna" as const,
        target: "fxm",
      },
    });
    await pushEvent(sql, event);

    const events = await getSessionEvents(sql, "pj", "fxm");
    expect(events[0].payload).toEqual(event.payload);
  });

  test("empty project returns empty array", async () => {
    expect(await getProjectEvents(sql, "pj")).toEqual([]);
  });
});
