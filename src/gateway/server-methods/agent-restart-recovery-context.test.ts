import { describe, expect, it } from "vitest";
import { resolveAgentRestartRecoveryChannelContext } from "./agent-restart-recovery-context.js";

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
