import { ensureSchema, type Sql } from "../src/service/db";

/**
 * Reset test data to a clean slate: drop every table in the public schema, then
 * recreate the canonical schema via `ensureSchema` (the same DDL production uses).
 *
 * Dropping dynamically with CASCADE means new tables and foreign keys never break
 * the reset, and recreating via `ensureSchema` means the test schema can't drift
 * from `src/service/db.ts` (previously this hand-maintained its own CREATE TABLEs,
 * which silently went stale when columns/tables like `orgs.plan` and `plan_changes`
 * were added).
 */
export async function resetTestData(sql: Sql): Promise<void> {
  const tables = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  for (const { tablename } of tables) {
    await sql`DROP TABLE IF EXISTS ${sql(tablename)} CASCADE`;
  }
  await ensureSchema(sql);
  await sql`INSERT INTO orgs (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING`;
}
