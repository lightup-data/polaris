import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  createSession,
  pushEvent,
  searchEvents,
  addAnnotation,
  listDecisions,
  setProjectVisibility,
  addProjectMember,
  type Sql,
} from "../src/service/db";
import type { PolarisEvent } from "../src/types";

// Regression test for the ACL bypass: search / decisions WITHOUT a project filter
// must not leak content from 'members'-restricted projects to non-members.

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `sacl-org-${RUN}`;
const OPEN_PROJECT = `pj-sacl-open-${RUN}`;
const LOCKED_PROJECT = `pj-sacl-locked-${RUN}`;
const MEMBER = `user:member-${RUN}`;
const OUTSIDER = `user:outsider-${RUN}`;

// Distinctive single-token search terms so each match is unambiguous.
const OPEN_TERM = "pelican";
const LOCKED_TERM = "narwhal";

let sql: Sql;

function ev(project: string, session: string, ts: string, prompt: string): PolarisEvent {
  return {
    id: crypto.randomUUID(),
    project,
    session,
    timestamp: ts,
    source: "hook",
    sender: "user:manu",
    payload: { hook_event_name: "UserPromptSubmit", session_id: "cc-s", prompt },
  };
}

beforeAll(async () => {
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS plan_changes`;
  await sql`DROP TABLE IF EXISTS annotations`;
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);

  await createOrg(sql, ORG, "Search ACL Org");
  await createProject(sql, ORG, OPEN_PROJECT);
  await createProject(sql, ORG, LOCKED_PROJECT);
  await createSession(sql, ORG, OPEN_PROJECT, "s1", "user:manu");
  await createSession(sql, ORG, LOCKED_PROJECT, "s1", "user:manu");

  await pushEvent(sql, ORG, ev(OPEN_PROJECT, "s1", "2026-06-10T10:00:00.000Z", `the ${OPEN_TERM} swims`));
  await pushEvent(sql, ORG, ev(LOCKED_PROJECT, "s1", "2026-06-10T10:01:00.000Z", `the ${LOCKED_TERM} dives`));

  await addAnnotation(sql, ORG, { project: OPEN_PROJECT, session: "s1", participant_id: "user:manu", kind: "decision", value: "use postgres" });
  await addAnnotation(sql, ORG, { project: LOCKED_PROJECT, session: "s1", participant_id: "user:manu", kind: "decision", value: "use kafka" });

  // Lock the second project and add MEMBER (OUTSIDER is intentionally not added).
  await setProjectVisibility(sql, ORG, LOCKED_PROJECT, "members");
  await addProjectMember(sql, ORG, LOCKED_PROJECT, MEMBER, "editor");
});

afterAll(async () => {
  await sql.end();
});

describe("search respects project ACLs (no project filter)", () => {
  test("outsider cannot find events in a 'members'-restricted project", async () => {
    const open = await searchEvents(sql, ORG, { q: OPEN_TERM, participantId: OUTSIDER });
    expect(open.results.length).toBeGreaterThan(0); // open project still searchable

    const locked = await searchEvents(sql, ORG, { q: LOCKED_TERM, participantId: OUTSIDER });
    expect(locked.results).toHaveLength(0); // restricted project content NOT leaked
  });

  test("member can find events in the restricted project", async () => {
    const locked = await searchEvents(sql, ORG, { q: LOCKED_TERM, participantId: MEMBER });
    expect(locked.results.length).toBeGreaterThan(0);
  });

  test("no participant (default-open / anonymous) sees everything", async () => {
    const locked = await searchEvents(sql, ORG, { q: LOCKED_TERM });
    expect(locked.results.length).toBeGreaterThan(0);
  });
});

describe("decisions respect project ACLs (no project filter)", () => {
  test("outsider does not see decisions from a restricted project", async () => {
    const decisions = await listDecisions(sql, ORG, { participantId: OUTSIDER });
    const projects = decisions.map((d) => d.project);
    expect(projects).toContain(OPEN_PROJECT);
    expect(projects).not.toContain(LOCKED_PROJECT);
  });

  test("member sees decisions from the restricted project", async () => {
    const decisions = await listDecisions(sql, ORG, { participantId: MEMBER });
    expect(decisions.map((d) => d.project)).toContain(LOCKED_PROJECT);
  });

  test("no participant (default-open) sees all decisions", async () => {
    const decisions = await listDecisions(sql, ORG, {});
    expect(decisions.map((d) => d.project)).toContain(LOCKED_PROJECT);
  });
});
