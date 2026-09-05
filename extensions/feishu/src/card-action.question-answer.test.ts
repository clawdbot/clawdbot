import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { processedCardActions } from "./card-action-state.js";
import {
  FEISHU_QUESTION_ANSWER_ACTION,
  handleFeishuCardAction,
  type FeishuCardActionEvent,
} from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";

// Mock account resolution
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
  resolveFeishuRuntimeAccount: vi
    .fn()
    .mockReturnValue({ accountId: "mock-account", configured: true }),
}));

// Mock bot.js to prove question answers never dispatch a synthetic message
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

// Mock the gateway question runtime used for button resolution
vi.mock("openclaw/plugin-sdk/question-gateway-runtime", () => ({
  questionGatewayRuntime: { resolveOption: vi.fn() },
}));

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const messageReactionCreateMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: vi.fn(),
  sendMessageFeishu: sendMessageFeishuMock,
}));

import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Action question button answers", () => {
  const cfg: ClawdbotConfig = {};
  const runtime: RuntimeEnv = createRuntimeEnv();
  const resolveOptionMock = vi.mocked(questionGatewayRuntime.resolveOption);

  afterAll(() => {
    vi.doUnmock("./accounts.js");
    vi.doUnmock("./bot.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./send.js");
    vi.doUnmock("openclaw/plugin-sdk/question-gateway-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    processedCardActions.clear();
    createFeishuClientMock.mockReset().mockReturnValue({
      im: {
        messageReaction: {
          create: messageReactionCreateMock,
        },
      },
    });
    messageReactionCreateMock.mockReset().mockResolvedValue({
      code: 0,
      data: { reaction_id: "reaction-1" },
    });
    resolveOptionMock.mockReset().mockResolvedValue({
      status: "answered",
      questionId: "unused",
      optionValue: "unused",
    });
    vi.mocked(handleFeishuMessage)
      .mockReset()
      .mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createQuestionAnswerEvent(params: {
    token: string;
    questionId: string;
    optionValue: string;
    contextOpenMessageId?: string;
    openMessageId?: string;
    operatorOpenId?: string;
  }): FeishuCardActionEvent {
    const openId = params.operatorOpenId ?? "u123";
    return {
      operator: { open_id: openId, user_id: "uid1", union_id: "un1" },
      token: params.token,
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "button",
          a: FEISHU_QUESTION_ANSWER_ACTION,
          q: params.questionId,
          m: { o: params.optionValue },
        }),
        tag: "button",
      },
      context: {
        open_id: openId,
        user_id: "uid1",
        chat_id: "chat1",
        ...(params.contextOpenMessageId
          ? { open_message_id: params.contextOpenMessageId }
          : {}),
      },
      ...(params.openMessageId ? { open_message_id: params.openMessageId } : {}),
    };
  }

  it("resolves an answered question button through the gateway and acks with an OK reaction", async () => {
    const questionId = "ask_11111111111111111111111111111111";
    const event = createQuestionAnswerEvent({
      token: "tok-q-answered",
      questionId,
      optionValue: "Option A",
      contextOpenMessageId: "om_question_card_1",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(resolveOptionMock).toHaveBeenCalledWith({
      cfg,
      questionId,
      senderId: "u123",
      optionValue: "Option A",
    });
    expect(messageReactionCreateMock).toHaveBeenCalledWith({
      path: { message_id: "om_question_card_1" },
      data: { reaction_type: { emoji_type: "OK" } },
    });
    // A button answer must never be re-injected as a synthetic user message.
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("skips the ack reaction when the question is already terminal", async () => {
    resolveOptionMock.mockResolvedValue({
      status: "already-terminal",
      reason: "already-terminal",
    } as never);
    const event = createQuestionAnswerEvent({
      token: "tok-q-terminal",
      questionId: "ask_22222222222222222222222222222222",
      optionValue: "Option A",
      contextOpenMessageId: "om_question_card_2",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(messageReactionCreateMock).not.toHaveBeenCalled();
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("falls back to the event-level message id for the ack reaction", async () => {
    const event = createQuestionAnswerEvent({
      token: "tok-q-top-id",
      questionId: "ask_33333333333333333333333333333333",
      optionValue: "Option A",
      openMessageId: "om_question_card_3",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(messageReactionCreateMock).toHaveBeenCalledWith({
      path: { message_id: "om_question_card_3" },
      data: { reaction_type: { emoji_type: "OK" } },
    });
  });

  it("skips the ack reaction when the callback carries no message id", async () => {
    const event = createQuestionAnswerEvent({
      token: "tok-q-no-id",
      questionId: "ask_44444444444444444444444444444444",
      optionValue: "Option A",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(createFeishuClientMock).not.toHaveBeenCalled();
  });

  it("rejects malformed question envelopes without resolving", async () => {
    const event = createQuestionAnswerEvent({
      token: "tok-q-missing-q",
      questionId: "",
      optionValue: "Option A",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(messageReactionCreateMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    const args = sendMessageFeishuMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.to).toBe("chat:chat1");
    expect(String(args.text)).toContain("payload is invalid");
  });

  it("rejects over-long question options as malformed", async () => {
    const event = createQuestionAnswerEvent({
      token: "tok-q-overlong",
      questionId: "ask_55555555555555555555555555555555",
      optionValue: "x".repeat(513),
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(resolveOptionMock).not.toHaveBeenCalled();
    expect(messageReactionCreateMock).not.toHaveBeenCalled();
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated taps on the same question within the dedupe window", async () => {
    const log = vi.fn();
    const customRuntime = { ...runtime, log };
    const questionId = "ask_66666666666666666666666666666666";

    await handleFeishuCardAction({
      cfg,
      event: createQuestionAnswerEvent({
        token: "tok-q-repeat-1",
        questionId,
        optionValue: "Option A",
        contextOpenMessageId: "om_question_card_6",
      }),
      runtime: customRuntime,
    });
    await handleFeishuCardAction({
      cfg,
      event: createQuestionAnswerEvent({
        token: "tok-q-repeat-2",
        questionId,
        optionValue: "Option A",
        contextOpenMessageId: "om_question_card_6",
      }),
      runtime: customRuntime,
    });

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(messageReactionCreateMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      `feishu[mock-account]: skipping repeated question button answer ${questionId} from u123`,
    );
  });

  it("swallows gateway resolution failures and still completes the card action", async () => {
    const log = vi.fn();
    resolveOptionMock.mockRejectedValue(new Error("gateway unavailable"));
    const event = createQuestionAnswerEvent({
      token: "tok-q-failure",
      questionId: "ask_77777777777777777777777777777777",
      optionValue: "Option A",
      contextOpenMessageId: "om_question_card_7",
    });

    await expect(
      handleFeishuCardAction({ cfg, event, runtime: { ...runtime, log } }),
    ).resolves.toBeUndefined();

    expect(messageReactionCreateMock).not.toHaveBeenCalled();
    expect(handleFeishuMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "feishu[mock-account]: question ask_77777777777777777777777777777777 answer failed: gateway unavailable",
    );
  });

  it("swallows ack reaction failures without blocking the answer", async () => {
    const log = vi.fn();
    messageReactionCreateMock.mockRejectedValue(new Error("reaction denied"));
    const event = createQuestionAnswerEvent({
      token: "tok-q-ack-failure",
      questionId: "ask_88888888888888888888888888888888",
      optionValue: "Option A",
      contextOpenMessageId: "om_question_card_8",
    });

    await expect(
      handleFeishuCardAction({ cfg, event, runtime: { ...runtime, log } }),
    ).resolves.toBeUndefined();

    expect(resolveOptionMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "feishu[mock-account]: question ack reaction skipped (non-fatal): reaction denied",
    );
  });

  it("allows a re-answer once the dedupe window has expired", async () => {
    vi.useFakeTimers();
    const questionId = "ask_99999999999999999999999999999999";
    const event = createQuestionAnswerEvent({
      token: "tok-q-ttl-1",
      questionId,
      optionValue: "Option A",
      contextOpenMessageId: "om_question_card_9",
    });

    await handleFeishuCardAction({ cfg, event, runtime });
    await vi.advanceTimersByTimeAsync(61_000);
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(resolveOptionMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
