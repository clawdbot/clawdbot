import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { planSessionStateDeleteIfUnreferenced } from "./session-accessor.sqlite-lifecycle-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return { ...actual, MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES: 1024 };
});

describe("SQLite transcript archive byte limit", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-archive-byte-limit-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("aborts encoded output at the cap and removes staging files", async () => {
    const sessionId = "archive-output-overflow";
    const sessionKey = "agent:main:archive-output-overflow";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      {
        type: "session",
        id: sessionId,
        content: randomBytes(4096).toString("base64"),
      },
    ]);

    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite target path");
    }
    const database = openOpenClawAgentDatabase({
      agentId: target.agentId ?? "main",
      path: target.path,
    });
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected archive plan");
    }
    closeOpenClawAgentDatabasesForTest();
    const { materializeTranscriptArchiveInWorker } =
      await import("./session-accessor.sqlite-archive.worker.js");

    await expect(materializeTranscriptArchiveInWorker(plan)).rejects.toThrow(
      "Archive exceeds 1024 bytes during encoding",
    );
    expect(
      fs
        .readdirSync(path.dirname(storePath))
        .filter((entry) => entry.includes(".stage") || entry.includes("jsonl-stage")),
    ).toEqual([]);
  });
});
