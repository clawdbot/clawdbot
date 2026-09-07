// Memory Host SDK tests cover session transcript path derivation.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionPathForFile } from "./session-files.js";

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-path-test-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
});

afterEach(() => {
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("sessionPathForFile", () => {
  it("includes the owning agent id when the transcript lives under an agent sessions dir", () => {
    const absPath = path.join(
      tmpDir,
      "agents",
      "main",
      "sessions",
      "deleted-session.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );

    expect(sessionPathForFile(absPath)).toBe(
      "sessions/main/deleted-session.jsonl.deleted.2026-02-16T22-27-33.000Z",
    );
  });

  it("keeps the legacy basename-only path when the agent owner cannot be derived", () => {
    expect(sessionPathForFile(path.join(tmpDir, "loose-session.jsonl"))).toBe(
      "sessions/loose-session.jsonl",
    );
  });
});
