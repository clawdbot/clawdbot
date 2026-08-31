import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getSessionEntry, patchSessionEntry, upsertSessionEntry } from "./session-store-runtime.js";

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
        upsertSessionEntry({
          agentId: "main",
          sessionKey,
          storePath,
          entry: { sessionId, updatedAt },
        });
      await seed(modelRunSessionKey, "session-model-run", now - 2 * DAY_MS);
      await seed(oldSessionKey, "session-old", now - 3 * DAY_MS);
      await seed(activeSessionKey, "session-active", now);

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

      expect(getSessionEntry({ sessionKey: modelRunSessionKey, storePath }) != null).toBe(
        modelRunSessionPresent,
      );
    },
  );
});
