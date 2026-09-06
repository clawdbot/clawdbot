import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  projectPluginSessionEntry,
  projectPluginSessionEntryPatch,
  projectPluginSessionStore,
  reconcilePluginSessionStore,
} from "./session-store-runtime-internal.js";
import {
  patchSessionEntry,
  updateSessionStore,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function privateGenerationEntry(): InternalSessionEntry {
  return {
    activeWriterRunId: "writer-run",
    lifecycleRevision: "generation-1",
    lifecycleRunId: "lifecycle-run",
    sessionDiffBaselineCapture: {
      version: 1,
      captureId: "capture-1",
      status: "pending",
    },
    transcriptByteCompactionLatch: {
      activeBytes: 60_000,
      sessionId: "session-1",
      maxBytes: 50_000,
    },
    sessionId: "session-1",
    updatedAt: 10,
  };
}

function expectGenerationPrivateFieldsCleared(entry: InternalSessionEntry | undefined): void {
  expect(entry?.activeWriterRunId).toBeUndefined();
  expect(entry?.lifecycleRunId).toBeUndefined();
  expect(entry?.sessionDiffBaselineCapture).toBeUndefined();
  expect(entry?.transcriptByteCompactionLatch).toBeUndefined();
}

const sessionEntryKeepsWriterClaimPrivate: "activeWriterRunId" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsWriterClaimPrivate;
const sessionEntryKeepsBaselineClaimPrivate: "sessionDiffBaselineCapture" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsBaselineClaimPrivate;
const sessionEntryKeepsByteCompactionLatchPrivate: "transcriptByteCompactionLatch" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsByteCompactionLatchPrivate;
const sessionEntryKeepsThinkingSelectionPrivate: "thinkingLevelSelection" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsThinkingSelectionPrivate;
const sessionFallbackKeepsThinkingSelectionPrivate: "prevThinkingLevelSelection" extends keyof NonNullable<
  SessionEntry["modelFallback"]
>
  ? false
  : true = true;
void sessionFallbackKeepsThinkingSelectionPrivate;

describe("plugin session writer claim projection", () => {
  it.each(["patch", "upsert", "whole-store"] as const)(
    "preserves server publication through %s lifecycle changes while rejecting forged grants",
    async (method) => {
      const sessionKey = "agent:main:plugin-publication";
      const storePath = path.join(tempDirs.make("openclaw-sdk-publication-"), "sessions.json");
      const publicShare = { id: "a".repeat(48), sessionId: "session-1", createdAt: 1 };
      const updatedAt = Date.now();
      await replaceSessionEntry(
        { sessionKey, storePath },
        {
          ...privateGenerationEntry(),
          publicShare,
          updatedAt,
        },
      );
      const mutate = async (entry: InternalSessionEntry) => {
        if (method === "patch") {
          await patchSessionEntry({
            sessionKey,
            storePath,
            replaceEntry: true,
            update: () => entry,
          });
        } else if (method === "upsert") {
          await upsertSessionEntry({ sessionKey, storePath, entry });
        } else {
          await updateSessionStore(storePath, (store) => {
            store[sessionKey] = entry;
          });
        }
      };
      await mutate({
        sessionId: "session-1",
        lifecycleRevision: "generation-2",
        updatedAt,
        publicShare: { ...publicShare, id: "b".repeat(48) },
      });
      const sameSession = loadSessionEntry({ sessionKey, storePath });
      expect(sameSession?.sessionId).toBe("session-1");
      expect(sameSession?.publicShare).toEqual(publicShare);
      expectGenerationPrivateFieldsCleared(sameSession);

      await mutate({
        sessionId: "session-2",
        lifecycleRevision: "generation-3",
        updatedAt,
        publicShare: { ...publicShare, sessionId: "session-2", id: "c".repeat(48) },
      });
      expect(loadSessionEntry({ sessionKey, storePath })?.publicShare).toBeUndefined();
    },
  );

  it("excludes private claims and retired thinking provenance from entries and patches", () => {
    const entry = {
      activeWriterRunId: "run-writer",
      lifecycleRunId: "run-lifecycle",
      sessionDiffBaselineCapture: {
        version: 1,
        captureId: "capture-writer",
        status: "pending",
      },
      transcriptByteCompactionLatch: {
        activeBytes: 60_000,
        sessionId: "session-writer",
        maxBytes: 50_000,
      },
      model: "gpt-5.6",
      modelFallback: {
        prevModel: "gpt-5.5",
        prevProvider: "openai",
        prevThinkingLevelSelection: { retired: true },
        source: "agent-patch",
        ts: 1,
      },
      sessionId: "session-writer",
      thinkingLevelSelection: { retired: true },
      updatedAt: 10,
    } as unknown as InternalSessionEntry;

    expect(projectPluginSessionEntry(entry)).toEqual({
      model: "gpt-5.6",
      modelFallback: {
        prevModel: "gpt-5.5",
        prevProvider: "openai",
        source: "agent-patch",
        ts: 1,
      },
      sessionId: "session-writer",
      updatedAt: 10,
    });
    expect(
      projectPluginSessionEntryPatch({
        activeWriterRunId: "run-next",
        lifecycleRunId: "run-lifecycle-next",
        sessionDiffBaselineCapture: {
          version: 1,
          captureId: "capture-next",
          status: "pending",
        },
        transcriptByteCompactionLatch: {
          activeBytes: 70_000,
          sessionId: "session-next",
          maxBytes: 60_000,
        },
        model: "gpt-5.5",
        modelFallback: {
          prevModel: "gpt-5.4",
          prevProvider: "openai",
          prevThinkingLevelSelection: { retired: true },
          source: "agent-patch",
          ts: 2,
        },
        thinkingLevelSelection: { retired: true },
      } as unknown as Partial<InternalSessionEntry>),
    ).toEqual({
      model: "gpt-5.5",
      modelFallback: {
        prevModel: "gpt-5.4",
        prevProvider: "openai",
        source: "agent-patch",
        ts: 2,
      },
    });
  });

  it("preserves private generation fields when patches and upserts omit lifecycle revision", async () => {
    const sessionKey = "agent:main:patch-preserve-generation";
    const storePath = path.join(tempDirs.make("openclaw-sdk-generation-"), "sessions.json");
    await replaceSessionEntry({ sessionKey, storePath }, privateGenerationEntry());

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({ model: "gpt-5.6" }),
    });

    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      activeWriterRunId: "writer-run",
      lifecycleRevision: "generation-1",
      lifecycleRunId: "lifecycle-run",
      model: "gpt-5.6",
      sessionDiffBaselineCapture: { captureId: "capture-1", status: "pending" },
      transcriptByteCompactionLatch: {
        activeBytes: 60_000,
        sessionId: "session-1",
        maxBytes: 50_000,
      },
    });

    await upsertSessionEntry({
      entry: { sessionId: "session-1", updatedAt: 20 },
      sessionKey,
      storePath,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      activeWriterRunId: "writer-run",
      lifecycleRevision: "generation-1",
      lifecycleRunId: "lifecycle-run",
      sessionDiffBaselineCapture: { captureId: "capture-1", status: "pending" },
      transcriptByteCompactionLatch: {
        activeBytes: 60_000,
        sessionId: "session-1",
        maxBytes: 50_000,
      },
    });
  });

  it("clears private generation fields when a patch rotates lifecycle revision", async () => {
    const sessionKey = "agent:main:patch-rotate-generation";
    const storePath = path.join(tempDirs.make("openclaw-sdk-generation-"), "sessions.json");
    await replaceSessionEntry({ sessionKey, storePath }, privateGenerationEntry());

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({ lifecycleRevision: "generation-2" }),
    });

    const entry = loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry | undefined;
    expect(entry).toMatchObject({ lifecycleRevision: "generation-2", sessionId: "session-1" });
    expectGenerationPrivateFieldsCleared(entry);
  });

  it("clears private generation fields when whole-store reconciliation rotates lifecycle revision", () => {
    const sessionKey = "agent:main:reconcile-rotate-generation";
    const internalStore = { [sessionKey]: privateGenerationEntry() };
    const publicStore = projectPluginSessionStore(internalStore);
    publicStore[sessionKey] = {
      ...publicStore[sessionKey]!,
      lifecycleRevision: "generation-2",
    };

    reconcilePluginSessionStore({ internalStore, publicStore });

    expect(internalStore[sessionKey]).toMatchObject({
      lifecycleRevision: "generation-2",
      sessionId: "session-1",
    });
    expectGenerationPrivateFieldsCleared(internalStore[sessionKey]);
  });
});
