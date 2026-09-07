import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { createEmbeddedAttemptCodingTools } from "./agent-tools.js";
import {
  createCurrentTurnDelivery,
  createCurrentTurnDeliveryTool,
  type CurrentTurnDelivery,
  type CurrentTurnDeliveryResult,
} from "./current-turn-delivery.js";
import {
  applyEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
} from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { isAgentToolReplaySafe, isAgentToolRestartSafe } from "./tool-replay-safety.js";

function delivery(send: CurrentTurnDelivery["send"]): CurrentTurnDelivery {
  return { send };
}

type DirectSendText = NonNullable<ChannelOutboundAdapter["sendText"]>;
type DirectSendTextMock = ReturnType<typeof vi.fn<DirectSendText>>;

function createCurrentTurnDeliveryHarness(params?: {
  tokenSessionId?: string;
  contextSessionId?: string;
  onPayloadNormalize?: (token: string) => void;
  sendText?: DirectSendTextMock;
}): {
  current: CurrentTurnDelivery;
  sendText: DirectSendTextMock;
  token: string;
} {
  const sessionKey = "agent:main:telegram:direct:123";
  const sessionId = params?.contextSessionId ?? "session-current-reply";
  const runId = "run-current-reply";
  const sendText =
    params?.sendText ??
    vi.fn<DirectSendText>(async () => ({
      channel: "telegram" as const,
      messageId: "sent-1",
    }));
  let token = "";
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          messaging: {
            targetResolver: {
              looksLikeId: (raw) => /^-?\d+$/.test(raw),
              hint: "<chatId>",
            },
          },
          outbound: {
            deliveryMode: "direct",
            ...(params?.onPayloadNormalize
              ? {
                  normalizePayload: ({ payload }) => {
                    params.onPayloadNormalize?.(token);
                    return payload;
                  },
                }
              : {}),
            sendText,
          },
        }),
      },
    ]),
  );
  token = mintMessageActionTurnCapability({
    agentId: "main",
    runId,
    sessionKey,
    sessionId: params?.tokenSessionId ?? sessionId,
  });
  const cfg = {} as OpenClawConfig;
  try {
    const current = createCurrentTurnDelivery({
      context: {
        runtimeConfig: cfg,
        getRuntimeConfig: () => cfg,
        agentId: "main",
        sessionKey,
        sessionId,
        deliveryContext: { channel: "telegram", to: "123" },
      },
      runId,
      token,
    });
    if (!current) {
      throw new Error("expected current-turn delivery");
    }
    return { current, sendText, token };
  } catch (error) {
    revokeMessageActionTurnCapability(token);
    throw error;
  }
}

