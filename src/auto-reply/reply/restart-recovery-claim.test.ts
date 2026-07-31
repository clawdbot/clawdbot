import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    const recorder = {
      message: undefined,
      getPersistedMessage: () => sourceMessage,
      resolveMessage: async () => sourceMessage,
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
});
