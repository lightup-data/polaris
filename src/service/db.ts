import postgres from "postgres";
import type { PolarisEvent, Project, Session, ParticipantId } from "../types";

export type Sql = postgres.Sql;

// --- Types ---

export interface Org {
  id: string;
  name: string;
  slug: string | null;
  domain: string | null;
  plan: string;
  slack_team_id: string | null;
  slack_bot_token: string | null;
  slack_system_channel_id: string | null;
  created_at: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  org_id: string;
  participant_id: string;
  created_at: string;
}

// --- Schema ---

export async function createDb(connectionString?: string): Promise<Sql> {
  const sql = postgres(connectionString ?? process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris");

  await sql`
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      domain TEXT,
      plan TEXT NOT NULL DEFAULT 'free',
      slack_team_id TEXT,
      slack_bot_token TEXT,
      slack_system_channel_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Migrate: add plan column if missing
  await sql`ALTER TABLE orgs ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'`;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      participant_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Migrate: if projects table exists without `id` column, drop and recreate
  const [{ exists: hasId }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'id'
    ) as exists
  `;
  if (!hasId) {
    // Check if the old table exists at all
    const [{ exists: hasTable }] = await sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'projects'
      ) as exists
    `;
    if (hasTable) {
      await sql`DROP TABLE IF EXISTS events`;
      await sql`DROP TABLE IF EXISTS sessions`;
      await sql`DROP TABLE IF EXISTS projects`;
    }
  }

  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES orgs(id),
      name TEXT NOT NULL,
      slack_channel_id TEXT,
      slack_channel_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (org_id, name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT NOT NULL,
      project_id UUID NOT NULL REFERENCES projects(id),
      org_id TEXT NOT NULL,
      driver TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id UUID NOT NULL REFERENCES projects(id),
      session TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      sender TEXT NOT NULL,
      payload JSONB NOT NULL
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, timestamp)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(project_id, session, timestamp)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS plan_changes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id TEXT NOT NULL REFERENCES orgs(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      from_plan TEXT NOT NULL,
      to_plan TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  return sql;
}

// --- Orgs ---

export async function createOrg(sql: Sql, id: string, name: string, domain?: string, plan?: string): Promise<Org> {
  const [row] = await sql`
    INSERT INTO orgs (id, name, domain, plan) VALUES (${id}, ${name}, ${domain ?? null}, ${plan ?? "free"})
    RETURNING *
  `;
  return { ...row, created_at: row.created_at.toISOString() } as Org;
}

export async function setOrgPlan(sql: Sql, orgId: string, fromPlan: string, toPlan: string, userId: string): Promise<void> {
  await sql`UPDATE orgs SET plan = ${toPlan} WHERE id = ${orgId}`;
  await sql`INSERT INTO plan_changes (org_id, user_id, from_plan, to_plan) VALUES (${orgId}, ${userId}, ${fromPlan}, ${toPlan})`;
}

export async function getOrg(sql: Sql, id: string): Promise<Org | null> {
  const [row] = await sql`SELECT * FROM orgs WHERE id = ${id}`;
  if (!row) return null;
  return { ...row, created_at: row.created_at.toISOString() } as Org;
}

export async function getOrgByDomain(sql: Sql, domain: string): Promise<Org | null> {
  const [row] = await sql`SELECT * FROM orgs WHERE domain = ${domain}`;
  if (!row) return null;
  return { ...row, created_at: row.created_at.toISOString() } as Org;
}

export async function setOrgSlack(sql: Sql, orgId: string, teamId: string, botToken: string, systemChannelId?: string, slug?: string): Promise<void> {
  if (slug) {
    await sql`UPDATE orgs SET slack_team_id = ${teamId}, slack_bot_token = ${botToken}, slack_system_channel_id = ${systemChannelId ?? null}, slug = ${slug} WHERE id = ${orgId}`;
  } else {
    await sql`UPDATE orgs SET slack_team_id = ${teamId}, slack_bot_token = ${botToken}, slack_system_channel_id = ${systemChannelId ?? null} WHERE id = ${orgId}`;
  }
}

export async function getOrgBySlug(sql: Sql, slug: string): Promise<Org | null> {
  const [row] = await sql`SELECT * FROM orgs WHERE slug = ${slug}`;
  if (!row) return null;
  return { ...row, created_at: row.created_at.toISOString() } as Org;
}

// --- Users ---

export async function createUser(sql: Sql, id: string, email: string, name: string, orgId: string, participantId: string): Promise<User> {
  const [row] = await sql`
    INSERT INTO users (id, email, name, org_id, participant_id) VALUES (${id}, ${email}, ${name}, ${orgId}, ${participantId})
    RETURNING *
  `;
  return { ...row, created_at: row.created_at.toISOString() } as User;
}

export async function getUser(sql: Sql, id: string): Promise<User | null> {
  const [row] = await sql`SELECT * FROM users WHERE id = ${id}`;
  if (!row) return null;
  return { ...row, created_at: row.created_at.toISOString() } as User;
}

export async function getUserByEmail(sql: Sql, email: string): Promise<User | null> {
  const [row] = await sql`SELECT * FROM users WHERE email = ${email}`;
  if (!row) return null;
  return { ...row, created_at: row.created_at.toISOString() } as User;
}

export async function upsertUser(sql: Sql, id: string, email: string, name: string, orgId: string, participantId: string): Promise<User> {
  const [row] = await sql`
    INSERT INTO users (id, email, name, org_id, participant_id) VALUES (${id}, ${email}, ${name}, ${orgId}, ${participantId})
    ON CONFLICT (email) DO UPDATE SET name = ${name}, org_id = ${orgId}, participant_id = ${participantId}
    RETURNING *
  `;
  return { ...row, created_at: row.created_at.toISOString() } as User;
}

export async function listUsers(sql: Sql, orgId: string): Promise<User[]> {
  const rows = await sql`SELECT * FROM users WHERE org_id = ${orgId} ORDER BY name ASC`;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }) as User);
}