describe("current-turn delivery tool", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("declares closed schemas and is neither replay-safe nor restart-safe", () => {
    const tool = createCurrentTurnDeliveryTool(delivery(async () => ({ status: "sent" })));

    expect(Value.Check(tool.parameters, { text: "hello" })).toBe(true);
    expect(Value.Check(tool.parameters, { text: "hello", target: "elsewhere" })).toBe(false);
    expect(Value.Check(tool.outputSchema!, { status: "sent" })).toBe(true);
    expect(Value.Check(tool.outputSchema!, { status: "sent", raw: true })).toBe(false);
    expect(isAgentToolReplaySafe(tool)).toBe(false);
    expect(isAgentToolRestartSafe(tool)).toBe(false);
  });

  it("validates before synchronously consuming its one-shot authority", async () => {
    let release!: (result: CurrentTurnDeliveryResult) => void;
    const send = vi.fn(
      async () =>
        await new Promise<CurrentTurnDeliveryResult>((resolve) => {
          release = resolve;
        }),
    );
    const tool = createCurrentTurnDeliveryTool(delivery(send));

    await expect(tool.execute("bad", { text: " " })).rejects.toThrow("text required");
    const first = tool.execute("first", { text: "hello" });
    await expect(tool.execute("second", { text: "again" })).rejects.toThrow(
      "already been consumed",
    );
    release({ status: "sent" });

    await expect(first).resolves.toMatchObject({
      details: { status: "sent" },
      terminate: true,
    });
    expect(send).toHaveBeenCalledWith({ text: "hello", mediaUrl: undefined }, true);
  });

  it.each([
    {
      outcome: { status: "sent" } satisfies CurrentTurnDeliveryResult,
      terminal: true,
    },
    {
      outcome: {
        status: "partial_failed",
        sentBeforeError: true,
        error: "receipt failed",
      } satisfies CurrentTurnDeliveryResult,
      terminal: true,
    },
    {
      outcome: {
        status: "partial_failed",
        error: "delivery failed",
      } satisfies CurrentTurnDeliveryResult,
      terminal: false,
    },
    {
      outcome: {
        status: "suppressed",
        suppressionReason: "policy",
      } satisfies CurrentTurnDeliveryResult,
      terminal: false,
    },
    {
      outcome: {
        status: "not_sent",
        suppressionReason: "adapter_returned_no_send",
      } satisfies CurrentTurnDeliveryResult,
      terminal: false,
    },
    {
      outcome: { status: "failed", error: "offline" } satisfies CurrentTurnDeliveryResult,
      terminal: false,
    },
  ])("projects $outcome.status with terminal=$terminal", async ({ outcome, terminal }) => {
    const result = await createCurrentTurnDeliveryTool(delivery(async () => outcome)).execute(
      "outcome",
      { text: "hello" },
    );

    expect(result.details).toEqual(outcome);
    expect(result.terminate).toBe(terminal ? true : undefined);
  });

  it("returns typed nonterminal failures for same-cell branching", async () => {
    const tool = createCurrentTurnDeliveryTool(
      delivery(async () => {
        throw new Error("authority expired");
      }),
    );

    await expect(tool.execute("failed", { text: "hello" })).resolves.toMatchObject({
      details: { status: "failed", error: "authority expired" },
    });
  });

  it("allows one direct adapter call while current-turn authority remains active", async () => {
    const { current, sendText, token } = createCurrentTurnDeliveryHarness();

    try {
      await expect(current.send({ text: "hello" })).resolves.toMatchObject({
        status: "sent",
        messageId: "sent-1",
      });
      expect(sendText).toHaveBeenCalledOnce();
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });

  it.each(["revoked", "replaced"] as const)(
    "rejects %s authority during delivery without adapter I/O",
    async (mode) => {
      const onPayloadNormalize = vi.fn((activeToken: string) => {
        if (mode === "revoked") {
          revokeMessageActionTurnCapability(activeToken);
        } else {
          setActivePluginRegistry(createTestRegistry([]));
        }
      });
      const { current, sendText, token } = createCurrentTurnDeliveryHarness({
        onPayloadNormalize,
      });

      try {
        await expect(current.send({ text: "must not escape" })).rejects.toThrow(
          "current-turn delivery capability is no longer active",
        );
        expect(sendText).not.toHaveBeenCalled();
        // Preparation normalizes before and after modifying policy.
        expect(onPayloadNormalize.mock.calls).toEqual([[token], [token]]);
      } finally {
        revokeMessageActionTurnCapability(token);
      }
    },
  );

  it("rejects a wrong-session capability before adapter I/O", () => {
    const sendText = vi.fn<DirectSendText>(async () => ({
      channel: "telegram" as const,
      messageId: "must-not-send",
    }));
    expect(() =>
      createCurrentTurnDeliveryHarness({
        tokenSessionId: "owning-session",
        contextSessionId: "replacement-session",
        sendText,
      }),
    ).toThrow("current-turn delivery capability is no longer active");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("keeps the actual host tool when toolsAllow only constructs read", () => {
    const sessionKey = "agent:main:telegram:direct:123";
    const runId = "run-current-reply";
    const sessionId = "session-current-reply";
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId,
      sessionKey,
      sessionId,
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
          }),
        },
      ]),
    );
    const plan = resolveEmbeddedAttemptToolConstructionPlan({
      toolsEnabled: true,
      toolsAllow: ["read"],
    });

    try {
      const currentTurnDeliveryToolRef: {
        value?: ReturnType<typeof createEmbeddedAttemptCodingTools>[number];
      } = {};
      const tools = createEmbeddedAttemptCodingTools(
        {
          agentId: "main",
          config: {} as OpenClawConfig,
          sessionKey,
          runSessionKey: sessionKey,
          runId,
          sessionId,
          messageChannel: "telegram",
          agentAccountId: "default",
          messageTo: "123",
          currentMessagingTarget: "123",
          messageActionTurnCapability: token,
          includeCoreTools: plan.includeCoreTools,
          runtimeToolAllowlist: plan.runtimeToolAllowlist,
          toolConstructionPlan: plan.codingToolConstructionPlan,
        },
        currentTurnDeliveryToolRef,
      );
      const currentReply = tools.find((tool) => tool.name === "send_current_reply");
      const filtered = applyEmbeddedAttemptToolsAllow(tools, plan.runtimeToolAllowlist, {
        preserveTools: currentReply ? new Set([currentReply]) : undefined,
      });

      expect(plan.codingToolConstructionPlan).toMatchObject({
        includeOpenClawTools: false,
        includePluginTools: false,
      });
      expect(currentReply).toBeDefined();
      expect(currentTurnDeliveryToolRef.value).toBe(currentReply);
      expect(filtered.map((tool) => tool.name)).toEqual(["send_current_reply", "read"]);
    } finally {
      revokeMessageActionTurnCapability(token);
    }
  });
});
