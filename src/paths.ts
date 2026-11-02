import { homedir } from "node:os";
import { join } from "node:path";

// POLARIS_HOME overrides ~/.polaris; the test preload points it at a temp dir so
// test runs never read or write a developer's real config, logs, outbox or sessions.
export const POLARIS_DIR = process.env.POLARIS_HOME || join(homedir(), ".polaris");
