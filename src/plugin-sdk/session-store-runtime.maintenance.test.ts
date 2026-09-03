import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { getSessionEntry, patchSessionEntry } from "./session-store-runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("plugin session store maintenance", () => {
  it.each([
    { modelRunPruneAfterMs: DAY_MS, modelRunSessionPresent: false },
    { modelRunPruneAfterMs: 0, modelRunSessionPresent: true },
    { modelRunPruneAfterMs: -DAY_MS, modelRunSessionPresent: true },
  ])(
    "applies model-run retention $modelRunPruneAfterMs through entry patches",
    async ({ modelRunPruneAfterMs, modelRunSessionPresent }) => {
      const storePath = path.join(tempDirs.make("openclaw-sdk-maintenance-"), "sessions.json");
      const modelRunSessionKey =
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
      const oldSessionKey = "agent:main:old";
      const activeSessionKey = "agent:main:active";
      const now = Date.now();
      const seed = (sessionKey: string, sessionId: string, updatedAt: number) =>
        replaceSessionEntrySync(
          { agentId: "main", sessionKey, storePath },
          { sessionId, updatedAt },
        );
      seed(modelRunSessionKey, "session-model-run", now - 2 * DAY_MS);
      seed(oldSessionKey, "session-old", now - 3 * DAY_MS);
      seed(activeSessionKey, "session-active", now);

      await patchSessionEntry({
        sessionKey: activeSessionKey,
        storePath,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 30 * DAY_MS,
          modelRunPruneAfterMs,
          maxEntries: 2,
          resetArchiveRetentionMs: 7 * DAY_MS,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        update: () => ({ model: "gpt-5.6-luna" }),
      });

      await vi.waitFor(
        () => {
          expect(getSessionEntry({ sessionKey: modelRunSessionKey, storePath }) != null).toBe(
            modelRunSessionPresent,
          );
        },
        { timeout: 5_000 },
      );
    },
  );
});
