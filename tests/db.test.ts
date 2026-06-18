import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { resetTestData } from "./helpers";
import {
  createDb,
  createOrg,
  getOrg,
  getOrgByDomain,
  setOrgSlack,
  createUser,
  getUser,
  getUserByEmail,
  upsertUser,
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
import type { PolarisEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

let sql: Sql;

beforeEach(async () => {
  sql = await createDb(DATABASE_URL);
  await resetTestData(sql);
  await createOrg(sql, "test-org", "Test Org");
});

afterAll(async () => {
  await sql.end();
});

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
      prompt: "hello",
    },
    ...overrides,
  };
}

describe("orgs", () => {
  test("create and retrieve an org", async () => {
    const org = await getOrg(sql, "test-org");
    expect(org).not.toBeNull();
    expect(org!.name).toBe("Test Org");
    expect(org!.created_at).toBeDefined();
  });

  test("duplicate org id throws", async () => {
    expect(createOrg(sql, "test-org", "Duplicate")).rejects.toThrow();
  });

  test("get nonexistent org returns null", async () => {
    expect(await getOrg(sql, "nope")).toBeNull();
  });

  test("get org by domain", async () => {
    await createOrg(sql, "domain-org", "Domain Org", "example.com");
    const org = await getOrgByDomain(sql, "example.com");
    expect(org).not.toBeNull();
    expect(org!.id).toBe("domain-org");
  });

  test("get org by domain returns null for unknown domain", async () => {
    expect(await getOrgByDomain(sql, "unknown.com")).toBeNull();
  });

  test("set org slack credentials", async () => {
    await setOrgSlack(sql, "test-org", "T123", "xoxb-token");
    const org = await getOrg(sql, "test-org");
    expect(org!.slack_team_id).toBe("T123");
    expect(org!.slack_bot_token).toBe("xoxb-token");
  });
});

describe("users", () => {
  test("create and retrieve a user", async () => {
    const user = await createUser(sql, "u1", "manu@test.com", "Manu", "test-org", "user:manu");
    expect(user.email).toBe("manu@test.com");
    expect(user.org_id).toBe("test-org");
    expect(user.participant_id).toBe("user:manu");

    const retrieved = await getUser(sql, "u1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("Manu");
  });

  test("get user by email", async () => {
    await createUser(sql, "u2", "krishna@test.com", "Krishna", "test-org", "user:krishna");
    const user = await getUserByEmail(sql, "krishna@test.com");
    expect(user).not.toBeNull();
    expect(user!.id).toBe("u2");
  });

  test("get nonexistent user returns null", async () => {
    expect(await getUser(sql, "nope")).toBeNull();
    expect(await getUserByEmail(sql, "nope@test.com")).toBeNull();
  });

  test("duplicate email throws", async () => {
    await createUser(sql, "u3", "dupe@test.com", "User A", "test-org", "user:a");
    expect(createUser(sql, "u4", "dupe@test.com", "User B", "test-org", "user:b")).rejects.toThrow();
  });

  test("upsert user updates existing", async () => {
    await createUser(sql, "u5", "upsert@test.com", "Old Name", "test-org", "user:old");
    const updated = await upsertUser(sql, "u5-new", "upsert@test.com", "New Name", "test-org", "user:new");
    expect(updated.name).toBe("New Name");
    expect(updated.participant_id).toBe("user:new");

    const fetched = await getUserByEmail(sql, "upsert@test.com");
    expect(fetched!.name).toBe("New Name");
  });
});

describe("projects", () => {
  test("create and retrieve a project", async () => {
    const project = await createProject(sql, "test-org", "pj");
    expect(project.name).toBe("pj");
    expect(project.created_at).toBeDefined();

    const retrieved = await getProject(sql, "test-org", "pj");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe("pj");
  });

  test("duplicate project name throws", async () => {
    await createProject(sql, "test-org", "pj");
    expect(createProject(sql, "test-org", "pj")).rejects.toThrow();
  });

  test("get nonexistent project returns null", async () => {
    expect(await getProject(sql, "test-org", "nope")).toBeNull();
  });
});

describe("sessions", () => {
  beforeEach(async () => {
    await createProject(sql, "test-org", "pj");
  });

  test("create and retrieve a session", async () => {
    const session = await createSession(sql, "test-org", "pj", "fxm", "user:manu");
    expect(session.name).toBe("fxm");
    expect(session.project).toBe("pj");
    expect(session.driver).toBe("user:manu");

    const retrieved = await getSession(sql, "test-org", "pj", "fxm");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.driver).toBe("user:manu");
  });

  test("create session with null driver", async () => {
    const session = await createSession(sql, "test-org", "pj", "open-session", null);
    expect(session.driver).toBeNull();
  });

  test("duplicate session name in same project throws", async () => {
    await createSession(sql, "test-org", "pj", "fxm", "user:manu");
    expect(createSession(sql, "test-org", "pj", "fxm", "user:krishna")).rejects.toThrow();
  });

  test("same session name in different projects is fine", async () => {
    await createProject(sql, "test-org", "pj2");
    await createSession(sql, "test-org", "pj", "fxm", "user:manu");
    const s2 = await createSession(sql, "test-org", "pj2", "fxm", "user:krishna");
    expect(s2.driver).toBe("user:krishna");
  });

  test("get nonexistent session returns null", async () => {
    expect(await getSession(sql, "test-org", "pj", "nope")).toBeNull();
  });

  test("set driver", async () => {
    await createSession(sql, "test-org", "pj", "fxm", "user:manu");
    await setDriver(sql, "test-org", "pj", "fxm", "user:krishna");
    const session = await getSession(sql, "test-org", "pj", "fxm");
    expect(session!.driver).toBe("user:krishna");
  });

  test("clear driver", async () => {
    await createSession(sql, "test-org", "pj", "fxm", "user:manu");
    await clearDriver(sql, "test-org", "pj", "fxm");
    const session = await getSession(sql, "test-org", "pj", "fxm");
    expect(session!.driver).toBeNull();
  });
});

