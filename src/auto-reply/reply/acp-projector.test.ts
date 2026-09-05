// Tests ACP event projection into session updates and reply payloads.
import { describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

type Delivery = { kind: string; text?: string };

function countMatching<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (const item of items) {
    if (predicate(item)) {
      count += 1;
    }
  }
  return count;
}

function createProjectorHarness(
  cfgOverrides?: Parameters<typeof createCfg>[0],
  opts?: {
    onProgress?: () => void;
    shouldSendToolSummaries?: boolean;
    shouldSendToolSummariesNow?: () => boolean;
    shouldSendFullToolDetails?: boolean;
    getConversationContext?: () => string | undefined;
  },
) {
  const deliveries: Delivery[] = [];
  const projector = createAcpReplyProjector({
    cfg: createCfg(cfgOverrides),
    shouldSendToolSummaries: opts?.shouldSendToolSummaries ?? true,
    shouldSendToolSummariesNow: opts?.shouldSendToolSummariesNow,
    shouldSendFullToolDetails: opts?.shouldSendFullToolDetails ?? false,
    deliver: async (kind, payload) => {
      deliveries.push({ kind, text: payload.text });
      return true;
    },
    getConversationContext: opts?.getConversationContext,
    onProgress: opts?.onProgress,
  });
  return { deliveries, projector };
}

