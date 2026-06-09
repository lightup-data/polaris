import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL ?? "");
const rows = await sql`SELECT id FROM orgs WHERE slack_team_id IS NOT NULL LIMIT 1`;
if (rows.length > 0) console.log(rows[0].id);
await sql.end();
