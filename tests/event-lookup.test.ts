import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  createSession,
  pushEvent,
  getEventById,
  getSessionEvents,
  type Sql,
} from "../src/service/db";
import type { PolarisEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `lookup-org-${RUN}`;
const PROJECT = `pj-lookup-${RUN}`;

let sql: Sql;

function makeEvent(overrides: Partial<PolarisEvent> = {}): PolarisEvent {
  return {
    id: crypto.randomUUID(),
    project: PROJECT,
    session: "s1",
    timestamp: new Date().toISOString(),
    source: "hook",
    sender: "user:manu",
    payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "hello lookup" },
    ...overrides,
  };
}

beforeAll(async () => {
  // Drop and recreate via createDb (mirrors tests/db.test.ts) so the schema
  // matches src/service/db.ts exactly.
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS plan_changes`;
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
  await createOrg(sql, ORG, "Lookup Org");
  await createProject(sql, ORG, PROJECT);
  await createSession(sql, ORG, PROJECT, "s1", "user:manu");
});

afterAll(async () => {
  await sql.end();
});

describe("pushEvent + getEventById", () => {
  test("a pushed event is retrievable by id with project name and org_id", async () => {
    const event = makeEvent();
    await pushEvent(sql, ORG, event);

    const fetched = await getEventById(sql, event.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(event.id);
    expect(fetched!.project).toBe(PROJECT);
    expect(fetched!.session).toBe("s1");
    expect(fetched!.source).toBe("hook");
    expect(fetched!.sender).toBe("user:manu");
    expect(fetched!.payload).toEqual(event.payload);
    expect(fetched!.org_id).toBe(ORG);
  });

  test("returns null for an unknown uuid and for a malformed id", async () => {
    expect(await getEventById(sql, crypto.randomUUID())).toBeNull();
    // NOTIFY payloads are untyped strings — a non-uuid must not throw
    expect(await getEventById(sql, "not-a-uuid")).toBeNull();
  });

  test("pushEvent into a nonexistent project is a silent no-op", async () => {
    const event = makeEvent({ project: `pj-missing-${RUN}` });
    await pushEvent(sql, ORG, event); // must not throw
    expect(await getEventById(sql, event.id)).toBeNull();
  });
});

describe("LISTEN/NOTIFY realtime backbone", () => {
  test("pushEvent NOTIFYs 'polaris_event' with the event id", async () => {
    // Dedicated second connection for LISTEN, mirroring how server.ts/bridge subscribe.
    const listener = await createDb(DATABASE_URL);
    const received: string[] = [];
    try {
      await listener.listen("polaris_event", (payload) => {
        received.push(payload);
      });

      const event = makeEvent({ payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "notify me" } });
      await pushEvent(sql, ORG, event);

      const deadline = Date.now() + 5000;
      while (!received.includes(event.id) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(received).toContain(event.id);

      // The notified id resolves to the full event via getEventById (the listener's own connection)
      const fetched = await getEventById(listener, event.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.org_id).toBe(ORG);
    } finally {
      await listener.end({ timeout: 5 });
    }
  }, 15000);
});
