import { describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

type Delivery = { kind: string; text?: string };

function createProjectorHarness(
  cfgOverrides?: Parameters<typeof createCfg>[0],
  opts?: { onProgress?: () => void },
) {
  const deliveries: Delivery[] = [];
  const projector = createAcpReplyProjector({
    cfg: createCfg(cfgOverrides),
    shouldSendToolSummaries: true,
    deliver: async (kind, payload) => {
      deliveries.push({ kind, text: payload.text });
      return true;
    },
    onProgress: opts?.onProgress,
  });
  return { deliveries, projector };
}

function createLiveCfgOverrides(
  streamOverrides: Record<string, unknown>,
): Parameters<typeof createCfg>[0] {
  return {
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...streamOverrides,
      },
    },
  } as Parameters<typeof createCfg>[0];
}

function createHiddenBoundaryCfg(
  streamOverrides: Record<string, unknown> = {},
): Parameters<typeof createCfg>[0] {
  return createLiveCfgOverrides({
    coalesceIdleMs: 0,
    maxChunkChars: 256,
    ...streamOverrides,
  });
}

function blockDeliveries(deliveries: Delivery[]) {
  return deliveries.filter((entry) => entry.kind === "block");
}

function combinedBlockText(deliveries: Delivery[]) {
  return blockDeliveries(deliveries)
    .map((entry) => entry.text ?? "")
    .join("");
}

function expectToolCallSummary(delivery: Delivery | undefined) {
  expect(delivery?.kind).toBe("tool");
  expect(delivery?.text).toContain("Tool Call");
}

function createFinalOnlyStatusToolHarness() {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        maxChunkChars: 512,
        deliveryMode: "final_only",
        tagVisibility: {
          available_commands_update: true,
          tool_call: true,
        },
      },
    },
  });
}

