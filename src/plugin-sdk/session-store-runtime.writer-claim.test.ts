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
    sessionId: "session-1",
    updatedAt: 10,
  };
}

function expectGenerationPrivateFieldsCleared(entry: InternalSessionEntry | undefined): void {
  expect(entry?.activeWriterRunId).toBeUndefined();
  expect(entry?.lifecycleRunId).toBeUndefined();
  expect(entry?.sessionDiffBaselineCapture).toBeUndefined();
}

const sessionEntryKeepsWriterClaimPrivate: "activeWriterRunId" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsWriterClaimPrivate;
const sessionEntryKeepsBaselineClaimPrivate: "sessionDiffBaselineCapture" extends keyof SessionEntry
  ? false
  : true = true;
void sessionEntryKeepsBaselineClaimPrivate;

describe("plugin session writer claim projection", () => {
  it("excludes the durable writer claim from entries and patches", () => {
    const entry: InternalSessionEntry = {
      activeWriterRunId: "run-writer",
      lifecycleRunId: "run-lifecycle",
      sessionDiffBaselineCapture: {
        version: 1,
        captureId: "capture-writer",
        status: "pending",
      },
      model: "gpt-5.6",
      sessionId: "session-writer",
      updatedAt: 10,
    };

    expect(projectPluginSessionEntry(entry)).toEqual({
      model: "gpt-5.6",
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
        model: "gpt-5.5",
      }),
    ).toEqual({ model: "gpt-5.5" });
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
