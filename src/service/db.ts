import postgres from "postgres";
import type { PolarisEvent, Project, Session, ParticipantId } from "../types";

export type Sql = postgres.Sql;

// --- Types ---

export interface Org {
  id: string;
  name: string;
  slug: string | null;
  domain: string | null;
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
      slack_team_id TEXT,
      slack_bot_token TEXT,
      slack_system_channel_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

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

  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT NOT NULL,
      org_id TEXT NOT NULL REFERENCES orgs(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      org_id TEXT NOT NULL,
      driver TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, project, name),
      FOREIGN KEY (org_id, project) REFERENCES projects(org_id, name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY,
      org_id TEXT NOT NULL,
      project TEXT NOT NULL,
      session TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      sender TEXT NOT NULL,
      payload JSONB NOT NULL
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(org_id, project, timestamp)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(org_id, project, session, timestamp)
  `;

  return sql;
}

// --- Orgs ---

export async function createOrg(sql: Sql, id: string, name: string, domain?: string): Promise<Org> {
  const [row] = await sql`
    INSERT INTO orgs (id, name, domain) VALUES (${id}, ${name}, ${domain ?? null})
    RETURNING *
  `;
  return { ...row, created_at: row.created_at.toISOString() } as Org;
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

// --- Projects (org-scoped) ---

export async function createProject(sql: Sql, orgId: string, name: string): Promise<Project> {
  const [row] = await sql`
    INSERT INTO projects (name, org_id) VALUES (${name}, ${orgId}) RETURNING name, created_at
  `;
  return { name: row.name, created_at: row.created_at.toISOString() };
}

export async function listProjects(sql: Sql, orgId: string): Promise<Project[]> {
  const rows = await sql`
    SELECT name, created_at FROM projects WHERE org_id = ${orgId} ORDER BY created_at ASC
  `;
  return rows.map((r) => ({ name: r.name, created_at: r.created_at.toISOString() }));
}

export async function getProject(sql: Sql, orgId: string, name: string): Promise<Project | null> {
  const [row] = await sql`
    SELECT name, created_at FROM projects WHERE org_id = ${orgId} AND name = ${name}
  `;
  if (!row) return null;
  return { name: row.name, created_at: row.created_at.toISOString() };
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
    INSERT INTO sessions (name, project, org_id, driver)
    VALUES (${name}, ${project}, ${orgId}, ${driver})
    RETURNING name, project, driver, created_at
  `;
  return {
    name: row.name,
    project: row.project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  };
}

export async function getSession(sql: Sql, orgId: string, project: string, name: string): Promise<Session | null> {
  const [row] = await sql`
    SELECT name, project, driver, created_at FROM sessions
    WHERE org_id = ${orgId} AND project = ${project} AND name = ${name}
  `;
  if (!row) return null;
  return {
    name: row.name,
    project: row.project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  };
}

export async function setDriver(sql: Sql, orgId: string, project: string, session: string, driver: ParticipantId): Promise<void> {
  await sql`
    UPDATE sessions SET driver = ${driver}
    WHERE org_id = ${orgId} AND project = ${project} AND name = ${session}
  `;
}

export async function clearDriver(sql: Sql, orgId: string, project: string, session: string): Promise<void> {
  await sql`
    UPDATE sessions SET driver = NULL
    WHERE org_id = ${orgId} AND project = ${project} AND name = ${session}
  `;
}

// --- Events (org-scoped) ---

export async function pushEvent(sql: Sql, orgId: string, event: PolarisEvent): Promise<void> {
  await sql`
    INSERT INTO events (id, org_id, project, session, timestamp, source, sender, payload)
    VALUES (${event.id}, ${orgId}, ${event.project}, ${event.session}, ${event.timestamp}, ${event.source}, ${event.sender}, ${sql.json(event.payload)})
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
    SELECT id, project, session, timestamp, source, sender, payload
    FROM events WHERE org_id = ${orgId} AND project = ${project} ORDER BY timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getSessionEvents(sql: Sql, orgId: string, project: string, session: string): Promise<PolarisEvent[]> {
  const rows = await sql`
    SELECT id, project, session, timestamp, source, sender, payload
    FROM events WHERE org_id = ${orgId} AND project = ${project} AND session = ${session} ORDER BY timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getEventsSince(sql: Sql, orgId: string, project: string, since: string): Promise<PolarisEvent[]> {
  const rows = await sql`
    SELECT id, project, session, timestamp, source, sender, payload
    FROM events WHERE org_id = ${orgId} AND project = ${project} AND timestamp > ${since} ORDER BY timestamp ASC
  `;
  return rows.map(rowToEvent);
}
