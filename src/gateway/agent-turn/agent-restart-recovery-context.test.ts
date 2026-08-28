import { describe, expect, it } from "vitest";
import {
  resolveAgentRestartRecoveryChannelContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";

const matchingParams = {
  canUseInternalRuntimeHandoff: true,
  expectedExistingSessionId: "session-1",
  resolvedSessionId: "session-1",
  runId: "recovery-run-1",
  sessionEntry: {
    sessionId: "session-1",
    updatedAt: 1,
    restartRecoveryDeliveryRunId: "recovery-run-1",
    restartRecoveryDeliverySourceRunId: "channel-user:v1:source-1",
    restartRecoveryDeliveryContext: {
      channel: "discord",
      to: "discord:dm:123",
      accountId: "work",
      threadId: "thread-1",
    },
    restartRecoveryRequesterAccountId: "work",
    restartRecoveryRequesterSenderId: "user-1",
    restartRecoverySameChannelThreadRequired: true,
    restartRecoverySourceIngress: "channel",
  },
} as const;

describe("resolveAgentRestartRecoveryChannelContext", () => {
  it("rehydrates the exact backend-owned recovery claim", () => {
    expect(resolveAgentRestartRecoveryChannelContext(matchingParams)).toEqual({
      channel: "discord",
      currentChannelId: "discord:dm:123",
      currentThreadTs: "thread-1",
      sourceTurnId: "channel-user:v1:source-1",
      requesterAccountId: "work",
      requesterSenderId: "user-1",
      sameChannelThreadRequired: true,
    });
  });

  it("does not promote a generic chat claim with channel delivery metadata", () => {
    expect(
      resolveAgentRestartRecoveryChannelContext({
        ...matchingParams,
        sessionEntry: {
          ...matchingParams.sessionEntry,
          restartRecoveryDeliveryContext: {
            channel: "discord",
            to: "discord:dm:123",
          },
          restartRecoverySourceIngress: undefined,
        },
      }),
    ).toBeUndefined();
  });

  it.each([
    { canUseInternalRuntimeHandoff: false },
    { expectedExistingSessionId: "session-2" },
    { resolvedSessionId: "session-2" },
    { runId: "recovery-run-2" },
    { sessionEntry: { ...matchingParams.sessionEntry, sessionId: "session-2" } },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoveryDeliveryContext: undefined,
      },
    },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoverySourceIngress: undefined,
      },
    },
    {
      sessionEntry: {
        ...matchingParams.sessionEntry,
        restartRecoveryDeliverySourceRunId: undefined,
      },
    },
  ])("rejects a non-matching or uncorrelated claim", (override) => {
    expect(
      resolveAgentRestartRecoveryChannelContext({ ...matchingParams, ...override }),
    ).toBeUndefined();
  });
});

describe("resolveAgentRestartRecoveryExecutionIdentityAdmission", () => {
  const token = {
    tokenVersion: 1 as const,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "recovery-run-1",
    createdAt: 1,
  };

  it("rehydrates the durable token across rotated operational recovery runs", () => {
    const sessionEntry = {
      ...matchingParams.sessionEntry,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        executionIdentity: token,
      },
    };
    const first = resolveAgentRestartRecoveryExecutionIdentityAdmission({
      collectionEnabled: true,
      isRestartRecoveryResumeRun: true,
      retryOnly: false,
      runId: "recovery-run-2",
      sessionEntry,
    });
    const retry = resolveAgentRestartRecoveryExecutionIdentityAdmission({
      collectionEnabled: true,
      isRestartRecoveryResumeRun: true,
      retryOnly: true,
      runId: "recovery-run-3",
      sessionEntry,
    });
    expect(first).toMatchObject({ retryOnly: false, consume: expect.any(Function) });
    expect(retry).toMatchObject({ retryOnly: true, consume: expect.any(Function) });
    expect(first?.consume("recovery-run-2")).toEqual({ accepted: true, token });
    expect(retry?.consume("recovery-run-3")).toEqual({ accepted: true, token });
  });

  it("returns no token for ordinary runs and refuses lost recovery evidence", () => {
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: false,
        retryOnly: false,
        runId: token.runId,
        sessionEntry: matchingParams.sessionEntry,
      }),
    ).toBeUndefined();
    const missing = resolveAgentRestartRecoveryExecutionIdentityAdmission({
      collectionEnabled: true,
      isRestartRecoveryResumeRun: true,
      retryOnly: true,
      runId: token.runId,
      sessionEntry: matchingParams.sessionEntry,
    });
    expect(missing?.consume(token.runId)).toEqual({ accepted: true });
  });

  it("omits retained recovery identity while collection is disabled", () => {
    const sessionEntry = {
      ...matchingParams.sessionEntry,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        executionIdentity: token,
      },
    };
    expect(
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: false,
        isRestartRecoveryResumeRun: true,
        retryOnly: true,
        runId: token.runId,
        sessionEntry,
      }),
    ).toBeUndefined();
  });

  it("refuses an enabled recovery without an explicit capture or retry mode", () => {
    expect(() =>
      resolveAgentRestartRecoveryExecutionIdentityAdmission({
        collectionEnabled: true,
        isRestartRecoveryResumeRun: true,
        runId: token.runId,
        sessionEntry: matchingParams.sessionEntry,
      }),
    ).toThrow("admission mode is unavailable");
  });
});
