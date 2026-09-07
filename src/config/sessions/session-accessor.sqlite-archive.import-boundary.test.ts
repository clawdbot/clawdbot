import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
  formatCliProcessFailure,
  runCliProcessChild,
} from "../../cli/cli-process-child.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

it("reads transcript archives without loading session reclamation", async () => {
  await withOpenClawTestState({ label: "archive-import", applyEnv: false }, async (state) => {
    const entry = state.path("archive-import.mjs");
    await fs.writeFile(
      entry,
      `import assert from "node:assert/strict";
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/session-accessor\\.sqlite-reclamation(?:\\.runtime)?\\.[jt]s(?:[?#]|$)/.test(specifier)) {
      throw new Error("Read-only archive work imported session reclamation: " + specifier);
    }
    return nextResolve(specifier, context);
  },
});
const { publishTranscriptArchiveInWorker } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/config/sessions/session-accessor.sqlite-archive.worker.ts")).href)});
const result = publishTranscriptArchiveInWorker({
  agentId: "main", archiveDirectory: ${JSON.stringify(state.path("archives"))},
  databasePath: ${JSON.stringify(state.path("missing.sqlite"))}, generation: "generation", sessionId: "session",
});
assert.deepEqual(result, {
  error: "Canonical SQLite transcript archive is missing for session",
  generation: "generation", sessionId: "session",
});
console.log("archive-import-boundary-ok");
`,
    );
    const result = await runCliProcessChild({
      nodeArgs: ["--import", "tsx", entry],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...state.envVars },
      timeoutMs: 30_000,
    });
    expect(
      result.code,
      formatCliProcessFailure({ reason: "Archive cold import failed", ...result }),
    ).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("archive-import-boundary-ok");
  });
});
