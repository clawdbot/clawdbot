import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withCodexSessionTranscriptMirrorWriteLock } from "./codex-session-transcript-runtime.js";
import { readSessionTranscriptVisibleMessageDelta } from "./session-transcript-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("private session transcript mirror runtime", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-sdk-transcript-mirror-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("rechecks idempotency and publishes only committed visible sequences", async () => {
    const scope = {
      agentId: "main",
      sessionId: "indexed-mirror-session",
      sessionKey: "agent:main:indexed-mirror",
      storePath,
    };
    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });

    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toEqual({
        existingIdempotencyKeys: new Set(),
        messagesByIdempotencyKey: new Map(),
      });
      const first = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: [{ type: "text", text: "persist once" }],
          idempotencyKey: "mirror-user",
          timestamp: 1,
        },
      });
      expect(first).toMatchObject({
        messageSeq: 1,
        result: { appended: true, message: { role: "user" } },
      });
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject({
        existingIdempotencyKeys: new Set(["mirror-user"]),
        messagesByIdempotencyKey: new Map([
          ["mirror-user", expect.objectContaining({ role: "user" })],
        ]),
      });
      const replay = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: [{ type: "text", text: "must not replace persisted payload" }],
          idempotencyKey: "mirror-user",
          timestamp: 2,
        },
      });
      expect(replay).toMatchObject({
        result: {
          appended: false,
          message: { content: [{ text: "persist once", type: "text" }], role: "user" },
        },
      });
      expect(replay.messageSeq).toBeUndefined();

      if (!first.result) {
        throw new Error("expected initial mirror append");
      }
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "abandoned branch" }],
          idempotencyKey: "mirror-abandoned",
          timestamp: 3,
        },
        parentId: first.result.messageId,
      });
      const activeBranch = await locked.appendMessageWithMessageSequence({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final active branch" }],
          idempotencyKey: "mirror-active",
          timestamp: 4,
        },
        parentId: first.result.messageId,
      });
      expect(activeBranch).toMatchObject({
        result: { appended: true, message: { role: "assistant" } },
      });
      expect(activeBranch.messageSeq).toBeUndefined();
    });

    const resolvedScope = resolveSqliteTranscriptScope(scope);
    await expect(
      readSessionTranscriptVisibleMessageDelta({ ...scope, maxMessages: 10 }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "projection_rebuilding",
    });
    await waitForSessionTranscriptProjection(scope);
    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      const afterReconcile = await locked.appendMessageWithMessageSequence({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "after active branch" }],
          idempotencyKey: "mirror-after-reconcile",
          timestamp: 5,
        },
      });
      expect(afterReconcile).toMatchObject({
        messageSeq: 3,
        result: { appended: true, message: { role: "assistant" } },
      });
    });

    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolvedScope));
    const external = new DatabaseSync(database.path);
    external
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    external.close();

    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject({
        existingIdempotencyKeys: new Set(["mirror-user"]),
        messagesByIdempotencyKey: new Map([
          ["mirror-user", expect.objectContaining({ role: "user" })],
        ]),
      });
      const dirtyProjection = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "projection fallback" }],
          idempotencyKey: "mirror-dirty",
          timestamp: 6,
        },
      });
      expect(dirtyProjection).toMatchObject({
        result: { appended: true, message: { role: "assistant" } },
      });
      expect(dirtyProjection.messageSeq).toBeUndefined();
    });
  });
});
