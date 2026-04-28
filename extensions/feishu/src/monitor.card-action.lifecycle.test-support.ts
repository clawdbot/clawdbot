import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./lifecycle.test-support.js";
import { resetProcessedFeishuCardActionTokensForTests } from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  createResolvedFeishuLifecycleAccount,
  expectFeishuReplyDispatcherSentFinalReplyOnce,
  expectFeishuReplyPipelineDedupedAcrossReplay,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  sendCardFeishuMock,
  sendMessageFeishuMock,
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime = createRuntimeEnv();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    dmPolicy: "open",
  },
  accountConfig: {
    dmPolicy: "open",
  },
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-card",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    dmPolicy: "open",
  },
});

function createCardActionEvent(params: {
  token: string;
  action: string;
  command: string;
  chatId?: string;
  chatType?: "group" | "p2p";
}) {
  const openId = "ou_user1";
  const chatId = params.chatId ?? "p2p:ou_user1";
  const chatType = params.chatType ?? "p2p";
  return {
    operator: {
      open_id: openId,
      user_id: "user_1",
      union_id: "union_1",
    },
    token: params.token,
    action: {
      tag: "button",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: params.action,
        q: params.command,
        c: {
          u: openId,
          h: chatId,
          t: chatType,
          e: Date.now() + 60_000,
        },
      }),
    },
    context: {
      open_id: openId,
      user_id: "user_1",
      chat_id: chatId,
    },
  };
}

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuLifecycleHandler({
    createEventDispatcherMock,
    onRegister: (registered) => {
      _handlers = registered;
    },
    runtime: lastRuntime,
    cfg: lifecycleConfig,
    account: lifecycleAccount,
    handlerKey: "card.action.trigger",
    missingHandlerMessage: "missing card.action.trigger handler",
  });
}

describe("Feishu card-action lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    _handlers = {};
    lastRuntime = createRuntimeEnv();
    resetProcessedFeishuCardActionTokensForTests();
    setFeishuLifecycleStateDir("openclaw-feishu-card-action");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-card",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-card",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "card action reply once",
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      finalizeInboundContextMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-card-action-sessions.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetProcessedFeishuCardActionTokensForTests();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("routes one reply across duplicate callback delivery", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-once",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      handler: onCardAction,
      event,
      dispatchReplyFromConfigMock,
      createFeishuReplyDispatcherMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "p2p:ou_user1",
        replyToMessageId: undefined,
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-card",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        MessageSid: "card-action-tok-card-once",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-card");

    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("routes v2 callbacks that report open_chat_id instead of chat_id", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const chatId = "oc_group_v2";

    await onCardAction({
      operator: {
        open_id: "ou_user1",
      },
      token: "tok-card-v2-context",
      action: {
        tag: "button",
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: {
            u: "ou_user1",
            h: chatId,
            t: "group",
            e: Date.now() + 60_000,
          },
        }),
      },
      context: {
        open_message_id: "om_card_v2",
        open_chat_id: chatId,
      },
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId,
        replyToMessageId: "om_card_v2",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageSid: "card-action-tok-card-v2-context",
      }),
    );
  });

  it("routes SDK-style card callbacks without context as direct callbacks", async () => {
    const onCardAction = await setupLifecycleMonitor();

    await onCardAction({
      open_id: "ou_user1",
      user_id: "user_1",
      tenant_key: "tenant_1",
      open_message_id: "om_sdk_card",
      token: "tok-card-sdk-flat",
      action: {
        tag: "button",
        value: {
          command: "/help",
        },
      },
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "ou_user1",
        replyToMessageId: "om_sdk_card",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageSid: "card-action-tok-card-sdk-flat",
      }),
    );
  });

  it("plain-sends card action replies when Feishu provides no real message id", async () => {
    const onCardAction = await setupLifecycleMonitor();

    await onCardAction({
      open_id: "ou_user1",
      token: "tok-card-no-reply-target",
      action: {
        tag: "button",
        value: {
          command: "/help",
        },
      },
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-card",
        chatId: "ou_user1",
        replyToMessageId: undefined,
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        MessageSid: "card-action-tok-card-no-reply-target",
      }),
    );
  });

  it("does not duplicate delivery when retrying after a post-send failure", async () => {
    const onCardAction = await setupLifecycleMonitor();
    const event = createCardActionEvent({
      token: "tok-card-retry",
      action: "feishu.quick_actions.help",
      command: "/help",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "card action reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      handler: onCardAction,
      event,
      dispatchReplyFromConfigMock,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
    });

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });

  it("drops malformed card-action events with empty tokens before handler dispatch", async () => {
    const onCardAction = await setupLifecycleMonitor();

    await onCardAction({
      operator: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
      token: "",
      action: {
        tag: "button",
        value: createFeishuCardInteractionEnvelope({
          k: "quick",
          a: "feishu.quick_actions.help",
          q: "/help",
          c: {
            u: "ou_user1",
            h: "p2p:ou_user1",
            t: "p2p",
            e: Date.now() + 60_000,
          },
        }),
      },
      context: {
        open_id: "ou_user1",
        user_id: "user_1",
        chat_id: "p2p:ou_user1",
      },
    });

    expect(lastRuntime?.error).toHaveBeenCalledWith(
      "feishu[acct-card]: ignoring malformed card action payload",
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });
});
