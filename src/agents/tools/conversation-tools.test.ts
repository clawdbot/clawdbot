import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationListResultSchema,
  ConversationSendResultSchema,
  ConversationTurnResultSchema,
} from "../../../packages/gateway-protocol/src/schema/agent.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { MessageActionResult } from "../../infra/outbound/message-action-contracts.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { ToolSearchRuntime } from "../tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "../tool-search.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./conversation-tools.js";
import { createMessageTool } from "./message-tool-execution.js";
import { resetTurnSendLedgerForTest } from "./turn-send-ledger.js";

afterEach(() => {
  resetTurnSendLedgerForTest();
  resetPluginRuntimeStateForTest();
});

// buildTurnSendTargetKey canonicalizes the target through the channel plugin's
// provider normalizer. Register the reef fixture as a loaded plugin so that read
// resolves from the loaded registry instead of falling through to bundled channel
// runtime materialization, which would cold-load every bundled channel under tsx.
function registerReefTestPlugin() {
  const plugin = {
    id: "reef",
    meta: {
      id: "reef",
      label: "Reef",
      selectionLabel: "Reef",
      docsPath: "/channels/reef",
      blurb: "reef test plugin",
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}) },
    actions: {
      describeMessageTool: () => ({ actions: ["send"], capabilities: [] }),
    },
  } as unknown as ChannelPlugin;
  setActivePluginRegistry(createTestRegistry([{ pluginId: "reef", source: "test", plugin }]));
}

beforeEach(() => {
  registerReefTestPlugin();
});

const conversation = {
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  channel: "reef",
  accountId: "default",
  kind: "direct" as const,
  target: "reef:peer-agent",
  sessionId: "shared-main-session",
  sessionKey: "agent:main:main",
  role: "participant" as const,
  firstSeenAt: 100,
  lastSeenAt: 200,
};

type MockGatewayCall = {
  method: string;
  params: Record<string, unknown>;
  config?: unknown;
  onSignalAbort?: (
    request: (method: string, params: unknown, options: unknown) => Promise<unknown>,
  ) => Promise<void>;
};

function createDeps() {
  const callGatewayMock = vi.fn(async (input: MockGatewayCall) =>
    input.method === "conversations.list"
      ? {
          conversations: [
            {
              conversationRef: conversation.conversationRef,
              channel: conversation.channel,
              accountId: conversation.accountId,
              kind: conversation.kind,
              target: conversation.target,
              firstSeenAt: conversation.firstSeenAt,
              lastSeenAt: conversation.lastSeenAt,
            },
          ],
        }
      : input.method === "conversations.send"
        ? {
            status: "sent" as const,
            conversationRef: conversation.conversationRef,
            channel: "reef",
            messageId: "reef-outbound-1",
            queueId: "queue-1",
          }
        : {
            status: "replied" as const,
            conversationRef: conversation.conversationRef,
            channel: "reef",
            messageId: "reef-outbound-1",
            correlationPersisted: true,
            reply: {
              conversationRef: conversation.conversationRef,
              messageId: "reef-inbound-1",
              replyToId: "reef-outbound-1",
              text: "peer acknowledged",
              timestamp: 300,
            },
          },
  );
  // The registry resolves the opaque ref to its real (channel, account, target)
  // route; the budget ledger keys on that route, not the raw conversationRef.
  const resolveConversationMock = vi.fn(() => conversation);
  return {
    callGateway: callGatewayMock as never,
    resolveConversation: resolveConversationMock as never,
    callGatewayMock,
    resolveConversationMock,
  };
}

