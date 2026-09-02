import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { transitionMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-state.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import {
  loadSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { isAgentRunStaleLifecycleError } from "../../infra/agent-lifecycle-error.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
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
        restartRecoveryDeliveryRunId: "recovery-run",
        sessionId,
        startedAt: 1,
        status: "running",
        updatedAt: 1,
      };
      await replaceSessionEntry({ storePath, sessionKey }, entry);
      const controller = createReplyRestartRecoveryClaimController({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
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

  it("preserves lifecycle ownership when cleanup observes a restart abort", async () => {
    const root = tempDirs.make("openclaw-reply-claim-restart-abort-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "session";
    let restartAborted = false;
    let entry: InternalSessionEntry = {
      abortedLastRun: false,
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryRunId: "recovery-run",
      sessionId,
      startedAt: 1,
      status: "running",
      updatedAt: 1,
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const controller = createReplyRestartRecoveryClaimController({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      admissionRunId: "recovery-run",
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => restartAborted,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      storePath,
    });

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    restartAborted = true;
    await controller.clear();

    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryRunId: "recovery-run",
      status: "running",
    });
  });

  it.each([
    "restart-handoff",
    "restart-abort",
    "successor-generation",
    "missing-generation",
    "commit-rotation",
    "commit-abort",
  ] as const)(
    "preserves the delivery claim when queued cleanup loses ownership through %s",
    async (interruption) => {
      const root = tempDirs.make("openclaw-reply-claim-queued-cleanup-");
      const scope = { storePath: path.join(root, "sessions.json"), sessionKey: "agent:main:main" };
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const deliveryContext = { channel: "telegram", to: "chat", accountId: "default" };
      let restartAborted = false;
      let interruptBeforeCommit = false;
      let entry: InternalSessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        status: "running",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoverySourceIngress: "channel",
      };
      await replaceSessionEntry(scope, entry);
      const controller = createReplyRestartRecoveryClaimController({
        lifecycleGeneration:
          interruption === "missing-generation" ? undefined : lifecycleGeneration,
        admissionRunId: "recovery-run",
        getEntry: () => entry,
        getSessionId: () => {
          if (interruptBeforeCommit) {
            interruptBeforeCommit = false;
            // The store awaits the prepared patch before entering its write transaction.
            queueMicrotask(() => {
              if (interruption === "commit-rotation") {
                rotateAgentEventLifecycleGeneration();
              } else {
                restartAborted = true;
              }
            });
          }
          return "session";
        },
        isRestartAbort: () => restartAborted,
        resolveDeliveryContext: () => deliveryContext,
        setEntry: (next) => {
          entry = next;
        },
        ...scope,
      });
      await expect(controller.admitUserTurn()).resolves.toBe("admitted");

      const writerEntered = createDeferred();
      const releaseWriter = createDeferred();
      let successorGeneration: string | undefined;
      const handoff = updateSessionEntry(scope, async (current) => {
        writerEntered.resolve();
        await releaseWriter.promise;
        if (interruption === "restart-handoff" || interruption === "successor-generation") {
          transitionMainSessionRecovery(current, {
            kind: "mark_interrupted",
            cycleId: "restart-cycle",
            now: 2,
            runs: [{ runId: "original-run", lifecycleGeneration }],
          });
          if (successorGeneration) {
            const recovery = current.mainRestartRecovery!;
            transitionMainSessionRecovery(current, {
              kind: "prepare_attempt",
              attempt: 1,
              lifecycleGeneration: successorGeneration,
              now: 3,
              observation: {
                sessionId: current.sessionId,
                cycleId: recovery.cycleId,
                revision: recovery.revision,
              },
              runId: "recovery-run",
              executionIdentity: { state: "disabled" },
            });
            transitionMainSessionRecovery(current, {
              kind: "admit_recovery",
              lifecycleGeneration: successorGeneration,
              now: 4,
              runId: "recovery-run",
              sessionId: current.sessionId,
            });
          }
        }
        return current;
      });
      await writerEntered.promise;
      interruptBeforeCommit = interruption === "commit-rotation" || interruption === "commit-abort";
      // The old cleanup enters before shutdown; its actual write waits behind the handoff.
      const clearing = controller.clear().catch((error: unknown) => {
        expect(isAgentRunStaleLifecycleError(error)).toBe(true);
      });
      try {
        if (interruption === "restart-abort") {
          restartAborted = true;
        } else if (interruption === "successor-generation") {
          successorGeneration = rotateAgentEventLifecycleGeneration();
        }
      } finally {
        releaseWriter.resolve();
      }
      await Promise.all([handoff, clearing]);

      const persisted = loadSessionEntry(scope);
      expect(persisted).toMatchObject({
        status: "running",
        abortedLastRun: interruption === "restart-handoff",
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: "source-turn",
        restartRecoveryDeliveryContext: deliveryContext,
        restartRecoverySourceIngress: "channel",
      });
      expect(persisted?.restartRecoveryTerminalRunIds).toBeUndefined();
      if (successorGeneration) {
        expect(persisted?.restartRecoveryRuns).toContainEqual({
          runId: "recovery-run",
          lifecycleGeneration: successorGeneration,
        });
      }
    },
  );

  it("retires the source claim after an ordinary user abort", async () => {
    const root = tempDirs.make("openclaw-reply-claim-user-abort-");
    const scope = { storePath: path.join(root, "sessions.json"), sessionKey: "agent:main:main" };
    let entry: InternalSessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      status: "running",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryContext: { channel: "telegram", to: "chat" },
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry(scope, entry);
    const controller = createReplyRestartRecoveryClaimController({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      admissionRunId: "recovery-run",
      getEntry: () => entry,
      getSessionId: () => "session",
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      setEntry: (next) => {
        entry = next;
      },
      ...scope,
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    await markSessionAbortTarget({ scope });
    await controller.clear();

    const persisted = loadSessionEntry(scope);
    expect(persisted?.abortedLastRun).toBe(true);
    expect(persisted?.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(persisted?.restartRecoveryDeliveryContext).toBeUndefined();
    expect(persisted?.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(persisted?.restartRecoveryTerminalRunIds).toContain("source-turn");
  });

  it("adopts an exact channel recovery claim before execution starts", async () => {
    const root = tempDirs.make("openclaw-reply-channel-claim-adoption-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:group:chat:topic:thread";
    const sessionId = "channel-session";
    const deliveryContext = {
      channel: "telegram",
      to: "chat",
      accountId: "default",
      threadId: "thread",
    };
    let entry: InternalSessionEntry = {
      abortedLastRun: false,
      lifecycleRunId: "recovery-run",
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryToolCallId: "message-call",
      sessionId,
      startedAt: 1,
      status: "running",
      updatedAt: 1,
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const controller = createReplyRestartRecoveryClaimController({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      admissionRunId: "recovery-run",
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => deliveryContext,
      sessionKey,
      setEntry: (next) => {
        entry = next;
      },
      sourceTurnId: "source-turn",
      storePath,
    });

    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryReceiptState: "terminal-pending",
      restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryToolCallId: "message-call",
      status: "running",
    });
  });

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
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
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
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
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
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
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

  it("rejects durable admission when the captured recovery owner releases", async () => {
    const root = tempDirs.make("openclaw-reply-admission-owner-release-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:group:chat:topic:owner-release";
    const sessionId = "channel-session-id";
    const sourceTurnId = "telegram-update-new";
    const deliveryContext = {
      channel: "telegram",
      to: "chat",
      accountId: "default",
      threadId: "thread",
    };
    let entry: InternalSessionEntry = {
      sessionId,
      updatedAt: 10,
      abortedLastRun: true,
      status: "running",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
      },
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const owner = await claimMainSessionRecoveryOwner({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionId,
      target: { sessionKey, storePath },
    });
    expect(owner.kind).toBe("claimed");
    if (owner.kind !== "claimed") {
      return;
    }
    entry = (await updateSessionEntry({ storePath, sessionKey }, () => ({
      abortedLastRun: false,
      restartRecoveryDeliveryContext: deliveryContext,
      restartRecoveryDeliveryRunId: "orphaned-run",
      restartRecoveryDeliverySourceRunId: "telegram-update-old",
      status: "done",
    }))) as InternalSessionEntry;
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
    const delegate = createUserTurnTranscriptRecorder({
      message: sourceMessage,
      target: {
        agentId: "main",
        sessionEntry: entry,
        sessionId,
        sessionKey,
        storePath,
      },
      updateMode: "none",
    });
    const recorder = {
      ...delegate,
      getAdmissionReceipt: () => admission,
      persistApproved: async (
        options?: Parameters<UserTurnTranscriptRecorder["persistApproved"]>[0],
      ) => {
        await releaseMainSessionRecoveryOwner(owner.lease);
        return await delegate.persistApproved(options);
      },
    } satisfies UserTurnTranscriptRecorder;
    const controller = createReplyRestartRecoveryClaimController({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
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
    const persisted = loadSessionEntry({ storePath, sessionKey });
    expect(persisted).not.toHaveProperty("mainRestartRecovery");
    expect(persisted).toMatchObject({
      restartRecoveryDeliveryRunId: "orphaned-run",
      restartRecoveryDeliverySourceRunId: "telegram-update-old",
      status: "done",
    });
  });
});