function createLiveToolLifecycleHarness(params?: {
  coalesceIdleMs?: number;
  maxChunkChars?: number;
  maxSessionUpdateChars?: number;
  repeatSuppression?: boolean;
}) {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...params,
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

function createLiveStatusAndToolLifecycleHarness(params?: {
  coalesceIdleMs?: number;
  maxChunkChars?: number;
  repeatSuppression?: boolean;
}) {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...params,
        tagVisibility: {
          available_commands_update: true,
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

async function emitToolLifecycleEvent(
  projector: ReturnType<typeof createProjectorHarness>["projector"],
  event: {
    tag: "tool_call" | "tool_call_update";
    toolCallId: string;
    status: "in_progress" | "completed";
    title?: string;
    text: string;
  },
) {
  await projector.onEvent({
    type: "tool_call",
    ...event,
  });
}

async function runHiddenBoundaryCase(params: {
  cfgOverrides?: Parameters<typeof createCfg>[0];
  toolCallId: string;
  includeNonTerminalUpdate?: boolean;
  firstText?: string;
  secondText?: string;
  expectedText: string;
}) {
  const { deliveries, projector } = createProjectorHarness(params.cfgOverrides);
  await projector.onEvent({
    type: "text_delta",
    text: params.firstText ?? "fallback.",
    tag: "agent_message_chunk",
  });
  await projector.onEvent({
    type: "tool_call",
    tag: "tool_call",
    toolCallId: params.toolCallId,
    status: "in_progress",
    title: "Run test",
    text: "Run test (in_progress)",
  });
  if (params.includeNonTerminalUpdate) {
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: params.toolCallId,
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
  }
  await projector.onEvent({
    type: "text_delta",
    text: params.secondText ?? "I don't",
    tag: "agent_message_chunk",
  });
  await projector.flush(true);

  expect(combinedBlockText(deliveries)).toBe(params.expectedText);
}

describe("createAcpReplyProjector", () => {
  it("reports progress for ACP runtime events before delivery filtering", async () => {
    const onProgress = vi.fn();
    const { projector } = createProjectorHarness(undefined, { onProgress });

    await projector.onEvent({
      type: "text_delta",
      stream: "thought",
      text: "hidden reasoning",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "tool-1",
      status: "in_progress",
      title: "Run command",
      text: "Run command",
    });

    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("buffers default final-only text into one final reply", async () => {
    const { deliveries, projector } = createProjectorHarness();

    await projector.onEvent({
      type: "text_delta",
      text: "a".repeat(70),
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([{ kind: "final", text: "a".repeat(70) }]);
  });

  it("does not suppress identical short text across terminal turn boundaries", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 64,
      }),
    );

    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });
    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });

    expect(blockDeliveries(deliveries)).toEqual([
      { kind: "block", text: "A" },
      { kind: "block", text: "A" },
    ]);
  });

  it("flushes staggered live text deltas after idle gaps", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createProjectorHarness(
        createLiveCfgOverrides({
          coalesceIdleMs: 50,
          maxChunkChars: 64,
        }),
      );

      await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ type: "text_delta", text: "B", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ type: "text_delta", text: "C", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      expect(blockDeliveries(deliveries)).toEqual([
        { kind: "block", text: "A" },
        { kind: "block", text: "B" },
        { kind: "block", text: "C" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits oversized live text by maxChunkChars", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          deliveryMode: "live",
          coalesceIdleMs: 0,
          maxChunkChars: 50,
        },
      },
    });

    const text = `${"a".repeat(50)}${"b".repeat(50)}${"c".repeat(20)}`;
    await projector.onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
    await projector.flush(true);

    expect(blockDeliveries(deliveries)).toEqual([
      { kind: "block", text: "a".repeat(50) },
      { kind: "block", text: "b".repeat(50) },
      { kind: "block", text: "c".repeat(20) },
    ]);
  });

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createProjectorHarness(
        createLiveCfgOverrides({
          coalesceIdleMs: 100,
          maxChunkChars: 256,
        }),
      );

      await projector.onEvent({
        type: "text_delta",
        text: "Yes. Send me the term(s), and I’ll run ",
        tag: "agent_message_chunk",
      });

      await vi.advanceTimersByTimeAsync(1200);
      expect(deliveries).toEqual([]);

      await projector.onEvent({
        type: "text_delta",
        text: "`wd-cli` searches right away. ",
        tag: "agent_message_chunk",
      });
      await projector.flush(false);

      expect(deliveries).toEqual([
        {
          kind: "block",
          text: "Yes. Send me the term(s), and I’ll run `wd-cli` searches right away. ",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports deliveryMode=final_only by buffering all projected output until done", async () => {
    const { deliveries, projector } = createFinalOnlyStatusToolHarness();

    await projector.onEvent({
      type: "text_delta",
      text: "What",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await projector.onEvent({
      type: "text_delta",
      text: " now?",
      tag: "agent_message_chunk",
    });
    expect(deliveries).toEqual([]);

    await projector.onEvent({ type: "done" });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
    expect(deliveries[2]).toEqual({ kind: "final", text: "What now?" });
  });

  it("flushes buffered status/tool output on error in deliveryMode=final_only", async () => {
    const { deliveries, projector } = createFinalOnlyStatusToolHarness();

    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_2",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    expect(deliveries).toEqual([]);

    await projector.onEvent({ type: "error", message: "turn failed" });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
  });

  it("suppresses usage_update by default and allows deduped usage when tag-visible", async () => {
    const { deliveries: hidden, projector: hiddenProjector } = createProjectorHarness();
    await hiddenProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    expect(hidden).toEqual([]);

    const { deliveries: shown, projector: shownProjector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 64,
        tagVisibility: {
          usage_update: true,
        },
      }),
    );

    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 11/100",
      tag: "usage_update",
      used: 11,
      size: 100,
    });

    expect(shown).toEqual([
      { kind: "tool", text: prefixSystemMessage("usage updated: 10/100") },
      { kind: "tool", text: prefixSystemMessage("usage updated: 11/100") },
    ]);
  });

  it("hides available_commands_update by default", async () => {
    const { deliveries, projector } = createProjectorHarness();
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });

    expect(deliveries).toEqual([]);
  });

  it("dedupes repeated tool lifecycle updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });

    expect(deliveries.length).toBe(2);
    expectToolCallSummary(deliveries[0]);
    expectToolCallSummary(deliveries[1]);
  });

  it("keeps terminal tool updates even when rendered summaries are truncated", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness({
      maxSessionUpdateChars: 48,
    });

    const longTitle =
      "Run an intentionally long command title that truncates before lifecycle status is visible";
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call",
      toolCallId: "call_truncated_status",
      status: "in_progress",
      title: longTitle,
      text: `${longTitle} (in_progress)`,
    });
    await emitToolLifecycleEvent(projector, {
      tag: "tool_call_update",
      toolCallId: "call_truncated_status",
      status: "completed",
      title: longTitle,
      text: `${longTitle} (completed)`,
    });

    expect(deliveries.length).toBe(2);
    expectToolCallSummary(deliveries[0]);
    expectToolCallSummary(deliveries[1]);
  });

  it("renders fallback tool labels without leaking call ids as primary label", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_ABC123",
      status: "in_progress",
      text: "call_ABC123 (in_progress)",
    });

    expectToolCallSummary(deliveries[0]);
    expect(deliveries[0]?.text).not.toContain("call_ABC123 (");
  });

  it("allows repeated status/tool summaries when repeatSuppression is disabled", async () => {
    const { deliveries, projector } = createLiveStatusAndToolLifecycleHarness({
      coalesceIdleMs: 0,
      maxChunkChars: 256,
      repeatSuppression: false,
    });

    await projector.onEvent({
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      text: "tool call",
      tag: "tool_call",
      toolCallId: "x",
      status: "in_progress",
    });
    await projector.onEvent({
      type: "tool_call",
      text: "tool call",
      tag: "tool_call_update",
      toolCallId: "x",
      status: "in_progress",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "hello",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries.filter((entry) => entry.kind === "tool").length).toBe(4);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expect(deliveries[1]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expectToolCallSummary(deliveries[2]);
    expectToolCallSummary(deliveries[3]);
    expect(deliveries[4]).toEqual({ kind: "block", text: "hello" });
  });

  it("suppresses exact duplicate status updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 256,
        tagVisibility: {
          available_commands_update: true,
        },
      }),
    );

    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (8)",
      tag: "available_commands_update",
    });

    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: prefixSystemMessage("available commands updated (8)") },
    ]);
  });

  it("truncates oversized turns once and emits one truncation notice", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 256,
          deliveryMode: "live",
          maxOutputChars: 5,
        },
      },
    });

    await projector.onEvent({
      type: "text_delta",
      text: "hello world",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "ignored tail",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toHaveLength(2);
    expect(deliveries).toContainEqual({ kind: "block", text: "hello" });
    expect(deliveries).toContainEqual({
      kind: "tool",
      text: prefixSystemMessage("output truncated"),
    });
  });

  it("supports tagVisibility overrides for tool updates", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 256,
          deliveryMode: "live",
          tagVisibility: {
            tool_call: true,
            tool_call_update: false,
          },
        },
      },
    });

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "c1",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      title: "Run tests",
      text: "Run tests (completed)",
    });

    expect(deliveries.length).toBe(1);
    expectToolCallSummary(deliveries[0]);
  });

  it("inserts a space boundary before visible text after hidden tool updates by default", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg(),
      toolCallId: "call_hidden_1",
      expectedText: "fallback. I don't",
    });
  });

  it("preserves hidden boundary across nonterminal hidden tool updates", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      toolCallId: "hidden_boundary_1",
      includeNonTerminalUpdate: true,
      expectedText: "fallback. I don't",
    });
  });

  it("supports hiddenBoundarySeparator=space", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        hiddenBoundarySeparator: "space",
      }),
      toolCallId: "call_hidden_2",
      expectedText: "fallback. I don't",
    });
  });

  it("supports hiddenBoundarySeparator=none", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        hiddenBoundarySeparator: "none",
      }),
      toolCallId: "call_hidden_3",
      expectedText: "fallback.I don't",
    });
  });

  it("does not duplicate newlines when previous visible text already ends with newline", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg(),
      toolCallId: "call_hidden_4",
      firstText: "fallback.\n",
      expectedText: "fallback.\nI don't",
    });
  });

  it("does not insert boundary separator for hidden non-tool status updates", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          maxChunkChars: 256,
          deliveryMode: "live",
        },
      },
    });

    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "status",
      tag: "available_commands_update",
      text: "available commands updated",
    });
    await projector.onEvent({ type: "text_delta", text: "B", tag: "agent_message_chunk" });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toBe("AB");
  });
});
