import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickClackInboundAccess } from "./access.js";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({
  sendClickClackText: sendClickClackTextMock,
}));

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    llm: {
      complete: vi.fn().mockResolvedValue({
        text: "service bot online",
        provider: "openai",
        model: "gpt-5.4-mini",
        agentId: "service-bot",
        usage: {},
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: "openai" },
        },
        audit: { caller: { kind: "plugin", id: "clickclack" } },
      }),
    },
  } as unknown as PluginRuntime);
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

function createAccess(params: {
  eventId: string;
  conversationId?: string;
}): ClickClackInboundAccess {
  const conversationId = params.conversationId ?? "chn_model_loop";
  return {
    shouldDispatch: true,
    commandAuthorized: false,
    mentionFacts: { canDetectMention: false, wasMentioned: false },
    botLoopProtection: {
      scopeId: "wsp_model_loop",
      conversationId,
      senderId: "usr_model_sender",
      receiverId: "usr_model_receiver",
      eventId: params.eventId,
      config: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
      defaultEnabled: true,
    },
    preparedRoute: {
      isDirect: false,
      target: `channel:${conversationId}`,
      route: { agentId: "service-bot" } as ClickClackInboundAccess["preparedRoute"]["route"],
      revoked: false,
    },
  };
}

describe("ClickClack direct-model bot loop protection", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  it("suppresses the second bot message before model completion", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAccount();
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fbx",
      workspace_id: "wsp_model_loop",
      channel_id: "chn_model_loop",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fbx",
      body: "hello from the other bot",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
    };

    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message,
      access: createAccess({ eventId: message.id, conversationId: "chn_model_loop_suppression" }),
    });
    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: { ...message, id: "msg_01arz3ndektsv4rrffq69g5fby" },
      access: createAccess({
        eventId: "msg_01arz3ndektsv4rrffq69g5fby",
        conversationId: "chn_model_loop_suppression",
      }),
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
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fbz",
      workspace_id: "wsp_model_loop",
      channel_id: "chn_model_loop_retry",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fbz",
      body: "retry this message",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
    };
    const access = createAccess({
      eventId: message.id,
      conversationId: "chn_model_loop_retry",
    });

    await expect(
      handleClickClackInbound({ account, config: {} as CoreConfig, message, access }),
    ).rejects.toThrow("transient model failure");
    await handleClickClackInbound({ account, config: {} as CoreConfig, message, access });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });
});