describe("conversation tools", () => {
  it("declares exact Gateway output contracts and promotes only bounded complete hints", async () => {
    const deps = createDeps();
    const list = createConversationsListTool({ agentId: "main" }, deps);
    const send = createConversationsSendTool({ agentId: "main" }, deps);
    const turn = createConversationsTurnTool({ agentId: "main" }, deps);
    const listResult = await list.execute("list-contract", {});
    const sendResult = await send.execute("send-contract", {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    });
    const turnResult = await turn.execute("turn-contract", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
    });

    expect(list.outputSchema).toBe(ConversationListResultSchema);
    expect(send.outputSchema).toBe(ConversationSendResultSchema);
    expect(turn.outputSchema).toBe(ConversationTurnResultSchema);
    expect(Value.Check(list.outputSchema!, listResult.details)).toBe(true);
    expect(Value.Check(send.outputSchema!, sendResult.details)).toBe(true);
    expect(Value.Check(turn.outputSchema!, turnResult.details)).toBe(true);
    expect(compactToolOutputHint(list.outputSchema)).toBe(
      '{ conversations: Array<{ accountId: string; channel: string; conversationRef: string; firstSeenAt: number; kind: "direct" | "group" | "channel"; lastSeenAt: number; target: string; label?: string; threadId?: string }> }',
    );
    expect(compactToolOutputHint(send.outputSchema)).toBe(
      '{ channel: string; conversationRef: string; status: "sent" | "queued" | "suppressed" | "unknown"; messageId?: string; queueId?: string }',
    );
    expect(compactToolOutputHint(turn.outputSchema)).toBe(
      '{ channel: string; conversationRef: string; correlationPersisted: boolean; messageId: string; reply: { conversationRef: string; messageId: string; text: string; timestamp: number; replyToId?: string; threadId?: string; transcriptArtifactId?: string; transcriptMessageId?: string }; status: "replied" } | { channel: string; conversationRef: string; correlationPersisted: boolean; messageId: string; status: "timeout" } | { channel: string; conversationRef: string; correlationPersisted: boolean; error: string; status: "sent" | "queued" | "suppressed" | "unknown"; messageId?: string }',
    );
  });

  it("lists opaque external addresses independently from sessions", async () => {
    const deps = createDeps();
    const result = await createConversationsListTool({ agentId: "main" }, deps).execute("list", {
      channel: "reef",
      query: "@peer-agent",
    });

    expect(deps.callGatewayMock).toHaveBeenCalledWith({
      method: "conversations.list",
      params: { agentId: "main", channel: "reef", query: "@peer-agent", limit: 50 },
    });
    expect(result.details).toEqual({
      conversations: [
        {
          conversationRef: conversation.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct",
          target: "reef:peer-agent",
          firstSeenAt: 100,
          lastSeenAt: 200,
        },
      ],
    });
  });

  it("routes sends through the Gateway with a stable operation id", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      {
        agentId: "main",
        agentSessionId: "operator-session",
        agentSessionKey: "agent:main:telegram:direct:operator",
        config: {},
      },
      deps,
    );
    const args = {
      conversationRef: conversation.conversationRef,
      message: "hello peer",
    };

    const firstResult = await tool.execute("tool-call-1", args);
    const secondResult = await tool.execute("tool-call-1", args);
    const first = deps.callGatewayMock.mock.calls[0]![0];
    const second = deps.callGatewayMock.mock.calls[1]![0];

    expect(first).toMatchObject({
      method: "conversations.send",
      params: {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        conversationRef: conversation.conversationRef,
        message: "hello peer",
      },
      config: {},
    });
    expect(first.params.operationId).toMatch(/^convop_[a-f0-9]{32}$/u);
    expect(second.params.operationId).toBe(first.params.operationId);
    expect(firstResult.details).toEqual(secondResult.details);
    expect(firstResult.details).toMatchObject({
      status: "sent",
      messageId: "reef-outbound-1",
      queueId: "queue-1",
    });
  });

  it("reports Gateway suppression without claiming delivery", async () => {
    const deps = createDeps();
    deps.callGatewayMock.mockResolvedValueOnce({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    } as never);

    const result = await createConversationsSendTool({ agentId: "main", config: {} }, deps).execute(
      "suppressed-call",
      {
        conversationRef: conversation.conversationRef,
        message: "suppressed hello",
      },
    );

    expect(result.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-suppressed",
    });
  });

  it("keeps a transient Gateway send failure retryable under the stable tool call id", async () => {
    const deps = createDeps();
    deps.callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));
    const tool = createConversationsSendTool({ agentId: "main", config: {} }, deps);
    const args = {
      conversationRef: conversation.conversationRef,
      message: "retry me",
    };

    await expect(tool.execute("retryable-call", args)).rejects.toThrow("gateway unavailable");
    await expect(tool.execute("retryable-call", args)).resolves.toMatchObject({
      details: { status: "sent", messageId: "reef-outbound-1" },
    });
    const first = deps.callGatewayMock.mock.calls[0]![0];
    const second = deps.callGatewayMock.mock.calls[1]![0];
    expect(second.params.operationId).toBe(first.params.operationId);
  });

  it("uses a stable operation id for correlated turns and cancels on abort", async () => {
    const deps = createDeps();
    const tool = createConversationsTurnTool(
      {
        agentId: "main",
        agentSessionId: "operator-session",
        agentSessionKey: "agent:main:telegram:direct:operator",
        config: {},
      },
      deps,
    );
    await tool.execute("turn-call", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });
    await tool.execute("turn-call", {
      conversationRef: conversation.conversationRef,
      message: "please acknowledge",
      timeoutSeconds: 12,
    });

    const first = deps.callGatewayMock.mock.calls[0]![0];
    const second = deps.callGatewayMock.mock.calls[1]![0];
    expect(first.params.turnId).toMatch(/^convop_[a-f0-9]{32}$/u);
    expect(second.params.turnId).toBe(first.params.turnId);
    const request = vi.fn(async () => ({ cancelled: true }));
    await first.onSignalAbort?.(request);
    expect(request).toHaveBeenCalledWith(
      "conversations.turn.cancel",
      { agentId: "main", turnId: first.params.turnId },
      { timeoutMs: 5_000 },
    );
  });

  it("validates references and owner access before Gateway delivery", async () => {
    const deps = createDeps();
    await expect(
      createConversationsSendTool({ agentId: "main", config: {} }, deps).execute("send", {
        conversationRef: "not-a-conversation",
        message: "hello",
      }),
    ).rejects.toThrow("Invalid conversationRef");

    for (const createTool of [
      createConversationsListTool,
      createConversationsSendTool,
      createConversationsTurnTool,
    ]) {
      const tool = createTool({ agentId: "main", senderIsOwner: false, config: {} } as never, deps);
      await expect(
        tool.execute("blocked", {
          conversationRef: conversation.conversationRef,
          message: "blocked",
        }),
      ).rejects.toThrow("require owner access");
    }
    expect(deps.callGatewayMock).not.toHaveBeenCalled();
    for (const name of ["conversations_list", "conversations_send", "conversations_turn"]) {
      expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain(name);
      expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain(name);
    }
  });
});

