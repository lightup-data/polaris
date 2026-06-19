import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  createSession,
  pushEvent,
  addAnnotation,
  listSessionAnnotations,
  listDecisions,
  deleteAnnotation,
  searchEvents,
  type Sql,
} from "../src/service/db";
import { Annotation } from "../src/types";
import type { PolarisEvent } from "../src/types";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
// (annotations rows survive resetTestData, so org-scoped uniqueness matters.)
const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `anno-org-${RUN}`;
const OTHER_ORG = `anno-other-org-${RUN}`;
const PROJECT = `pj-anno-${RUN}`;
const PROJECT_B = `pj-anno-b-${RUN}`;

let sql: Sql;

function makeEvent(overrides: Partial<PolarisEvent> = {}): PolarisEvent {
  return {
    id: crypto.randomUUID(),
    project: PROJECT,
    session: "s1",
    timestamp: new Date().toISOString(),
    source: "hook",
    sender: "user:manu",
    payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "hello" },
    ...overrides,
  };
}

beforeAll(async () => {
  // Drop and recreate via createDb (mirrors tests/db.test.ts) so the schema —
  // including the additive annotations migration — matches src/service/db.ts exactly.
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS plan_changes`;
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
  await createOrg(sql, ORG, "Annotations Org");
  await createOrg(sql, OTHER_ORG, "Other Annotations Org");
  await createProject(sql, ORG, PROJECT);
  await createProject(sql, ORG, PROJECT_B);
  await createSession(sql, ORG, PROJECT, "s1", "user:manu");
  await createSession(sql, ORG, PROJECT, "s2", "user:manu");
});

afterAll(async () => {
  await sql.end();
});

describe("annotations CRUD", () => {
  test("add a star and list it back", async () => {
    const event = makeEvent();
    await pushEvent(sql, ORG, event);
    const { id } = await addAnnotation(sql, ORG, {
      event_id: event.id,
      project: PROJECT,
      session: "s1",
      participant_id: "user:manu",
      kind: "star",
    });
    expect(id).toBeDefined();

    const annotations = await listSessionAnnotations(sql, ORG, PROJECT, "s1");
    const star = annotations.find((a) => a.id === id);
    expect(star).toBeDefined();
    expect(star!.kind).toBe("star");
    expect(star!.event_id).toBe(event.id);
    expect(star!.participant_id).toBe("user:manu");
    expect(star!.value).toBeNull();
    // Round-trips through the shared zod schema
    expect(() => Annotation.parse(star)).not.toThrow();
  });

  test("add a tag with a value and a session-level decision (no event_id)", async () => {
    const event = makeEvent();
    await pushEvent(sql, ORG, event);
    const tag = await addAnnotation(sql, ORG, {
      event_id: event.id,
      project: PROJECT,
      session: "s1",
      participant_id: "user:krishna",
      kind: "tag",
      value: "auth",
    });
    const decision = await addAnnotation(sql, ORG, {
      project: PROJECT,
      session: "s1",
      kind: "decision",
      value: "Use RS256 for signing",
    });

    const annotations = await listSessionAnnotations(sql, ORG, PROJECT, "s1");
    const tagged = annotations.find((a) => a.id === tag.id);
    expect(tagged!.kind).toBe("tag");
    expect(tagged!.value).toBe("auth");

    const decided = annotations.find((a) => a.id === decision.id);
    expect(decided!.kind).toBe("decision");
    expect(decided!.event_id).toBeNull();
    expect(decided!.participant_id).toBeNull();
  });

  test("listSessionAnnotations is scoped to org, project, and session", async () => {
    const inS2 = await addAnnotation(sql, ORG, { project: PROJECT, session: "s2", kind: "star" });
    const otherOrg = await addAnnotation(sql, OTHER_ORG, { project: PROJECT, session: "s1", kind: "star" });

    const s1Ids = (await listSessionAnnotations(sql, ORG, PROJECT, "s1")).map((a) => a.id);
    expect(s1Ids).not.toContain(inS2.id);
    expect(s1Ids).not.toContain(otherOrg.id);

    const s2Ids = (await listSessionAnnotations(sql, ORG, PROJECT, "s2")).map((a) => a.id);
    expect(s2Ids).toContain(inS2.id);
  });

  test("listDecisions returns only decisions, newest first, with project filter and limit", async () => {
    const d1 = await addAnnotation(sql, ORG, { project: PROJECT, session: "s2", kind: "decision", value: "first" });
    const d2 = await addAnnotation(sql, ORG, { project: PROJECT_B, session: "s9", kind: "decision", value: "second" });
    await addAnnotation(sql, ORG, { project: PROJECT_B, session: "s9", kind: "tag", value: "not-a-decision" });

    const all = await listDecisions(sql, ORG);
    expect(all.every((a) => a.kind === "decision")).toBe(true);
    const ids = all.map((a) => a.id);
    expect(ids).toContain(d1.id);
    expect(ids).toContain(d2.id);
    // Newest first
    expect(ids.indexOf(d2.id)).toBeLessThan(ids.indexOf(d1.id));

    const onlyB = await listDecisions(sql, ORG, { project: PROJECT_B });
    expect(onlyB.map((a) => a.id)).toContain(d2.id);
    expect(onlyB.map((a) => a.id)).not.toContain(d1.id);

    const limited = await listDecisions(sql, ORG, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test("deleteAnnotation removes it; wrong org is a no-op", async () => {
    const { id } = await addAnnotation(sql, ORG, { project: PROJECT, session: "s1", kind: "star" });

    // Deleting under a different org must not remove it
    await deleteAnnotation(sql, OTHER_ORG, id);
    let ids = (await listSessionAnnotations(sql, ORG, PROJECT, "s1")).map((a) => a.id);
    expect(ids).toContain(id);

    await deleteAnnotation(sql, ORG, id);
    ids = (await listSessionAnnotations(sql, ORG, PROJECT, "s1")).map((a) => a.id);
    expect(ids).not.toContain(id);
  });
});

describe("searchEvents tag filter", () => {
  // Distinctive vocabulary ("kraken") so full-text matches are unambiguous.
  const taggedInfra = makeEvent({
    timestamp: "2026-06-10T10:00:00.000Z",
    payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "the kraken deployment plan" },
  });
  const taggedBug = makeEvent({
    timestamp: "2026-06-10T10:01:00.000Z",
    payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "kraken retry logic" },
  });
  const untagged = makeEvent({
    timestamp: "2026-06-10T10:02:00.000Z",
    payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt: "kraken docs" },
  });

  beforeAll(async () => {
    for (const event of [taggedInfra, taggedBug, untagged]) {
      await pushEvent(sql, ORG, event);
    }
    await addAnnotation(sql, ORG, { event_id: taggedInfra.id, project: PROJECT, session: "s1", kind: "tag", value: "infra" });
    await addAnnotation(sql, ORG, { event_id: taggedBug.id, project: PROJECT, session: "s1", kind: "tag", value: "bug" });
    // A star with the same value must NOT satisfy the tag filter (kind='tag' only)
    await addAnnotation(sql, ORG, { event_id: untagged.id, project: PROJECT, session: "s1", kind: "star", value: "infra" });
  });

  test("without a tag filter all matches are returned", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "kraken" });
    expect(results.map((r) => r.event.id).sort()).toEqual([taggedInfra.id, taggedBug.id, untagged.id].sort());
  });

  test("tag filter restricts to events carrying that tag annotation", async () => {
    const infra = await searchEvents(sql, ORG, { q: "kraken", tag: "infra" });
    expect(infra.results.map((r) => r.event.id)).toEqual([taggedInfra.id]);

    const bug = await searchEvents(sql, ORG, { q: "kraken", tag: "bug" });
    expect(bug.results.map((r) => r.event.id)).toEqual([taggedBug.id]);
  });

  test("an unknown tag matches nothing", async () => {
    const { results } = await searchEvents(sql, ORG, { q: "kraken", tag: "nope" });
    expect(results).toEqual([]);
  });
});
