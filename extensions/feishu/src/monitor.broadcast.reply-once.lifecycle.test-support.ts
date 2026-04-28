import "./lifecycle.test-support.js";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { FeishuConfigSchema } from "./config-schema.js";
import {
  getFeishuLifecycleTestMocks,
  resetFeishuLifecycleTestMocks,
} from "./lifecycle.test-support.js";
import {
  createFeishuTextMessageEvent,
  createFeishuLifecycleReplyDispatcher,
  installFeishuLifecycleReplyRuntime,
  mockFeishuReplyOnceDispatch,
  restoreFeishuLifecycleStateDir,
  runFeishuLifecycleSequence,
  setFeishuLifecycleStateDir,
  setupFeishuLifecycleHandler,
} from "./test-support/lifecycle-test-support.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const {
  createEventDispatcherMock,
  createFeishuReplyDispatcherMock,
  dispatchReplyFromConfigMock,
  finalizeInboundContextMock,
  resolveAgentRouteMock,
  resolveBoundConversationMock,
  withReplyDispatcherMock,
} = getFeishuLifecycleTestMocks();

let handlersByAccount = new Map<string, Record<string, (data: unknown) => Promise<void>>>();
let runtimesByAccount = new Map<string, RuntimeEnv>();
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function createLifecycleConfig(): ClawdbotConfig {
  return {
    broadcast: {
      oc_broadcast_group: ["susan", "main"],
    },
    agents: {
      list: [{ id: "main" }, { id: "susan" }],
    },
    channels: {
      feishu: {
        enabled: true,
        groupPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
        accounts: {
          "account-A": {
            enabled: true,
            appId: "cli_a",
            appSecret: "secret_a", // pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_broadcast_group: {
                requireMention: false,
              },
            },
          },
          "account-B": {
            enabled: true,
            appId: "cli_b",
            appSecret: "secret_b", // pragma: allowlist secret
            connectionMode: "websocket",
            groupPolicy: "open",
            requireMention: false,
            resolveSenderNames: false,
            groups: {
              oc_broadcast_group: {
                requireMention: false,
              },
            },
          },
        },
      },
    },
    messages: {
      inbound: {
        debounceMs: 0,
        byChannel: {
          feishu: 0,
        },
      },
    },
  } as ClawdbotConfig;
}

function createLifecycleAccount(accountId: "account-A" | "account-B"): ResolvedFeishuAccount {
  const config: FeishuConfig = FeishuConfigSchema.parse({
    enabled: true,
    connectionMode: "websocket",
    groupPolicy: "open",
    requireMention: false,
    resolveSenderNames: false,
    groups: {
      oc_broadcast_group: {
        requireMention: false,
      },
    },
  });
  return {
    accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: accountId === "account-A" ? "cli_a" : "cli_b",
    appSecret: accountId === "account-A" ? "secret_a" : "secret_b", // pragma: allowlist secret
    domain: "feishu",
    config,
  };
}

async function setupLifecycleMonitor(accountId: "account-A" | "account-B") {
  const runtime = createNonExitingRuntimeEnv();
  runtimesByAccount.set(accountId, runtime);
  return setupFeishuLifecycleHandler({
    createEventDispatcherMock,
    onRegister: (registered) => {
      handlersByAccount.set(accountId, registered);
    },
    runtime,
    cfg: createLifecycleConfig(),
    account: createLifecycleAccount(accountId),
    handlerKey: "im.message.receive_v1",
    missingHandlerMessage: `missing im.message.receive_v1 handler for ${accountId}`,
    once: true,
  });
}

describe("Feishu broadcast reply-once lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetFeishuLifecycleTestMocks();
    handlersByAccount = new Map();
    runtimesByAccount = new Map();
    setFeishuLifecycleStateDir("openclaw-feishu-broadcast");

    createFeishuReplyDispatcherMock.mockReturnValue(createFeishuLifecycleReplyDispatcher());

    resolveBoundConversationMock.mockReturnValue(null);
    resolveAgentRouteMock.mockReturnValue({
      agentId: "main",
      channel: "feishu",
      accountId: "account-A",
      sessionKey: "agent:main:feishu:group:oc_broadcast_group",
      mainSessionKey: "agent:main:main",
      matchedBy: "default",
    });

    mockFeishuReplyOnceDispatch({
      dispatchReplyFromConfigMock,
      replyText: "broadcast reply once",
      shouldSendFinalReply: (ctx) =>
        typeof (ctx as { SessionKey?: string } | undefined)?.SessionKey === "string" &&
        (ctx as { SessionKey: string }).SessionKey.includes("agent:main:"),
    });

    withReplyDispatcherMock.mockImplementation(async ({ run }) => await run());

    installFeishuLifecycleReplyRuntime({
      resolveAgentRouteMock,
      finalizeInboundContextMock,
      dispatchReplyFromConfigMock,
      withReplyDispatcherMock,
      storePath: "/tmp/feishu-broadcast-sessions.json",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreFeishuLifecycleStateDir(originalStateDir);
  });

  it("uses one active reply path when the same broadcast event reaches two accounts", async () => {
    const onMessageA = await setupLifecycleMonitor("account-A");
    const onMessageB = await setupLifecycleMonitor("account-B");
    const event = createFeishuTextMessageEvent({
      messageId: "om_broadcast_once",
      chatId: "oc_broadcast_group",
      text: "hello broadcast",
    });

    await runFeishuLifecycleSequence(
      [() => onMessageA(event), () => onMessageB(event)],
      [
        () => {
          expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
        },
        () => {
          expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
          expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
        },
      ],
    );

    expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
    expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();

    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledTimes(1);
    expect(createFeishuReplyDispatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-a",
        chatId: "oc_broadcast_group",
        replyToMessageId: "om_broadcast_once",
      }),
    );

    const sessionKeys = finalizeInboundContextMock.mock.calls.map(
      (call) => (call[0] as { SessionKey?: string }).SessionKey,
    );
    expect(sessionKeys).toContain("agent:main:feishu:group:oc_broadcast_group");
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc_broadcast_group");

    const activeDispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(activeDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate delivery after a post-send failure on the first account", async () => {
    const onMessageA = await setupLifecycleMonitor("account-A");
    const onMessageB = await setupLifecycleMonitor("account-B");
    const event = createFeishuTextMessageEvent({
      messageId: "om_broadcast_retry",
      chatId: "oc_broadcast_group",
      text: "hello broadcast",
    });

    dispatchReplyFromConfigMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      if (typeof ctx?.SessionKey === "string" && ctx.SessionKey.includes("agent:susan:")) {
        return { queuedFinal: false, counts: { final: 0 } };
      }
      await dispatcher.sendFinalReply({ text: "broadcast reply once" });
      throw new Error("post-send failure");
    });

    await runFeishuLifecycleSequence(
      [() => onMessageA(event), () => onMessageB(event)],
      [
        () => {
          expect(dispatchReplyFromConfigMock.mock.calls.length).toBeGreaterThan(0);
        },
        () => {
          expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);
        },
      ],
    );

    expect(runtimesByAccount.get("account-A")?.error).not.toHaveBeenCalled();
    expect(runtimesByAccount.get("account-B")?.error).not.toHaveBeenCalled();
    expect(dispatchReplyFromConfigMock).toHaveBeenCalledTimes(2);

    const activeDispatcher = createFeishuReplyDispatcherMock.mock.results[0]?.value.dispatcher as {
      sendFinalReply: ReturnType<typeof vi.fn>;
    };
    expect(activeDispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });
});
