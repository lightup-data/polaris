// Which Claude Code process owns a hook / MCP server process, and is it still running?
// Shared by the daemon (session liveness) and the MCP server (exit with its session).

export interface Owner { pid: number; start: string }
export type Proc = { ppid: number; start: string; args: string };

const PS_ENV = { ...process.env, LC_ALL: "C" }; // stable `lstart` format

// One `ps` snapshot: pid → parent, start time, command line
export function processTable(): Map<number, Proc> | null {
  if (process.platform === "win32") return null;
  const r = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,lstart=,args="], { stdout: "pipe", stderr: "ignore", env: PS_ENV });
  if (r.exitCode !== 0) return null;
  const table = new Map<number, Proc>();
  for (const line of r.stdout.toString().split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), start: m[3].replace(/\s+/g, " "), args: m[4] });
  }
  return table;
}

// Claude Code's interactive process itself — not its helper processes (`claude daemon`,
// `claude bg-spare`, `claude bg-pty-host`), which hooks and tools run under.
function isClaudeSessionProcess(args: string): boolean {
  const [bin, sub] = args.trim().split(/\s+/);
  const isClaude = /(^|\/)claude$/.test(bin ?? "") || /@anthropic-ai\/claude-code\//.test(args);
  return isClaude && sub !== "daemon" && !(sub ?? "").startsWith("bg-");
}

// Walk up from a hook / MCP process to the Claude Code process that owns it
export function findOwner(pid: number, table: Map<number, Proc>): Owner | null {
  let p = pid;
  for (let i = 0; i < 25 && p > 1; i++) {
    const proc = table.get(p);
    if (!proc) return null;
    if (isClaudeSessionProcess(proc.args)) return { pid: p, start: proc.start };
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
