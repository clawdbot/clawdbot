import { assert, describe, expect, it } from "vitest";
import {
  createSessionProjection,
  hasSessionProjectionAcceptedFinal,
  readSessionMessageIdentity,
  reduceSessionProjection,
  reduceSessionProjectionRunEvent,
} from "../../packages/gateway-client/src/session-projection.js";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

const runId = "fallback-run";
const scope = { sessionKey: "agent:main:fallback-reconciliation" };
const user = {
  role: "user",
  content: [{ type: "text", text: "Reply with exactly: RECOVERY_OK" }],
  __openclaw: { id: "user", seq: 1, idempotencyKey: `${runId}:user` },
};
const failed = {
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "The selected model is not supported by this account.",
  __openclaw: { id: "failed-attempt", seq: 2, runId },
};
const answer = {
  role: "assistant",
  content: [{ type: "text", text: "RECOVERY_OK" }],
  stopReason: "stop",
  __openclaw: { id: "successful-attempt", seq: 3, runId },
};

describe("recovered fallback history reconciliation", () => {
  it("adopts the live answer once after a failed attempt and accepts the later status final", () => {
    const rawHistory = structuredClone([user, failed, answer]);
    const history = projectChatDisplayMessages(rawHistory);
    let projection = createSessionProjection(scope, history);
    const liveAnswer = { role: "assistant", content: answer.content };
    const fallbackNotice = {
      role: "assistant",
      content: [{ type: "text", text: "Model fallback: the backup model answered." }],
      stopReason: "stop",
    };

    // The live Gateway publishes persisted attempts before the answer final,
    // then a separate status final without a durable message identity.
    for (const message of [liveAnswer, fallbackNotice]) {
      const transition = reduceSessionProjectionRunEvent(projection, {
        state: "final",
        runId,
        message,
      });
      assert(transition);
      projection = reduceSessionProjection(transition.projection, {
        type: "messagePersisted",
        message,
        envelope: { runId },
      });
    }
    projection = reduceSessionProjection(projection, {
      type: "snapshotLoaded",
      messages: projectChatDisplayMessages(rawHistory),
    });

    expect(projection.messages).toEqual([user, answer]);
    expect(projection.runs[runId]).toMatchObject({ status: "completed", message: liveAnswer });
    expect(hasSessionProjectionAcceptedFinal(projection.runs[runId], fallbackNotice)).toBe(true);
    expect(rawHistory).toEqual([user, failed, answer]);
  });

  it("preserves distinct durable answers even when one run produced identical text", () => {
    const secondAnswer = {
      ...answer,
      __openclaw: { id: "second-answer", seq: 4, runId },
    };
    const rawHistory = [user, failed, answer, secondAnswer];
    const history = projectChatDisplayMessages(rawHistory);
    let projection = createSessionProjection(scope, history);
    projection = reduceSessionProjection(projection, {
      type: "messagePersisted",
      message: secondAnswer,
      envelope: { runId },
    });
    projection = reduceSessionProjection(projection, {
      type: "snapshotLoaded",
      messages: projectChatDisplayMessages(rawHistory),
    });

    expect(projection.messages).toEqual([user, answer, secondAnswer]);
    expect(projection.messages.map((message) => readSessionMessageIdentity(message)?.id)).toEqual([
      "user",
      "successful-attempt",
      "second-answer",
    ]);
  });
});
