import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { startServer } from "../src/service/server";
import type { Sql } from "../src/service/db";
import type { Server } from "bun";
import { resetTestData } from "./helpers";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://polaris:polaris@localhost:5432/polaris_test";

let base: string;
let sql: Sql;
let stop: () => Promise<void>;

beforeAll(async () => {
  const s = await startServer({ port: 0, databaseUrl: DATABASE_URL });
  sql = s.sql;
  stop = s.stop;
  base = `http://localhost:${s.server.port}`;
});

afterAll(async () => {
  await stop();
});

beforeEach(async () => {
  await resetTestData(sql);
});

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return fetch(`${base}${path}`);
}

// --- Projects ---

describe("POST /projects", () => {
  test("creates a project", async () => {
    const res = await post("/projects", { name: "pj" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("pj");
    expect(body.created_at).toBeDefined();
  });

  test("409 on duplicate", async () => {
    await post("/projects", { name: "pj" });
    const res = await post("/projects", { name: "pj" });
    expect(res.status).toBe(409);
  });

  test("400 on missing name", async () => {
    const res = await post("/projects", {});
    expect(res.status).toBe(400);
  });
});

describe("GET /projects/:proj", () => {
  test("returns project metadata", async () => {
    await post("/projects", { name: "pj" });
    const res = await get("/projects/pj");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("pj");
  });

  test("404 for nonexistent project", async () => {
    const res = await get("/projects/nope");
    expect(res.status).toBe(404);
  });
});

// --- Sessions ---

describe("POST /projects/:proj/sessions", () => {
  test("creates a session with driver", async () => {
    await post("/projects", { name: "pj" });
    const res = await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("fxm");
    expect(body.driver).toBe("user:manu");
  });

  test("creates a session without driver", async () => {
    await post("/projects", { name: "pj" });
    const res = await post("/projects/pj/sessions", { name: "fxm" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.driver).toBeNull();
  });

  test("404 if project doesn't exist", async () => {
    const res = await post("/projects/nope/sessions", { name: "fxm" });
    expect(res.status).toBe(404);
  });

  test("409 on duplicate session in same project", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm" });
    const res = await post("/projects/pj/sessions", { name: "fxm" });
    expect(res.status).toBe(409);
  });
});

describe("GET /projects/:proj/sessions/:sess", () => {
  test("returns session metadata", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    const res = await get("/projects/pj/sessions/fxm");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.driver).toBe("user:manu");
  });

  test("404 for nonexistent session", async () => {
    await post("/projects", { name: "pj" });
    const res = await get("/projects/pj/sessions/nope");
    expect(res.status).toBe(404);
  });
});

// --- Events ---

describe("POST /projects/:proj/sessions/:sess/events", () => {
  test("pushes a hook event and returns it", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    const res = await post("/projects/pj/sessions/fxm/events", {
      sender: "user:manu",
      payload: {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        prompt: "build auth middleware",
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.source).toBe("hook");
    expect(body.payload.prompt).toBe("build auth middleware");
  });

  test("stores the full hook payload, including fields the schema doesn't list", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "toolu_123",
      tool_response: { stdout: "a\nb", stderr: "", interrupted: false },
      duration_ms: 42,
      some_future_field: { nested: [1, 2] },
    };
    const res = await post("/projects/pj/sessions/fxm/events", { sender: "agent:claude", payload });
    expect(res.status).toBe(201);
    const stored = (await (await fetch(`${base}/projects/pj/sessions/fxm/messages`)).json()) as Array<{ payload: unknown }>;
    expect(stored[0].payload).toEqual(payload);
  });

  test("400 on invalid payload", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm" });
    const res = await post("/projects/pj/sessions/fxm/events", { bad: "data" });
    expect(res.status).toBe(400);
  });
});

// --- Inject ---

describe("POST /projects/:proj/sessions/:sess/inject", () => {
  test("injects a message into a session", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    const res = await post("/projects/pj/sessions/fxm/inject", {
      content: "Use RS256 for auth tokens",
      sender: "user:krishna",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.source).toBe("inject");
    expect(body.payload.content).toBe("Use RS256 for auth tokens");
    expect(body.payload.target).toBe("fxm");
  });

  test("400 on missing content", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm" });
    const res = await post("/projects/pj/sessions/fxm/inject", { sender: "user:krishna" });
    expect(res.status).toBe(400);
  });
});

// --- Messages ---

describe("GET /projects/:proj/messages", () => {
  test("returns all events across sessions", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    await post("/projects/pj/sessions", { name: "fxk", driver: "user:krishna" });
    await post("/projects/pj/sessions/fxm/events", {
      sender: "user:manu",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hello" },
    });
    await post("/projects/pj/sessions/fxk/events", {
      sender: "user:krishna",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s2", prompt: "world" },
    });

    const res = await get("/projects/pj/messages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });
});

describe("GET /projects/:proj/sessions/:sess/messages", () => {
  test("returns events for a specific session", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    await post("/projects/pj/sessions", { name: "fxk", driver: "user:krishna" });
    await post("/projects/pj/sessions/fxm/events", {
      sender: "user:manu",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hello" },
    });
    await post("/projects/pj/sessions/fxk/events", {
      sender: "user:krishna",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s2", prompt: "world" },
    });

    const res = await get("/projects/pj/sessions/fxm/messages");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].payload.prompt).toBe("hello");
  });
});