describe("conversations_send per-turn send budget", () => {
  const budgetOptions = {
    agentId: "main",
    agentSessionKey: "agent:main:reef:direct:operator",
    runId: "run-conv-1",
    config: {},
  } as const;

  function softNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.includes("already sent"));
  }

  function blockedNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.startsWith("Blocked:"));
  }

  // conversations_send declares the closed ConversationSendResultSchema, so a capped
  // send must return schema-valid details (status/conversationRef/channel only) and
  // carry the human-readable block reason in text content, not details.
  function expectSchemaValidCappedResult(result: {
    content: Array<{ type: string; text?: string }>;
    details: unknown;
  }) {
    expect(Value.Check(ConversationSendResultSchema, result.details)).toBe(true);
    expect(result.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
    });
    expect(blockedNotice(result)).toContain("already sent");
  }

  it("returns a schema-valid capped result with the block reason in text, not details", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    const blocked = await tool.execute("c2", args);
    expectSchemaValidCappedResult(blocked);
    // No extra fields leaked into details that would fail the closed output schema.
    expect(blocked.details).not.toHaveProperty("reason");
    expect(blocked.details).not.toHaveProperty("message");
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("passes the Code Mode output-schema check on the capped path", async () => {
    // In Code Mode the runtime validates the returned details against the tool's
    // declared outputSchema (assertCatalogOutputMatchesSchema). A capped result with
    // extra details fields would throw there; the schema-valid shape must not.
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [tool] });
    const runtime = new ToolSearchRuntime(
      { catalogRef },
      resolveToolSearchConfig({ tools: { toolSearch: { enabled: true, mode: "code" } } } as never),
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    // First send is admitted; the second is capped and returns the schema-valid
    // suppressed shape, so the output-schema check must accept it instead of throwing.
    await runtime.call("conversations_send", args);
    await expect(runtime.call("conversations_send", args)).resolves.toMatchObject({
      result: { details: { status: "suppressed", channel: "reef" } },
    });
  });

  it("appends a soft reminder from the second send to the same conversation this turn", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(budgetOptions, deps);
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    const first = await tool.execute("c1", args);
    const second = await tool.execute("c2", args);
    expect(softNotice(first)).toBeUndefined();
    expect(softNotice(second)).toContain("already sent 2 messages");
    expect(second.details).toMatchObject({ status: "sent" });
  });

  it.each(["suppressed", "queued", "unknown"] as const)(
    "does not count a %s (unconfirmed) Gateway result",
    async (status) => {
      const deps = createDeps();
      deps.callGatewayMock.mockResolvedValueOnce({
        status,
        conversationRef: conversation.conversationRef,
        channel: "reef",
      } as never);
      const tool = createConversationsSendTool(budgetOptions, deps);
      const args = { conversationRef: conversation.conversationRef, message: "hi" };
      await tool.execute("c1", args);
      const second = await tool.execute("c2", args);
      // Only a confirmed "sent" counts. This first send was not confirmed delivered
      // (queued is enqueue-only; suppressed/unknown never reached the peer), so the
      // following send is the first success and draws no nudge.
      expect(softNotice(second)).toBeUndefined();
    },
  );

  it("counts a queued-then-sent pair as a single first delivery under the hard cap", async () => {
    const deps = createDeps();
    // First send is only enqueued (unconfirmed): it must not consume the cap.
    deps.callGatewayMock.mockResolvedValueOnce({
      status: "queued",
      conversationRef: conversation.conversationRef,
      channel: "reef",
      queueId: "queue-1",
    } as never);
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    const queued = await tool.execute("c1", args);
    // Queued does not count, so the cap is untouched and the Gateway was still reached.
    expect(queued.details).toMatchObject({ status: "queued" });
    expect(softNotice(queued)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
    // The subsequent confirmed "sent" is the first counted delivery, so it is admitted.
    const sent = await tool.execute("c2", args);
    expect(sent.details).toMatchObject({ status: "sent" });
    expect(softNotice(sent)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
    // With the cap now reached by that one confirmed delivery, a third send is blocked
    // before the Gateway call.
    const blocked = await tool.execute("c3", args);
    expectSchemaValidCappedResult(blocked);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("lets an idempotent replay through the cap without double-counting or a fresh nudge", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    // 1st send consumes the single-send budget.
    const first = await tool.execute("call-1", args);
    expect(first.details).toMatchObject({ status: "sent" });
    expect(softNotice(first)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);

    // Same toolCallId again -> same operationId. The Gateway resolves it to the
    // completed operation and returns "sent" without re-delivering, so it must not be
    // capped, must reach the Gateway, and must neither double-count nor nudge afresh.
    const replay = await tool.execute("call-1", args);
    expect(replay.details).toMatchObject({ status: "sent" });
    expect(softNotice(replay)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);

    // A THIRD, distinct toolCallId is a genuinely new send and is blocked by the cap
    // that the single counted delivery already reached.
    const blocked = await tool.execute("call-2", args);
    expectSchemaValidCappedResult(blocked);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("resets the count for a new turn (new runId)", async () => {
    const deps = createDeps();
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await createConversationsSendTool(budgetOptions, deps).execute("c1", args);
    const nextTurn = createConversationsSendTool({ ...budgetOptions, runId: "run-conv-2" }, deps);
    const result = await nextTurn.execute("c1", args);
    expect(softNotice(result)).toBeUndefined();
  });

  it("blocks before the Gateway call once the opt-in hard cap is reached", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
    const blocked = await tool.execute("c2", args);
    expectSchemaValidCappedResult(blocked);
    // The blocked send never reached the Gateway.
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses the soft reminder when turnSendNudge is disabled", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      { ...budgetOptions, config: { tools: { message: { turnSendNudge: false } } } },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    const second = await tool.execute("c2", args);
    // The nudge is gated off, but both sends still reached the Gateway.
    expect(softNotice(second)).toBeUndefined();
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("still enforces the hard cap when turnSendNudge is disabled", async () => {
    const deps = createDeps();
    const tool = createConversationsSendTool(
      {
        ...budgetOptions,
        config: { tools: { message: { maxMessagesPerTurnPerTarget: 1, turnSendNudge: false } } },
      },
      deps,
    );
    const args = { conversationRef: conversation.conversationRef, message: "hi" };
    await tool.execute("c1", args);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
    const blocked = await tool.execute("c2", args);
    // Counting still ran past the first send, so the cap blocks the second.
    expectSchemaValidCappedResult(blocked);
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });
});

describe("message and conversations_send share the per-turn budget", () => {
  // Both tools route to the same real recipient reef:peer-agent under the default
  // account: the message tool resolves it as an explicit target, and the registry
  // resolves the conv ref to the same (channel, account, target). Alternating them
  // must therefore share one ledger key rather than evade the nudge and hard cap.
  const sessionKey = "agent:main:reef:direct:operator";
  const runId = "run-mixed-1";
  const peerTarget = conversation.target;

  function softNotice(result: { content: Array<{ type: string; text?: string }> }) {
    return result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .find((text) => text.includes("already sent"));
  }

  function createMixedMessageTool(config: Record<string, unknown>) {
    return createMessageTool({
      currentChannelProvider: "reef",
      currentChannelId: "reef:operator",
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId,
      sourceReplyDeliveryMode: "message_tool_only",
      config: config as never,
      runMessageAction: (async () =>
        ({
          kind: "send",
          action: "send",
          channel: "reef",
          to: peerTarget,
          handledBy: "plugin",
          payload: {},
          dryRun: false,
        }) satisfies MessageActionResult) as never,
      resolveCommandSecretRefsViaGateway: (async ({ config: cfg }: { config: unknown }) => ({
        resolvedConfig: cfg,
        diagnostics: [],
      })) as never,
      getScopedChannelsCommandSecretTargets: (() => ({ targetIds: new Set<string>() })) as never,
    });
  }

  async function sendViaMessageTool(tool: ReturnType<typeof createMessageTool>, message: string) {
    return tool.execute(`msg-${message}`, {
      action: "send",
      channel: "reef",
      to: peerTarget,
      message,
    });
  }

  it("nudges on the second cross-tool send and blocks the third at the cap", async () => {
    const config = { tools: { message: { maxMessagesPerTurnPerTarget: 2 } } };
    const deps = createDeps();
    const messageTool = createMixedMessageTool(config);
    const conversationTool = createConversationsSendTool(
      { agentId: "main", agentSessionKey: sessionKey, runId, config: config as never },
      deps,
    );

    // 1st send (message tool): silent.
    const first = await sendViaMessageTool(messageTool, "hello");
    expect(softNotice(first)).toBeUndefined();

    // 2nd send (conversations_send, same recipient): nudge fires despite the tool switch.
    const second = await conversationTool.execute("conv-1", {
      conversationRef: conversation.conversationRef,
      message: "hello again",
    });
    expect(softNotice(second)).toContain("already sent 2 messages");

    // 3rd send (message tool again): blocked by the shared cap of 2.
    const third = await sendViaMessageTool(messageTool, "third variant");
    expect(third.details).toMatchObject({
      status: "suppressed",
      reason: "turn_send_budget_exhausted",
    });
    // The blocked send never reached the runner-backed gateway path.
    expect(deps.callGatewayMock).toHaveBeenCalledTimes(1);
  });

  // A no-target source reply must resolve to the concrete current target, not a
  // sentinel: the operator is replying to reef:peer-agent, which is also the conv
  // ref's target. Its ledger key must equal the one conversations_send builds for
  // the same peer, or alternating them evades the cap.
  function createSourceReplyMessageTool(config: Record<string, unknown>) {
    return createMessageTool({
      currentChannelProvider: "reef",
      currentChannelId: "reef:operator",
      // The current source's real target is the peer the conv ref also points at.
      currentMessagingTarget: peerTarget,
      agentAccountId: "default",
      agentSessionKey: sessionKey,
      runId,
      sourceReplyDeliveryMode: "message_tool_only",
      config: config as never,
      runMessageAction: (async () =>
        ({
          kind: "send",
          action: "send",
          channel: "reef",
          to: peerTarget,
          handledBy: "plugin",
          payload: {},
          dryRun: false,
        }) satisfies MessageActionResult) as never,
      resolveCommandSecretRefsViaGateway: (async ({ config: cfg }: { config: unknown }) => ({
        resolvedConfig: cfg,
        diagnostics: [],
      })) as never,
      getScopedChannelsCommandSecretTargets: (() => ({ targetIds: new Set<string>() })) as never,
    });
  }

  it("caps a conversations_send that follows a no-target source reply to the same peer", async () => {
    const config = { tools: { message: { maxMessagesPerTurnPerTarget: 1 } } };
    const deps = createDeps();
    const messageTool = createSourceReplyMessageTool(config);
    const conversationTool = createConversationsSendTool(
      { agentId: "main", agentSessionKey: sessionKey, runId, config: config as never },
      deps,
    );

    // 1st send (message tool, NO explicit target): resolves to the current source's
    // concrete target and consumes the single-send budget for that peer.
    const first = await messageTool.execute("msg-source", { action: "send", message: "hello" });
    expect(first.details).not.toMatchObject({ status: "suppressed" });

    // 2nd send (conversations_send, same peer): blocked by the shared cap of 1, so the
    // no-target source key and the conv-ref key must be one and the same slot.
    const blocked = await conversationTool.execute("conv-1", {
      conversationRef: conversation.conversationRef,
      message: "hello again",
    });
    // conversations_send returns the closed-schema suppressed shape (no reason field);
    // the block reason rides in the text content.
    expect(blocked.details).toEqual({
      status: "suppressed",
      conversationRef: conversation.conversationRef,
      channel: "reef",
    });
    // The blocked send never reached the Gateway.
    expect(deps.callGatewayMock).not.toHaveBeenCalled();
  });
});
