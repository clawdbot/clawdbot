import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
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

  it("adopts a channel claim orphaned by a restart instead of rejecting it forever", async () => {
    const root = tempDirs.make("openclaw-restart-orphan-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:telegram:direct:42";
    const sessionId = "orphaned-session-id";
    // Shape a gateway restart leaves behind: the run died with the old process,
    // so status stays "running" and the delivery claim still names the dead run.
    const entry = {
      sessionId,
      updatedAt: Date.now(),
      status: "running" as const,
      restartRecoveryDeliveryRunId: "run-that-died-with-the-process",
      restartRecoveryDeliveryContext: {
        channel: "telegram",
        to: "telegram:42",
        accountId: "main",
      },
      restartRecoverySourceIngress: "channel" as const,
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);

    const controller = createReplyRestartRecoveryClaimController({
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      sessionKey,
      setEntry: () => {},
      storePath,
    });

    // No reply run is registered for this session id, so the claim is orphaned:
    // admission must retire it and proceed rather than throw on every later turn.
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
  });
});
