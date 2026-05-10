import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({
  sendClickClackText: sendClickClackTextMock,
}));

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    agent: {
      runEmbeddedPiAgent: vi.fn().mockResolvedValue({
        payloads: [{ text: "service bot online" }],
        meta: {},
      }),
    },
    channel: {
      routing: {
        resolveAgentRoute({
          accountId,
          peer,
        }: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) {
          return {
            agentId: "main",
            channel: "clickclack",
            accountId: accountId ?? "default",
            sessionKey: `agent:main:clickclack:${peer?.kind ?? "channel"}:${peer?.id ?? "general"}`,
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          };
        },
        buildAgentSessionKey({
          agentId,
          channel,
          accountId,
          peer,
        }: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) {
          return `agent:${agentId}:${channel}:${accountId ?? "default"}:${peer?.kind ?? "channel"}:${peer?.id ?? "general"}`;
        },
      },
    },
    llm: {
      complete: vi.fn().mockResolvedValue({
        text: "service bot online",
        provider: "openai",
        model: "gpt-5.4-mini",
        agentId: "service-bot",
        usage: {},
        audit: {
          caller: { kind: "plugin", id: "clickclack" },
        },
      }),
    },
  } as unknown as PluginRuntime);
}

describe("handleClickClackInbound", () => {
  it("runs model-mode bot accounts without tools and posts the bot reply", async () => {
    sendClickClackTextMock.mockReset();
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;
    const account = {
      accountId: "service",
      enabled: true,
      configured: true,
      baseUrl: "http://127.0.0.1:8080",
      token: "ccb_service",
      workspace: "wsp_1",
      agentId: "service-bot",
      replyMode: "model",
      model: "openai/gpt-5.4-mini",
      senderIsOwner: false,
      toolsAllow: [],
      defaultTo: "channel:general",
      allowFrom: ["*"],
      reconnectMs: 1_500,
      config: {},
    } satisfies ResolvedClickClackAccount;

    await handleClickClackInbound({
      account,
      config: cfg,
      message: {
        id: "msg_1",
        workspace_id: "wsp_1",
        channel_id: "chn_1",
        author_id: "usr_human",
        thread_root_id: "msg_1",
        body: "hello bot",
        body_format: "markdown",
        created_at: "2026-05-09T12:00:00.000Z",
        author: {
          id: "usr_human",
          kind: "human",
          display_name: "Peter",
          handle: "steipete",
          avatar_url: "",
          created_at: "2026-05-09T12:00:00.000Z",
        },
      },
    });

    expect(runtime.channel.turn.runPrepared).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedPiAgent).not.toHaveBeenCalled();
    expect(runtime.llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "service-bot",
        model: "openai/gpt-5.4-mini",
        maxTokens: 96,
        purpose: "clickclack bot reply",
        messages: [{ role: "user", content: "hello bot" }],
      }),
    );
    expect(sendClickClackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "service",
        to: "channel:chn_1",
        text: "service bot online",
        replyToId: "msg_1",
      }),
    );
  });
});
