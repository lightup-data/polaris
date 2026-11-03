// src/core/daemon-client.ts
// Typed HTTP client for the Polaris local daemon.
// Used by both the MCP server (client.ts) and the CLI (cli.ts) so that
// all daemon calls share a single implementation.

export interface DaemonClientOptions {
  url: string;
  secret?: string | null | (() => string | null);
  /** Re-read the secret (e.g. from config) when the daemon rejects the current one */
  refreshSecret?: () => string | null;
}

export interface ConnectOptions {
  ccSessionId: string;
  project: string;
  user: string;
  profile?: string;
  session?: string;
  agent?: string;
  create?: boolean;
}

export interface ConnectResult {
  ok: boolean;
  status?: string;
  project?: string;
  session?: string;
  user?: string;
  agent?: string;
  account?: string;
  error?: string;
  existing?: string[];
  gap?: { events: number; since: string } | null;
  httpStatus: number;
}

export interface StatusResult {
  connected: boolean;
  project?: string;
  session?: string;
  user?: string;
  account?: string;
  slackChannel?: string;
  lastEventAge?: number;
}

export interface CheckpointResult {
  hasCheckpoint: boolean;
  lastEventTimestamp?: string;
  pending?: number;
}

export interface SendResult {
  ok: boolean;
  from?: string;
  to?: string;
  error?: string;
  httpStatus: number;
}

export interface TeamMember {
  name: string;
  participant_id: string | null;
  slack_id: string | null;
  slack_handle: string | null;
  slack_display: string | null;
  polaris_user: boolean;
  alias: string | null;
}

export interface BackfillResult {
  ok: boolean;
  recovered?: number;
  would_recover?: number;
  source?: string;
  gaps?: string[];
  error?: string;
}

// A 401 from the local daemon means this process has the wrong daemon secret — not
// that the user's Polaris login is bad. Say so, so it isn't mistaken for "log in again".
export const DAEMON_AUTH_ERROR =
  "The Polaris MCP server couldn't authenticate to the local Polaris daemon (daemon secret mismatch). " +
  "This is not your account login. Reconnect with /mcp; if it keeps happening, run `polaris install`.";

// Fetch from the daemon; on 401, re-resolve the secret once (it may have been
// regenerated since this process started) and retry, else return a clear error.
export async function daemonFetch(
  url: string, init: RequestInit, secret: () => string | null, refresh?: () => string | null
): Promise<Response> {
  const withSecret = (s: string | null): RequestInit => ({
    ...init,
    headers: { "Content-Type": "application/json", ...(s ? { "x-polaris-daemon-secret": s } : {}) },
  });
  let res = await fetch(url, withSecret(secret()));
  if (res.status === 401 && refresh) {
    const fresh = refresh();
    if (fresh && fresh !== secret()) res = await fetch(url, withSecret(fresh));
  }
  if (res.status !== 401) return res;
  return new Response(JSON.stringify({ error: DAEMON_AUTH_ERROR }), { status: 401, headers: { "Content-Type": "application/json" } });
}

export class DaemonClient {
  private url: string;
  private secret: () => string | null;
  private refresh?: () => string | null;

  constructor(opts: DaemonClientOptions) {
    this.url = opts.url.replace(/\/$/, "");
    const s = opts.secret ?? null;
    this.secret = typeof s === "function" ? s : () => s;
    this.refresh = opts.refreshSecret;
  }

  async post(path: string, body: unknown): Promise<Response> {
    return daemonFetch(`${this.url}${path}`, { method: "POST", body: JSON.stringify(body) }, this.secret, this.refresh);
  }

  async get(path: string, signal?: AbortSignal): Promise<Response> {
    return daemonFetch(`${this.url}${path}`, { signal }, this.secret, this.refresh);
  }

  async channels(): Promise<string[]> {
    const res = await this.get("/channels");
    if (!res.ok) return [];
    const body = await res.json() as { channels: string[] };
    return body.channels;
  }

  async connect(opts: ConnectOptions): Promise<ConnectResult> {
    const res = await this.post("/connect", {
      ccSessionId: opts.ccSessionId,
      project: opts.project,
      user: opts.user,
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.create ? { create: true } : {}),
    });
    const body = await res.json() as ConnectResult;
    return { ...body, httpStatus: res.status, ok: res.ok };
  }

  async disconnect(ccSessionId: string): Promise<boolean> {
    try {
      await this.post("/disconnect", { ccSessionId });
      return true;
    } catch { return false; }
  }

  async status(ccSessionId: string): Promise<StatusResult> {
    const res = await this.get(`/status/${encodeURIComponent(ccSessionId)}`);
    return res.json() as Promise<StatusResult>;
  }

  async checkpoint(ccSessionId: string): Promise<CheckpointResult> {
    const res = await this.get(`/checkpoint/${encodeURIComponent(ccSessionId)}`);
    if (!res.ok) return { hasCheckpoint: false };
    return res.json() as Promise<CheckpointResult>;
  }

  async send(ccSessionId: string, targetSession: string, message: string): Promise<SendResult> {
    const res = await this.post("/send", { ccSessionId, targetSession, message });
    const body = await res.json() as { from?: string; to?: string; error?: string };
    return { ok: res.ok, httpStatus: res.status, ...body };
  }

  async reply(ccSessionId: string, message: string): Promise<boolean> {
    const res = await this.post("/reply", { ccSessionId, message });
    return res.ok;
  }

  async rename(oldName: string, newName: string): Promise<{ ok: boolean; error?: string }> {
    const res = await this.post("/rename", { oldName, newName });
    const body = await res.json() as { error?: string };
    return { ok: res.ok, error: body.error };
  }

  async renameSession(ccSessionId: string, newName: string): Promise<{ ok: boolean; oldName?: string; newName?: string; error?: string }> {
    const res = await this.post("/rename-session", { ccSessionId, newName });
    const body = await res.json() as { status?: string; oldName?: string; newName?: string; error?: string };
    return { ok: res.ok, ...body };
  }

  async context(ccSessionId: string, targetSession: string): Promise<Array<{ sender: string; payload: Record<string, unknown> }>> {
    const res = await this.get(`/context/${encodeURIComponent(ccSessionId)}/${encodeURIComponent(targetSession)}`);
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json() as Promise<Array<{ sender: string; payload: Record<string, unknown> }>>;
  }

  async team(): Promise<TeamMember[]> {
    const res = await this.get("/team");
    if (!res.ok) throw new Error(`${res.status}`);
    const body = await res.json() as { members: TeamMember[] };
    return body.members;
  }

  async backfill(ccSessionId: string, opts: { duration?: string; from?: string; dry_run?: boolean } = {}): Promise<BackfillResult> {
    const res = await this.post("/backfill", {
      ccSessionId,
      ...(opts.duration ? { duration: opts.duration } : {}),
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.dry_run ? { dry_run: true } : {}),
    });
    const body = await res.json() as BackfillResult;
    return { ok: res.ok, ...body };
  }

  async standby(ccSessionId: string, timeoutSec: number, signal?: AbortSignal): Promise<{ status: string; pushes: Array<{ from: string; content: string; timestamp: string }> }> {
    const res = await this.get(`/standby/${encodeURIComponent(ccSessionId)}?timeout=${timeoutSec}`, signal);
    return res.json() as Promise<{ status: string; pushes: Array<{ from: string; content: string; timestamp: string }> }>;
  }

  /** Ping the daemon — returns true if reachable. */
  async ping(): Promise<boolean> {
    try {
      const res = await this.get("/status");
      return res.ok;
    } catch { return false; }
  }
}