export async function getRecentSignups(sql: Sql, since: Date, limit = 10): Promise<Array<User & { org_name: string }>> {
  const rows = await sql`
    SELECT u.*, o.name as org_name
    FROM users u JOIN orgs o ON u.org_id = o.id
    WHERE u.created_at >= ${since.toISOString()}
    ORDER BY u.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), org_name: r.org_name }) as User & { org_name: string });
}

// --- Projects (org-scoped) ---

export async function createProject(sql: Sql, orgId: string, name: string): Promise<Project> {
  const [row] = await sql`
    INSERT INTO projects (org_id, name) VALUES (${orgId}, ${name})
    RETURNING id, name, slack_channel_id, slack_channel_name, created_at
  `;
  return {
    id: row.id,
    name: row.name,
    slack_channel_id: row.slack_channel_id ?? null,
    slack_channel_name: row.slack_channel_name ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function renameProject(sql: Sql, orgId: string, oldName: string, newName: string): Promise<void> {
  await sql`
    UPDATE projects SET name = ${newName}, slack_channel_name = ${newName}
    WHERE org_id = ${orgId} AND name = ${oldName}
  `;
}

export async function setProjectSlackChannel(sql: Sql, orgId: string, projectName: string, channelId: string, channelName?: string): Promise<void> {
  await sql`
    UPDATE projects SET slack_channel_id = ${channelId}, slack_channel_name = ${channelName ?? null}
    WHERE org_id = ${orgId} AND name = ${projectName}
  `;
}

export async function listProjects(sql: Sql, orgId: string): Promise<Project[]> {
  const rows = await sql`
    SELECT id, name, slack_channel_id, slack_channel_name, created_at
    FROM projects WHERE org_id = ${orgId} ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slack_channel_id: r.slack_channel_id ?? null,
    slack_channel_name: r.slack_channel_name ?? null,
    created_at: r.created_at.toISOString(),
  }));
}

export async function getProject(sql: Sql, orgId: string, name: string): Promise<Project | null> {
  const [row] = await sql`
    SELECT id, name, slack_channel_id, slack_channel_name, created_at
    FROM projects WHERE org_id = ${orgId} AND name = ${name}
  `;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slack_channel_id: row.slack_channel_id ?? null,
    slack_channel_name: row.slack_channel_name ?? null,
    created_at: row.created_at.toISOString(),
  };
}

// --- Sessions (org-scoped) ---

export async function createSession(
  sql: Sql,
  orgId: string,
  project: string,
  name: string,
  driver: ParticipantId | null
): Promise<Session> {
  const [row] = await sql`
    INSERT INTO sessions (name, project_id, org_id, driver)
    SELECT ${name}, p.id, ${orgId}, ${driver}
    FROM projects p WHERE p.org_id = ${orgId} AND p.name = ${project}
    RETURNING name, driver, created_at
  `;
  if (!row) throw new Error(`Project not found: ${project}`);
  return {
    name: row.name,
    project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  };
}

export async function getSession(sql: Sql, orgId: string, project: string, name: string): Promise<Session | null> {
  const [row] = await sql`
    SELECT s.name, p.name as project, s.driver, s.created_at
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    WHERE s.org_id = ${orgId} AND p.name = ${project} AND s.name = ${name}
  `;
  if (!row) return null;
  return {
    name: row.name,
    project: row.project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  };
}