// --- Handoff & Driver ---

describe("handoff and driver claim", () => {
  test("handoff clears driver, claim sets new driver", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });

    // Handoff
    const handoffRes = await post("/projects/pj/sessions/fxm/handoff", {});
    expect(handoffRes.status).toBe(200);
    const handoffBody = await handoffRes.json();
    expect(handoffBody.status).toBe("open");

    // Verify driver is null
    const sessionRes = await get("/projects/pj/sessions/fxm");
    const sessionBody = await sessionRes.json();
    expect(sessionBody.driver).toBeNull();

    // Claim
    const claimRes = await post("/projects/pj/sessions/fxm/driver", { driver: "user:krishna" });
    expect(claimRes.status).toBe(200);
    const claimBody = await claimRes.json();
    expect(claimBody.driver).toBe("user:krishna");

    // Verify driver is set
    const sessionRes2 = await get("/projects/pj/sessions/fxm");
    const sessionBody2 = await sessionRes2.json();
    expect(sessionBody2.driver).toBe("user:krishna");
  });

  test("handoff fails if no driver", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm" });
    const res = await post("/projects/pj/sessions/fxm/handoff", {});
    expect(res.status).toBe(400);
  });

  test("claim fails if driver already set", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    const res = await post("/projects/pj/sessions/fxm/driver", { driver: "user:krishna" });
    expect(res.status).toBe(409);
  });
});

// --- WebSocket ---

describe("WebSocket", () => {
  test("project-level WS receives events from all sessions", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    await post("/projects/pj/sessions", { name: "fxk", driver: "user:krishna" });

    const ws = new WebSocket(`${base.replace("http", "ws")}/projects/pj/ws`);
    const received: unknown[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    ws.onmessage = (e) => received.push(JSON.parse(e.data as string));

    await post("/projects/pj/sessions/fxm/events", {
      sender: "user:manu",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hello from fxm" },
    });
    await post("/projects/pj/sessions/fxk/events", {
      sender: "user:krishna",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s2", prompt: "hello from fxk" },
    });

    // Give time for messages to arrive
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(2);
    ws.close();
  });

  test("session-level WS receives only that session's events", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm", driver: "user:manu" });
    await post("/projects/pj/sessions", { name: "fxk", driver: "user:krishna" });

    const ws = new WebSocket(`${base.replace("http", "ws")}/projects/pj/sessions/fxm/ws`);
    const received: unknown[] = [];

    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    ws.onmessage = (e) => received.push(JSON.parse(e.data as string));

    await post("/projects/pj/sessions/fxm/events", {
      sender: "user:manu",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hello from fxm" },
    });
    await post("/projects/pj/sessions/fxk/events", {
      sender: "user:krishna",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "s2", prompt: "hello from fxk" },
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect((received[0] as { session: string }).session).toBe("fxm");
    ws.close();
  });
});

// --- Status ---

describe("GET /status", () => {
  test("returns ok", async () => {
    const res = await get("/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});

// --- 404 ---

describe("unknown routes", () => {
  test("returns 404", async () => {
    const res = await get("/nonexistent");
    expect(res.status).toBe(404);
  });
});

// --- Renames ---

describe("renames", () => {
  async function seed() {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "old", driver: "user:manu" });
    await post("/projects/pj/sessions/old/events", {
      sender: "user:manu",
      payload: { hook_event_name: "UserPromptSubmit", session_id: "cc1", prompt: "before rename" },
    });
  }

  test("session rename carries its events along", async () => {
    await seed();
    const res = await post("/projects/pj/sessions/old/rename", { name: "new" });
    expect(res.status).toBe(200);
    const events = (await (await fetch(`${base}/projects/pj/sessions/new/messages`)).json()) as Array<{ session: string; payload: { prompt?: string } }>;
    expect(events).toHaveLength(1);
    expect(events[0].session).toBe("new");
    expect(events[0].payload.prompt).toBe("before rename");
    expect((await fetch(`${base}/projects/pj/sessions/old/messages`)).status).toBe(404);
  });

  test("rename history records both kinds under the project's current name", async () => {
    await seed();
    await post("/projects/pj/sessions/old/rename", { name: "new" });
    await post("/projects/pj/rename", { name: "pj2" });
    const history = (await (await fetch(`${base}/renames`)).json()) as Array<{ kind: string; project: string; old_name: string; new_name: string }>;
    expect(history.map(({ kind, project, old_name, new_name }) => ({ kind, project, old_name, new_name }))).toEqual([
      { kind: "session", project: "pj2", old_name: "old", new_name: "new" },
      { kind: "project", project: "pj2", old_name: "pj", new_name: "pj2" },
    ]);
  });
});

describe("server errors", () => {
  test("a handler that throws (database error) answers 500 instead of escaping", async () => {
    await post("/projects", { name: "pj" });
    await post("/projects/pj/sessions", { name: "fxm" });
    await sql`DROP TABLE events CASCADE`; // restored by resetTestData before the next test
    const res = await fetch(`${base}/projects/pj/sessions/fxm/messages`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});
