import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CLI ↔ MCP tool sync check
//
// Every MCP tool should have a CLI counterpart and vice versa, with a small
// set of documented intentional exceptions. This test parses both source
// files and fails when a new tool or command appears without a pair.
//
// To add a new tool: add its pair first, then update EXCEPTIONS if it is
// intentionally one-sided.
// ---------------------------------------------------------------------------

// Documented intentional asymmetries (will NOT cause test failure).
// Update this table when you intentionally add a one-sided command.
const MCP_ONLY = new Set([
  "polaris_standby",   // agent-only blocking long-poll — nonsensical in a CLI
  "polaris_account",   // per-Claude-session account choice; the CLI has no session (see `polaris use`)
]);

const CLI_ONLY = new Set([
  "install",    // machine setup — not meaningful as an MCP tool
  "login",      // browser/token OAuth — not meaningful as an MCP tool
  "token",      // prints local token — auth management, CLI only
  "use",        // switch active account — auth management, CLI only
  "daemon",     // starts daemon process — infra, CLI only
  "logout",     // removes credentials — auth management, CLI only
  "accounts", "account", // machine-wide account list; in-session choice is polaris_account
  "setup",      // first-time onboarding (install + login) — CLI only
  "help", "--help", "-h",          // usage text
  "version", "--version", "-v",    // installed version
]);

// Explicit pairing: MCP tool name → CLI command name.
// Pairs that don't follow the simple polaris_X ↔ X pattern.
const EXPLICIT_PAIRS: Record<string, string> = {
  polaris_rename_session: "rename-session",
  polaris_backfill: "recover",
};

async function extractMcpTools(src: string): Promise<string[]> {
  // Match: name: "polaris_xxx"
  const matches = [...src.matchAll(/name:\s*"(polaris_\w+)"/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

async function extractCliCommands(src: string): Promise<string[]> {
  // Match only top-level command dispatch: `  case "xxx":` with exactly 2-space indent.
  // Inner switches (e.g. hook event type dispatch inside recover()) use deeper indent.
  const matches = [...src.matchAll(/^  case "([^"]+)":/gm)];
  return [...new Set(matches.map((m) => m[1]))];
}

describe("CLI ↔ MCP sync", () => {
  test("every MCP tool has a CLI counterpart (or is documented as MCP-only)", async () => {
    const clientSrc = await readFile(join(import.meta.dir, "../src/client/client.ts"), "utf-8");
    const cliSrc = await readFile(join(import.meta.dir, "../src/cli/cli.ts"), "utf-8");

    const mcpTools = await extractMcpTools(clientSrc);
    const cliCommands = new Set(await extractCliCommands(cliSrc));

    const missing: string[] = [];
    for (const tool of mcpTools) {
      if (MCP_ONLY.has(tool)) continue;
      // Derive expected CLI name: polaris_foo → foo, with explicit overrides
      const cliName = EXPLICIT_PAIRS[tool] ?? tool.replace(/^polaris_/, "").replace(/_/g, "-");
      if (!cliCommands.has(cliName)) {
        missing.push(`${tool} → expected CLI command: "${cliName}"`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `MCP tools missing CLI counterparts:\n${missing.map(m => `  ${m}`).join("\n")}\n\n` +
        `Add the CLI command or add the tool to MCP_ONLY in tests/cli-mcp-sync.test.ts.`
      );
    }
  });

  test("every CLI command has an MCP counterpart (or is documented as CLI-only)", async () => {
    const clientSrc = await readFile(join(import.meta.dir, "../src/client/client.ts"), "utf-8");
    const cliSrc = await readFile(join(import.meta.dir, "../src/cli/cli.ts"), "utf-8");

    const mcpTools = new Set(await extractMcpTools(clientSrc));
    const cliCommands = await extractCliCommands(cliSrc);

    // Build reverse map: CLI name → MCP tool name
    const cliToMcp: Record<string, string> = {};
    for (const [mcp, cli] of Object.entries(EXPLICIT_PAIRS)) {
      cliToMcp[cli] = mcp;
    }

    const missing: string[] = [];
    for (const cmd of cliCommands) {
      if (CLI_ONLY.has(cmd)) continue;
      const expectedTool = cliToMcp[cmd] ?? `polaris_${cmd.replace(/-/g, "_")}`;
      if (!mcpTools.has(expectedTool)) {
        missing.push(`"${cmd}" → expected MCP tool: "${expectedTool}"`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `CLI commands missing MCP counterparts:\n${missing.map(m => `  ${m}`).join("\n")}\n\n` +
        `Add the MCP tool or add the command to CLI_ONLY in tests/cli-mcp-sync.test.ts.`
      );
    }
  });
});
