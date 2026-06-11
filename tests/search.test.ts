import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  createSession,
  pushEvent,
  searchEvents,
  type Sql,
} from "../src/service/db";
import type { PolarisEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `search-org-${RUN}`;
const PROJECT_A = `pj-search-a-${RUN}`;
const PROJECT_B = `pj-search-b-${RUN}`;

let sql: Sql;

function baseEvent(project: string, session: string, timestamp: string): Pick<PolarisEvent, "id" | "project" | "session" | "timestamp"> {
  return { id: crypto.randomUUID(), project, session, timestamp };
}

// Distinctive vocabulary per field so each match is unambiguous:
//   "zeppelin"  -> prompt (A/s1), inject content (A/s1), prompt (B/s1)
//   "quasar"    -> stop_response (A/s1)
//   "labyrinth" -> last_assistant_message (A/s2)
const promptEvent: PolarisEvent = {
  ...baseEvent(PROJECT_A, "s1", "2026-06-10T10:00:00.000Z"),
  source: "hook",
  sender: "user:manu",
  payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "deploy the zeppelin airship today" },
};
const stopEvent: PolarisEvent = {
  ...baseEvent(PROJECT_A, "s1", "2026-06-10T10:01:00.000Z"),
  source: "hook",
  sender: "agent:claude",
  payload: { hook_event_name: "Stop", session_id: "cc-s", stop_response: "the quasar pipeline output is ready" },
};
const lastMessageEvent: PolarisEvent = {
  ...baseEvent(PROJECT_A, "s2", "2026-06-10T10:02:00.000Z"),
  source: "hook",
  sender: "agent:claude",
  payload: { hook_event_name: "Stop", session_id: "cc-s", last_assistant_message: "finished the labyrinth refactor" },
};
const injectEvent: PolarisEvent = {
  ...baseEvent(PROJECT_A, "s1", "2026-06-10T10:03:00.000Z"),
  source: "inject",
  sender: "user:priya",
  payload: { type: "inject", content: "watch the zeppelin fuel budget", sender: "user:priya", target: "s1" },
};
const otherProjectEvent: PolarisEvent = {
  ...baseEvent(PROJECT_B, "s1", "2026-06-10T10:04:00.000Z"),
  source: "hook",
  sender: "user:manu",
  payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "zeppelin maintenance checklist" },
};

beforeAll(async () => {
  // Drop and recreate via createDb (mirrors tests/db.test.ts) so the schema —
  // including the additive migrations — matches src/service/db.ts exactly.
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
  await createOrg(sql, ORG, "Search Org");
  await createProject(sql, ORG, PROJECT_A);
  await createProject(sql, ORG, PROJECT_B);
  await createSession(sql, ORG, PROJECT_A, "s1", "user:manu");
  await createSession(sql, ORG, PROJECT_A, "s2", "user:manu");
  await createSession(sql, ORG, PROJECT_B, "s1", "user:manu");
  for (const event of [promptEvent, stopEvent, lastMessageEvent, injectEvent, otherProjectEvent]) {
    await pushEvent(sql, ORG, event);
  }
});

afterAll(async () => {
  await sql.end();
});

function ids(results: Array<{ event: PolarisEvent; snippet: string }>): string[] {
  return results.map((r) => r.event.id).sort();
}

describe("searchEvents", () => {
  test("matches a keyword in stop_response and returns a non-empty snippet", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "quasar" });
    expect(results).toHaveLength(1);
    expect(results[0].event.id).toBe(stopEvent.id);
    expect(results[0].snippet.length).toBeGreaterThan(0);
    expect(results[0].snippet.toLowerCase()).toContain("quasar");
  });

  test("matches across prompt, inject content, and last_assistant_message", async () => {
    const zeppelin = await searchEvents(sql, ORG, { q: "zeppelin" });
    expect(ids(zeppelin.results)).toEqual([promptEvent.id, injectEvent.id, otherProjectEvent.id].sort());

    const labyrinth = await searchEvents(sql, ORG, { q: "labyrinth" });
    expect(ids(labyrinth.results)).toEqual([lastMessageEvent.id]);
  });

  test("respects the project filter", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "zeppelin", project: PROJECT_A });
    expect(ids(results)).toEqual([promptEvent.id, injectEvent.id].sort());
  });

  test("respects the session filter", async () => {
    const inS1 = await searchEvents(sql, ORG, { q: "zeppelin", project: PROJECT_A, session: "s1" });
    expect(ids(inS1.results)).toEqual([promptEvent.id, injectEvent.id].sort());

    const inS2 = await searchEvents(sql, ORG, { q: "zeppelin", project: PROJECT_A, session: "s2" });
    expect(inS2.results).toEqual([]);
  });

  test("respects the sender filter", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "zeppelin", sender: "user:priya" });
    expect(ids(results)).toEqual([injectEvent.id]);
  });

  test("respects the source filter", async () => {
    const injects = await searchEvents(sql, ORG, { q: "zeppelin", source: "inject" });
    expect(ids(injects.results)).toEqual([injectEvent.id]);

    const hooks = await searchEvents(sql, ORG, { q: "zeppelin", source: "hook" });
    expect(ids(hooks.results)).toEqual([promptEvent.id, otherProjectEvent.id].sort());
  });

  test("respects the limit", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "zeppelin", limit: 1 });
    expect(results).toHaveLength(1);
  });

  test("returns no results for a non-matching query", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "octopus" });
    expect(results).toEqual([]);
  });
});
