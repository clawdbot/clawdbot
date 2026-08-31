import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => void) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  archiveMaterializationHook.beforeMaterialize = undefined;
  closeOpenClawAgentDatabasesForTest();
});

it("releases the store writer before maintenance archive sizing completes", async () => {
  const tempDir = tempDirs.make("openclaw-session-maintenance-writer-");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const removedKey = "agent:main:maintenance-sizing-removed";
  const writerKey = "agent:main:maintenance-sizing-writer";
  replaceSessionEntrySync(
    { sessionKey: removedKey, storePath },
    { sessionId: "maintenance-sizing-removed", updatedAt: 1 },
  );
  replaceTranscriptEventsSync(
    { sessionKey: removedKey, sessionId: "maintenance-sizing-removed", storePath },
    [{ type: "session", id: "maintenance-sizing-removed", content: "archive me" }],
  );
  replaceSessionEntrySync(
    { sessionKey: writerKey, storePath },
    { sessionId: "maintenance-sizing-writer", updatedAt: Date.now() },
  );

  let writerCompleted = false;
  let writerCompletedBeforeMaterialization = false;
  archiveMaterializationHook.beforeMaterialize = () => {
    writerCompletedBeforeMaterialization = writerCompleted;
  };

  const cleanup = applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      maxEntries: 1,
      mode: "enforce",
      pruneAfterMs: Number.MAX_SAFE_INTEGER,
    },
  });
  const writer = applySessionEntryLifecycleMutation({
    storePath,
    skipMaintenance: true,
    upserts: [
      {
        sessionKey: writerKey,
        entry: {
          sessionId: "maintenance-sizing-writer",
          label: "progressed",
          updatedAt: Date.now(),
        },
      },
    ],
  }).then((result) => {
    writerCompleted = true;
    return result;
  });

  await expect(cleanup).resolves.toMatchObject({ capped: 1 });
  await writer;
  expect(loadSessionEntry({ sessionKey: writerKey, storePath })).toMatchObject({
    label: "progressed",
  });
  expect(writerCompletedBeforeMaterialization).toBe(true);
});
