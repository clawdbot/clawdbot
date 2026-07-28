import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveSqliteReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function replaceSessionEntryFromIndependentConnection(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): void {
  const database = openOpenClawAgentDatabase(
    resolveSqliteReadScope({ storePath: params.storePath, sessionKey: params.sessionKey }),
  );
  const external = new DatabaseSync(database.path);
  try {
    external
      .prepare("UPDATE session_nodes SET entry_json = ?, updated_at = ? WHERE session_key = ?")
      .run(JSON.stringify(params.entry), params.entry.updatedAt, params.sessionKey);
  } finally {
    external.close();
  }
}

describe("createReplyRestartRecoveryClaimController", () => {
  it("retargets durable user-turn admission to the prepared reply session", async () => {
    const root = tempDirs.make("openclaw-reply-admission-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "plugin-binding:codex:target";
    const sessionId = "bound-session-id";
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);

    let persistedTarget: UserTurnTranscriptTarget | undefined;
    const persistApproved = vi.fn<UserTurnTranscriptRecorder["persistApproved"]>(async (params) => {
      persistedTarget =
        typeof params?.target === "function" ? await params.target() : params?.target;
      return {
        appended: true,
        message: { role: "user", content: "hello", timestamp: Date.now() },
        messageId: "user-turn-1",
        sessionEntry: entry,
        sessionFile: "sqlite:bound-session-id",
      };
    });
    const recorder = {
      message: undefined,
      resolveMessage: async () => undefined,
      markRuntimePersistencePending: () => {},
      markRuntimePersisted: () => {},
      markBlocked: () => {},
      hasPersisted: () => false,
      isBlocked: () => false,
      hasRuntimePersistencePending: () => false,
      waitForRuntimePersistence: async () => {},
      persistApproved,
      persistBlocked: async () => undefined,
      persistFallback: async () => undefined,
    } satisfies UserTurnTranscriptRecorder;
    const controller = createReplyRestartRecoveryClaimController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      resolveUserTurnTarget: (target) => ({
        ...target,
        sessionEntry: target.entry,
        agentId: "main",
      }),
      sessionKey,
      setEntry: () => {},
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    expect(persistApproved).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionId: sessionId }),
    );
    expect(persistedTarget).toMatchObject({
      sessionId,
      sessionKey,
      storePath,
      agentId: "main",
    });
  });

  it("confirms a cross-process restart claim after SQLite lease loss", async () => {
    const root = tempDirs.make("openclaw-reply-restart-handoff-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "session";
    let memoryEntry: SessionEntry = {
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "old-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      sessionId,
      status: "running" as const,
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ storePath, sessionKey }, memoryEntry);
    const controller = createReplyRestartRecoveryClaimController({
      admissionRunId: "old-run",
      getEntry: () => memoryEntry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: (entry) => {
        memoryEntry = entry;
      },
      storePath,
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    expect(memoryEntry.abortedLastRun).toBe(false);

    replaceSessionEntryFromIndependentConnection({
      entry: {
        ...memoryEntry,
        abortedLastRun: true,
        status: "killed" as const,
        updatedAt: Date.now() + 1,
      },
      sessionKey,
      storePath,
    });

    expect(memoryEntry.abortedLastRun).toBe(false);
    await expect(controller.confirmRestartRecoveryArmedAfterLeaseLoss()).resolves.toBe(true);
    expect(memoryEntry).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "old-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      status: "killed",
    });

    await controller.clear();
    expect(loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })).toMatchObject({
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "old-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      status: "killed",
    });
    expect(
      loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" })
        ?.restartRecoveryTerminalRunIds,
    ).toBeUndefined();
  });

  it("confirms a completed replacement handoff by its terminal source marker", async () => {
    const root = tempDirs.make("openclaw-reply-completed-handoff-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "session";
    let memoryEntry: SessionEntry = {
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "old-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      sessionId,
      status: "running",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ storePath, sessionKey }, memoryEntry);
    const controller = createReplyRestartRecoveryClaimController({
      admissionRunId: "old-run",
      getEntry: () => memoryEntry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: (entry) => {
        memoryEntry = entry;
      },
      storePath,
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");

    replaceSessionEntryFromIndependentConnection({
      entry: {
        ...memoryEntry,
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: undefined,
        restartRecoveryDeliverySourceRunId: undefined,
        restartRecoveryTerminalRunIds: ["source-run"],
        status: "done",
        updatedAt: Date.now() + 1,
      },
      sessionKey,
      storePath,
    });

    expect(memoryEntry.restartRecoveryTerminalRunIds).toBeUndefined();
    await expect(controller.confirmRestartRecoveryArmedAfterLeaseLoss()).resolves.toBe(true);
    expect(memoryEntry).toMatchObject({
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["source-run"],
      status: "done",
    });
    expect(memoryEntry.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(memoryEntry.restartRecoveryDeliverySourceRunId).toBeUndefined();

    await controller.clear();
    const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    expect(persisted?.restartRecoveryTerminalRunIds).toEqual(["source-run"]);
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
  });
});
