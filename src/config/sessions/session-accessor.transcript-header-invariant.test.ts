// A transcript's first persisted row must be the canonical session header. Reset
// boundaries against a never-materialized transcript used to land at seq 0 without
// one, permanently wedging every later session load.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";

describe("transcript header invariant", () => {
  const tempDirs: string[] = [];
  let storePath: string;

  beforeEach(() => {
    storePath = path.join(makeTempDir(tempDirs, "openclaw-transcript-header-"), "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  function makeScope(name: string) {
    return {
      agentId: "main",
      sessionId: `${name}-session`,
      sessionKey: `agent:main:${name}`,
      storePath,
    };
  }

  it("appends no reset boundary to a never-materialized transcript on single reset", async () => {
    const scope = makeScope("single-reset-empty");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: scope.sessionId, updatedAt: 20 }),
      resetBoundary: { context: "clear", reason: "new" },
      storePath,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("appends no reset boundary to a never-materialized transcript on bulk lifecycle reset", async () => {
    const scope = makeScope("bulk-reset-empty");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });

    await applySessionEntryLifecycleMutation({
      skipMaintenance: true,
      storePath,
      upserts: [
        {
          entry: { sessionId: scope.sessionId, updatedAt: 20 },
          resetBoundary: { context: "preserve-tail", reason: "daily" },
          sessionKey: scope.sessionKey,
        },
      ],
    });

    await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
  });

  it("still appends a reset boundary once the transcript has real entries", async () => {
    const scope = makeScope("materialized-reset");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    appendTranscriptMessageSync(scope, {
      eventId: "first-message",
      message: { role: "user", content: "hello" },
      parentId: null,
    });

    await resetSessionEntryLifecycle({
      buildNextEntry: () => ({ sessionId: scope.sessionId, updatedAt: 20 }),
      resetBoundary: { context: "clear", reason: "new" },
      storePath,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
    });

    const events = await loadTranscriptEvents(scope);
    expect(events[0]).toMatchObject({ type: "session" });
    expect(events.at(-1)).toMatchObject({ type: "reset", reason: "new" });
  });
});
