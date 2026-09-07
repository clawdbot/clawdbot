import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({
  sendClickClackText: sendClickClackTextMock,
}));

function createRuntime(text = "service bot online"): PluginRuntime {
  return createPluginRuntimeMock({
    llm: {
      complete: vi.fn<PluginRuntime["llm"]["complete"]>().mockResolvedValue({
        text,
        provider: "openai",
        model: "gpt-5.6-luna",
        agentId: "service-bot",
        usage: {},
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: "openai" },
        },
        audit: { caller: { kind: "plugin", id: "clickclack" } },
      }),
    },
  });
}

function createAccount(): ResolvedClickClackAccount {
  return {
    accountId: "model-loop-account",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_model_loop",
    botUserId: "usr_model_receiver",
    agentId: "service-bot",
    replyMode: "model",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["usr_model_sender"],
    allowBots: true,
    botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
    reconnectMs: 1_500,
    agentActivity: false,
    nativeProgress: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_model_loop", section: "Sessions" },
    config: {},
    requireMention: false,
    mentionPatterns: [],
    groups: {},
  };
}

function createBotMessage(params: {
  id: string;
  conversationId: string;
  attachmentBytes?: number;
}): ClickClackMessage {
  return {
    id: params.id,
    workspace_id: "wsp_model_loop",
    direct_conversation_id: params.conversationId,
    author_id: "usr_model_sender",
    thread_root_id: params.id,
    body: "hello from the other bot",
    body_format: "markdown",
    created_at: "2026-05-09T12:00:00.000Z",
    author: {
      id: "usr_model_sender",
      kind: "bot",
      display_name: "Model sender",
      handle: "model-sender",
      avatar_url: "",
      created_at: "2026-05-09T12:00:00.000Z",
    },
    ...(params.attachmentBytes === undefined
      ? {}
      : {
          attachments: [
            {
              id: `upl_${params.id.slice(4)}`,
              workspace_id: "wsp_model_loop",
              owner_id: "usr_model_sender",
              filename: "plan.png",
              content_type: "image/png",
              byte_size: params.attachmentBytes,
              width: 100,
              height: 80,
              duration_ms: 0,
              created_at: "2026-05-09T12:00:00.000Z",
            },
          ],
        }),
  };
}

describe("ClickClack direct-model response prefix", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  function createMessage(): ClickClackMessage {
    return {
      id: "msg_01arz3ndektsv4rrffq69g5fca",
      workspace_id: "wsp_model_loop",
      direct_conversation_id: "dm_model_prefix",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fca",
      body: "hello bot",
      body_format: "markdown",
      created_at: "2026-05-09T12:00:00.000Z",
      author: {
        id: "usr_model_sender",
        kind: "human",
        display_name: "Model sender",
        handle: "model-sender",
        avatar_url: "",
        created_at: "2026-05-09T12:00:00.000Z",
      },
    };
  }

  it("renders root, account, and templated prefixes on model replies", async () => {
    const cases = [
      {
        label: "root",
        cfg: { channels: { clickclack: { responsePrefix: "[bot]" } } },
        expected: "[bot] service bot online",
      },
      {
        label: "account",
        cfg: {
          channels: {
            clickclack: {
              responsePrefix: "[root]",
              accounts: { "model-loop-account": { responsePrefix: "[svc]" } },
            },
          },
        },
        expected: "[svc] service bot online",
      },
      {
        label: "templated",
        cfg: { channels: { clickclack: { responsePrefix: "[{model}]" } } },
        expected: "[gpt-5.6-luna] service bot online",
      },
      {
        label: "empty account override",
        cfg: {
          channels: {
            clickclack: {
              responsePrefix: "[root]",
              accounts: { "model-loop-account": { responsePrefix: "" } },
            },
          },
        },
        expected: "service bot online",
      },
      {
        label: "identity",
        cfg: {
          agents: { list: [{ id: "service-bot", identity: { name: "Service Bot" } }] },
          channels: { clickclack: { responsePrefix: "auto" } },
        },
        expected: "[Service Bot] service bot online",
      },
    ];

    for (const testCase of cases) {
      sendClickClackTextMock.mockClear();
      setClickClackRuntime(createRuntime());
      await handleClickClackInbound({
        account: createAccount(),
        config: testCase.cfg,
        message: createMessage(),
      });

      expect(sendClickClackTextMock.mock.calls[0]?.[0]?.text, testCase.label).toBe(
        testCase.expected,
      );
    }
  });

  it("does not add a second prefix when the completion already opens with one", async () => {
    sendClickClackTextMock.mockClear();
    const runtime = createRuntime("[bot] service bot online");
    setClickClackRuntime(runtime);
    await handleClickClackInbound({
      account: createAccount(),
      config: {
        channels: { clickclack: { responsePrefix: "[bot]" } },
      },
      message: createMessage(),
    });
    expect(sendClickClackTextMock.mock.calls[0]?.[0]?.text).toBe("[bot] service bot online");
  });
});

describe("ClickClack direct-model bot loop protection", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  it("suppresses the second bot message before model completion", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAccount();
    const message = createBotMessage({
      id: "msg_01arz3ndektsv4rrffq69g5fbx",
      conversationId: "dm_model_loop_suppression",
    });

    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message,
    });
    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: { ...message, id: "msg_01arz3ndektsv4rrffq69g5fby" },
    });

    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });

  it("retries the same bot message without consuming another loop slot", async () => {
    const runtime = createRuntime();
    const complete = vi.mocked(runtime.llm.complete);
    complete.mockRejectedValueOnce(new Error("transient model failure"));
    setClickClackRuntime(runtime);
    const account = createAccount();
    const message = createBotMessage({
      id: "msg_01arz3ndektsv4rrffq69g5fbz",
      conversationId: "dm_model_loop_retry",
    });

    await expect(
      handleClickClackInbound({ account, config: {} as CoreConfig, message }),
    ).rejects.toThrow("transient model failure");
    await handleClickClackInbound({ account, config: {} as CoreConfig, message });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses the second text-only model attachment notice", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAccount();
    const message = createBotMessage({
      id: "msg_01arz3ndektsv4rrffq69g5fc1",
      conversationId: "dm_model_media_suppression",
      attachmentBytes: 1,
    });

    await handleClickClackInbound({ account, config: {} as CoreConfig, message });
    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: { ...message, id: "msg_01arz3ndektsv4rrffq69g5fc2" },
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });

  it("allows the same attachment notice to retry without consuming another loop slot", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    sendClickClackTextMock.mockRejectedValueOnce(new Error("transient notice failure"));
    const account = createAccount();
    const message = createBotMessage({
      id: "msg_01arz3ndektsv4rrffq69g5fc3",
      conversationId: "dm_model_media_retry",
      attachmentBytes: 1,
    });

    await expect(
      handleClickClackInbound({ account, config: {} as CoreConfig, message }),
    ).rejects.toThrow("transient notice failure");
    await handleClickClackInbound({ account, config: {} as CoreConfig, message });

    expect(sendClickClackTextMock).toHaveBeenCalledTimes(2);
  });

  it("suppresses the second permanent media-limit notice", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = { ...createAccount(), replyMode: "agent" as const };
    const message = createBotMessage({
      id: "msg_01arz3ndektsv4rrffq69g5fc4",
      conversationId: "dm_agent_media_limit_suppression",
      attachmentBytes: 65 * 1024 * 1024,
    });

    await handleClickClackInbound({ account, config: {} as CoreConfig, message });
    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: { ...message, id: "msg_01arz3ndektsv4rrffq69g5fc5" },
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });
});
