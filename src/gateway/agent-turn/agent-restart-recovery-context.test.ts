import { describe, expect, it } from "vitest";
import {
  resolveAgentRestartRecoveryContext,
  resolveAgentRestartRecoveryExecutionIdentityAdmission,
} from "./agent-restart-recovery-context.js";

const matchingParams = {
  isRestartRecoveryResumeRun: true,
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

const matchingUiParams = {
  ...matchingParams,
  sessionEntry: { ...matchingParams.sessionEntry, restartRecoverySourceIngress: "control-ui" },
} as const;

describe("resolveAgentRestartRecoveryContext", () => {
  it.each([matchingParams, matchingUiParams])("rejects mismatched recovery ownership", (params) => {
    for (const override of [
      { canUseInternalRuntimeHandoff: false },
      { expectedExistingSessionId: undefined },
      { expectedExistingSessionId: "replacement-session" },
      { resolvedSessionId: "replacement-session" },
      { runId: "replacement-run" },
      { sessionEntry: undefined },
      { sessionEntry: { ...params.sessionEntry, sessionId: "replacement-session" } },
      { sessionEntry: { ...params.sessionEntry, restartRecoveryDeliverySourceRunId: " " } },
      { sessionEntry: { ...params.sessionEntry, restartRecoverySourceIngress: undefined } },
      {
        sessionEntry: { ...params.sessionEntry, restartRecoverySourceIngress: "internal" as const },
      },
    ]) {
      expect(resolveAgentRestartRecoveryContext({ ...params, ...override })).toBeUndefined();
    }
  });

  it("restores only pinned authoring for an admitted Control UI recovery", () => {
    expect(resolveAgentRestartRecoveryContext(matchingUiParams)).toEqual({
      pinnedWidgetAuthoring: true,
    });
    expect(
      resolveAgentRestartRecoveryContext({
        ...matchingUiParams,
        isRestartRecoveryResumeRun: false,
      }),
    ).toBeUndefined();
  });

  it.each([true, false])(
    "restores correlated channel delivery facts (resume=%s)",
    (isRestartRecoveryResumeRun) => {
      expect(
        resolveAgentRestartRecoveryContext({ ...matchingParams, isRestartRecoveryResumeRun }),
      ).toEqual({
        channel: {
          channel: "discord",
          currentChannelId: "discord:dm:123",
          currentThreadTs: "thread-1",
          sourceTurnId: "channel-user:v1:source-1",
          requesterAccountId: "work",
          requesterSenderId: "user-1",
          sameChannelThreadRequired: true,
        },
      });
      expect(
        resolveAgentRestartRecoveryContext({
          ...matchingParams,
          sessionEntry: {
            ...matchingParams.sessionEntry,
            restartRecoveryDeliveryContext: undefined,
          },
        }),
      ).toBeUndefined();
    },
  );
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
