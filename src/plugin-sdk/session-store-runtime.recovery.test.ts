import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadSessionEntry as loadInternalSessionEntry,
  replaceSessionEntry as replaceInternalSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry as ConfigSessionEntry } from "../config/sessions/types.js";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
  updateSessionStoreEntry,
  upsertSessionEntry,
  type SessionEntry,
} from "./session-store-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const publicPendingProjectIsPrivate: "pendingProjectGitUrl" extends keyof SessionEntry
  ? false
  : true = true;
const configPendingProjectIsPrivate: "pendingProjectGitUrl" extends keyof ConfigSessionEntry
  ? false
  : true = true;
void publicPendingProjectIsPrivate;
void configPendingProjectIsPrivate;

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

  it("keeps pending remote-project recovery private across public session mutations", async () => {
    const sessionKey = "agent:main:pending-project";
    const pendingProjectGitUrl = "https://github.com/openclaw/openclaw.git";
    await replaceInternalSessionEntry(
      { sessionKey, storePath },
      { pendingProjectGitUrl, sessionId: "project-session", updatedAt: 10 },
    );

    expect(getSessionEntry({ sessionKey, storePath })).not.toHaveProperty("pendingProjectGitUrl");
    expect(listSessionEntries({ storePath })[0]?.entry).not.toHaveProperty("pendingProjectGitUrl");

    await patchSessionEntry({
      sessionKey,
      storePath,
      update: () => ({ model: "gpt-5.5" }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.5",
      pendingProjectGitUrl,
    });

    await updateSessionStoreEntry({
      sessionKey,
      storePath,
      update: () => ({ model: "gpt-5.6" }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).toMatchObject({
      model: "gpt-5.6",
      pendingProjectGitUrl,
    });

    await upsertSessionEntry({
      entry: { sessionId: "project-session", updatedAt: 20 },
      sessionKey,
      storePath,
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })?.pendingProjectGitUrl).toBe(
      pendingProjectGitUrl,
    );

    await patchSessionEntry({
      replaceEntry: true,
      sessionKey,
      storePath,
      update: () => ({ sessionId: "replacement-session", updatedAt: 30 }),
    });
    expect(loadInternalSessionEntry({ sessionKey, storePath })).not.toHaveProperty(
      "pendingProjectGitUrl",
    );
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
        pendingProjectGitUrl: "https://github.com/openclaw/injected.git",
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
    expect(loadInternalSessionEntry({ sessionKey: patchSessionKey, storePath })).not.toHaveProperty(
      "pendingProjectGitUrl",
    );

    const upsertSessionKey = "agent:main:upsert-created";
    await upsertSessionEntry({
      entry: {
        mainRestartRecovery,
        pendingProjectGitUrl: "https://github.com/openclaw/injected.git",
        sessionId: "upsert-created",
        updatedAt: 10,
      } as unknown as SessionEntry,
      sessionKey: upsertSessionKey,
      storePath,
    });
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("mainRestartRecovery");
    expect(
      loadInternalSessionEntry({ sessionKey: upsertSessionKey, storePath }),
    ).not.toHaveProperty("pendingProjectGitUrl");
  });
});
