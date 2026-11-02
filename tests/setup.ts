import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before any test module is imported, so every in-process daemon/client/CLI
// resolves its state under this throwaway dir instead of the real ~/.polaris.
const home = mkdtempSync(join(tmpdir(), "polaris-test-home-"));
process.env.POLARIS_HOME = home;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
