import { ensureSchema, type Sql } from "../src/service/db";

// The daemon relays hook events in the background, so poll until upstream catches up.
export async function waitForMessages(url: string, count: number, timeoutMs = 3000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  let body: any[] = [];
  while (Date.now() < deadline) {
    body = await (await fetch(url)).json();
    if (Array.isArray(body) && body.length >= count) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  return body;
}

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
