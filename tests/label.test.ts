import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  createProject,
  createSession,
  getSession,
  listSessions,
  setSessionLabel,
  type Sql,
} from "../src/service/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
const RUN = crypto.randomUUID().slice(0, 8);
const ORG = `label-org-${RUN}`;
const PROJECT = `pj-label-${RUN}`;
const SESSION = "fx-label";
const OTHER_SESSION = "fx-other";

let sql: Sql;

beforeAll(async () => {
  // Drop and recreate via createDb (NOT tests/helpers.ts resetTestData, which builds
  // a sessions table without the label column) so the additive label migration applies.
  sql = await createDb(DATABASE_URL);
  await sql`DROP TABLE IF EXISTS events`;
  await sql`DROP TABLE IF EXISTS sessions`;
  await sql`DROP TABLE IF EXISTS projects`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`DROP TABLE IF EXISTS orgs`;
  await sql.end();
  sql = await createDb(DATABASE_URL);
  await createOrg(sql, ORG, "Label Org");
  await createProject(sql, ORG, PROJECT);
});

afterAll(async () => {
  await sql.end();
});

describe("session labels", () => {
  test("createSession and getSession default to a null label", async () => {
    const created = await createSession(sql, ORG, PROJECT, SESSION, "user:manu");
    expect(created.label).toBeNull();

    const fetched = await getSession(sql, ORG, PROJECT, SESSION);
    expect(fetched).not.toBeNull();
    expect(fetched!.label).toBeNull();
  });

  test("setSessionLabel then getSession returns the label", async () => {
    await setSessionLabel(sql, ORG, PROJECT, SESSION, "Auth refactor");
    const session = await getSession(sql, ORG, PROJECT, SESSION);
    expect(session!.label).toBe("Auth refactor");
  });

  test("listSessions returns the label", async () => {
    const sessions = await listSessions(sql, ORG, PROJECT);
    const labeled = sessions.find((s) => s.name === SESSION);
    expect(labeled).toBeDefined();
    expect(labeled!.label).toBe("Auth refactor");
  });

  test("relabeling overwrites the previous label", async () => {
    await setSessionLabel(sql, ORG, PROJECT, SESSION, "Token refresh work");
    const session = await getSession(sql, ORG, PROJECT, SESSION);
    expect(session!.label).toBe("Token refresh work");
  });

  test("labels are scoped to the target session", async () => {
    await createSession(sql, ORG, PROJECT, OTHER_SESSION, null);
    const other = await getSession(sql, ORG, PROJECT, OTHER_SESSION);
    expect(other!.label).toBeNull();

    const labeled = await getSession(sql, ORG, PROJECT, SESSION);
    expect(labeled!.label).toBe("Token refresh work");
  });

  test("setSessionLabel on an unknown session is a silent no-op", async () => {
    // Per the db contract: UPDATE matches 0 rows, no throw.
    await setSessionLabel(sql, ORG, PROJECT, "fx-nonexistent", "ignored");
    expect(await getSession(sql, ORG, PROJECT, "fx-nonexistent")).toBeNull();

    const untouched = await getSession(sql, ORG, PROJECT, SESSION);
    expect(untouched!.label).toBe("Token refresh work");
  });
});
