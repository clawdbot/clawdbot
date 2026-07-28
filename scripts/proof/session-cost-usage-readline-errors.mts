// Real behavior proof: session log readline errors are swallowed at the
// diagnostic boundary so callers get a truncated but stable result.
//
// The proof creates a real transcript session directory where the session file
// is a directory instead of a file. `fs.createReadStream` on a directory emits
// an EISDIR error on the stream. With the fix, `loadSessionLogs` returns an
// empty array after the stream closes. Before the fix the unhandled stream error
// rejected `loadSessionLogs`.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { loadSessionLogs } = await import(path.join(repoRoot, "src/infra/session-cost-usage.js"));

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-proof-session-cost-"));
const sessionsDir = path.join(tmpDir, "agents", "main", "sessions");
await fs.mkdir(sessionsDir, { recursive: true });

// Make the session file a directory. createReadStream on a directory emits
// EISDIR, which exercises the best-effort error handler in loadSessionLogs.
const sessionFile = path.join(sessionsDir, "proof-session.jsonl");
await fs.mkdir(sessionFile);

console.log("=== Proof: session-cost usage readline stream error catch ===\n");
console.log(`Created directory-as-file at: ${sessionFile}`);
console.log("Calling loadSessionLogs...\n");

try {
  const logs = await loadSessionLogs({ sessionFile });
  if (Array.isArray(logs) && logs.length === 0) {
    console.log("loadSessionLogs returned: []");
    console.log("\nPASS: EISDIR stream error was caught and loadSessionLogs returned empty logs.");
  } else {
    console.log(`\nFAIL: unexpected result: ${JSON.stringify(logs)}`);
    process.exitCode = 1;
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.log(`\nFAIL: loadSessionLogs threw: ${message}`);
  console.log("The stream error should have been swallowed by loadSessionLogs.");
  process.exitCode = 1;
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
