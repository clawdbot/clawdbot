/**
 * Fixtures for chat method tests that need a real persisted session transcript.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";

/** Writes a minimal current-version transcript file and returns its temp location. */
export function createTranscriptFixtureSync(params: {
  prefix: string;
  sessionId: string;
  fileName?: string;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const transcriptPath = path.join(dir, params.fileName ?? "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  return { dir, transcriptPath };
}
