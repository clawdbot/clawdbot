import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createTestAdmission(params: {
  entryId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  return {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    generation: "test-generation",
    entryId: params.entryId,
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: `${params.entryId}:turn`,
    role: "user" as const,
  };
}

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
  it.each([
    { receiptState: undefined, expectedStatus: "done" },
    { receiptState: "terminal-pending" as const, expectedStatus: "failed" },
  ])(
    "clears lifecycle ownership when claim cleanup settles $expectedStatus",
    async ({ receiptState, expectedStatus }) => {
      const root = tempDirs.make(`openclaw-reply-claim-${expectedStatus}-`);
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:main";
      const sessionId = "session";
      let entry: InternalSessionEntry = {
        abortedLastRun: false,
        lifecycleRunId: "recovery-run",
        restartRecoveryBeforeAgentReplyState: "admitted",
        restartRecoveryDeliveryRunId: "recovery-run",
        sessionId,
        startedAt: 1,
        status: "running",
        updatedAt: 1,
      };
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      const controller = createReplyRestartRecoveryClaimController({
        admissionRunId: "recovery-run",
        getEntry: () => entry,
        getSessionId: () => sessionId,
        isRestartAbort: () => false,
        resolveDeliveryContext: () => undefined,
        sessionKey,
        setEntry: (next) => {
          entry = next;
        },
        storePath,
      });

      await expect(controller.admitUserTurn()).resolves.toBe("admitted");
      if (receiptState) {
        entry = (await updateSessionEntry({ storePath, sessionKey }, () => ({
          restartRecoveryDeliveryReceiptState: receiptState,
        }))) as InternalSessionEntry;
      } else {
        await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
        await controller.checkpointBeforeAgentReply({ state: "handled-silent" });
      }
      await controller.clear();

      const persisted = loadSessionEntry({ storePath, sessionKey }) as InternalSessionEntry;
      expect(persisted.status).toBe(expectedStatus);
      expect(persisted.lifecycleRunId).toBeUndefined();
    },
  );

  it("retargets durable user-turn admission to the prepared reply session", async () => {
    const root = tempDirs.make("openclaw-reply-admission-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "plugin-binding:codex:target";
    const sessionId = "bound-session-id";
    const entry = { sessionId, updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);

    let persistedTarget: UserTurnTranscriptTarget | undefined;
    const admission = createTestAdmission({
      entryId: "user-turn-1",
      sessionId,
      sessionKey,
      storePath,
    });
    const persistApproved = vi.fn<UserTurnTranscriptRecorder["persistApproved"]>(async (params) => {
      persistedTarget =
        typeof params?.target === "function" ? await params.target() : params?.target;
      return {
        admission,
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
      getAdmissionReceipt: () => admission,
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

  it("keeps claim adoption valid across unrelated same-session metadata writes", async () => {
    const root = tempDirs.make("openclaw-reply-admission-metadata-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:group:chat:topic:thread";
    const sessionId = "channel-session-id";
    const sourceTurnId = "telegram-update-new";
    const deliveryContext = {
      channel: "telegram",
      to: "chat",
      accountId: "default",
      threadId: "thread",
    };
    let entry: SessionEntry = {
      sessionId,
      updatedAt: 10,
      abortedLastRun: false,
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryRunId: "orphaned-run",
      restartRecoveryDeliverySourceRunId: "telegram-update-old",
      status: "done",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const admission = createTestAdmission({
      entryId: sourceTurnId,
      sessionId,
      sessionKey,
      storePath,
    });
    const persistApproved = vi.fn<UserTurnTranscriptRecorder["persistApproved"]>();
    const recorder = {
      message: undefined,
      getPersistedMessage: () => undefined,
      resolveMessage: async () => {
        await updateSessionEntry({ storePath, sessionKey }, (current) => ({
          model: "gpt-5.6-luna",
          updatedAt: current.updatedAt + 1,
        }));
        return {
          role: "user" as const,
          content: "continue",
          idempotencyKey: sourceTurnId,
          timestamp: Date.now(),
        };
      },
      getAdmissionReceipt: () => admission,
      markRuntimePersistencePending: () => {},
      markRuntimePersisted: () => {},
      markBlocked: () => {},
      hasPersisted: () => true,
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
      resolveDeliveryContext: () => deliveryContext,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      sourceTurnId,
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
    expect(persistApproved).not.toHaveBeenCalled();
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      model: "gpt-5.6-luna",
      restartRecoveryDeliverySourceRunId: sourceTurnId,
      status: "running",
    });
  });

  it("rejects claim adoption when a recovery cycle starts after the snapshot", async () => {
    const root = tempDirs.make("openclaw-reply-admission-cycle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:group:chat:topic:thread";
    const sessionId = "channel-session-id";
    const sourceTurnId = "telegram-update-new";
    const deliveryContext = {
      channel: "telegram",
      to: "chat",
      accountId: "default",
      threadId: "thread",
    };
    let entry: SessionEntry = {
      sessionId,
      updatedAt: 10,
      abortedLastRun: false,
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryRunId: "orphaned-run",
      restartRecoveryDeliverySourceRunId: "telegram-update-old",
      status: "done",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const sourceMessage = {
      role: "user" as const,
      content: "continue",
      idempotencyKey: sourceTurnId,
      timestamp: Date.now(),
    };
    const admission = createTestAdmission({
      entryId: sourceTurnId,
      sessionId,
      sessionKey,
      storePath,
    });
    const recorder = {
      message: undefined,
      getPersistedMessage: () => sourceMessage,
      resolveMessage: async () => sourceMessage,
      getAdmissionReceipt: () => admission,
      markRuntimePersistencePending: () => {},
      markRuntimePersisted: () => {},
      markBlocked: () => {},
      hasPersisted: () => false,
      isBlocked: () => false,
      hasRuntimePersistencePending: () => false,
      waitForRuntimePersistence: async () => {},
      persistApproved: async (
        options?: Parameters<UserTurnTranscriptRecorder["persistApproved"]>[0],
      ) => {
        const recoveryPatch: Partial<InternalSessionEntry> = {
          mainRestartRecovery: {
            cycleId: "cycle-new",
            revision: 1,
            chargedAttempts: 0,
          },
        };
        await updateSessionEntry({ storePath, sessionKey }, () => recoveryPatch);
        return await createUserTurnTranscriptRecorder({
          message: sourceMessage,
          target: {
            agentId: "main",
            sessionEntry: entry,
            sessionId,
            sessionKey,
            storePath,
          },
          updateMode: "none",
        }).persistApproved(options);
      },
      persistBlocked: async () => undefined,
      persistFallback: async () => undefined,
    } satisfies UserTurnTranscriptRecorder;
    const controller = createReplyRestartRecoveryClaimController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => deliveryContext,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      sourceTurnId,
      storePath,
    });

    await expect(controller.admitUserTurn(recorder)).rejects.toThrow(
      "session changed before durable user-turn admission",
    );
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      mainRestartRecovery: {
        cycleId: "cycle-new",
        revision: 1,
      },
      restartRecoveryDeliveryRunId: "orphaned-run",
      restartRecoveryDeliverySourceRunId: "telegram-update-old",
      status: "done",
    });
  });

  it("confirms an active replacement claim after SQLite lease loss", async () => {
    const root = tempDirs.make("openclaw-reply-restart-handoff-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "session";
    let entry: SessionEntry = {
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "old-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      sessionId,
      status: "running",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const controller = createReplyRestartRecoveryClaimController({
      admissionRunId: "old-run",
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      storePath,
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");

    replaceSessionEntryFromIndependentConnection({
      entry: {
        ...entry,
        abortedLastRun: true,
        status: "killed",
        updatedAt: Date.now() + 1,
      },
      sessionKey,
      storePath,
    });

    expect(entry.abortedLastRun).toBe(false);
    await expect(controller.confirmRestartRecoveryArmedAfterLeaseLoss()).resolves.toBe(true);
    expect(entry).toMatchObject({
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
  });

  it("confirms a completed replacement handoff by its terminal source marker", async () => {
    const root = tempDirs.make("openclaw-reply-completed-handoff-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "session";
    let entry: SessionEntry = {
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "old-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      sessionId,
      status: "running",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const controller = createReplyRestartRecoveryClaimController({
      admissionRunId: "old-run",
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      storePath,
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");

    replaceSessionEntryFromIndependentConnection({
      entry: {
        ...entry,
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

    expect(entry.restartRecoveryTerminalRunIds).toBeUndefined();
    await expect(controller.confirmRestartRecoveryArmedAfterLeaseLoss()).resolves.toBe(true);
    expect(entry).toMatchObject({
      abortedLastRun: false,
      restartRecoveryTerminalRunIds: ["source-run"],
      status: "done",
    });
    expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(entry.restartRecoveryDeliverySourceRunId).toBeUndefined();

    await controller.clear();
    const persisted = loadSessionEntry({ storePath, sessionKey, readConsistency: "latest" });
    expect(persisted?.restartRecoveryTerminalRunIds).toEqual(["source-run"]);
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
  });
});
