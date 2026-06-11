import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  getProject,
  setProjectVisibility,
  addProjectMember,
  removeProjectMember,
  listProjectMembers,
  userCanAccessProject,
  type Sql,
} from "../src/service/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
// (project_members rows survive resetTestData, so unique ids matter.)
const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `acl-org-${RUN}`;
const OPEN_PROJECT = `pj-acl-open-${RUN}`;
const LOCKED_PROJECT = `pj-acl-locked-${RUN}`;

const MEMBER = `user:member-${RUN}`;
const OUTSIDER = `user:outsider-${RUN}`;

let sql: Sql;

beforeAll(async () => {
  // Drop and recreate via createDb (mirrors tests/db.test.ts) so the schema —
  // including the visibility migration and project_members — matches db.ts exactly.
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
  await createOrg(sql, ORG, "ACL Org");
  await createProject(sql, ORG, OPEN_PROJECT);
  await createProject(sql, ORG, LOCKED_PROJECT);
});

afterAll(async () => {
  await sql.end();
});

describe("project visibility", () => {
  test("projects default to 'org' visibility and are accessible to anyone", async () => {
    const project = await getProject(sql, ORG, OPEN_PROJECT);
    expect(project).not.toBeNull();
    expect(project!.visibility).toBe("org");
    expect(await userCanAccessProject(sql, ORG, OPEN_PROJECT, OUTSIDER)).toBe(true);
    expect(await userCanAccessProject(sql, ORG, OPEN_PROJECT, null)).toBe(true);
  });

  test("'members' visibility blocks non-members but allows members", async () => {
    await setProjectVisibility(sql, ORG, LOCKED_PROJECT, "members");
    const project = await getProject(sql, ORG, LOCKED_PROJECT);
    expect(project!.visibility).toBe("members");

    // Non-member blocked
    expect(await userCanAccessProject(sql, ORG, LOCKED_PROJECT, OUTSIDER)).toBe(false);
    // Anonymous (null participant) stays allowed — dev/test back-compat
    expect(await userCanAccessProject(sql, ORG, LOCKED_PROJECT, null)).toBe(true);

    // Member allowed
    await addProjectMember(sql, ORG, LOCKED_PROJECT, MEMBER, "editor");
    expect(await userCanAccessProject(sql, ORG, LOCKED_PROJECT, MEMBER)).toBe(true);

    // The open project is unaffected
    expect(await userCanAccessProject(sql, ORG, OPEN_PROJECT, OUTSIDER)).toBe(true);
  });

  test("adding the same member twice upserts the role", async () => {
    await addProjectMember(sql, ORG, LOCKED_PROJECT, MEMBER, "viewer");
    const members = await listProjectMembers(sql, ORG, LOCKED_PROJECT);
    const rows = members.filter((m) => m.participant_id === MEMBER);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("viewer");
  });

  test("removing a member revokes access", async () => {
    await removeProjectMember(sql, ORG, LOCKED_PROJECT, MEMBER);
    const members = await listProjectMembers(sql, ORG, LOCKED_PROJECT);
    expect(members.find((m) => m.participant_id === MEMBER)).toBeUndefined();
    expect(await userCanAccessProject(sql, ORG, LOCKED_PROJECT, MEMBER)).toBe(false);
  });

  test("switching back to 'org' restores access for everyone", async () => {
    await setProjectVisibility(sql, ORG, LOCKED_PROJECT, "org");
    expect(await userCanAccessProject(sql, ORG, LOCKED_PROJECT, OUTSIDER)).toBe(true);
  });

  test("unknown projects are treated as accessible (default-open)", async () => {
    expect(await userCanAccessProject(sql, ORG, `pj-does-not-exist-${RUN}`, OUTSIDER)).toBe(true);
  });
});
