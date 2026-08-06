import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry as loadInternalSessionEntry } from "../config/sessions/session-accessor.js";
import {
  patchSessionEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session-store-runtime recovery boundary", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-sdk-session-recovery-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("allows public recovery fields to change without an active core transaction", async () => {
    const sessionKey = "agent:main:healthy-public-recovery";
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath,
      entry: {
        sessionId: "healthy-session",
        updatedAt: 10,
      },
    });

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({
        abortedLastRun: true,
        restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      }),
    });

    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryRuns: [{ lifecycleGeneration: "generation-1", runId: "run-1" }],
      sessionId: "healthy-session",
    });
  });

  it("rejects core recovery state from runtime-escaped creation inputs", async () => {
    const mainRestartRecovery = {
      chargedAttempts: 1,
      cycleId: "cycle-injected",
      revision: 1,
    };
    const patchSessionKey = "agent:main:patch-created";
    await patchSessionEntry({
      fallbackEntry: {
        mainRestartRecovery,
        sessionId: "patch-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: patchSessionKey,
      storePath,
      update: () => ({ updatedAt: 20 }),
    });
    expect(loadInternalSessionEntry({ sessionKey: patchSessionKey, storePath })).not.toHaveProperty(
      "mainRestartRecovery",
    );

    const upsertSessionKey = "agent:main:upsert-created";
    await upsertSessionEntry({
      entry: {
        mainRestartRecovery,
        sessionId: "upsert-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: upsertSessionKey,
      storePath,
    });
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("mainRestartRecovery");
  });
});