describe("events", () => {
  beforeEach(async () => {
    await createProject(sql, "test-org", "pj");
    await createSession(sql, "test-org", "pj", "fxm", "user:manu");
    await createSession(sql, "test-org", "pj", "fxk", "user:krishna");
  });

  test("push and retrieve events by project", async () => {
    const e1 = makeEvent({ session: "fxm", timestamp: "2026-06-05T10:00:00.000Z" });
    const e2 = makeEvent({ session: "fxk", sender: "user:krishna", timestamp: "2026-06-05T10:01:00.000Z" });
    await pushEvent(sql, "test-org", e1);
    await pushEvent(sql, "test-org", e2);

    const events = await getProjectEvents(sql, "test-org", "pj");
    expect(events).toHaveLength(2);
    expect(events[0].session).toBe("fxm");
    expect(events[1].session).toBe("fxk");
  });

  test("retrieve events by session", async () => {
    await pushEvent(sql, "test-org", makeEvent({ session: "fxm" }));
    await pushEvent(sql, "test-org", makeEvent({ session: "fxk", sender: "user:krishna" }));
    await pushEvent(sql, "test-org", makeEvent({ session: "fxm" }));

    const fxmEvents = await getSessionEvents(sql, "test-org", "pj", "fxm");
    expect(fxmEvents).toHaveLength(2);

    const fxkEvents = await getSessionEvents(sql, "test-org", "pj", "fxk");
    expect(fxkEvents).toHaveLength(1);
  });

  test("events are ordered by timestamp", async () => {
    await pushEvent(sql, "test-org", makeEvent({ session: "fxm", timestamp: "2026-06-05T10:02:00.000Z" }));
    await pushEvent(sql, "test-org", makeEvent({ session: "fxm", timestamp: "2026-06-05T10:00:00.000Z" }));
    await pushEvent(sql, "test-org", makeEvent({ session: "fxm", timestamp: "2026-06-05T10:01:00.000Z" }));

    const events = await getSessionEvents(sql, "test-org", "pj", "fxm");
    expect(events[0].timestamp).toBe("2026-06-05T10:00:00.000Z");
    expect(events[1].timestamp).toBe("2026-06-05T10:01:00.000Z");
    expect(events[2].timestamp).toBe("2026-06-05T10:02:00.000Z");
  });

  test("getEventsSince filters by timestamp", async () => {
    await pushEvent(sql, "test-org", makeEvent({ timestamp: "2026-06-05T10:00:00.000Z" }));
    await pushEvent(sql, "test-org", makeEvent({ timestamp: "2026-06-05T10:01:00.000Z" }));
    await pushEvent(sql, "test-org", makeEvent({ timestamp: "2026-06-05T10:02:00.000Z" }));

    const events = await getEventsSince(sql, "test-org", "pj", "2026-06-05T10:00:30.000Z");
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
    await pushEvent(sql, "test-org", event);

    const events = await getSessionEvents(sql, "test-org", "pj", "fxm");
    expect(events[0].payload).toEqual(event.payload);
  });

  test("empty project returns empty array", async () => {
    expect(await getProjectEvents(sql, "test-org", "pj")).toEqual([]);
  });
});
