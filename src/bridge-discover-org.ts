import postgres from "postgres";
import type { Sql } from "./service/db";

// All orgs eligible for a Slack bridge: Slack-connected (team id) with a bot token.
export async function discoverBridgeOrgs(sql: Sql): Promise<string[]> {
  const rows = await sql`
    SELECT id FROM orgs
    WHERE slack_team_id IS NOT NULL AND slack_bot_token IS NOT NULL
    ORDER BY created_at ASC
  `;
  return rows.map((row) => row.id as string);
}

// Back-compat: first eligible org (legacy single-org callers).
export async function discoverBridgeOrg(sql: Sql): Promise<string | null> {
  const orgs = await discoverBridgeOrgs(sql);
  return orgs[0] ?? null;
}

// CLI mode (docker/bridge-entrypoint.sh): print the first eligible org id.
// Kept single-line so `ORG_ID=$(bun run src/bridge-discover-org.ts)` stays valid;
// multi-org deployments should run bridge.ts with no args (startAllBridges) instead.
if (import.meta.main) {
  const sql = postgres(process.env.DATABASE_URL ?? "");
  try {
    const orgId = await discoverBridgeOrg(sql);
    if (orgId) console.log(orgId);
  } finally {
    await sql.end();
  }
}
