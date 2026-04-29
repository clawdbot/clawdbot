import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./lifecycle.test-support.js";
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
  expectFeishuSingleEffectAcrossReplay,
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
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime = createRuntimeEnv();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountId: "acct-menu",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
  accountConfig: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-menu",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    dmPolicy: "open",
    allowFrom: ["ou_user1"],
  },
});

function createBotMenuEvent(params: { eventKey: string; timestamp: string }) {
  return {
    event_key: params.eventKey,
    timestamp: params.timestamp,
    operator: {
      operator_id: {
        open_id: "ou_user1",
        user_id: "user_1",
        union_id: "union_1",
      },
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
    handlerKey: "application.bot.menu_v6",
    missingHandlerMessage: "missing application.bot.menu_v6 handler",
  });
}

describe("Feishu bot-menu lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    _handlers = {};
    lastRuntime = createRuntimeEnv();
    setFeishuLifecycleStateDir("openclaw-feishu-bot-menu");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockImplementation(() => ({
      bindingId: "binding-menu",
      targetSessionKey: "agent:bound-agent:feishu:direct:ou_user1",
    }));

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-menu",
      sessionKey: "agent:main:feishu:direct:ou_user1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "menu reply once",
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      finalizeInboundContextMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-bot-menu-sessions.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("opens one launcher card across duplicate quick-actions replay", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000000",
    });

    await expectFeishuSingleEffectAcrossReplay({
      handler: onBotMenu,
      event,
      effectMock: sendCardFeishuMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-menu",
        to: "user:ou_user1",
      }),
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
    expect(createFeishuReplyDispatcherMock).not.toHaveBeenCalled();
  });

  it("falls back once to the legacy routed reply path when launcher rendering fails", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000001",
    });
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      handler: onBotMenu,
      event,
      dispatchReplyFromConfigMock,
      createFeishuReplyDispatcherMock,
      waitTimeoutMs: 5_000,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-menu",
        chatId: "p2p:ou_user1",
        replyToMessageId: undefined,
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-menu",
        SessionKey: "agent:bound-agent:feishu:direct:ou_user1",
        MessageSid: "bot-menu:quick-actions:1700000000001",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-menu");

    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });

  it("does not duplicate delivery when launcher fallback hits a post-send failure", async () => {
    const onBotMenu = await setupLifecycleMonitor();
    const event = createBotMenuEvent({
      eventKey: "quick-actions",
      timestamp: "1700000000002",
    });
    sendCardFeishuMock.mockRejectedValueOnce(new Error("boom"));
    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "menu reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      handler: onBotMenu,
      event,
      dispatchReplyFromConfigMock,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
      waitTimeoutMs: 5_000,
    });

    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });
});
