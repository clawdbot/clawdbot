import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import {
  FeishuRetryableCardActionError,
  handleFeishuCardAction,
  resetProcessedFeishuCardActionTokensForTests,
  type FeishuCardActionEvent,
} from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  expectFirstSentCardUsesFillWidthOnly,
  expectSentCardHasP2pAction,
} from "./card-test-helpers.js";
import {
  FEISHU_APPROVAL_CANCEL_ACTION,
  FEISHU_APPROVAL_CONFIRM_ACTION,
  FEISHU_APPROVAL_REQUEST_ACTION,
} from "./card-ux-approval.js";

// Mock account resolution
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
  resolveFeishuRuntimeAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

// Mock bot.js to verify handleFeishuMessage call
vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: sendMessageFeishuMock,
}));

import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Action Handler", () => {
  const cfg: ClawdbotConfig = {};
  const runtime: RuntimeEnv = createRuntimeEnv();

  function createCardActionEvent(params: {
    token: string;
    actionValue: Record<string, unknown>;
    chatId?: string;
    openId?: string;
    userId?: string;
    unionId?: string;
  }): FeishuCardActionEvent {
    const openId = params.openId ?? "u123";
    const userId = params.userId ?? "uid1";
    return {
      operator: { open_id: openId, user_id: userId, union_id: params.unionId ?? "un1" },
      token: params.token,
      action: {
        value: params.actionValue,
        tag: "button",
      },
      context: { open_id: openId, user_id: userId, chat_id: params.chatId ?? "chat1" },
    };
  }

  function createStructuredQuickActionEvent(params: {
    token: string;
    action: string;
    command?: string;
    chatId?: string;
    chatType?: "group" | "p2p";
    operatorOpenId?: string;
    actionOpenId?: string;
  }): FeishuCardActionEvent {
    return createCardActionEvent({
      token: params.token,
      chatId: params.chatId,
      openId: params.operatorOpenId,
      actionValue: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: params.action,
        ...(params.command ? { q: params.command } : {}),
        c: {
          u: params.actionOpenId ?? params.operatorOpenId ?? "u123",
          h: params.chatId ?? "chat1",
          t: params.chatType ?? "group",
          e: Date.now() + 60_000,
        },
      }),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReset().mockReturnValue({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { chat_type: "group" } }),
        },
      },
    });
    vi.mocked(handleFeishuMessage)
      .mockReset()
      .mockResolvedValue(undefined as never);
    resetProcessedFeishuCardActionTokensForTests();
  });

  it("handles card action with text payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok1",
      action: { value: { text: "/ping" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/ping"}',
            chat_id: "chat1",
          }),
        }),
      }),
    );
  });

  it("handles card action with JSON object payload", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok2",
      action: { value: { key: "val" }, tag: "button" },
      context: { open_id: "u123", user_id: "uid1", chat_id: "" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"{\\"key\\":\\"val\\"}"}',
            chat_id: "u123", // Fallback to open_id
          }),
        }),
      }),
    );
  });

  it("routes quick command actions with operator and conversation context", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok3",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          sender: expect.objectContaining({
            sender_id: expect.objectContaining({
              open_id: "u123",
              user_id: "uid1",
              union_id: "un1",
            }),
          }),
          message: expect.objectContaining({
            chat_id: "chat1",
            content: '{"text":"/help"}',
          }),
        }),
      }),
    );
  });

  it("opens an approval card for metadata actions", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok4",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "meta",
          a: FEISHU_APPROVAL_REQUEST_ACTION,
          m: {
            command: "/new",
            prompt: "Start a fresh session?",
          },
          c: {
            u: "u123",
            h: "chat1",
            t: "group",
            s: "agent:codex:feishu:chat:chat1",
            e: Date.now() + 60_000,
          },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime, accountId: "main" });

    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:chat1",
        accountId: "main",
        card: expect.objectContaining({
          config: expect.objectContaining({
            width_mode: "fill",
          }),
          header: expect.objectContaining({
            title: expect.objectContaining({ content: "Confirm action" }),
          }),
          body: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "action",
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    value: expect.objectContaining({
                      c: expect.objectContaining({
                        u: "u123",
                        h: "chat1",
                        t: "group",
                        s: "agent:codex:feishu:chat:chat1",
                      }),
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        }),
      }),
    );
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("runs approval confirmation through the normal message path", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok5",
      action: FEISHU_APPROVAL_CONFIRM_ACTION,
      command: "/new",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            content: '{"text":"/new"}',
          }),
        }),
      }),
    );
  });

  it("safely rejects stale structured actions", async () => {
    const event = createCardActionEvent({
      token: "tok6",
      actionValue: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: "feishu.quick_actions.help",
        q: "/help",
        c: { u: "u123", h: "chat1", t: "group", e: Date.now() - 1 },
      }),
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:chat1",
        text: expect.stringContaining("expired"),
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("safely rejects wrong-user structured actions", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok7",
      action: "feishu.quick_actions.help",
      command: "/help",
      operatorOpenId: "u999",
      actionOpenId: "u123",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("different user"),
      }),
    );
    expect(handleFeishuMessage).not.toHaveBeenCalled();
  });

  it("sends a lightweight cancellation notice", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok8",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "button",
          a: FEISHU_APPROVAL_CANCEL_ACTION,
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:chat1",
        text: "Cancelled.",
      }),
    );
  });

  it("preserves p2p callbacks for DM quick actions", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok9",
      action: "feishu.quick_actions.help",
      command: "/help",
      chatId: "p2p-chat-1",
      chatType: "p2p",
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "p2p-chat-1",
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("resolves DM chat type from the Feishu chat API when card context omits it", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { chat_type: "p2p" } }),
        },
      },
    });
    const event = createCardActionEvent({
      token: "tok9b",
      chatId: "oc_dm_chat_123",
      actionValue: { text: "/help" },
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_id: "oc_dm_chat_123",
            chat_type: "p2p",
          }),
        }),
      }),
    );
    expect(createFeishuClientMock).toHaveBeenCalledTimes(1);
  });

  it("uses resolved DM chat type when building approval cards without stored context", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ code: 0, data: { chat_mode: "p2p" } }),
        },
      },
    });
    const event = createCardActionEvent({
      token: "tok9c",
      chatId: "oc_dm_chat_234",
      actionValue: createFeishuCardInteractionEnvelope({
        k: "meta",
        a: FEISHU_APPROVAL_REQUEST_ACTION,
        m: {
          command: "/new",
          prompt: "Start a fresh session?",
        },
        c: {
          u: "u123",
          h: "oc_dm_chat_234",
          e: Date.now() + 60_000,
        },
      }),
    });

    await handleFeishuCardAction({ cfg, event, runtime, accountId: "main" });

    expectSentCardHasP2pAction(sendCardFeishuMock);
    expect(createFeishuClientMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to p2p when Feishu chat API returns an error", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          get: vi.fn().mockResolvedValue({ code: 99, msg: "not found" }),
        },
      },
    });
    const event = createCardActionEvent({
      token: "tok9d",
      chatId: "oc_unknown_chat_456",
      actionValue: { text: "/help" },
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("falls back to p2p when Feishu chat API throws", async () => {
    createFeishuClientMock.mockReturnValueOnce({
      im: {
        chat: {
          get: vi.fn().mockRejectedValue(new Error("network failure")),
        },
      },
    });
    const event = createCardActionEvent({
      token: "tok9e",
      chatId: "oc_broken_chat_789",
      actionValue: { text: "/help" },
    });

    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("drops duplicate structured callback tokens", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok10",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await handleFeishuCardAction({ cfg, event, runtime });
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects empty callback tokens before dispatch", async () => {
    const log = vi.fn();
    const event = createStructuredQuickActionEvent({
      token: "   ",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await handleFeishuCardAction({
      cfg,
      event,
      runtime: {
        ...runtime,
        log,
      },
    });

    expect(handleFeishuMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "feishu[mock-account]: rejected card action from u123: missing token",
    );
  });

  it("keeps a claimed token completed after a non-retryable dispatch failure", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok11",
      action: "feishu.quick_actions.help",
      command: "/help",
    });
    vi.mocked(handleFeishuMessage)
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined as never);

    await expect(handleFeishuCardAction({ cfg, event, runtime })).rejects.toThrow("transient");
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
  });

  it("releases a claimed token for explicit retryable dispatch failures", async () => {
    const event = createStructuredQuickActionEvent({
      token: "tok11-retryable",
      action: "feishu.quick_actions.help",
      command: "/help",
    });
    vi.mocked(handleFeishuMessage)
      .mockRejectedValueOnce(new FeishuRetryableCardActionError("retry me"))
      .mockResolvedValueOnce(undefined as never);

    await expect(handleFeishuCardAction({ cfg, event, runtime })).rejects.toThrow("retry me");
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-flight token claimed while a slow dispatch is still running", async () => {
    vi.useFakeTimers();
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok12",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    let resolveDispatch: (() => void) | undefined;
    vi.mocked(handleFeishuMessage).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }) as never,
    );

    const first = handleFeishuCardAction({ cfg, event, runtime });
    await vi.advanceTimersByTimeAsync(61_000);
    await handleFeishuCardAction({ cfg, event, runtime });

    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);

    resolveDispatch?.();
    await first;
    vi.useRealTimers();
  });
});
