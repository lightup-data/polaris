import postgres from "postgres";
import type { Annotation, PolarisEvent, Project, Session, ParticipantId } from "../types";

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

export interface ProjectMember {
  participant_id: string;
  role: string | null;
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
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

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

  // Curation annotations (stars, tags, decisions). Deliberately NO foreign keys:
  // tests/helpers.ts resetTestData drops events/sessions/projects without dropping this table.
  await sql`
    CREATE TABLE IF NOT EXISTS annotations (
      id UUID PRIMARY KEY,
      org_id TEXT NOT NULL,
      event_id UUID,
      project TEXT NOT NULL,
      session TEXT NOT NULL,
      participant_id TEXT,
      kind TEXT NOT NULL,
      value TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_annotations_session ON annotations(org_id, project, session)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_annotations_event ON annotations(event_id)
  `;

  // Per-project ACL membership. Deliberately NO foreign keys (see annotations note above).
  await sql`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id UUID,
      participant_id TEXT,
      role TEXT,
      PRIMARY KEY (project_id, participant_id)
    )
  `;

  await runMigrations(sql);

  return sql;
}

// Additive, idempotent migrations. Each statement uses IF NOT EXISTS so it is safe to
// re-run on every startup; schema_migrations records what has been applied. NEVER drop a table.
async function runMigrations(sql: Sql): Promise<void> {
  const migrations: Array<{ id: string; run: () => Promise<unknown> }> = [
    {
      id: "001-sessions-label",
      run: () => sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS label TEXT`,
    },
    {
      id: "002-projects-visibility",
      run: () => sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'org'`,
    },
  ];
  for (const migration of migrations) {
    await migration.run();
    await sql`INSERT INTO schema_migrations (id) VALUES (${migration.id}) ON CONFLICT (id) DO NOTHING`;
  }
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

// SELECT * / RETURNING * (not an explicit list) so project reads tolerate tables created
// before the visibility migration (e.g. tests/helpers.ts resetTestData); visibility maps to 'org'.
function rowToProject(row: postgres.Row): Project {
  return {
    id: row.id,
    name: row.name,
    slack_channel_id: row.slack_channel_id ?? null,
    slack_channel_name: row.slack_channel_name ?? null,
    visibility: row.visibility ?? "org",
    created_at: row.created_at.toISOString(),
  };
}

export async function createProject(sql: Sql, orgId: string, name: string): Promise<Project> {
  const [row] = await sql`
    INSERT INTO projects (org_id, name) VALUES (${orgId}, ${name})
    RETURNING *
  `;
  return rowToProject(row);
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
    SELECT * FROM projects WHERE org_id = ${orgId} ORDER BY created_at ASC
  `;
  return rows.map(rowToProject);
}

export async function getProject(sql: Sql, orgId: string, name: string): Promise<Project | null> {
  const [row] = await sql`
    SELECT * FROM projects WHERE org_id = ${orgId} AND name = ${name}
  `;
  if (!row) return null;
  return rowToProject(row);
}

// --- Project visibility & members (ACL) ---

export async function setProjectVisibility(sql: Sql, orgId: string, project: string, visibility: string): Promise<void> {
  // Self-heal: resetTestData recreates projects without the visibility column, so make
  // sure it exists (idempotent) before writing.
  await sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'org'`;
  await sql`
    UPDATE projects SET visibility = ${visibility}
    WHERE org_id = ${orgId} AND name = ${project}
  `;
}

export async function addProjectMember(sql: Sql, orgId: string, project: string, participantId: string, role?: string): Promise<void> {
  await sql`
    INSERT INTO project_members (project_id, participant_id, role)
    SELECT p.id, ${participantId}, ${role ?? null}
    FROM projects p WHERE p.org_id = ${orgId} AND p.name = ${project}
    ON CONFLICT (project_id, participant_id) DO UPDATE SET role = EXCLUDED.role
  `;
}

export async function removeProjectMember(sql: Sql, orgId: string, project: string, participantId: string): Promise<void> {
  await sql`
    DELETE FROM project_members
    WHERE participant_id = ${participantId}
      AND project_id = (SELECT id FROM projects WHERE org_id = ${orgId} AND name = ${project})
  `;
}

export async function listProjectMembers(sql: Sql, orgId: string, project: string): Promise<ProjectMember[]> {
  const rows = await sql`
    SELECT m.participant_id, m.role
    FROM project_members m
    JOIN projects p ON m.project_id = p.id
    WHERE p.org_id = ${orgId} AND p.name = ${project}
    ORDER BY m.participant_id ASC
  `;
  return rows.map((r) => ({ participant_id: r.participant_id, role: r.role ?? null }));
}

export async function userCanAccessProject(sql: Sql, orgId: string, project: string, participantId: string | null): Promise<boolean> {
  // Default-open: anonymous callers, unknown projects, 'org' visibility, and any schema
  // created before the visibility migration / project_members table all mean accessible.
  if (!participantId) return true;
  try {
    const [row] = await sql`SELECT * FROM projects WHERE org_id = ${orgId} AND name = ${project}`;
    if (!row) return true;
    if ((row.visibility ?? "org") !== "members") return true;
    const members = await sql`
      SELECT 1 FROM project_members WHERE project_id = ${row.id} AND participant_id = ${participantId}
    `;
    return members.length > 0;
  } catch {
    return true;
  }
}

// --- Sessions (org-scoped) ---

export async function createSession(
  sql: Sql,
  orgId: string,
  project: string,
  name: string,
  driver: ParticipantId | null
): Promise<Session> {
  // RETURNING * (not an explicit list) so this tolerates session tables created
  // before the label migration (e.g. tests/helpers.ts resetTestData); label maps to null.
  const [row] = await sql`
    INSERT INTO sessions (name, project_id, org_id, driver)
    SELECT ${name}, p.id, ${orgId}, ${driver}
    FROM projects p WHERE p.org_id = ${orgId} AND p.name = ${project}
    RETURNING *
  `;
  if (!row) throw new Error(`Project not found: ${project}`);
  return {
    name: row.name,
    project,
    driver: row.driver,
    label: row.label ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function getSession(sql: Sql, orgId: string, project: string, name: string): Promise<Session | null> {
  // s.* (not explicit s.label) so this tolerates session tables created
  // before the label migration (e.g. tests/helpers.ts resetTestData); label maps to null.
  const [row] = await sql`
    SELECT s.*, p.name as project
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    WHERE s.org_id = ${orgId} AND p.name = ${project} AND s.name = ${name}
  `;
  if (!row) return null;
  return {
    name: row.name,
    project: row.project,
    driver: row.driver,
    label: row.label ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function listSessions(sql: Sql, orgId: string, project?: string): Promise<Session[]> {
  const rows = project
    ? await sql`
        SELECT s.*, p.name as project
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.org_id = ${orgId} AND p.name = ${project}
        ORDER BY s.created_at ASC
      `
    : await sql`
        SELECT s.*, p.name as project
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE s.org_id = ${orgId}
        ORDER BY s.created_at ASC
      `;
  return rows.map((row) => ({
    name: row.name,
    project: row.project,
    driver: row.driver,
    label: row.label ?? null,
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

export async function setSessionLabel(sql: Sql, orgId: string, project: string, session: string, label: string): Promise<void> {
  await sql`
    UPDATE sessions SET label = ${label}
    WHERE org_id = ${orgId} AND name = ${session}
      AND project_id = (SELECT id FROM projects WHERE org_id = ${orgId} AND name = ${project})
  `;
}

// --- Events (org-scoped) ---

export async function pushEvent(sql: Sql, orgId: string, event: PolarisEvent): Promise<void> {
  const result = await sql`
    INSERT INTO events (id, org_id, project_id, session, timestamp, source, sender, payload)
    SELECT ${event.id}, ${orgId}, p.id, ${event.session}, ${event.timestamp}, ${event.source}, ${event.sender}, ${sql.json(event.payload)}
    FROM projects p WHERE p.org_id = ${orgId} AND p.name = ${event.project}
  `;
  // Realtime backbone: notify listeners (server WS/SSE fan-out, Slack bridge) with the
  // event id only — tiny payload; listeners fetch the full event via getEventById.
  if (result.count > 0) await sql.notify("polaris_event", event.id);
}

function rowToEvent(row: postgres.Row): PolarisEvent {
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

// Lookup for LISTEN('polaris_event') subscribers. The returned event additionally carries
// org_id (a structural superset of PolarisEvent) so multi-org consumers (e.g. the Slack
// bridge) can route to the right org without a second query.
export async function getEventById(sql: Sql, id: string): Promise<(PolarisEvent & { org_id: string }) | null> {
  // NOTIFY payloads are untyped strings; a non-UUID would fail the uuid cast, so treat it as not-found.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await sql`
    SELECT e.id, e.org_id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
    FROM events e
    JOIN projects p ON e.project_id = p.id
    WHERE e.id = ${id}
  `;
  if (!row) return null;
  return { ...rowToEvent(row), org_id: row.org_id };
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

export async function getSessionEventsPage(
  sql: Sql,
  orgId: string,
  project: string,
  session: string,
  opts?: { limit?: number; before?: string }
): Promise<{ events: PolarisEvent[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, Math.floor(opts?.limit ?? 100)), 500);
  // Cursor is `${iso_timestamp}|${id}`; keyset pagination on (timestamp, id) DESC.
  let beforeTs: string | null = null;
  let beforeId: string | null = null;
  if (opts?.before) {
    const sep = opts.before.lastIndexOf("|");
    if (sep > 0) {
      beforeTs = opts.before.slice(0, sep);
      beforeId = opts.before.slice(sep + 1);
    }
  }
  const rows = beforeTs && beforeId
    ? await sql`
        SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
        FROM events e
        JOIN projects p ON e.project_id = p.id
        WHERE e.org_id = ${orgId} AND p.name = ${project} AND e.session = ${session}
          AND (e.timestamp, e.id) < (${beforeTs}::timestamptz, ${beforeId}::uuid)
        ORDER BY e.timestamp DESC, e.id DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload
        FROM events e
        JOIN projects p ON e.project_id = p.id
        WHERE e.org_id = ${orgId} AND p.name = ${project} AND e.session = ${session}
        ORDER BY e.timestamp DESC, e.id DESC
        LIMIT ${limit}
      `;
  const events = rows.map(rowToEvent);
  const oldest = events[events.length - 1];
  const nextCursor = events.length === limit && oldest ? `${oldest.timestamp}|${oldest.id}` : null;
  return { events, nextCursor };
}

// Query-time full-text search using the explicit two-arg ('english'::regconfig) form,
// which is immutable-safe. No index for the alpha (small data).
// FOLLOW-UP: trigger-maintained indexed search_tsv before scale
export async function searchEvents(
  sql: Sql,
  orgId: string,
  opts: { q: string; project?: string; session?: string; sender?: string; source?: string; tag?: string; limit?: number }
): Promise<{ results: Array<{ event: PolarisEvent; snippet: string }> }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 100);
  const rows = await sql`
    SELECT e.id, p.name as project, e.session, e.timestamp, e.source, e.sender, e.payload,
      ts_headline('english'::regconfig, t.text, q.query) as snippet,
      ts_rank(to_tsvector('english'::regconfig, t.text), q.query) as score
    FROM events e
    JOIN projects p ON e.project_id = p.id
    CROSS JOIN LATERAL (
      SELECT coalesce(e.payload->>'prompt', '') || ' ' || coalesce(e.payload->>'stop_response', '') || ' ' ||
        coalesce(e.payload->>'last_assistant_message', '') || ' ' || coalesce(e.payload->>'content', '') as text
    ) t
    CROSS JOIN LATERAL (SELECT websearch_to_tsquery('english', ${opts.q}) as query) q
    WHERE e.org_id = ${orgId}
      AND to_tsvector('english'::regconfig, t.text) @@ q.query
      ${opts.project ? sql`AND p.name = ${opts.project}` : sql``}
      ${opts.session ? sql`AND e.session = ${opts.session}` : sql``}
      ${opts.sender ? sql`AND e.sender = ${opts.sender}` : sql``}
      ${opts.source ? sql`AND e.source = ${opts.source}` : sql``}
      ${opts.tag ? sql`AND EXISTS (
        SELECT 1 FROM annotations a
        WHERE a.event_id = e.id AND a.org_id = ${orgId} AND a.kind = 'tag' AND a.value = ${opts.tag}
      )` : sql``}
    ORDER BY score DESC, e.timestamp DESC
    LIMIT ${limit}
  `;
  return {
    results: rows.map((row) => ({ event: rowToEvent(row), snippet: row.snippet as string })),
  };
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

// --- Annotations (org-scoped curation: stars, tags, decisions) ---

function rowToAnnotation(row: postgres.Row): Annotation {
  return {
    id: row.id,
    event_id: row.event_id ?? null,
    project: row.project,
    session: row.session,
    participant_id: row.participant_id ?? null,
    kind: row.kind as Annotation["kind"],
    value: row.value ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function addAnnotation(
  sql: Sql,
  orgId: string,
  annotation: {
    event_id?: string | null;
    project: string;
    session: string;
    participant_id?: string | null;
    kind: Annotation["kind"];
    value?: string | null;
  }
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO annotations (id, org_id, event_id, project, session, participant_id, kind, value)
    VALUES (${id}, ${orgId}, ${annotation.event_id ?? null}, ${annotation.project}, ${annotation.session},
      ${annotation.participant_id ?? null}, ${annotation.kind}, ${annotation.value ?? null})
  `;
  return { id };
}

export async function listSessionAnnotations(sql: Sql, orgId: string, project: string, session: string): Promise<Annotation[]> {
  const rows = await sql`
    SELECT * FROM annotations
    WHERE org_id = ${orgId} AND project = ${project} AND session = ${session}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToAnnotation);
}

export async function listDecisions(sql: Sql, orgId: string, opts?: { project?: string; limit?: number }): Promise<Annotation[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts?.limit ?? 100)), 500);
  const rows = await sql`
    SELECT * FROM annotations
    WHERE org_id = ${orgId} AND kind = 'decision'
      ${opts?.project ? sql`AND project = ${opts.project}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(rowToAnnotation);
}

export async function deleteAnnotation(sql: Sql, orgId: string, id: string): Promise<void> {
  await sql`DELETE FROM annotations WHERE org_id = ${orgId} AND id = ${id}`;
}