function createStreamHarness(
  deliveryMode: "live" | "final_only",
  streamOverrides: Record<string, unknown> = {},
  opts?: Parameters<typeof createProjectorHarness>[1],
) {
  return createProjectorHarness(
    {
      acp: { enabled: true, stream: { deliveryMode, ...streamOverrides } },
    } as Parameters<typeof createCfg>[0],
    opts,
  );
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

const statusAndToolTagVisibility = { available_commands_update: true, tool_call: true };

function createFinalOnlyStatusToolHarness(opts?: Parameters<typeof createProjectorHarness>[1]) {
  return createStreamHarness("final_only", { tagVisibility: statusAndToolTagVisibility }, opts);
}

function createLiveToolLifecycleHarness(params?: {
  repeatSuppression?: boolean;
  includeStatus?: boolean;
}) {
  const { includeStatus = false, ...streamOverrides } = params ?? {};
  return createStreamHarness("live", {
    ...streamOverrides,
    tagVisibility: {
      ...(includeStatus ? { available_commands_update: true } : {}),
      tool_call: true,
      tool_call_update: true,
    },
  });
}

type Projector = ReturnType<typeof createProjectorHarness>["projector"];
type ProjectorEvent = Parameters<Projector["onEvent"]>[0];
type EventOf<T extends ProjectorEvent["type"]> = Extract<ProjectorEvent, { type: T }>;

function emitText(
  projector: Projector,
  text: string,
  overrides: Partial<Omit<EventOf<"text_delta">, "type" | "text">> = {},
) {
  return projector.onEvent({ type: "text_delta", text, tag: "agent_message_chunk", ...overrides });
}

function emitStatus(
  projector: Projector,
  text: string,
  tag: EventOf<"status">["tag"],
  overrides: Partial<Omit<EventOf<"status">, "type" | "text" | "tag">> = {},
) {
  return projector.onEvent({ type: "status", text, tag, ...overrides });
}

function emitTool(projector: Projector, event: Omit<EventOf<"tool_call">, "type">) {
  return projector.onEvent({ type: "tool_call", ...event });
}

async function runHiddenBoundaryCase(params: {
  streamOverrides?: Record<string, unknown>;
  toolCallId: string;
  includeNonTerminalUpdate?: boolean;
  firstText?: string;
  secondText?: string;
  expectedText: string;
}) {
  const { deliveries, projector } = createStreamHarness("live", params.streamOverrides);
  await emitText(projector, params.firstText ?? "fallback.");
  await emitTool(projector, {
    tag: "tool_call",
    toolCallId: params.toolCallId,
    status: "in_progress",
    title: "Run test",
    text: "Run test (in_progress)",
  });
  if (params.includeNonTerminalUpdate) {
    await emitTool(projector, {
      tag: "tool_call_update",
      toolCallId: params.toolCallId,
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
  }
  await emitText(projector, params.secondText ?? "I don't");
  await projector.flush(true);

  expect(combinedBlockText(deliveries)).toBe(params.expectedText);
}

describe("createAcpReplyProjector", () => {
  it("shows execute details only in full verbose mode", async () => {
    const summary = createLiveToolLifecycleHarness();
    await emitTool(summary.projector, {
      tag: "tool_call",
      toolCallId: "call_execute_summary",
      kind: "execute",
      status: "in_progress",
      title: "exec: cat /private/operator-file",
      text: "exec: cat /private/operator-file (in_progress)",
    });
    expect(summary.deliveries[0]?.text).not.toContain("cat /private/operator-file");
    expect(summary.deliveries[0]?.text).toContain("status=in_progress");

    const full = createStreamHarness(
      "live",
      { tagVisibility: { tool_call: true } },
      { shouldSendFullToolDetails: true },
    );
    await emitTool(full.projector, {
      tag: "tool_call",
      toolCallId: "call_execute_full",
      kind: "execute",
      status: "in_progress",
      title: "exec: cat /private/operator-file",
      text: "exec: cat /private/operator-file (in_progress)",
    });
    expect(full.deliveries[0]?.text).toContain("cat /private/operator-file");
  });

  it("reports progress for ACP runtime events before delivery filtering", async () => {
    const onProgress = vi.fn();
    const { projector } = createProjectorHarness(undefined, { onProgress });

    await emitText(projector, "hidden reasoning", { stream: "thought" });
    await emitTool(projector, {
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

    await emitText(projector, "a".repeat(70));
    await projector.flush(true);

    expect(deliveries).toEqual([{ kind: "final", text: "a".repeat(70) }]);
  });

  it.each(["live", "final_only"] as const)(
    "uses finalized and refreshed owner context to redact split private prompts in %s mode",
    async (deliveryMode) => {
      const marker = "[Current message - respond to this]";
      let conversationContext = "";
      const { deliveries, projector } = createStreamHarness(
        deliveryMode,
        {},
        {
          getConversationContext: () => conversationContext,
        },
      );
      conversationContext = `${marker}\nPrivate secret. Keep hidden.`;

      await emitText(projector, "Visible answer before. ");
      conversationContext = `${marker}\nPrivate updated context. Keep hidden.`;
      await emitText(projector, `${marker}\nPrivate updated context. `);
      await emitText(projector, "Keep hidden. Visible answer after.");
      await projector.flush(true);

      expect(deliveries.map((delivery) => delivery.text).join("")).toBe(
        "Visible answer before.  Visible answer after.",
      );
    },
  );

  it("rechecks the dynamic tool-summary gate for each ACP event", async () => {
    let allowToolSummaries = false;
    const { deliveries, projector } = createStreamHarness(
      "live",
      {
        tagVisibility: {
          tool_call: true,
        },
      },
      {
        shouldSendToolSummaries: false,
        shouldSendToolSummariesNow: () => allowToolSummaries,
      },
    );

    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "tool-1",
      status: "in_progress",
      title: "Run hidden command",
      text: "Run hidden command",
    });
    expect(deliveries).toEqual([]);

    allowToolSummaries = true;
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "tool-2",
      status: "in_progress",
      title: "Run visible command",
      text: "Run visible command",
    });

    expectToolCallSummary(deliveries[0]);
  });

  it("drops buffered final-only tool summaries when the dynamic gate turns off before flush", async () => {
    let allowToolSummaries = true;
    const { deliveries, projector } = createFinalOnlyStatusToolHarness({
      shouldSendToolSummariesNow: () => allowToolSummaries,
    });

    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "tool-1",
      status: "in_progress",
      title: "Run hidden command",
      text: "Run hidden command",
    });
    await emitText(projector, "done");
    allowToolSummaries = false;

    await projector.flush(true);

    expect(deliveries).toEqual([{ kind: "final", text: "done" }]);
  });

  it("preserves final-only text boundary when a buffered tool summary is dropped", async () => {
    let allowToolSummaries = true;
    const { deliveries, projector } = createStreamHarness(
      "final_only",
      {
        tagVisibility: {
          tool_call: true,
        },
      },
      { shouldSendToolSummariesNow: () => allowToolSummaries },
    );

    await emitText(projector, "fallback.");
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "tool-dropped-before-flush",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await emitText(projector, "I don't");
    allowToolSummaries = false;

    await projector.flush(true);

    expect(deliveries).toEqual([{ kind: "final", text: "fallback.\n\nI don't" }]);
  });

  it("flushes staggered live text deltas after idle gaps", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createStreamHarness("live");

      await emitText(projector, "A");
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await emitText(projector, "B");
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await emitText(projector, "C");
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

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createStreamHarness("live");

      await emitText(projector, "Yes. Send me the term(s), and I’ll run ");

      await vi.advanceTimersByTimeAsync(1200);
      expect(deliveries).toStrictEqual([]);

      await emitText(projector, "`wd-cli` searches right away. ");
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

    await emitText(projector, "What");
    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitText(projector, " now?");
    expect(deliveries).toStrictEqual([]);

    await projector.flush(true);
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

    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "call_2",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    expect(deliveries).toStrictEqual([]);

    await projector.flush(true);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
  });

  it("suppresses usage_update by default and allows deduped usage when tag-visible", async () => {
    const { deliveries: hidden, projector: hiddenProjector } = createProjectorHarness();
    await emitStatus(hiddenProjector, "usage updated: 10/100", "usage_update", {
      used: 10,
      size: 100,
    });
    expect(hidden).toStrictEqual([]);

    const { deliveries: shown, projector: shownProjector } = createStreamHarness("live", {
      tagVisibility: {
        usage_update: true,
      },
    });

    await emitStatus(shownProjector, "usage updated: 10/100", "usage_update", {
      used: 10,
      size: 100,
    });
    await emitStatus(shownProjector, "usage updated: 10/100", "usage_update", {
      used: 10,
      size: 100,
    });
    await emitStatus(shownProjector, "usage updated: 11/100", "usage_update", {
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
    await emitStatus(projector, "available commands updated (7)", "available_commands_update");

    expect(deliveries).toStrictEqual([]);
  });

  it("dedupes repeated tool lifecycle updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitTool(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await emitTool(projector, {
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });
    await emitTool(projector, {
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
    const { deliveries, projector } = createLiveToolLifecycleHarness({});

    const longTitle =
      "Run an intentionally long command title that truncates before lifecycle status is visible";
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "call_truncated_status",
      status: "in_progress",
      title: longTitle,
      text: `${longTitle} (in_progress)`,
    });
    await emitTool(projector, {
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

    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "call_ABC123",
      status: "in_progress",
      text: "call_ABC123 (in_progress)",
    });

    expectToolCallSummary(deliveries[0]);
    expect(deliveries[0]?.text).not.toContain("call_ABC123 (");
  });

  it("allows repeated status/tool summaries when repeatSuppression is disabled", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness({
      repeatSuppression: false,
      includeStatus: true,
    });

    await emitStatus(projector, "available commands updated", "available_commands_update");
    await emitStatus(projector, "available commands updated", "available_commands_update");
    await emitTool(projector, {
      text: "tool call",
      tag: "tool_call",
      toolCallId: "x",
      status: "in_progress",
    });
    await emitTool(projector, {
      text: "tool call",
      tag: "tool_call_update",
      toolCallId: "x",
      status: "in_progress",
    });
    await emitText(projector, "hello");
    await projector.flush(true);

    expect(countMatching(deliveries, (entry) => entry.kind === "tool")).toBe(4);
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
    const { deliveries, projector } = createStreamHarness("live", {
      tagVisibility: {
        available_commands_update: true,
      },
    });

    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitStatus(projector, "available commands updated (7)", "available_commands_update");
    await emitStatus(projector, "available commands updated (8)", "available_commands_update");

    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: prefixSystemMessage("available commands updated (8)") },
    ]);
  });

  it("supports tagVisibility overrides for tool updates", async () => {
    const { deliveries, projector } = createStreamHarness("live", {
      tagVisibility: {
        tool_call: true,
        tool_call_update: false,
      },
    });

    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "c1",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    await emitTool(projector, {
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
      toolCallId: "call_hidden_1",
      expectedText: "fallback. I don't",
    });
  });

  it("preserves hidden boundary when the dynamic tool-summary gate hides a visible tool event", async () => {
    const { deliveries, projector } = createStreamHarness(
      "live",
      {
        tagVisibility: {
          tool_call: true,
        },
      },
      {
        shouldSendToolSummaries: false,
        shouldSendToolSummariesNow: () => false,
      },
    );

    await emitText(projector, "fallback.");
    await emitTool(projector, {
      tag: "tool_call",
      toolCallId: "call_dynamic_hidden",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await emitText(projector, "I don't");
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toBe("fallback. I don't");
    expect(deliveries.some((delivery) => delivery.kind === "tool")).toBe(false);
  });

  it("preserves hidden boundary across nonterminal hidden tool updates", async () => {
    await runHiddenBoundaryCase({
      streamOverrides: {
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      },
      toolCallId: "hidden_boundary_1",
      includeNonTerminalUpdate: true,
      expectedText: "fallback. I don't",
    });
  });

  it("uses the built-in space separator for hidden live boundaries", async () => {
    await runHiddenBoundaryCase({
      toolCallId: "call_hidden_2",
      expectedText: "fallback. I don't",
    });
  });

  it("does not duplicate newlines when previous visible text already ends with newline", async () => {
    await runHiddenBoundaryCase({
      toolCallId: "call_hidden_4",
      firstText: "fallback.\n",
      expectedText: "fallback.\nI don't",
    });
  });

  it("does not insert boundary separator for hidden non-tool status updates", async () => {
    const { deliveries, projector } = createStreamHarness("live");

    await emitText(projector, "A");
    await emitStatus(projector, "available commands updated", "available_commands_update");
    await emitText(projector, "B");
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toBe("AB");
  });
});
