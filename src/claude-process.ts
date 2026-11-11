// Which Claude Code process owns a hook / MCP server process, and is it still running?
// Shared by the daemon (session liveness) and the MCP server (exit with its session).

export interface Owner { pid: number; start: string }
// comm = the executable (a path on macOS, which may contain spaces — e.g. the desktop
// app's bundled Claude Code under "Application Support"; a short name on Linux; some
// processes retitle it, like "claude bg-spare"). args = the full command line.
export type Proc = { ppid: number; start: string; args: string; comm?: string };

const PS_ENV = { ...process.env, LC_ALL: "C" }; // stable `lstart` format

function ps(columns: string): string | null {
  const r = Bun.spawnSync(["ps", "-axo", columns], { stdout: "pipe", stderr: "ignore", env: PS_ENV });
  return r.exitCode === 0 ? r.stdout.toString() : null;
}

// One `ps` snapshot: pid → parent, start time, executable, command line. comm and args
// can both contain spaces, so each is read as the last column of its own listing.
export function processTable(): Map<number, Proc> | null {
  if (process.platform === "win32") return null;
  const a = ps("pid=,ppid=,lstart=,args=");
  const c = ps("pid=,comm=");
  if (!a) return null;
  const table = new Map<number, Proc>();
  for (const line of a.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), start: m[3].replace(/\s+/g, " "), args: m[4] });
  }
  for (const line of (c ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    const proc = m ? table.get(Number(m[1])) : undefined;
    if (proc) proc.comm = m![2].trim();
  }
  return table;
}

// Claude Code's interactive process itself — not its helper processes (`claude daemon`,
// `claude bg-spare`, `claude bg-pty-host`), which hooks and tools run under.
export function isClaudeSessionProcess(proc: Proc): boolean {
  const comm = proc.comm ?? "";
  // The executable, by path when we have one (spaces allowed), else the first word
  const exe = comm.includes("/") ? comm : (comm.split(/\s+/)[0] || proc.args.trim().split(/\s+/)[0] || "");
  const isClaude = /(^|\/)claude$/.test(exe) || /@anthropic-ai\/claude-code\//.test(proc.args);
  if (!isClaude) return false;
  // First word after the executable: skip helpers. The command line repeats the
  // executable path when it has one; otherwise drop the first word.
  const rest = comm.includes("/") && proc.args.startsWith(comm) ? proc.args.slice(comm.length) : proc.args.trim().replace(/^\S+/, "");
  const sub = rest.trim().split(/\s+/)[0] ?? "";
  return sub !== "daemon" && !sub.startsWith("bg-");
}

// Walk up from a hook / MCP process to the Claude Code process that owns it
export function findOwner(pid: number, table: Map<number, Proc>): Owner | null {
  let p = pid;
  for (let i = 0; i < 25 && p > 1; i++) {
    const proc = table.get(p);
    if (!proc) return null;
    if (isClaudeSessionProcess(proc)) return { pid: p, start: proc.start };
    p = proc.ppid;
  }
  return null;
}

// Alive = that pid exists AND started at the recorded time (a reused pid doesn't count)
export function ownerAlive(owner: Owner): boolean {
  const r = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(owner.pid)], { stdout: "pipe", stderr: "ignore", env: PS_ENV });
  return r.exitCode === 0 && r.stdout.toString().trim().replace(/\s+/g, " ") === owner.start;
}

// Call onGone once the owner has exited. Returns a stop function.
export function watchOwner(owner: Owner, onGone: () => void, opts: { intervalMs?: number; isAlive?: (o: Owner) => boolean } = {}): () => void {
  const isAlive = opts.isAlive ?? ownerAlive;
  const timer = setInterval(() => {
    if (!isAlive(owner)) {
      clearInterval(timer);
      onGone();
    }
  }, opts.intervalMs ?? 30_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
