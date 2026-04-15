import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import "./lifecycle.test-support.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  createFeishuTextMessageEvent,
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
  touchBindingMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime: ReturnType<typeof createRuntimeEnv> | null = null;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const lifecycleConfig = createFeishuLifecycleConfig({
  accountId: "acct-lifecycle",
  appId: "cli_test",
  appSecret: "secret_test",
  accountConfig: {
    groupPolicy: "open",
    groups: {
      oc_group_1: {
        requireMention: false,
        groupSessionScope: "group_topic_sender",
        replyInThread: "enabled",
      },
    },
  },
});

const lifecycleAccount = createResolvedFeishuLifecycleAccount({
  accountId: "acct-lifecycle",
  appId: "cli_test",
  appSecret: "secret_test",
  config: {
    groupPolicy: "open",
    groups: {
      oc_group_1: {
        requireMention: false,
        groupSessionScope: "group_topic_sender",
        replyInThread: "enabled",
      },
    },
  },
});

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
    handlerKey: "im.message.receive_v1",
    missingHandlerMessage: "missing im.message.receive_v1 handler",
  });
}

describe("Feishu reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _handlers = {};
    lastRuntime = null;
    setFeishuLifecycleStateDir("openclaw-feishu-lifecycle");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: "agent:bound-agent:feishu:topic:om_root_topic_1:ou_sender_1",
    });

    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-lifecycle",
      sessionKey: "agent:main:feishu:group:oc_group_1",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "reply once",
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      finalizeInboundContextMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-lifecycle-sessions.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("routes a topic-bound inbound event and emits one reply across duplicate replay", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      messageId: "om_lifecycle_once",
      chatId: "oc_group_1",
      rootId: "om_root_topic_1",
      threadId: "omt_topic_1",
      text: "hello from topic",
    });

    await expectFeishuReplyPipelineDedupedAcrossReplay({
      handler: onMessage,
      event,
      dispatchReplyFromConfigMock,
      createFeishuReplyDispatcherMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-lifecycle",
        chatId: "oc_group_1",
        replyToMessageId: "om_root_topic_1",
        replyInThread: true,
        rootId: "om_root_topic_1",
      }),
    );
    expect(finalizeInboundContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        AccountId: "acct-lifecycle",
        SessionKey: "agent:bound-agent:feishu:topic:om_root_topic_1:ou_sender_1",
        MessageSid: "om_lifecycle_once",
        MessageThreadId: "om_root_topic_1",
      }),
    );
    expect(touchBindingMock).toHaveBeenCalledWith("binding-1");
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });

  it("does not duplicate delivery when the first attempt fails after sending the reply", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      messageId: "om_lifecycle_retry",
      chatId: "oc_group_1",
      rootId: "om_root_topic_1",
      threadId: "omt_topic_1",
      text: "hello from topic",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ dispatcher }) => {
      await dispatcher.sendFinalReply({ text: "reply once" });
      throw new Error("post-send failure");
    });

    await expectFeishuReplyPipelineDedupedAfterPostSendFailure({
      handler: onMessage,
      event,
      dispatchReplyFromConfigMock,
      runtimeErrorMock: lastRuntime?.error as ReturnType<typeof vi.fn>,
    });

    expect(lastRuntime?.error).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });
});
