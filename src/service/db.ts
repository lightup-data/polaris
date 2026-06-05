import postgres from "postgres";
import type { CollabEvent, Project, Session, ParticipantId } from "../types";

export type Sql = postgres.Sql;

export async function createDb(connectionString?: string): Promise<Sql> {
  const sql = postgres(connectionString ?? process.env.DATABASE_URL ?? "postgres://collab:collab@localhost:5432/collab");

  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      name TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT NOT NULL,
      project TEXT NOT NULL REFERENCES projects(name),
      driver TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (project, name)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY,
      project TEXT NOT NULL,
      session TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL,
      sender TEXT NOT NULL,
      payload JSONB NOT NULL
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project, timestamp)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(project, session, timestamp)
  `;

  return sql;
}

export async function createProject(sql: Sql, name: string): Promise<Project> {
  const [row] = await sql`
    INSERT INTO projects (name) VALUES (${name}) RETURNING name, created_at
  `;
  return { name: row.name, created_at: row.created_at.toISOString() };
}

export async function getProject(sql: Sql, name: string): Promise<Project | null> {
  const [row] = await sql`
    SELECT name, created_at FROM projects WHERE name = ${name}
  `;
  if (!row) return null;
  return { name: row.name, created_at: row.created_at.toISOString() };
}

export async function createSession(
  sql: Sql,
  project: string,
  name: string,
  driver: ParticipantId | null
): Promise<Session> {
  const [row] = await sql`
    INSERT INTO sessions (name, project, driver)
    VALUES (${name}, ${project}, ${driver})
    RETURNING name, project, driver, created_at
  `;
  return {
    name: row.name,
    project: row.project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  };
}

export async function getSession(sql: Sql, project: string, name: string): Promise<Session | null> {
  const [row] = await sql`
    SELECT name, project, driver, created_at FROM sessions
    WHERE project = ${project} AND name = ${name}
  `;
  if (!row) return null;
  return {
    name: row.name,
    project: row.project,
    driver: row.driver,
    created_at: row.created_at.toISOString(),
  };
}

export async function setDriver(sql: Sql, project: string, session: string, driver: ParticipantId): Promise<void> {
  await sql`
    UPDATE sessions SET driver = ${driver}
    WHERE project = ${project} AND name = ${session}
  `;
}

export async function clearDriver(sql: Sql, project: string, session: string): Promise<void> {
  await sql`
    UPDATE sessions SET driver = NULL
    WHERE project = ${project} AND name = ${session}
  `;
}

export async function pushEvent(sql: Sql, event: CollabEvent): Promise<void> {
  await sql`
    INSERT INTO events (id, project, session, timestamp, source, sender, payload)
    VALUES (${event.id}, ${event.project}, ${event.session}, ${event.timestamp}, ${event.source}, ${event.sender}, ${sql.json(event.payload)})
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
}): CollabEvent {
  return {
    id: row.id,
    project: row.project,
    session: row.session,
    timestamp: row.timestamp.toISOString(),
    source: row.source as CollabEvent["source"],
    sender: row.sender as ParticipantId,
    payload: row.payload as CollabEvent["payload"],
  };
}

export async function getProjectEvents(sql: Sql, project: string): Promise<CollabEvent[]> {
  const rows = await sql`
    SELECT * FROM events WHERE project = ${project} ORDER BY timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getSessionEvents(sql: Sql, project: string, session: string): Promise<CollabEvent[]> {
  const rows = await sql`
    SELECT * FROM events WHERE project = ${project} AND session = ${session} ORDER BY timestamp ASC
  `;
  return rows.map(rowToEvent);
}

export async function getEventsSince(sql: Sql, project: string, since: string): Promise<CollabEvent[]> {
  const rows = await sql`
    SELECT * FROM events WHERE project = ${project} AND timestamp > ${since} ORDER BY timestamp ASC
  `;
  return rows.map(rowToEvent);
}
