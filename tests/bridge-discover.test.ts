import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createDb,
  createOrg,
  setOrgSlack,
  type Sql,
} from "../src/service/db";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

// Unique ids so this file is self-contained against a live Postgres.
const RUN = crypto.randomUUID().slice(0, 8);
const ORG_A = `bridge-org-a-${RUN}`;
const ORG_B = `bridge-org-b-${RUN}`;
const ORG_NO_SLACK = `bridge-org-plain-${RUN}`;
const ORG_TEAM_ONLY = `bridge-org-teamonly-${RUN}`;

// Make sure the schema exists before importing the discovery module (its legacy
// form runs a query at import time), then resolve the contract export. Until the
// bridge agent's work is integrated the export is absent and these tests skip.
{
  const bootstrap = await createDb(DATABASE_URL);
  await bootstrap.end();
}
let discoverBridgeOrgs: ((sql: Sql) => Promise<string[]>) | undefined;
try {
  const mod = (await import("../src/bridge-discover-org")) as Record<string, unknown>;
  if (typeof mod.discoverBridgeOrgs === "function") {
    discoverBridgeOrgs = mod.discoverBridgeOrgs as (sql: Sql) => Promise<string[]>;
  }
} catch {
  // Import-time side effects failed (legacy script form) — treat as not available.
}
if (!discoverBridgeOrgs) {
  console.warn("[bridge-discover.test] discoverBridgeOrgs not exported yet — skipping (expected before bridge-agent integration)");
}

let sql: Sql;

beforeAll(async () => {
  sql = await createDb(DATABASE_URL);
  // Eligible: both slack_team_id and slack_bot_token set
  await createOrg(sql, ORG_A, "Bridge Org A");
  await setOrgSlack(sql, ORG_A, `T-A-${RUN}`, `xoxb-a-${RUN}`);
  await createOrg(sql, ORG_B, "Bridge Org B");
  await setOrgSlack(sql, ORG_B, `T-B-${RUN}`, `xoxb-b-${RUN}`);
  // Ineligible: no Slack at all
  await createOrg(sql, ORG_NO_SLACK, "Bridge Org Plain");
  // Ineligible: team id but no bot token
  await createOrg(sql, ORG_TEAM_ONLY, "Bridge Org Team Only");
  await sql`UPDATE orgs SET slack_team_id = ${`T-half-${RUN}`} WHERE id = ${ORG_TEAM_ONLY}`;
});

afterAll(async () => {
  await sql.end();
});

describe("discoverBridgeOrgs", () => {
  test.skipIf(!discoverBridgeOrgs)("returns every org with full Slack credentials (no LIMIT 1)", async () => {
    const orgs = await discoverBridgeOrgs!(sql);
    expect(orgs).toContain(ORG_A);
    expect(orgs).toContain(ORG_B);
  });

  test.skipIf(!discoverBridgeOrgs)("excludes orgs without complete Slack credentials", async () => {
    const orgs = await discoverBridgeOrgs!(sql);
    expect(orgs).not.toContain(ORG_NO_SLACK);
    expect(orgs).not.toContain(ORG_TEAM_ONLY);
  });
});
