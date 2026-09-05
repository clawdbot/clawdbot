import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionEntries from "../../config/sessions/session-accessor.sqlite-entry.js";
import { runExclusiveSessionStoreWrite } from "../../config/sessions/store-writer.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import * as registry from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  testing.resetReplyRunRegistry();
  closeOpenClawAgentDatabasesForTest();
  vi.restoreAllMocks();
});

it.each(
  (["writer", "active", "delivery"] as const).flatMap((wait) =>
    (["unchanged", "same-inode", "other-inode"] as const).map((replacement) => ({
      wait,
      replacement,
    })),
  ),
)(
  "keeps the exact database owner across $wait wait, replacement=$replacement",
  async ({ wait, replacement }) => {
    const root = tempDirs.make("reply-admission-claim-");
    const originalPath = path.join(root, "original.sqlite");
    const replacementPath = path.join(root, "replacement.sqlite");
    const storePath = path.join(root, "selected.sqlite");
    const sessionKey = "global";
    const sessionId = "copied-session";
    for (const databasePath of [originalPath, replacementPath]) {
      sessionEntries.replaceSessionEntrySync(
        { storePath: databasePath, sessionKey },
        { sessionId, updatedAt: 1 },
      );
    }
    closeOpenClawAgentDatabasesForTest();
    fs.symlinkSync(originalPath, storePath);
    const release = createDeferred();
    const writerStarted = createDeferred();
    let owner: registry.ReplyOperation | undefined;
    let writer: Promise<void> | undefined;
    if (wait === "writer") {
      writer = runExclusiveSessionStoreWrite(storePath, async () => {
        writerStarted.resolve();
        await release.promise;
      });
      await writerStarted.promise;
    } else {
      const admitted = await admitReplyTurn({
        storePath,
        sessionKey,
        sessionId,
        kind: "visible",
        resetTriggered: false,
      });
      expect(admitted.status).toBe("owned");
      if (admitted.status !== "owned") {
        throw new Error("fixture requires an admitted blocking owner");
      }
      owner = admitted.operation;
      if (wait === "delivery") {
        owner.completeWithAfterClearBarrier(release.promise);
      }
    }
    const loaded = vi.spyOn(sessionEntries, "loadSessionEntryWithDatabase");
    const waiting =
      wait === "active"
        ? vi.spyOn(registry.replyRunRegistry, "waitForIdle")
        : wait === "delivery"
          ? vi.spyOn(registry, "waitForReplyRunFollowupAdmission")
          : loaded;
    const controller = new AbortController();
    const pending = admitReplyTurn({
      storePath,
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(waiting).toHaveBeenCalled());
      const observed = loaded.mock.results.at(-1);
      if (observed?.type !== "return") {
        throw new Error("fixture requires a completed authoritative row read");
      }
      const database = observed.value.databaseClaim.database;
      expect(database.db.isOpen).toBe(true);
      if (replacement !== "unchanged") {
        expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
        expect(database.db.isOpen).toBe(false);
        if (replacement === "other-inode") {
          fs.unlinkSync(storePath);
          fs.symlinkSync(replacementPath, storePath);
        }
      }
      owner?.complete();
      release.resolve();
      const result = await pending;
      if (replacement === "unchanged") {
        expect(result.status).toBe("owned");
        if (result.status === "owned") {
          expect(result.databaseClaim?.database.db).toBe(database.db);
          result.operation.complete();
        }
      } else {
        expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
      }
    } finally {
      owner?.complete();
      release.resolve();
      controller.abort();
      const result = await pending.catch(() => undefined);
      if (result?.status === "owned") {
        result.operation.complete();
      }
      await writer;
    }
  },
);