export async function listSessions(sql: Sql, orgId: string, project?: string): Promise<Session[]> {
  const rows = project
    ? await sql`
        SELECT s.name, p.name as project, s.driver, s.created_at
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.org_id = ${orgId} AND p.name = ${project}
        ORDER BY s.created_at ASC
      `
    : await sql`
        SELECT s.name, p.name as project, s.driver, s.created_at
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.org_id = ${orgId}
        ORDER BY s.created_at ASC
      `;
  return rows.map((row) => ({
    name: row.name,
    project: row.project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  }));
}

export async function getSessionPromptCounts(sql: Sql, orgId: string): Promise<Map<string, number>> {
  const rows = await sql`
    SELECT p.name as project, e.session, count(*)::int as count
    FROM events e
    JOIN projects p ON e.project_id = p.id
    WHERE e.org_id = ${orgId} AND e.payload->>'hook_event_name' = 'UserPromptSubmit'
    GROUP BY p.name, e.session
  `;
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(`${row.project}/${row.session}`, row.count);
  }
  return counts;
}

export async function getDailyPromptCounts(sql: Sql, orgId: string, days = 14): Promise<Array<{ date: string; sender: string; count: number }>> {
  const rows = await sql`
    SELECT date_trunc('day', e.timestamp)::date as date, e.sender, count(*)::int as count
    FROM events e
    WHERE e.org_id = ${orgId} AND e.payload->>'hook_event_name' = 'UserPromptSubmit'
      AND e.timestamp >= now() - ${days + ' days'}::interval
    GROUP BY date, e.sender
    ORDER BY date ASC
  `;
  return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), sender: r.sender, count: r.count }));
}

export async function setDriver(sql: Sql, orgId: string, project: string, session: string, driver: ParticipantId): Promise<void> {
  await sql`
    UPDATE sessions SET driver = ${driver}
    WHERE org_id = ${orgId} AND name = ${session}
      AND project_id = (SELECT id FROM projects WHERE org_id = ${orgId} AND name = ${project})
  `;
}

export async function clearDriver(sql: Sql, orgId: string, project: string, session: string): Promise<void> {
  await sql`
    UPDATE sessions SET driver = NULL
    WHERE org_id = ${orgId} AND name = ${session}
      AND project_id = (SELECT id FROM projects WHERE org_id = ${orgId} AND name = ${project})
  `;
}

// --- Events (org-scoped) ---

export async function pushEvent(sql: Sql, orgId: string, event: PolarisEvent): Promise<void> {
  await sql`
    INSERT INTO events (id, org_id, project_id, session, timestamp, source, sender, payload)
    SELECT ${event.id}, ${orgId}, p.id, ${event.session}, ${event.timestamp}, ${event.source}, ${event.sender}, ${sql.json(event.payload)}
    FROM projects p WHERE p.org_id = ${orgId} AND p.name = ${event.project}
  `;
}

function rowToEvent(row: {
  id: string;
  project: string;
  session: string;
  timestamp: Date;
  source: string;
  sender: string;
  payload: unknown;
}): PolarisEvent {
  return {
    id: row.id,
    project: row.project,
    session: row.session,
    timestamp: row.timestamp.toISOString(),
    source: row.source as PolarisEvent["source"],
    sender: row.sender as ParticipantId,
    payload: row.payload as PolarisEvent["payload"],
  };
}

export async function getProjectEvents(sql: Sql, orgId: string, project: string): Promise<PolarisEvent[]> {
  const rows = await sql`
    SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
    FROM events e
    JOIN projects p ON e.project_id = p.id
    WHERE e.org_id = ${orgId} AND p.name = ${project}
    ORDER BY e.timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getSessionEvents(sql: Sql, orgId: string, project: string, session: string): Promise<PolarisEvent[]> {
  const rows = await sql`
    SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
    FROM events e
    JOIN projects p ON e.project_id = p.id
    WHERE e.org_id = ${orgId} AND p.name = ${project} AND e.session = ${session}
    ORDER BY e.timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getOrgEventsSince(sql: Sql, orgId: string, since: string): Promise<PolarisEvent[]> {
  const rows = await sql`
    SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
    FROM events e
    JOIN projects p ON e.project_id = p.id
    WHERE e.org_id = ${orgId} AND e.timestamp > ${since}
    ORDER BY e.timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getEventsSince(sql: Sql, orgId: string, project: string, since: string): Promise<PolarisEvent[]> {
  const rows = await sql`
    SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
    FROM events e
    JOIN projects p ON e.project_id = p.id
    WHERE e.org_id = ${orgId} AND p.name = ${project} AND e.timestamp > ${since}
    ORDER BY e.timestamp ASC
  `;
  return rows.map(rowToEvent);
}
