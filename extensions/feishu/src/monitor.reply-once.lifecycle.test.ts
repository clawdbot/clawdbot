import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/plugins/runtime-env.js";
import "./lifecycle.test-support.js";
import { getFeishuLifecycleTestMocks } from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleConfig,
  createFeishuLifecycleReplyDispatcher,
  createFeishuTextMessageEvent,
  expectFeishuReplyDispatcherSentFinalReplyOnce,
  expectFeishuReplyPipelineDedupedAcrossReplay,
  expectFeishuReplyPipelineDedupedAfterPostSendFailure,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuMessageReceiveLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";

const {
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let lastRuntime: ReturnType<typeof createRuntimeEnv> | null = null;
let lifecycleCore: ReturnType<typeof installFeishuLifecycleReplyRuntime>;
const handleMessageMock = vi.fn();
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

async function setupLifecycleMonitor() {
  lastRuntime = createRuntimeEnv();
  return setupFeishuMessageReceiveLifecycleHandler({
    runtime: lastRuntime,
    core: lifecycleCore,
    cfg: lifecycleConfig,
    accountId: "acct-lifecycle",
    handleMessage: handleMessageMock,
    resolveDebounceText: ({ event }) => {
      const parsed = JSON.parse(event.message.content) as { text?: string };
      return parsed.text ?? "";
    },
  });
}

describe("Feishu reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    lastRuntime = null;
    setFeishuLifecycleStateDir("openclaw-feishu-lifecycle");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

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
    handleMessageMock.mockImplementation(async ({ event }) => {
      const reply = createFeishuReplyDispatcherMock({
        accountId: "acct-lifecycle",
        chatId: event.message.chat_id,
        replyToMessageId: event.message.root_id ?? event.message.message_id,
        replyInThread: true,
        rootId: event.message.root_id,
      });
      try {
        await withReplyDispatcherMock({
          dispatcher: reply.dispatcher,
          onSettled: () => reply.markDispatchIdle(),
          run: () =>
            dispatchReplyFromConfigMock({
              ctx: {
                AccountId: "acct-lifecycle",
                MessageSid: event.message.message_id,
              },
              dispatcher: reply.dispatcher,
            }),
        });
      } catch (err) {
        lastRuntime?.error(`feishu[acct-lifecycle]: failed to dispatch message: ${String(err)}`);
      }
    });

    lifecycleCore = installFeishuLifecycleReplyRuntime({
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
    expect(handleMessageMock).toHaveBeenCalledTimes(1);
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
    expect(handleMessageMock).toHaveBeenCalledTimes(1);
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expectFeishuReplyDispatcherSentFinalReplyOnce({ createFeishuReplyDispatcherMock });
  });
});
