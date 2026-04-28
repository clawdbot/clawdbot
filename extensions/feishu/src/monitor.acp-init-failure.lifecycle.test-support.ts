import "./lifecycle.test-support.js";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import {
  createFeishuLifecycleFixture,
  createFeishuTextMessageEvent,
  expectFeishuSingleEffectAcrossReplay,
  installFeishuLifecycleReplyRuntime,
  restoreFeishuLifecycleStateDir,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";
import type { ResolvedFeishuAccount } from "./types.js";

const {
  createEventDispatcherMock,
  dispatchReplyFromConfigMock,
  ensureConfiguredBindingRouteReadyMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  resolveConfiguredBindingRouteMock,
  sendMessageFeishuMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let _handlers: Record<string, (data: unknown) => Promise<void>> = {};
let lastRuntime = createRuntimeEnv();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const { cfg: lifecycleConfig, account: lifecycleAccount } = createFeishuLifecycleFixture({
  accountId: "acct-acp",
  appId: "cli_test",
  appSecret: "secret_test",
  channelConfig: {
    groupPolicy: "open",
    allowFrom: ["ou_sender_1"],
  },
  accountConfig: {
    groupPolicy: "open",
    groups: {
      oc_group_topic: {
        requireMention: false,
        groupSessionScope: "group_topic",
        replyInThread: "enabled",
      },
    },
  },
  extraConfig: {
    session: { mainKey: "main", scope: "per-sender" },
  },
}) as {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
};

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

describe("Feishu ACP-init failure lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    _handlers = {};
    lastRuntime = createRuntimeEnv();
    setFeishuLifecycleStateDir("openclaw-feishu-acp-failure");

    resolveBoundConversationMock.mockReturnValue(null);
    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "acct-acp",
      sessionKey: "agent:main:feishu:group:oc_group_topic",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });
    resolveConfiguredBindingRouteMock.mockReturnValue({
      bindingResolution: {
        configuredBinding: {
          spec: {
            channel: "feishu",
            accountId: "acct-acp",
            conversationId: "oc_group_topic:topic:om_topic_root_1",
            agentId: "codex",
            mode: "persistent",
          },
          record: {
            bindingId: "config:acp:feishu:acct-acp:oc_group_topic:topic:om_topic_root_1",
            targetSessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
            targetKind: "session",
            conversation: {
              channel: "feishu",
              accountId: "acct-acp",
              conversationId: "oc_group_topic:topic:om_topic_root_1",
              parentConversationId: "oc_group_topic",
            },
            status: "active",
            boundAt: 0,
            metadata: { source: "config" },
          },
        },
        statefulTarget: {
          kind: "stateful",
          driverId: "acp",
          sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
          agentId: "codex",
        },
      },
      configuredBinding: {
        spec: {
          channel: "feishu",
          accountId: "acct-acp",
          conversationId: "oc_group_topic:topic:om_topic_root_1",
          agentId: "codex",
          mode: "persistent",
        },
      },
      route: {
        agentId: "codex",
        channel: "feishu",
        accountId: "acct-acp",
        sessionKey: "agent:codex:acp:binding:feishu:acct-acp:abc123",
        mainSessionKey: "agent:codex:main",
        matchedBy: "binding.channel",
      },
    });
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "runtime unavailable",
    });

    dispatchReplyFromConfigMock.mockResolvedValue({
      queuedFinal: false,
      counts: { final: 0 },
    });
    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      finalizeInboundContextMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-acp-failure-sessions.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("sends one ACP failure notice to the topic root across replay", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      messageId: "om_topic_msg_1",
      chatId: "oc_group_topic",
      rootId: "om_topic_root_1",
      threadId: "omt_topic_1",
      text: "hello topic",
    });

    await expectFeishuSingleEffectAcrossReplay({
      handler: onMessage,
      event,
      effectMock: sendMessageFeishuMock,
    });

    expect(lastRuntime?.error).not.toHaveBeenCalled();
    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-acp",
        to: "chat:oc_group_topic",
        replyToMessageId: "om_topic_root_1",
        replyInThread: true,
        text: expect.stringContaining("runtime unavailable"),
      }),
    );
    expect(dispatchReplyFromConfigMock).not.toHaveBeenCalled();
  });

  it("does not duplicate the ACP failure notice after the first send succeeds", async () => {
    const onMessage = await setupLifecycleMonitor();
    const event = createFeishuTextMessageEvent({
      messageId: "om_topic_msg_2",
      chatId: "oc_group_topic",
      rootId: "om_topic_root_1",
      threadId: "omt_topic_1",
      text: "hello topic",
    });

    await expectFeishuSingleEffectAcrossReplay({
      handler: onMessage,
      event,
      effectMock: sendMessageFeishuMock,
    });

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(lastRuntime?.error).not.toHaveBeenCalled();
  });
});
