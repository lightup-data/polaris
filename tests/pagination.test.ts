import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  createSession,
  pushEvent,
  getSessionEventsPage,
  type Sql,
} from "../src/service/db";
import type { PolarisEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `pag-org-${RUN}`;
const PROJECT = `pj-pagination-${RUN}`;
const SESSION = "fx-page";
const TIE_SESSION = "fx-ties";
const TOTAL = 25;

let sql: Sql;
const insertedIds: string[] = [];
const tieIds: string[] = [];

function makeEvent(session: string, timestamp: string, prompt: string): PolarisEvent {
  return {
    id: crypto.randomUUID(),
    project: PROJECT,
    session,
    timestamp,
    source: "hook",
    sender: "user:manu",
    payload: {
      hook_event_name: "UserPromptSubmit",
      session_id: "cc-page",
      prompt,
    },
  };
}

beforeAll(async () => {
  // Drop and recreate via createDb (mirrors tests/db.test.ts) so the schema —
  // including the additive migrations — matches src/service/db.ts exactly.
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS plan_changes`;
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
  await createOrg(sql, ORG, "Pagination Org");
  await createProject(sql, ORG, PROJECT);
  await createSession(sql, ORG, PROJECT, SESSION, "user:manu");
  await createSession(sql, ORG, PROJECT, TIE_SESSION, "user:manu");

  // 25 events with distinct millisecond timestamps, inserted oldest-first
  const base = Date.parse("2026-06-10T10:00:00.000Z");
  for (let i = 0; i < TOTAL; i++) {
    const event = makeEvent(SESSION, new Date(base + i * 1000).toISOString(), `prompt ${i}`);
    insertedIds.push(event.id);
    await pushEvent(sql, ORG, event);
  }

  // 6 events sharing an identical timestamp — keyset must fall back to id ordering
  const tieTs = "2026-06-10T12:00:00.000Z";
  for (let i = 0; i < 6; i++) {
    const event = makeEvent(TIE_SESSION, tieTs, `tie ${i}`);
    tieIds.push(event.id);
    await pushEvent(sql, ORG, event);
  }
});

afterAll(async () => {
  await sql.end();
});

describe("getSessionEventsPage", () => {
  test("returns at most `limit` events, newest first", async () => {
    const { events } = await getSessionEventsPage(sql, ORG, PROJECT, SESSION, { limit: 10 });
    expect(events).toHaveLength(10);
    expect(events[0].payload).toHaveProperty("prompt", `prompt ${TOTAL - 1}`);
    for (let i = 1; i < events.length; i++) {
      expect(Date.parse(events[i - 1].timestamp)).toBeGreaterThanOrEqual(Date.parse(events[i].timestamp));
    }
  });

  test("default limit returns everything when under 100, with null cursor", async () => {
    const { events, nextCursor } = await getSessionEventsPage(sql, ORG, PROJECT, SESSION);
    expect(events).toHaveLength(TOTAL);
    expect(nextCursor).toBeNull();
  });

  test("nextCursor is the composite cursor of the oldest returned row", async () => {
    const { events, nextCursor } = await getSessionEventsPage(sql, ORG, PROJECT, SESSION, { limit: 10 });
    const oldest = events[events.length - 1];
    expect(nextCursor).toBe(`${oldest.timestamp}|${oldest.id}`);
  });

  test("pages through all events with no duplicates or gaps", async () => {
    const seen = new Set<string>();
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    let lastCursor: string | null = null;
    while (true) {
      const page = await getSessionEventsPage(sql, ORG, PROJECT, SESSION, { limit: 10, before: cursor });
      if (page.events.length === 0) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      pageSizes.push(page.events.length);
      for (const event of page.events) {
        expect(seen.has(event.id)).toBe(false); // no duplicates across pages
        seen.add(event.id);
      }
      lastCursor = page.nextCursor;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pageSizes).toEqual([10, 10, 5]);
    expect(lastCursor).toBeNull(); // short final page ends pagination
    expect(seen.size).toBe(TOTAL);
    expect([...seen].sort()).toEqual([...insertedIds].sort()); // no gaps
  });

  test("pages do not overlap and stay strictly older across the cursor boundary", async () => {
    const page1 = await getSessionEventsPage(sql, ORG, PROJECT, SESSION, { limit: 10 });
    const page2 = await getSessionEventsPage(sql, ORG, PROJECT, SESSION, { limit: 10, before: page1.nextCursor! });
    const page1Ids = new Set(page1.events.map((e) => e.id));
    for (const event of page2.events) {
      expect(page1Ids.has(event.id)).toBe(false);
    }
    const oldestOfPage1 = page1.events[page1.events.length - 1];
    expect(Date.parse(page2.events[0].timestamp)).toBeLessThan(Date.parse(oldestOfPage1.timestamp));
  });

  test("keyset is stable across identical timestamps (id tiebreak, no dupes/gaps)", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const page = await getSessionEventsPage(sql, ORG, PROJECT, TIE_SESSION, { limit: 2, before: cursor });
      if (page.events.length === 0) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      for (const event of page.events) {
        expect(seen.has(event.id)).toBe(false);
        seen.add(event.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen.size).toBe(tieIds.length);
    expect([...seen].sort()).toEqual([...tieIds].sort());
  });

  test("empty session returns no events and a null cursor", async () => {
    const { events, nextCursor } = await getSessionEventsPage(sql, ORG, PROJECT, "fx-nothing-here");
    expect(events).toEqual([]);
    expect(nextCursor).toBeNull();
  });
});
