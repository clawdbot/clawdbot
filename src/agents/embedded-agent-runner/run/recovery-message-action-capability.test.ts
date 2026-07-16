import { describe, expect, it } from "vitest";
import {
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../../auto-reply/reply/source-turn-id.js";
import {
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../../gateway/message-action-turn-capability.js";
import { createRecoveryMessageActionTurnCapability } from "./recovery-message-action-capability.js";

function createParams() {
  return {
    agentId: "main",
    agentAccountId: "work",
    currentChannelId: "chat-1",
    messageProvider: "telegram",
    messageTo: "chat-1",
    runId: "recovery-run-1",
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:direct:chat-1",
    senderId: "user-1",
    timeoutMs: 60_000,
  };
}

describe("createRecoveryMessageActionTurnCapability", () => {
  it("mints exact source correlation for a reconstructed channel run", () => {
    const params = createParams();
    setChannelSourceTurnId(params, "channel-user:v1:source-1");
    setChannelSourceTurnSameThreadRequired(params, true);
    const token = createRecoveryMessageActionTurnCapability(params);
    expect(token).toEqual(expect.any(String));
    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "recovery-run-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({
      requesterAccountId: "work",
      requesterSenderId: "user-1",
      toolContext: {
        currentChannelId: "chat-1",
        currentChannelProvider: "telegram",
        currentSourceTurnId: "channel-user:v1:source-1",
        sameChannelThreadRequired: true,
      },
    });
    revokeMessageActionTurnCapability(token);
  });

  it("does not mint without durable source correlation", () => {
    expect(createRecoveryMessageActionTurnCapability(createParams())).toBeUndefined();
  });

  it("keeps an unlimited recovered run authorized until run cleanup", () => {
    const params = { ...createParams(), timeoutMs: 0 };
    setChannelSourceTurnId(params, "channel-user:v1:source-1");
    const token = createRecoveryMessageActionTurnCapability(params);
    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "recovery-run-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ expiresAtMs: Number.MAX_SAFE_INTEGER });
    revokeMessageActionTurnCapability(token);
  });
});
