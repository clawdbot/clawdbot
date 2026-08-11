import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
// Tool handler tests cover tool lifecycle events, read-path diagnostics,
// messaging tool capture, approvals, and emitted summaries.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onAgentEvent as registerAgentEventListener,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import {
  buildBlockedToolResult,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
} from "./agent-tools.before-tool-call.js";
import {
  adjustedParamsByToolCallId,
  buildAdjustedParamsKey,
  recordToolExecutionTracked,
} from "./agent-tools.before-tool-call.state.js";
import type { MessagingToolSend } from "./embedded-agent-messaging.types.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./embedded-agent-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./embedded-agent-subscribe.handlers.types.js";
import {
  createAskUserTool,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
} from "./tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./tools/ask-user-tool.test-support.js";

type ToolExecutionStartEvent = Omit<Extract<AgentEvent, { type: "tool_execution_start" }>, "type">;
type ToolExecutionEndEvent = Omit<Extract<AgentEvent, { type: "tool_execution_end" }>, "type">;
type ToolExecutionUpdateEvent = {
  toolName: string;
  toolCallId: string;
  args?: unknown;
  partialResult?: unknown;
  hideFromChannelProgress?: boolean;
};

function startTool(ctx: ToolHandlerContext, event: ToolExecutionStartEvent) {
  return handleToolExecutionStart(ctx, { type: "tool_execution_start", ...event });
}

function endTool(ctx: ToolHandlerContext, event: ToolExecutionEndEvent) {
  return handleToolExecutionEnd(ctx, { type: "tool_execution_end", ...event });
}

async function executeTool(
  ctx: ToolHandlerContext,
  event: ToolExecutionStartEvent & Omit<ToolExecutionEndEvent, "toolName" | "toolCallId">,
) {
  const { toolName, toolCallId, args, ...completion } = event;
  await startTool(ctx, { toolName, toolCallId, args });
  await endTool(ctx, { toolName, toolCallId, ...completion });
}

function updateTool(ctx: ToolHandlerContext, event: ToolExecutionUpdateEvent) {
  return handleToolExecutionUpdate(ctx, {
    type: "tool_execution_update",
    args: event.args ?? {},
    partialResult: event.partialResult,
    ...event,
  });
}

const pendingAskUserFinishes = new Set<() => Promise<void>>();

function createBasicAskUserArgs() {
  return {
    questions: [
      {
        id: "target",
        header: "Target",
        question: "Where next?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ],
  };
}

async function activateAskUserPrompt(toolCallId: string, args: unknown) {
  let questionId: string | undefined;
  let resolveAnswer: ((value: { status: "cancelled" }) => void) | undefined;
  const tool = createAskUserTool({
    sessionKey: "agent:unit-session",
    runId: "run-test",
    gatewayCall: async (method, _opts, params) => {
      if (method === "question.request") {
        if (!params || typeof params !== "object" || !("id" in params)) {
          throw new Error("question.request params missing id");
        }
        questionId = String(params.id);
        return { id: questionId };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          resolveAnswer = resolve;
        });
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  const pending = tool.execute(toolCallId, args);
  let finished = false;
  const finish = async () => {
    if (finished) {
      return;
    }
    finished = true;
    await vi.waitFor(() => expect(resolveAnswer).toBeTypeOf("function"));
    resolveAnswer?.({ status: "cancelled" });
    await pending;
    pendingAskUserFinishes.delete(finish);
  };
  pendingAskUserFinishes.add(finish);
  await vi.waitFor(() => expect(questionId).toBeTypeOf("string"));
  return { questionId: questionId!, finish };
}

afterEach(async () => {
  await Promise.all([...pendingAskUserFinishes].map((finish) => finish()));
  resetPendingAskUserQuestionsForTest();
});

const beforeToolCallTesting = { adjustedParamsByToolCallId, buildAdjustedParamsKey };

function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<
    typeof vi.fn<NonNullable<ToolHandlerContext["params"]["onBlockReplyFlush"]>>
  >;
  onAgentEvent: ReturnType<typeof vi.fn>;
  onExecutionPhase: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  isEnabled: ReturnType<typeof vi.fn>;
} {
  // Shared tool-handler fixture exposes the callbacks and state maps mutated by
  // start/update/end handlers without booting a full subscription.
  const onBlockReplyFlush = vi.fn<NonNullable<ToolHandlerContext["params"]["onBlockReplyFlush"]>>();
  const onAgentEvent = vi.fn();
  const onExecutionPhase = vi.fn();
  const warn = vi.fn();
  const trace = vi.fn();
  const isEnabled = vi.fn(() => false);
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      sessionKey: "agent:unit-session",
      sessionId: "session-test-id",
      agentId: "agent-test-id",
      onBlockReplyFlush,
      onAgentEvent,
      onExecutionPhase,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      trace,
      isEnabled,
      info: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      acceptedSessionSpawns: [],
      toolSummaryById: new Set<string>(),
      liveEditDiffStateById: new Map(),
      itemActiveIds: new Set<string>(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      pendingToolMediaUrls: [],
      pendingToolMediaTrustByUrl: new Map(),
      pendingToolAudioAsVoice: false,
      deterministicApprovalPromptPending: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      currentSourceMessagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSourceReplyPayloads: [],
      messageToolOnlySourceReplyDelivered: false,
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
      toolExecutionSinceLastBlockReply: false,
      assistantMessageIndex: 0,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush, onAgentEvent, onExecutionPhase, trace, isEnabled };
}

type CapturedAgentEvent = { stream?: string; data?: Record<string, unknown> };

function requireEvent(
  events: CapturedAgentEvent[],
  predicate: (event: CapturedAgentEvent) => boolean,
  label: string,
): CapturedAgentEvent {
  // Tool lifecycle tests emit multiple event streams; this helper makes the
  // expected event kind explicit before field assertions.
  const event = events.find(predicate);
  if (!event) {
    throw new Error(`expected ${label} event`);
  }
  return event;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label}`);
  }
  return value;
}

describe("update_plan progress events", () => {
  it("emits the typed full plan snapshot after a successful result", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    const emitted: CapturedAgentEvent[] = [];
    const unsubscribe = registerAgentEventListener((event) => emitted.push(event));
    try {
      await endTool(ctx, {
        toolName: "update_plan",
        toolCallId: "plan-1",
        isError: false,
        result: {
          content: [],
          details: {
            status: "updated",
            explanation: "Implementation underway",
            plan: [
              { step: "Inspect", status: "completed" },
              { step: "Patch", status: "in_progress" },
            ],
          },
        },
      });
      await Promise.resolve();

      const expected = {
        stream: "plan",
        data: {
          phase: "update",
          title: "Plan updated",
          source: "openclaw",
          explanation: "Implementation underway",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        },
      };
      expect(onAgentEvent).toHaveBeenCalledWith(expected);
      expect(emitted).toContainEqual(expect.objectContaining(expected));
    } finally {
      unsubscribe();
    }
  });
});

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  return requireRecord(mock.mock.calls[callIndex]?.[0], label);
}

function requireNestedRecord(value: unknown, label: string, path: string[]) {
  let current = value;
  for (const key of path) {
    current = requireRecord(current, label)[key];
  }
  return requireRecord(current, label);
}

function expectInteractiveApprovalButtons(
  result: Record<string, unknown>,
  expectedButtons: readonly Record<string, unknown>[],
) {
  const interactive = result.interactive;
  if (interactive === undefined) {
    expect(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
    ).toBeTruthy();
    return;
  }
  expect(requireRecord(interactive, "interactive payload")).toEqual({
    blocks: [{ type: "buttons", buttons: expectedButtons }],
  });
}

function requireSingleMessagingTarget(ctx: ToolHandlerContext) {
  const targets = ctx.state.messagingToolSentTargets;
  expect(targets).toHaveLength(1);
  return requireRecord(targets[0], "messaging target");
}

describe("handleToolExecutionStart read path checks", () => {
  it("delivers a numbered ask_user prompt with question id association", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const args = {
      questions: [
        {
          id: "deploy_target",
          header: "Target",
          question: "Where should this deploy?",
          options: [
            { label: "Staging (Recommended)", description: "Safer default" },
            { label: "Production" },
          ],
        },
      ],
    };

    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-call-1",
      args,
    });
    const activation = await activateAskUserPrompt("ask-call-1", args);
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    const { questionId } = activation;

    expect(onToolResult).toHaveBeenCalledWith({
      text: [
        "Question for you:",
        "",
        "Target",
        "Where should this deploy?",
        "1. Staging (Recommended) - Safer default",
        "2. Production",
        "Other: reply with your own answer.",
        "",
        "Reply with the number, the option text, or your own answer.",
      ].join("\n"),
      channelData: {
        askUser: {
          questionId,
          optionValues: ["Staging (Recommended)", "Production"],
        },
      },
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Where should this deploy?" },
          {
            type: "text",
            text: [
              "- Staging (Recommended): Safer default",
              "- Production",
              "",
              "Tap an option, or reply with the option text or your own answer.",
            ].join("\n"),
          },
          {
            type: "buttons",
            buttons: [
              {
                label: "Staging (Recommended)",
                action: {
                  type: "question",
                  questionId,
                  optionValue: "Staging (Recommended)",
                },
              },
              {
                label: "Production",
                action: {
                  type: "question",
                  questionId,
                  optionValue: "Production",
                },
              },
            ],
          },
        ],
      },
    });
    await activation.finish();
  });

  it.each([
    {
      name: "multi-question",
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Where next?",
          options: [{ label: "Staging" }, { label: "Production" }],
        },
        {
          id: "region",
          header: "Region",
          question: "Which region?",
          options: [{ label: "EU" }, { label: "US" }],
        },
      ],
    },
    {
      name: "multi-select",
      questions: [
        {
          id: "targets",
          header: "Targets",
          question: "Where next?",
          options: [{ label: "Staging" }, { label: "Production" }],
          multiSelect: true,
        },
      ],
    },
  ])("keeps $name ask_user prompts text-only", async ({ questions }) => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const toolCallId = `ask-${questions[0]?.id ?? "unknown"}`;

    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId,
      args: { questions },
    });
    const activation = await activateAskUserPrompt(toolCallId, { questions });
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());

    const payload = onToolResult.mock.calls[0]?.[0];
    expect(payload?.text).toContain(
      questions.length > 1
        ? "Reply by number or question id. Use a declared option where choices are fixed."
        : "Reply with the number, the option text, or your own answer.",
    );
    expect(payload).not.toHaveProperty("presentation");
    expect(payload).not.toHaveProperty("presentationTextMode");
    await activation.finish();
  });

  it("reserves ask_user before awaiting block-reply flush", async () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    let releaseFlush: (() => void) | undefined;
    onBlockReplyFlush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );
    const args = createBasicAskUserArgs();

    const pending = startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-flush",
      args,
    });
    const activation = await activateAskUserPrompt("ask-flush", args);
    await Promise.resolve();
    expect(onToolResult).not.toHaveBeenCalled();

    releaseFlush?.();
    await pending;
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    await activation.finish();
  });

  it.each(["buffer", "callback"] as const)(
    "releases ask_user reservation when the %s flush throws synchronously",
    (flushKind) => {
      const { ctx, onBlockReplyFlush } = createTestContext();
      ctx.params.onToolResult = vi.fn();
      const failure = new Error("flush failed");
      if (flushKind === "buffer") {
        vi.mocked(ctx.flushBlockReplyBuffer).mockImplementation(() => {
          throw failure;
        });
      } else {
        onBlockReplyFlush.mockImplementation(() => {
          throw failure;
        });
      }
      const args = createBasicAskUserArgs();

      expect(() =>
        startTool(ctx, {
          toolName: "ask_user",
          toolCallId: `ask-${flushKind}-failure`,
          args,
        }),
      ).toThrow(failure);
      expect(
        reserveAskUserPromptDelivery({
          toolCallId: `ask-${flushKind}-retry`,
          sessionKey: "agent:unit-session",
          questions: normalizeAskUserParams(args).questions,
        }),
      ).toBeDefined();
    },
  );

  it("delivers only the ask_user prompt that reserved the session slot", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const args = createBasicAskUserArgs();

    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-first",
      args,
    });
    const activation = await activateAskUserPrompt("ask-first", args);
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-second",
      args,
    });

    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        channelData: {
          askUser: {
            questionId: activation.questionId,
            optionValues: ["Staging", "Production"],
          },
        },
      }),
    );
    await activation.finish();
  });

  it("releases an undelivered ask_user reservation when execution is rejected", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const args = createBasicAskUserArgs();

    await executeTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-denied",
      args,
      isError: true,
      result: { content: [{ type: "text", text: "denied" }] },
    });
    await Promise.resolve();
    expect(onToolResult).not.toHaveBeenCalled();

    await startTool(ctx, {
      toolName: "ask_user",
      toolCallId: "ask-after-denial",
      args,
    });
    const activation = await activateAskUserPrompt("ask-after-denial", args);
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    await activation.finish();
  });

  it("emits trace-only tool start diagnostics when trace logging is enabled", async () => {
    const { ctx, trace, isEnabled, warn } = createTestContext();
    isEnabled.mockImplementation((level: string) => level === "trace");

    const evt: ToolExecutionStartEvent = {
      toolName: "write",
      toolCallId: "tool-trace",
      args: { path: "notes.txt" },
    };

    await startTool(ctx, evt);

    expect(warn).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace.mock.calls[0]?.[0]).toBe("embedded run tool start");
    expect(trace.mock.calls[0]?.[1]).toEqual({
      event: "embedded_tool_execution_start",
      tags: ["tool_start", "embedded", "trace"],
      runId: "run-test",
      toolName: "write",
      toolCallId: "tool-trace",
      argsType: "object",
      argsKeys: ["path"],
      sessionKey: "agent:unit-session",
      sessionId: "session-test-id",
      agentId: "agent-test-id",
      requiredParamsMissing: ["content"],
    });
  });

  it("does not build trace tool start diagnostics unless trace logging is enabled", async () => {
    const { ctx, trace, isEnabled } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      toolName: "write",
      toolCallId: "tool-trace-disabled",
      args: { path: "notes.txt" },
    };

    await startTool(ctx, evt);

    expect(isEnabled).toHaveBeenCalledWith("trace");
    expect(trace).not.toHaveBeenCalled();
  });

  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, trace, isEnabled, onBlockReplyFlush, onExecutionPhase } =
      createTestContext();
    isEnabled.mockImplementation((level: string) => level === "trace");

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-1",
      args: { file_path: "/tmp/example.txt" },
    };

    await startTool(ctx, evt);

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(onBlockReplyFlush).toHaveBeenCalledWith({
      reason: "tool_start",
      assistantMessageIndex: 0,
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      tool: "read",
      toolCallId: "tool-1",
      source: "embedded-agent",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace.mock.calls[0]?.[1]).not.toHaveProperty("requiredParamsMissing");
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-2",
      args: {},
    };

    await startTool(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    const warnMessage = String(warn.mock.calls[0]?.[0] ?? "");
    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(warnMessage).toContain("read tool called without path");
    expect(warnMeta).toBeTypeOf("object");
    expect(warnMeta?.event).toBe("embedded_read_tool_start_warning");
    expect(warnMeta?.tags).toEqual(["tool_start", "read", "embedded", "validation"]);
    expect(warnMeta?.runId).toBe("run-test");
    expect(warnMeta?.sessionKey).toBe("agent:unit-session");
    expect(warnMeta?.sessionId).toBe("session-test-id");
    expect(warnMeta?.agentId).toBe("agent-test-id");
    expect(warnMeta?.toolCallId).toBe("tool-2");
    expect(warnMeta?.argsType).toBe("object");
    expect(warnMeta?.consoleMessage).toContain("runId=run-test");
    expect(warnMeta?.consoleMessage).toContain("sessionKey=agent:unit-session");
    expect(warnMeta?.consoleMessage).toContain("sessionId=session-test-id");
    expect(warnMeta?.consoleMessage).toContain("agentId=agent-test-id");
    expect(warnMeta?.consoleMessage).toContain("toolCallId=tool-2");
    expect(warnMeta?.consoleMessage).toContain("argsType=object");
    expect(warnMeta?.consoleMessage).toContain("read tool called without path");
    expect(warnMeta).not.toHaveProperty("argsPreview");
  });

  it("bounds string args before adding read warning preview", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-string-args",
      args: "x".repeat(500),
    };

    await startTool(ctx, evt);

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const argsPreview = warnMeta?.argsPreview;
    expect(typeof argsPreview).toBe("string");
    expect(argsPreview).toBe(`${"x".repeat(200)}…`);
  });

  it("keeps read warning args previews on UTF-16 boundaries", async () => {
    const { ctx, warn } = createTestContext();
    const emoji = "😀";

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-surrogate-args",
      args: `${"x".repeat(200)}${emoji}tail`,
    };

    await startTool(ctx, evt);

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const argsPreview = warnMeta?.argsPreview;
    expect(typeof argsPreview).toBe("string");
    expect(argsPreview).toBe(`${"x".repeat(200)}…`);
    expect(argsPreview).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("marks astral-only read warning args previews as truncated", async () => {
    const { ctx, warn } = createTestContext();
    const emoji = "😀";

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-astral-args",
      args: emoji.repeat(101),
    };

    await startTool(ctx, evt);

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const argsPreview = warnMeta?.argsPreview;
    expect(typeof argsPreview).toBe("string");
    expect(argsPreview).toBe(`${emoji.repeat(100)}…`);
    expect(argsPreview).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("does not scan visible preview content beyond the raw warning bound", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-bounded-args",
      args: `${" ".repeat(200)}hidden`,
    };

    await startTool(ctx, evt);

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(warnMeta).not.toHaveProperty("argsPreview");
  });

  it("does not split surrogate pairs when bounding read warning preview", async () => {
    const { ctx, warn } = createTestContext();

    // Whitespace collapsing must not let a surrogate half from the raw cap survive sanitization.
    const evt: ToolExecutionStartEvent = {
      toolName: "read",
      toolCallId: "tool-surrogate-args",
      args: `${"x".repeat(198)}  🎉`,
    };

    await startTool(ctx, evt);

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(warnMeta?.argsPreview).toBe(`${"x".repeat(198)}…`);
  });

  it("awaits onBlockReplyFlush before continuing tool start processing", async () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    let releaseFlush: (() => void) | undefined;
    onBlockReplyFlush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        }),
    );

    const evt: ToolExecutionStartEvent = {
      toolName: "exec",
      toolCallId: "tool-await-flush",
      args: { command: "echo hi" },
    };

    const pending = startTool(ctx, evt);
    // Let the async function reach the awaited flush Promise.
    await Promise.resolve();

    // If flush isn't awaited, tool metadata would already be recorded here.
    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(false);
    expect(releaseFlush).toBeTypeOf("function");

    releaseFlush?.();
    await pending;

    expect(ctx.state.toolMetaById.has("tool-await-flush")).toBe(true);
    expect(ctx.state.itemStartedCount).toBe(2);
    expect(ctx.state.itemActiveIds.has("tool:tool-await-flush")).toBe(true);
    expect(ctx.state.itemActiveIds.has("command:tool-await-flush")).toBe(true);
  });

  it("keeps processing tool start when progress callbacks throw", async () => {
    const { ctx, warn, onExecutionPhase, onAgentEvent } = createTestContext();
    onExecutionPhase.mockImplementation(() => {
      throw new Error("phase exploded");
    });
    onAgentEvent.mockImplementation(() => {
      throw new Error("event exploded");
    });

    const evt: ToolExecutionStartEvent = {
      toolName: "exec",
      toolCallId: "tool-callback-throws",
      args: { command: "echo hi" },
    };

    await startTool(ctx, evt);

    expect(ctx.state.toolMetaById.has("tool-callback-throws")).toBe(true);
    expect(ctx.state.itemStartedCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("tool execution phase callback failed"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool agent event callback failed"));
  });

  it("does not leak unhandled rejections when tool start progress rejects", async () => {
    const { ctx, warn, onAgentEvent } = createTestContext();
    onAgentEvent.mockRejectedValue(new Error("progress failed"));

    const evt: ToolExecutionStartEvent = {
      toolName: "exec",
      toolCallId: "tool-callback-rejects",
      args: { command: "echo hi" },
    };

    await startTool(ctx, evt);
    await Promise.resolve();

    expect(ctx.state.toolMetaById.has("tool-callback-rejects")).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool agent event callback failed"));
  });

  it("preserves hidden tool telemetry while marking its channel progress private", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await startTool(ctx, {
      toolName: "wait",
      toolCallId: "tool-code-wait",
      args: { runId: "cm_1" },
      hideFromChannelProgress: true,
    });
    updateTool(ctx, {
      toolName: "wait",
      toolCallId: "tool-code-wait",
      args: { runId: "cm_1" },
      partialResult: { status: "waiting" },
      hideFromChannelProgress: true,
    });
    await endTool(ctx, {
      toolName: "wait",
      toolCallId: "tool-code-wait",
      isError: false,
      result: { details: { status: "completed" } },
      hideFromChannelProgress: true,
    });

    const lifecycleEvents = onAgentEvent.mock.calls
      .map((call) => call[0] as CapturedAgentEvent)
      .filter((event) => event.data?.name === "wait");
    expect(lifecycleEvents).not.toHaveLength(0);
    expect(lifecycleEvents.every((event) => event.data?.hideFromChannelProgress === true)).toBe(
      true,
    );
  });

  it("keeps an unmarked catalog tool named wait visible", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await executeTool(ctx, {
      toolName: "wait",
      toolCallId: "tool-catalog-wait",
      args: {},
      isError: false,
      result: { details: { status: "completed" } },
    });

    const lifecycleEvents = onAgentEvent.mock.calls
      .map((call) => call[0] as CapturedAgentEvent)
      .filter((event) => event.data?.name === "wait");
    expect(lifecycleEvents).not.toHaveLength(0);
    expect(lifecycleEvents.every((event) => event.data?.hideFromChannelProgress !== true)).toBe(
      true,
    );
  });
});

describe("handleToolExecutionEnd cron mutation tracking", () => {
  it("increments successfulCronAdds when cron add succeeds", async () => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId: "tool-cron-1",
      args: { action: "add", job: { name: "reminder" } },
      isError: false,
      result: { details: { status: "ok" } },
    });

    expect(ctx.state.successfulCronAdds).toBe(1);
    expect(ctx.state.replayState.hadPotentialSideEffects).toBe(true);
  });

  it("does not increment successfulCronAdds when cron add fails", async () => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId: "tool-cron-2",
      args: { action: "add", job: { name: "reminder" } },
      isError: true,
      result: { details: { status: "error" } },
    });

    expect(ctx.state.successfulCronAdds).toBe(0);
    expect(ctx.state.itemCompletedCount).toBe(1);
    expect(ctx.state.itemActiveIds.size).toBe(0);
  });

  it.each([
    ["exec", "openclaw cron add --at +1h --message 'follow up' --name reminder"],
    ["exec", "npx openclaw cron add --at=+1h --message 'follow up'"],
    ["exec", "bunx openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "pnpm exec openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "pnpm dlx openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "npx -y openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "bunx --bun openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "pnpm dlx openclaw@latest cron add --at +1h --message 'follow up'"],
    ["exec", "npx openclaw@latest cron add --at +1h --message 'follow up'"],
    ["exec", "bunx openclaw@latest cron add --at +1h --message 'follow up'"],
    ["exec", "/usr/local/bin/openclaw cron add --at +1h --message 'follow up'"],
    ["bash", "corepack pnpm exec openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "env OPENCLAW_PROFILE=test openclaw cron add --at +1h --message 'follow up'"],
    ["exec", "openclaw cron create --at +1h --message 'follow up'"],
    ["exec", "openclaw --profile work cron create --at +1h --message 'follow up'"],
    ["exec", "openclaw --dev cron add --at +1h --message 'follow up'"],
    ["exec", "openclaw --log-level debug --no-color cron add --at +1h --message 'follow up'"],
    ["exec", "openclaw --container helper cron add --at +1h --message 'follow up'"],
    ["exec", "openclaw cron add --at +1h --message 'follow up || wait'"],
    ["exec", "openclaw cron add --at +1h --message 'follow up' 2>&1"],
  ] as const)("increments successfulCronAdds when %s runs %s", async (toolName, command) => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName,
      toolCallId: "tool-shell-cron-add",
      args: { command },
      isError: false,
      result: {
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          aggregated: "warning text and human-readable success output",
        },
      },
    });

    expect(ctx.state.successfulCronAdds).toBe(1);
  });

  it("does not increment successfulCronAdds when shell cron add fails", async () => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-cron-add-failed",
      args: {
        command: "openclaw cron add --at +1h --message 'follow up' --name reminder",
      },
      isError: false,
      result: {
        details: {
          status: "completed",
          exitCode: 1,
          aggregated: "Cron job name is required.",
        },
      },
    });

    expect(ctx.state.successfulCronAdds).toBe(0);
  });

  it.each([
    ["openclaw cron list --json", "a different cron action"],
    ["echo openclaw cron add --at +1h", "a command that only mentions cron add"],
    ["openclaw cron add --at '+1h", "an unterminated shell argument"],
    ["cd /tmp && openclaw cron add --at +1h", "a compound command"],
    ["openclaw cron add --help", "the add command help"],
    ["openclaw cron create -h", "the create alias help"],
    ["openclaw cron add --bad||true", "a masked cron failure"],
    ["openclaw cron add --at +1h; true", "a semicolon suffix"],
    ["openclaw cron add --at +1h | cat", "a pipeline suffix"],
    ["openclaw cron add --at +1h & true", "a background suffix"],
    ["openclaw cron add --at +1h\ntrue", "a newline-separated suffix"],
    ["openclaw cron add --bad # ignored\ntrue", "a comment-masked cron failure"],
    ["npx -y echo openclaw cron add --at +1h", "a package runner for another executable"],
    ["pnpm openclaw cron add --at +1h", "a bare pnpm package script"],
    ["corepack pnpm openclaw cron add --at +1h", "a corepack pnpm package script"],
    ["openclaw@latest cron add --at +1h", "a package spec without a package runner"],
    ["pnpm exec openclaw@latest cron add --at +1h", "a package spec passed to pnpm exec"],
    ["openclaw cron add --bad &>/tmp/cron.log", "a bash-only combined redirection"],
    ["openclaw cron add --bad &>>/tmp/cron.log", "a bash-only append redirection"],
  ])("does not count %s (%s)", async (command) => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-not-cron-add",
      args: { command },
      isError: false,
      result: {
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          aggregated: "completed",
        },
      },
    });

    expect(ctx.state.successfulCronAdds).toBe(0);
  });

  it("keeps pre-execution cron failures replay-safe", async () => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId: "tool-cron-invalid",
      args: { action: "add" },
      isError: true,
      executionStarted: false,
      result: { details: { status: "error", error: "job required" } },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    });
    expect(ctx.state.lastToolError?.mutatingAction).toBe(false);
  });

  it("uses wrapped execution-boundary evidence when terminal events omit it", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-cron-aborted-before-execution";
    recordToolExecutionTracked(toolCallId, "run-test");
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "add", job: { name: "reminder" } },
      isError: true,
      result: { details: { status: "error", error: "tool timed out" } },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    });
    expect(ctx.state.lastToolError?.mutatingAction).toBe(false);
  });

  it("prefers wrapped execution-boundary evidence over a terminal event default", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-cron-cancelled-before-body";
    recordToolExecutionTracked(toolCallId, "run-test");
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "add", job: { name: "reminder" } },
      isError: true,
      executionStarted: true,
      result: { details: { status: "error", error: "cancelled before tool body" } },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    });
    expect(ctx.state.lastToolError?.mutatingAction).toBe(false);
  });

  it("keeps a policy-blocked cron mutation replay-safe", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-cron-blocked";
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "add", job: { name: "reminder" } },
      isError: false,
      result: buildBlockedToolResult({
        reason: "blocked by policy",
        toolCallId,
        runId: "run-test",
      }),
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    });
    expect(ctx.state.lastToolError?.mutatingAction).toBe(false);
  });

  it("keeps executed mutations replay-unsafe when middleware rewrites the result as blocked", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-cron-rewritten-blocked";
    await executeTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "add", job: { name: "reminder" } },
      isError: true,
      result: {
        content: [{ type: "text", text: "blocked by middleware" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by middleware",
        },
      },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    expect(ctx.state.lastToolError?.mutatingAction).toBe(true);
  });

  it("records structured core read actions as replay-safe", async () => {
    for (const [toolName, action] of [
      ["cron", "status"],
      ["gateway", "config.get"],
      ["gateway", "config.schema.lookup"],
      ["nodes", "status"],
      ["nodes", "describe"],
      ["nodes", "pending"],
    ] as const) {
      const { ctx } = createTestContext();
      const toolCallId = `tool-${toolName}-${action}`;
      recordStructuredReplayTrustForToolCall(
        toolCallId,
        { name: toolName, execute: vi.fn() } as never,
        "run-test",
      );
      await executeTool(ctx, {
        toolName,
        toolCallId,
        args: { action },
        isError: false,
        result: { details: { ok: true } },
      });

      expect(ctx.state.replayState.hadPotentialSideEffects, `${toolName}.${action}`).toBe(false);
    }
  });

  it("does not trust replay-safe names without concrete instance provenance", async () => {
    const { ctx } = createTestContext();
    await executeTool(ctx, {
      toolName: "search",
      toolCallId: "tool-shadowed-search",
      args: { query: "scheduler" },
      isError: false,
      result: { matches: [] },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });
});

describe("handleToolExecutionEnd private result observer", () => {
  it("reports the sanitized original tool result", async () => {
    const { ctx } = createTestContext();
    const onAgentToolResult = vi.fn();
    ctx.params.onAgentToolResult = onAgentToolResult;
    const result = {
      content: [{ type: "text", text: '{"results":[{"text":"ramen"}]}' }],
      details: { results: [{ text: "ramen" }] },
    };

    await endTool(ctx, {
      toolName: "memory_search",
      toolCallId: "tool-memory-search",
      isError: false,
      result,
    });

    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "memory_search",
      result,
      isError: false,
    });
  });
});

describe("handleToolExecutionEnd MCP App channel view tracking", () => {
  const result = (viewId: string, title: string) => ({
    details: {
      mcpAppPreview: {
        view: { id: viewId, title },
        mcpApp: { viewId },
      },
    },
  });

  it("retains only the latest successful bounded view identity", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "mcp_first",
      toolCallId: "mcp-first",
      isError: false,
      result: result("view-first", "First app"),
    });
    await endTool(ctx, {
      toolName: "mcp_failed",
      toolCallId: "mcp-failed",
      isError: true,
      result: result("view-failed", "Failed app"),
    });
    await endTool(ctx, {
      toolName: "mcp_latest",
      toolCallId: "mcp-latest",
      isError: false,
      result: result("view-latest", "Latest app"),
    });

    expect(ctx.state.latestMcpAppChannelView).toEqual({ viewId: "view-latest" });
  });

  it("ignores mismatched or unbounded preview data", async () => {
    const { ctx } = createTestContext();
    const leaked = {
      ...result("view-safe", "Safe app"),
      html: "private html",
      sessionKey: "agent:secret",
      bearerToken: "secret",
    };
    leaked.details.mcpAppPreview.view.id = "different-view";

    await endTool(ctx, {
      toolName: "mcp_invalid",
      toolCallId: "mcp-invalid",
      isError: false,
      result: leaked,
    });

    expect(ctx.state.latestMcpAppChannelView).toBeUndefined();
  });
});

describe("handleToolExecutionEnd sessions_spawn terminal success tracking", () => {
  it("records accepted sessions_spawn identifiers", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "sessions_spawn",
      toolCallId: "tool-spawn-accepted",
      isError: false,
      result: {
        details: {
          status: "accepted",
          runId: " run-child ",
          childSessionKey: " agent:claude:subagent:child ",
        },
      },
    });

    expect(ctx.state.acceptedSessionSpawns).toEqual([
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ]);
    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("does not record failed or malformed sessions_spawn results", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "sessions_spawn",
      toolCallId: "tool-spawn-failed",
      isError: false,
      result: {
        details: {
          status: "error",
          runId: "run-child",
          childSessionKey: "agent:claude:subagent:child",
        },
      },
    });
    await endTool(ctx, {
      toolName: "sessions_spawn",
      toolCallId: "tool-spawn-malformed",
      isError: false,
      result: {
        details: {
          status: "accepted",
          runId: "run-child",
          childSessionKey: " ",
        },
      },
    });

    expect(ctx.state.acceptedSessionSpawns).toEqual([]);
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("marks middleware failures on the last tool error", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-middleware-error",
      args: { cmd: "echo ok" },
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Tool output unavailable due to post-processing error.",
          },
        ],
        details: {
          status: "error",
          middlewareError: true,
        },
      },
    });

    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      middlewareError: true,
    });
  });

  it("preserves an unresolved mutation across a later read failure", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "write",
      toolCallId: "tool-write-failed",
      args: { path: "/tmp/demo.txt", content: "updated" },
      isError: true,
      result: { error: "permission denied" },
    });

    await executeTool(ctx, {
      toolName: "read",
      toolCallId: "tool-read-failed",
      args: { path: "/tmp/missing.txt" },
      isError: true,
      result: { error: "file not found" },
    });

    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "write",
      error: "permission denied",
      mutatingAction: true,
    });
  });

  it("clears edit failure when the retry succeeds through common file path aliases", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-1",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "beta stale",
        new_string: "beta fixed",
      },
      isError: true,
      result: { error: "Could not find the exact text in /tmp/demo.txt" },
    });

    expect(ctx.state.lastToolError?.toolName).toBe("edit");

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-2",
      args: {
        file: "/tmp/demo.txt",
        oldText: "beta",
        newText: "beta fixed",
      },
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.lastToolError).toBeUndefined();
  });

  it("clears a failed multi-file patch after every target is recovered", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "apply_patch",
      toolCallId: "tool-patch-failed",
      args: {
        input: [
          " *** Begin Patch",
          " *** Add File: /tmp/day-1.md",
          "+new",
          " *** Add File: /tmp/day-2.md",
          "+new",
          " *** End Patch",
        ].join("\n"),
      },
      isError: true,
      result: { error: "Path escapes sandbox root" },
    });

    await executeTool(ctx, {
      toolName: "write",
      toolCallId: "tool-write-recovery",
      args: { path: "/tmp/day-2.md", content: "new" },
      isError: false,
      result: { ok: true },
    });
    expect(ctx.state.lastToolError?.toolName).toBe("apply_patch");

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-recovery",
      args: { path: "/tmp/day-1.md", edits: [{ oldText: "old", newText: "new" }] },
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.lastToolError).toBeUndefined();
  });

  it("emits a prepared validation diagnostic without model arguments", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    const error =
      'Validation failed for tool "edit":\n  - edits: must have required properties edits\n\nReceived arguments:\n{"path":"secret.txt","contents":"PTY_PLANTED_SECRET"}';
    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-validation",
      args: { path: "secret.txt" },
      isError: true,
      executionStarted: false,
      errorKind: "argument-validation",
      result: { details: { status: "error", error } },
    });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: expect.objectContaining({
        phase: "result",
        toolErrorSummary: "edit tool validation failed: invalid arguments",
      }),
    });
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("PTY_PLANTED_SECRET");
  });

  it("records command sensitivity on namespaced tool results", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    await executeTool(ctx, {
      toolName: "server.exec",
      toolCallId: "tool-namespaced-exec",
      args: { command: "echo private-sentinel" },
      isError: false,
      result: { ok: true },
    });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "tool",
      data: expect.objectContaining({
        phase: "result",
        commandBearing: true,
        isError: false,
      }),
    });
  });

  it("does not export a validation-lookalike error from an executed tool", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    const error =
      'Validation failed for tool "edit":\n  - secret tool output\n\nReceived arguments:\n{}';
    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-spoof",
      args: {},
      isError: true,
      executionStarted: true,
      result: { details: { status: "error", error } },
    });

    const resultEvent = onAgentEvent.mock.calls.find(
      ([event]) => event.stream === "tool" && event.data.phase === "result",
    )?.[0];
    expect(resultEvent?.data).not.toHaveProperty("toolErrorSummary");
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("secret tool output");
  });

  it("marks successful mutating tool results as replay-invalid for terminal lifecycle truth", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-side-effect",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "beta",
        new_string: "gamma",
      },
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("keeps failed mutating tool attempts replay-invalid", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-partial-failure",
      args: { command: "printf changed > /tmp/demo.txt && false" },
      isError: true,
      result: { error: "Command exited with code 1" },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("keeps unclassified interactive tool calls replay-invalid", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "browser",
      toolCallId: "tool-browser-click",
      args: { action: "act", kind: "click", ref: "e12" },
      isError: false,
      result: { details: { ok: true } },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("uses hook-adjusted args for replay safety", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-cron-hook-rewrite";
    const adjustedParamsKey = beforeToolCallTesting.buildAdjustedParamsKey({
      runId: "run-test",
      toolCallId,
    });
    beforeToolCallTesting.adjustedParamsByToolCallId.set(adjustedParamsKey, {
      action: "add",
      job: { name: "rewritten mutation" },
    });

    await executeTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "status" },
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    expect(ctx.state.successfulCronAdds).toBe(1);
    expect(beforeToolCallTesting.adjustedParamsByToolCallId.has(adjustedParamsKey)).toBe(false);
  });

  it("snapshots hook-adjusted args before result middleware can mutate them", async () => {
    const { ctx, onAgentEvent } = createTestContext();
    const toolCallId = "tool-cron-mutable-adjusted-args";
    const executedArgs = {
      action: "add",
      job: { name: "rewritten mutation" },
    };
    recordAdjustedParamsForToolCall(toolCallId, executedArgs, "run-test");

    await startTool(ctx, {
      toolName: "cron",
      toolCallId,
      args: { action: "status" },
    });
    executedArgs.action = "status";
    await endTool(ctx, {
      toolName: "cron",
      toolCallId,
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    expect(ctx.state.successfulCronAdds).toBe(1);
    const resultEvent = onAgentEvent.mock.calls.find(
      ([event]) => event.stream === "tool" && event.data.phase === "result",
    )?.[0];
    expect(resultEvent?.data).not.toHaveProperty("args");
  });

  it("uses hook-adjusted message arguments for delivery telemetry", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-message-hook-rewrite";
    const adjustedParamsKey = beforeToolCallTesting.buildAdjustedParamsKey({
      runId: "run-test",
      toolCallId,
    });
    beforeToolCallTesting.adjustedParamsByToolCallId.set(adjustedParamsKey, {
      action: "send",
      provider: "telegram",
      to: "chat-rewritten",
      text: "rewritten delivery",
      mediaUrl: "/tmp/rewritten.png",
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: { action: "status" },
      isError: false,
      result: { details: { messageId: "message-rewritten" } },
    });

    expect(ctx.state.messagingToolSentTexts).toEqual(["rewritten delivery"]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/rewritten.png"]);
    expect(ctx.state.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-rewritten",
        threadId: undefined,
        text: "rewritten delivery",
        mediaUrls: ["/tmp/rewritten.png"],
      },
    ]);
  });

  it("records preview suppression text only for confirmed current-source sends", async () => {
    const { ctx } = createTestContext();
    ctx.params.sourceReplyDeliveryMode = "automatic";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-message-other-route",
      args: {
        action: "send",
        provider: "telegram",
        to: "chat-other",
        text: "Other route text",
      },
      isError: false,
      result: { details: { ok: true } },
    });
    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-message-current-source",
      args: {
        action: "send",
        provider: "telegram",
        to: "chat-source",
        text: "QA-MSTEAMS-DM-OK",
      },
      isError: false,
      result: {
        details: {
          ok: true,
          sourceReplyRoute: "current-source",
        },
      },
    });

    expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual(["qa-msteams-dm-ok"]);
  });

  it("records rich-content delivery when visible text is blank", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-message-rich-content";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: {
        action: "send",
        provider: "telegram",
        to: "chat-rich",
        text: "  ",
        presentation: JSON.stringify({
          blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
        }),
      },
      isError: false,
      result: { details: { messageId: "message-rich" } },
    });

    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat-rich",
        hasRichContent: true,
      }),
    ]);
  });

  it("records reply target evidence without treating it as terminal send evidence", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-message-reply-target";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: {
        action: "reply",
        provider: "telegram",
        target: "chat-reply",
        message: "visible reply",
      },
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.messagingToolSentTexts).toEqual([]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat-reply",
      }),
    ]);
  });

  it.each([
    {
      name: "reply",
      args: {
        action: "reply",
        provider: "telegram",
        target: "chat-reply",
        message: "Visible reply",
      },
      result: {
        ok: true,
        messageId: "message-reply",
        details: { sourceReplyRoute: "current-source" },
      },
      expected: "visible reply",
    },
    {
      name: "poll",
      args: {
        action: "poll",
        provider: "telegram",
        target: "chat-poll",
        pollQuestion: "Preferred default?",
        pollOption: ["Tell me right away", "Only important"],
      },
      result: {
        ok: true,
        pollId: "poll-1",
        details: { sourceReplyRoute: "current-source" },
      },
      expected: "preferred default?",
    },
  ])("records confirmed current-source $name text for preview dedupe", async (testCase) => {
    const { ctx } = createTestContext();
    ctx.params.sourceReplyDeliveryMode = "automatic";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: `tool-message-current-source-${testCase.name}`,
      args: testCase.args,
      isError: false,
      result: testCase.result,
    });

    expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual([testCase.expected]);
    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(true);
    expect(ctx.state.messagingToolSentTexts).toEqual([]);
  });

  it.each([
    {
      name: "reply",
      args: {
        action: "reply",
        provider: "telegram",
        target: "chat-reply",
        message: "Visible reply",
      },
      result: { ok: true, messageId: "message-reply" },
    },
    {
      name: "poll",
      args: {
        action: "poll",
        provider: "telegram",
        target: "chat-poll",
        pollQuestion: "Preferred default?",
        pollOption: ["Tell me right away", "Only important"],
      },
      result: { ok: true, pollId: "poll-1" },
    },
  ])("does not record off-route $name text for preview dedupe", async (testCase) => {
    const { ctx } = createTestContext();
    ctx.params.sourceReplyDeliveryMode = "automatic";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: `tool-message-off-route-${testCase.name}`,
      args: testCase.args,
      isError: false,
      result: testCase.result,
    });

    expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual([]);
    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(false);
  });

  it("records conversation creation target evidence", async () => {
    const { ctx } = createTestContext();
    const toolCallId = "tool-message-thread-create-target";

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: {
        action: "thread-create",
        provider: "telegram",
        target: "chat-thread",
        message: "new thread",
      },
      isError: false,
      result: { ok: true, thread: { id: "thread-1" } },
    });

    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat-thread",
      }),
    ]);
  });

  it.each([
    { name: "dry-run", result: { ok: true, dryRun: true } },
    { name: "suppressed", result: { ok: true, status: "suppressed" } },
  ])("does not record target evidence for $name reply results", async ({ result }) => {
    const { ctx } = createTestContext();
    const toolCallId = `tool-message-reply-${result.status ?? "dry-run"}`;

    await executeTool(ctx, {
      toolName: "message",
      toolCallId,
      args: {
        action: "reply",
        provider: "telegram",
        target: "chat-reply",
        message: "visible reply",
      },
      isError: false,
      result,
    });

    expect(ctx.state.messagingToolSentTexts).toEqual([]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
    expect(ctx.state.messagingToolSentTargets).toEqual([]);
  });

  it("does not treat text or media arguments on non-messaging tools as delivery", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "cron",
      toolCallId: "tool-cron-wake",
      args: {
        action: "wake",
        text: "not an outbound message",
        mediaUrl: "/tmp/not-an-outbound-message.png",
      },
      isError: false,
      result: { details: { status: "ok" } },
    });

    expect(ctx.state.messagingToolSentTexts).toEqual([]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
    expect(ctx.state.messagingToolSentTargets).toEqual([]);
  });

  it("marks successful legacy subagents control actions as replay-invalid", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "subagents",
      toolCallId: "tool-subagents-kill",
      args: {
        action: "kill",
        target: "worker-1",
      },
      isError: false,
      result: { status: "ok", action: "kill", target: "worker-1" },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("keeps action-dependent subagents calls replay-unsafe", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "subagents",
      toolCallId: "tool-subagents-list",
      args: {
        action: "list",
      },
      isError: false,
      result: { status: "ok", action: "list", total: 0, text: "no active subagents." },
    });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("keeps audited core read-only tools replay-safe", async () => {
    const { ctx } = createTestContext();
    ctx.params.replaySafeToolNames = new Set(["search"]);

    await executeTool(ctx, {
      toolName: "search",
      toolCallId: "tool-search",
      args: { query: "scheduler" },
      isError: false,
      result: { matches: [] },
    });

    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "search", replaySafe: true }),
    ]);
    expect(ctx.state.replayState).toEqual({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    });
  });

  it("keeps successful mutating retries replay-invalid after an earlier tool failure", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-fail-first",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "beta stale",
        new_string: "gamma",
      },
      isError: true,
      result: { error: "Could not find the exact text in /tmp/demo.txt" },
    });

    await executeTool(ctx, {
      toolName: "edit",
      toolCallId: "tool-edit-retry-success",
      args: {
        file_path: "/tmp/demo.txt",
        old_string: "beta",
        new_string: "gamma",
      },
      isError: false,
      result: { ok: true },
    });

    expect(ctx.state.lastToolError).toBeUndefined();
    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });
});

describe("handleToolExecutionEnd timeout metadata", () => {
  it("marks every finalized built-in call with its explicit outcome", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "read",
      toolCallId: "tool-read-complete",
      isError: false,
      result: { content: "ok" },
    });
    await endTool(ctx, {
      toolName: "process",
      toolCallId: "tool-process-running",
      isError: false,
      result: { details: { status: "running" } },
    });
    await endTool(ctx, {
      toolName: "image_generate",
      toolCallId: "tool-image-async-started",
      isError: false,
      result: { details: { async: true, status: "started" } },
    });
    await endTool(ctx, {
      toolName: "write",
      toolCallId: "tool-write-failed",
      isError: true,
      result: { error: "failed" },
    });

    expect(
      ctx.state.toolMetas.map(({ toolName, isError }) => ({
        toolName,
        isError,
      })),
    ).toEqual([
      { toolName: "read", isError: false },
      { toolName: "process", isError: false },
      { toolName: "image_generate", isError: false },
      { toolName: "write", isError: true },
    ]);
    expect(ctx.state.toolMetas[2]?.asyncStarted).toBe(true);
  });

  it("retains every failed call after later successes change the last-error slot", async () => {
    const { ctx } = createTestContext();

    for (const [toolCallId, isError] of [
      ["tool-read-failed", true],
      ["tool-read-succeeded", false],
      ["tool-exec-failed", true],
    ] as const) {
      await endTool(ctx, {
        toolName: toolCallId.includes("read") ? "read" : "exec",
        toolCallId,
        isError,
        result: isError ? { error: `${toolCallId} failed` } : { content: "ok" },
      });
    }

    expect(ctx.state.toolMetas.map(({ toolName, isError }) => ({ toolName, isError }))).toEqual([
      { toolName: "read", isError: true },
      { toolName: "read", isError: false },
      { toolName: "exec", isError: true },
    ]);
  });

  it("records timeout metadata for failed exec results", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-timeout",
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text: "Command timed out after 1800 seconds.",
          },
        ],
        details: {
          status: "failed",
          timedOut: true,
          exitCode: null,
          durationMs: 1_800_000,
          aggregated: "",
        },
      },
    });

    expectRecordFields(ctx.state.lastToolError, "last tool error", {
      toolName: "exec",
      timedOut: true,
    });
    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "exec", isError: true }),
    ]);
  });

  async function executeProcessResult(
    ctx: ToolHandlerContext,
    params: {
      action?: string;
      details?: Record<string, unknown>;
      isError?: boolean;
      output?: string;
    } = {},
  ) {
    const action = params.action ?? "poll";
    const output = params.output ?? "SAFE_PROCESS_STDERR";
    await executeTool(ctx, {
      toolName: "process",
      toolCallId: `tool-process-${action}`,
      args: { action, sessionId: "wild-lagoon" },
      isError: params.isError ?? true,
      result: {
        content: [{ type: "text", text: output }],
        details: {
          status: "completed",
          sessionId: "wild-lagoon",
          exitReason: "exit",
          aggregated: output,
          ...params.details,
        },
      },
    });
  }

  it.each(["poll", "log"])(
    "projects a structured terminal process diagnostic from %s",
    async (action) => {
      const { ctx } = createTestContext();
      await executeProcessResult(ctx, { action, details: { exitCode: 7 } });

      expect(ctx.state.lastToolError).toMatchObject({
        toolName: "process",
        terminalDiagnostic: {
          kind: "process",
          sessionId: "wild-lagoon",
          reason: { kind: "exit", exitCode: 7 },
        },
      });
    },
  );

  it.each([
    {
      label: "signal",
      details: { exitCode: 0, exitSignal: "SIGKILL", exitReason: "signal" },
      reason: { kind: "signal", signal: "SIGKILL" },
    },
    {
      label: "overall timeout",
      details: {
        exitCode: 0,
        exitSignal: "SIGTERM",
        exitReason: "overall-timeout",
        timedOut: true,
      },
      reason: { kind: "timeout", timeoutKind: "overall-timeout" },
    },
    {
      label: "no-output timeout",
      details: {
        exitCode: 0,
        exitSignal: "SIGTERM",
        exitReason: "no-output-timeout",
        timedOut: true,
      },
      reason: { kind: "timeout", timeoutKind: "no-output-timeout" },
    },
  ])(
    "preserves a typed process $label without fabricating exit status",
    async ({ details, reason }) => {
      const { ctx } = createTestContext();
      await executeProcessResult(ctx, { details });

      expect(ctx.state.lastToolError?.terminalDiagnostic).toMatchObject({ reason });
      expect(ctx.state.lastToolError?.terminalDiagnostic?.reason).not.toHaveProperty("exitCode");
    },
  );

  it("keeps child output out of the terminal diagnostic while retaining a safe full-verbosity error", async () => {
    const { ctx } = createTestContext();
    const dummyTelegramToken = `123456:${"A".repeat(28)}WXYZ`;
    await executeProcessResult(ctx, {
      output: `${dummyTelegramToken} ${"x".repeat(500)}`,
      details: { exitCode: 7 },
    });

    const diagnostic = ctx.state.lastToolError?.terminalDiagnostic;
    expect(diagnostic).toEqual({
      kind: "process",
      sessionId: "wild-lagoon",
      reason: { kind: "exit", exitCode: 7 },
    });
    expect(ctx.state.lastToolError?.error?.length).toBeLessThanOrEqual(401);
    expect(ctx.state.lastToolError?.error).toMatch(/…$/u);
    expect(JSON.stringify(ctx.state.lastToolError)).not.toContain(dummyTelegramToken);
  });

  it("omits full-verbosity process output containing terminal control characters", async () => {
    const { ctx } = createTestContext();
    await executeProcessResult(ctx, {
      output: "SAFE\u001b[31m_PROCESS_STDERR",
      details: { exitCode: 7 },
    });

    expect(ctx.state.lastToolError?.terminalDiagnostic).toEqual({
      kind: "process",
      sessionId: "wild-lagoon",
      reason: { kind: "exit", exitCode: 7 },
    });
    expect(ctx.state.lastToolError?.error).toBeUndefined();
  });

  it.each([
    {
      label: "running poll",
      isError: false,
      details: { status: "running", exitReason: undefined, exitCode: undefined },
    },
    {
      label: "failed process operation",
      details: { status: "failed", exitReason: undefined, exitCode: undefined },
    },
    {
      label: "missing session",
      details: { status: "failed", sessionId: undefined, exitReason: undefined, exitCode: 7 },
    },
    {
      label: "successful poll",
      isError: false,
      details: { exitCode: 0 },
    },
    {
      label: "log without terminal provenance",
      action: "log",
      details: { exitReason: undefined, exitCode: 7, exitSignal: "SIGKILL" },
    },
    {
      label: "non-observing process action",
      action: "write",
      details: { status: "failed", sessionId: "wild-lagoon", exitCode: 7 },
    },
    {
      label: "kill result",
      action: "kill",
      details: {
        status: "failed",
        sessionId: undefined,
        exitReason: undefined,
        name: "node command.js",
      },
    },
  ])(
    "does not project a terminal diagnostic for a $label",
    async ({ label, action, details, isError }) => {
      const { ctx } = createTestContext();
      await executeProcessResult(ctx, {
        action,
        details,
        isError,
        output: `No terminal process result for ${label}.`,
      });

      expect(ctx.state.lastToolError?.terminalDiagnostic).toBeUndefined();
    },
  );

  it("projects outcome-unknown exec results as errors with typed details", async () => {
    resetAgentEventsForTest();
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx } = createTestContext();
    const result = {
      content: [
        {
          type: "text",
          text: "The command may have executed. Do not rerun it automatically.",
        },
      ],
      details: {
        status: "failed",
        exitCode: null,
        failureKind: "outcome-unknown",
        reason: "outcome-unknown",
        nodeInvokeFailure: {
          failureCode: "TIMEOUT",
          message: "node invoke timed out",
          nodeCommandDispatched: true,
        },
        durationMs: 10,
        aggregated: "The command may have executed. Do not rerun it automatically.",
      },
    };

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-outcome-unknown",
      isError: false,
      result,
    });

    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "exec", isError: true }),
    ]);
    const toolResult = events.find(
      (event) => event.stream === "tool" && event.data?.phase === "result",
    );
    expect(toolResult?.data).toMatchObject({
      isError: true,
      result: {
        details: {
          reason: "outcome-unknown",
          nodeInvokeFailure: {
            failureCode: "TIMEOUT",
            nodeCommandDispatched: true,
          },
        },
      },
    });
    resetAgentEventsForTest();
  });

  it.each([
    {
      name: "records raw exec metadata without exposing it in default payload warnings",
      toolCallId: "tool-exec-raw-command",
      args: { command: "python3 /tmp/audit.py" },
      meta: "run python3 /tmp/audit.py, `python3 /tmp/audit.py`",
    },
    {
      name: "records backtick commands without exposing them in default payload warnings",
      toolCallId: "tool-exec-raw-command-backticks",
      args: { command: "node -e 'console.log(1, `x`)'" },
      meta: "run node inline script, ``node -e 'console.log(1, `x`)'``",
    },
    {
      name: "records node context without exposing it in default payload warnings",
      toolCallId: "tool-exec-node-raw-command",
      args: { command: "python3 /tmp/audit.py", host: "node", node: "mac-1" },
      meta: "run python3 /tmp/audit.py, node: mac-1, `python3 /tmp/audit.py`",
    },
    {
      name: "records cwd context without exposing it in default payload warnings",
      toolCallId: "tool-exec-cwd-raw-command",
      args: { command: "python3 audit.py", workdir: "/tmp/build" },
      meta: "run python3 audit.py (in /tmp/build), `python3 audit.py`",
    },
    {
      name: "records compact cwd labels without exposing them in default payload warnings",
      toolCallId: "tool-exec-repo-raw-command",
      args: { command: "git status", workdir: "/Users/agent/Projects/OpenClaw" },
      meta: "check git status (repo), `git status`",
    },
  ])("$name", async ({ toolCallId, args, meta }) => {
    const { ctx } = createTestContext();
    ctx.params.toolProgressDetail = "raw";
    await executeTool(ctx, {
      toolName: "exec",
      toolCallId,
      args,
      isError: true,
      result: {
        error: "Command exited with code 1",
        content: [{ type: "text", text: "Command exited with code 1" }],
        details: { status: "failed", exitCode: 1 },
      },
    });
    expectRecordFields(ctx.state.lastToolError, "last tool error", { toolName: "exec", meta });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      lastAssistant: undefined,
      lastToolError: ctx.state.lastToolError,
      sessionKey: "agent:unit-session",
      toolResultFormat: "markdown",
    });
    expect(payloads[0]?.text).toBe("⚠️ 🛠️ Exec failed (exit 1)");
  });

  it("records structured error codes for failed tool results", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-denied",
      isError: true,
      result: {
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: {
          status: "failed",
          error: {
            code: "SYSTEM_RUN_DENIED",
            message: "approval required",
          },
        },
      },
    });

    expectRecordFields(ctx.state.lastToolError, "last tool error", {
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
      error: "approval required",
    });
  });

  it("records node denial codes from thrown gateway error results", async () => {
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-node-denied",
      isError: true,
      result: {
        details: {
          status: "error",
          error: "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
          gatewayCode: "UNAVAILABLE",
          nodeError: {
            code: "UNAVAILABLE",
            message: "SYSTEM_RUN_DENIED: approval required",
          },
        },
      },
    });

    expectRecordFields(ctx.state.lastToolError, "last tool error", {
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
      error: "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
    });
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-approval",
      isError: false,
      result: {
        details: {
          status: "approval-pending",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          expiresAtMs: 1_800_000_000_000,
          host: "gateway",
          command: "npm view diver name version description",
          cwd: "/tmp/work",
          warningText: "Warning: heredoc execution requires explicit approval in allowlist mode.",
        },
      },
    });

    const result = requireMockCallArg(onToolResult, 0, "tool result");
    expect(requireString(result.text, "tool result text")).toContain(
      "```txt\n/approve 12345678 allow-once\n```",
    );
    expectRecordFields(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
      "exec approval payload",
      {
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    );
    expectInteractiveApprovalButtons(result, [
      {
        label: "Allow Once",
        value: "/approve 12345678-1234-1234-1234-123456789012 allow-once",
        style: "success",
      },
      {
        label: "Allow Always",
        value: "/approve 12345678-1234-1234-1234-123456789012 allow-always",
        style: "primary",
      },
      {
        label: "Deny",
        value: "/approve 12345678-1234-1234-1234-123456789012 deny",
        style: "danger",
      },
    ]);
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("preserves filtered approval decisions from tool details", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-approval-ask-always",
      isError: false,
      result: {
        details: {
          status: "approval-pending",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          expiresAtMs: 1_800_000_000_000,
          allowedDecisions: ["allow-once", "deny"],
          host: "gateway",
          command: "npm view diver name version description",
        },
      },
    });

    const result = requireMockCallArg(onToolResult, 0, "tool result");
    expect(requireString(result.text, "tool result text")).not.toContain("allow-always");
    expectRecordFields(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
      "exec approval payload",
      {
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    );
    expectInteractiveApprovalButtons(result, [
      {
        label: "Allow Once",
        value: "/approve 12345678-1234-1234-1234-123456789012 allow-once",
        style: "success",
      },
      {
        label: "Deny",
        value: "/approve 12345678-1234-1234-1234-123456789012 deny",
        style: "danger",
      },
    ]);
  });

  it("emits a deterministic unavailable payload when the initiating surface cannot approve", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    const onAgentToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    ctx.params.onAgentToolResult = onAgentToolResult;

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-unavailable",
      isError: false,
      result: {
        details: {
          status: "approval-unavailable",
          reason: "no-approval-route",
          channel: "discord",
          channelLabel: "Discord",
          accountId: "work",
          host: "node",
          nodeId: "node-mac-1",
        },
      },
    });

    const text = requireString(
      requireMockCallArg(onToolResult, 0, "tool result").text,
      "tool result text",
    );
    expect(text).toContain("no interactive approval client is currently available");
    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node node-mac-1`.",
    );
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
    expect(text).not.toContain("Host:");
    expect(text).not.toContain("CWD:");
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "exec",
      result: expect.objectContaining({
        details: expect.objectContaining({ status: "approval-unavailable" }),
      }),
      isError: true,
    });
    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "exec", isError: true }),
    ]);
    const [
      { normalizeAgentRunTerminalReceipt },
      { createUsageAccumulator },
      { createEmbeddedRunContextRecoveryState },
      { prepareEmbeddedRunTerminal },
    ] = await Promise.all([
      import("./agent-run-terminal-receipt.js"),
      import("./embedded-agent-runner/usage-accumulator.js"),
      import("./embedded-agent-runner/run/context-recovery-state.js"),
      import("./embedded-agent-runner/run/terminal-preparation.js"),
    ]);
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-test"),
        sessionId: "session-test-id",
        runId: "run-test",
        workspaceDir: "/tmp/openclaw-test",
        prompt: "run",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt: {
        terminal: { kind: "ok" },
        sessionIdUsed: "session-test-id",
        messagesSnapshot: [],
        assistantTexts: [],
        toolMetas: ctx.state.toolMetas.flatMap(({ toolName, ...entry }) =>
          toolName ? [{ ...entry, toolName }] : [],
        ),
        lastAssistant: undefined,
        didSendViaMessagingTool: false,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [],
        cloudCodeAssistFormatError: false,
        replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
        itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
      },
      provider: "openai",
      model: "gpt-5.4",
      activeErrorContext: { provider: "openai", model: "gpt-5.4" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session-test-id",
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });
    expect(
      normalizeAgentRunTerminalReceipt(Reflect.get(prepared.agentMeta, "terminalReceipt"))
        ?.successfulToolNames,
    ).toEqual([]);
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits the shared approver-DM notice when another approval client received the request", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-unavailable-dm-redirect",
      isError: false,
      result: {
        details: {
          status: "approval-unavailable",
          reason: "initiating-platform-disabled",
          channelLabel: "Telegram",
          sentApproverDms: true,
        },
      },
    });

    expect(requireMockCallArg(onToolResult, 0, "tool result").text).toBe(
      "Approval required. I sent approval DMs to the approvers for this account.",
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("records an actionable failure when deterministic approval delivery rejects", async () => {
    const { ctx, warn } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-approval-reject",
      isError: false,
      result: {
        details: {
          status: "approval-pending",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          expiresAtMs: 1_800_000_000_000,
          host: "gateway",
          command: "npm view diver name version description",
          cwd: "/tmp/work",
        },
      },
    });

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to deliver exec approval prompt: delivery failed"),
    );
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      error: "Approval prompt delivery failed: delivery failed",
      mutatingAction: false,
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      lastAssistant: undefined,
      lastToolError: ctx.state.lastToolError,
      sessionKey: "agent:unit-session",
      toolResultFormat: "markdown",
    });
    expect(payloads[0]?.text).toBe("⚠️ 🛠️ Exec failed");
  });

  it("records an actionable failure when unavailable-approval notice delivery rejects", async () => {
    const { ctx, warn } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("notice delivery failed");
    });

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-unavailable-reject",
      isError: false,
      result: {
        details: {
          status: "approval-unavailable",
          reason: "no-approval-route",
          channelLabel: "Discord",
        },
      },
    });

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to deliver exec approval prompt: notice delivery failed"),
    );
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      error: "Approval prompt delivery failed: notice delivery failed",
      mutatingAction: false,
    });
  });

  it("emits approval + blocked command item events when exec needs approval", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-approval-events",
      args: { command: "npm test" },
      isError: false,
      result: {
        details: {
          status: "approval-pending",
          approvalId: "12345678-1234-1234-1234-123456789012",
          approvalSlug: "12345678",
          host: "gateway",
          command: "npm test",
        },
      },
    });

    const approvalEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "approval"),
      "approval event",
    );
    expectRecordFields(approvalEvent.data, "approval event data", {
      phase: "requested",
      status: "pending",
      itemId: "command:tool-exec-approval-events",
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalSlug: "12345678",
    });
    const itemEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => {
          const candidate = event as {
            stream?: string;
            data?: { itemId?: string; status?: string };
          };
          return (
            candidate.stream === "item" &&
            candidate.data?.itemId === "command:tool-exec-approval-events" &&
            candidate.data?.status === "blocked"
          );
        }),
      "blocked item event",
    );
    expectRecordFields(itemEvent.data, "blocked item event data", {
      itemId: "command:tool-exec-approval-events",
      phase: "end",
      status: "blocked",
      summary: "Awaiting approval before command can run.",
    });
  });
});

describe("handleToolExecutionEnd derived tool events", () => {
  it("surfaces typed public tool progress for any non-exec tool", () => {
    resetAgentEventsForTest();
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx, onAgentEvent } = createTestContext();

    updateTool(ctx, {
      toolName: "custom_fetcher",
      toolCallId: "tool-custom-progress",
      partialResult: {
        content: [],
        details: undefined,
        progress: {
          text: "Loading remote resource...",
          visibility: "channel",
          privacy: "public",
        },
      },
    });

    expect(
      events.filter(
        (event) =>
          event.stream === "tool" &&
          (event.data as { phase?: string } | undefined)?.phase === "update",
      ),
    ).toHaveLength(0);
    const itemEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "item"),
      "progress item event",
    );
    expectRecordFields(itemEvent.data, "progress item event data", {
      itemId: "tool:tool-custom-progress",
      phase: "update",
      kind: "tool",
      name: "custom_fetcher",
      progressText: "Loading remote resource...",
      status: "running",
    });
    expect(requireRecord(itemEvent.data, "progress item event data").meta).toBeUndefined();

    resetAgentEventsForTest();
  });

  it("does not promote untyped non-exec content into channel progress", () => {
    resetAgentEventsForTest();
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx, onAgentEvent } = createTestContext();

    updateTool(ctx, {
      toolName: "web_fetch",
      toolCallId: "tool-web-fetch-untyped",
      partialResult: {
        content: [{ type: "text", text: "Fetching page content..." }],
        details: undefined,
      },
    });

    expect(
      events.filter(
        (event) =>
          event.stream === "tool" &&
          (event.data as { phase?: string } | undefined)?.phase === "update",
      ),
    ).toHaveLength(1);
    const itemEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "item"),
      "tool item event",
    );
    expect(requireRecord(itemEvent.data, "tool item event data").progressText).toBeUndefined();
    expect(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .filter((event) => (event as { stream?: string })?.stream === "tool"),
    ).toHaveLength(1);

    resetAgentEventsForTest();
  });

  it("caps typed public tool progress before channel item events", () => {
    const { ctx, onAgentEvent } = createTestContext();
    const largeProgress = "x".repeat(9000);

    updateTool(ctx, {
      toolName: "custom_fetcher",
      toolCallId: "tool-large-progress",
      partialResult: {
        content: [],
        details: undefined,
        progress: {
          text: largeProgress,
          visibility: "channel",
          privacy: "public",
        },
      },
    });

    const itemEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "item"),
      "large progress item event",
    );
    const progressText = requireString(
      requireRecord(itemEvent.data, "large progress item event data").progressText,
      "progress text",
    );
    expect(progressText).toContain("...(live output truncated)...");
    expect(progressText.length).toBeLessThan(largeProgress.length);
  });

  it("emits command output deltas for exec update results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await startTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-update-output",
      args: { command: "npm test" },
    });

    updateTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-update-output",
      partialResult: {
        details: {
          status: "running",
          aggregated: "RUN  src/example.test.ts",
        },
      },
    });

    const commandOutputEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "command_output"),
      "command output event",
    );
    expectRecordFields(commandOutputEvent.data, "command output event data", {
      itemId: "command:tool-exec-update-output",
      phase: "delta",
      output: "RUN  src/example.test.ts",
      status: "running",
    });
  });

  it("caps and throttles exec update output before live events", async () => {
    resetAgentEventsForTest();
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx, onAgentEvent } = createTestContext();
    const largeOutput = "x".repeat(9000);

    await startTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-large-update",
      args: { command: "yes" },
    });

    updateTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-large-update",
      partialResult: {
        details: {
          status: "running",
          aggregated: largeOutput,
        },
      },
    });
    updateTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-large-update",
      partialResult: {
        details: {
          status: "running",
          aggregated: `${largeOutput}again`,
        },
      },
    });

    const updateEvents = events.filter(
      (evt) => evt.stream === "tool" && (evt.data as { phase?: string })?.phase === "update",
    );
    expect(updateEvents).toHaveLength(1);
    const partialResult = updateEvents[0]?.data?.partialResult as
      | { details?: { aggregated?: string } }
      | undefined;
    expect(partialResult?.details?.aggregated).toContain("...(live output truncated)...");
    expect(partialResult?.details?.aggregated?.length).toBeLessThan(largeOutput.length);

    const commandOutputCalls = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((arg: unknown) => (arg as { stream?: string })?.stream === "command_output");
    expect(commandOutputCalls).toHaveLength(1);
    const output = (commandOutputCalls[0] as { data?: { output?: string } }).data?.output;
    expect(output).toContain("...(live output truncated)...");
    expect(output?.length).toBeLessThan(largeOutput.length);

    resetAgentEventsForTest();
  });

  it("caps exec final output before result and command output events", async () => {
    resetAgentEventsForTest();
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx, onAgentEvent } = createTestContext();
    const largeOutput = "z".repeat(9000);

    await endTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-large-result",
      isError: false,
      result: {
        details: {
          status: "completed",
          aggregated: largeOutput,
          exitCode: 0,
        },
      },
    });

    const resultEvent = events.find(
      (evt) => evt.stream === "tool" && (evt.data as { phase?: string })?.phase === "result",
    );
    const result = resultEvent?.data?.result as { details?: { aggregated?: string } } | undefined;
    expect(result?.details?.aggregated).toContain("...(live output truncated)...");
    expect(result?.details?.aggregated?.length).toBeLessThan(largeOutput.length);

    const commandOutputCalls = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((arg: unknown) => (arg as { stream?: string })?.stream === "command_output");
    const output = (commandOutputCalls.at(-1) as { data?: { output?: string } } | undefined)?.data
      ?.output;
    expect(output).toContain("...(live output truncated)...");
    expect(output?.length).toBeLessThan(largeOutput.length);

    resetAgentEventsForTest();
  });

  it("emits command output events for exec results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-output",
      args: { command: "ls" },
      isError: false,
      result: {
        details: {
          status: "completed",
          aggregated: "README.md",
          exitCode: 0,
          durationMs: 10,
          cwd: "/tmp/work",
        },
      },
    });

    const commandOutputEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "command_output"),
      "command output event",
    );
    expectRecordFields(commandOutputEvent.data, "command output event data", {
      itemId: "command:tool-exec-output",
      phase: "end",
      output: "README.md",
      exitCode: 0,
      cwd: "/tmp/work",
    });
  });

  it("emits patch summary events for apply_patch results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await executeTool(ctx, {
      toolName: "apply_patch",
      toolCallId: "tool-patch-summary",
      args: { patch: "*** Begin Patch" },
      isError: false,
      result: {
        details: {
          summary: {
            added: ["a.ts"],
            modified: ["b.ts"],
            deleted: ["c.ts"],
          },
        },
      },
    });

    const patchEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "patch"),
      "patch event",
    );
    expectRecordFields(patchEvent.data, "patch event data", {
      itemId: "patch:tool-patch-summary",
      added: ["a.ts"],
      modified: ["b.ts"],
      deleted: ["c.ts"],
      summary: "1 added, 1 modified, 1 deleted",
    });
  });
});

describe("messaging tool media URL tracking", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses the current provider and thread for implicit message sends", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            threading: {
              resolveAutoThreadId: ({
                to,
                toolContext,
              }: {
                to: string;
                toolContext?: {
                  currentChannelId?: string;
                  currentMessagingTarget?: string;
                  currentThreadTs?: string;
                  replyToMode?: "off" | "first" | "all" | "batched";
                };
              }) =>
                toolContext?.replyToMode === "all" &&
                (to === toolContext.currentMessagingTarget || to === toolContext.currentChannelId)
                  ? toolContext.currentThreadTs
                  : undefined,
            },
          },
          source: "test",
        },
      ]),
    );
    const { ctx } = createTestContext();
    ctx.params.messageChannel = "slack";
    ctx.params.currentChannelId = "D1";
    ctx.params.currentMessagingTarget = "user:u1";
    ctx.params.currentThreadId = "171.222";
    ctx.params.replyToMode = "all";

    await startTool(ctx, {
      toolName: "message",
      toolCallId: "tool-threaded-message",
      args: {
        action: "send",
        to: "user:U1",
        content: "hi",
      },
    });

    expect(ctx.state.pendingMessagingTargets.get("tool-threaded-message")).toMatchObject({
      provider: "slack",
      to: "user:u1",
      threadId: "171.222",
      threadImplicit: true,
    });
  });

  it("preserves the pre-send reply state when committing implicit thread evidence", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            threading: {
              resolveAutoThreadId: ({
                toolContext,
              }: {
                toolContext?: {
                  currentThreadTs?: string;
                  replyToMode?: "off" | "first" | "all" | "batched";
                  hasRepliedRef?: { value: boolean };
                };
              }) =>
                toolContext?.replyToMode === "first" && !toolContext.hasRepliedRef?.value
                  ? toolContext.currentThreadTs
                  : undefined,
            },
          },
          source: "test",
        },
      ]),
    );
    const { ctx } = createTestContext();
    ctx.params.currentChannelId = "D1";
    ctx.params.currentMessagingTarget = "user:u1";
    ctx.params.currentThreadId = "171.222";
    ctx.params.replyToMode = "first";
    ctx.params.hasRepliedRef = { value: false };

    await startTool(ctx, {
      toolName: "message",
      toolCallId: "tool-first-threaded-message",
      args: {
        action: "send",
        provider: "slack",
        to: "user:U1",
        content: "hi",
      },
    });
    ctx.params.hasRepliedRef.value = true;
    await endTool(ctx, {
      toolName: "message",
      toolCallId: "tool-first-threaded-message",
      isError: false,
      result: { details: { messageId: "message-1" } },
    });

    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "slack",
      to: "user:u1",
      threadId: "171.222",
      threadImplicit: true,
      text: "hi",
    });
  });

  it("reconciles unresolved send targets from successful provider results", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "mattermost",
          plugin: {
            ...createChannelTestPluginBase({ id: "mattermost" }),
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
                args.action === "send" && typeof args.to === "string"
                  ? { to: args.to, threadImplicit: true }
                  : null,
              extractToolSendResult: ({ result }: { result: unknown }) => {
                const providerResult = result as {
                  status?: string;
                  details?: { redacted?: boolean; toolSend?: unknown };
                };
                if (providerResult.status !== "sent" || providerResult.details?.redacted !== true) {
                  return null;
                }
                const details = providerResult.details;
                return (details?.toolSend as { to: string; threadId?: string } | undefined) ?? null;
              },
            },
          },
          source: "test",
        },
      ]),
    );
    const { ctx } = createTestContext();
    ctx.consumeToolSendReceipt = () => ({
      details: {
        toolSend: {
          to: "channel:resolved-id",
          threadId: "root-1",
        },
      },
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-mattermost-name",
      args: {
        action: "send",
        provider: "mattermost",
        to: "town-square",
        content: "hi",
      },
      isError: false,
      result: {
        status: "sent",
        details: { redacted: true },
      },
    });

    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "mattermost",
      to: "channel:resolved-id",
      threadId: "root-1",
      text: "hi",
    });
  });

  it("tracks media arg from messaging tool as pending", async () => {
    const { ctx } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      toolName: "message",
      toolCallId: "tool-m1",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await startTool(ctx, evt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-m1")).toEqual(["file:///img.jpg"]);
  });

  it("commits pending media URL on tool success", async () => {
    const { ctx } = createTestContext();

    // Simulate start
    const startEvt: ToolExecutionStartEvent = {
      toolName: "message",
      toolCallId: "tool-m2",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await startTool(ctx, startEvt);

    // Simulate successful end
    const endEvt: ToolExecutionEndEvent = {
      toolName: "message",
      toolCallId: "tool-m2",
      isError: false,
      result: { ok: true },
    };

    await endTool(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toContain("file:///img.jpg");
    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      to: "channel:123",
      text: "hi",
      mediaUrls: ["file:///img.jpg"],
    });
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m2")).toBe(false);
  });

  it("commits mediaUrls from tool result payload", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      toolName: "message",
      toolCallId: "tool-m2b",
      args: { action: "send", to: "channel:123", content: "hi" },
    };
    await startTool(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      toolName: "message",
      toolCallId: "tool-m2b",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
          },
        ],
      },
    };
    await endTool(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual([
      "file:///img-a.jpg",
      "file:///img-b.jpg",
    ]);
    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      to: "channel:123",
      text: "hi",
      mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
    });
  });

  it.each([
    {
      name: "commits upload-file args as message delivery evidence",
      toolCallId: "tool-upload-file",
      args: {
        action: "upload-file",
        channel: "discord",
        to: "channel:123",
        message: "track ready",
        path: "/tmp/generated-song.mp3",
      },
      provider: "discord",
      mediaUrls: ["/tmp/generated-song.mp3"],
      verifyPendingMedia: true,
    },
    {
      name: "commits message attachment aliases as delivery evidence",
      toolCallId: "tool-attachment-aliases",
      args: {
        action: "send",
        to: "channel:123",
        content: "track ready",
        media: "/tmp/generated-song.mp3",
        attachments: [{ filePath: "/tmp/generated-cover.png" }],
      },
      mediaUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
    },
    {
      name: "commits sendAttachment args as message delivery evidence",
      toolCallId: "tool-send-attachment",
      args: {
        action: "sendAttachment",
        provider: "discord",
        to: "channel:123",
        content: "track ready",
        filePath: "/tmp/generated-song.mp3",
      },
      provider: "discord",
      mediaUrls: ["/tmp/generated-song.mp3"],
    },
  ])("$name", async ({ toolCallId, args, provider, mediaUrls, verifyPendingMedia }) => {
    const { ctx } = createTestContext();
    await startTool(ctx, { toolName: "message", toolCallId, args });
    if (verifyPendingMedia) {
      expect(ctx.state.pendingMessagingMediaUrls.get(toolCallId)).toEqual(mediaUrls);
    }
    await endTool(ctx, {
      toolName: "message",
      toolCallId,
      isError: false,
      result: { ok: true },
    });
    expect(ctx.state.messagingToolSentMediaUrls).toEqual(mediaUrls);
    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      ...(provider === undefined ? {} : { provider }),
      to: "channel:123",
      text: "track ready",
      mediaUrls,
    });
    if (verifyPendingMedia) {
      expect(ctx.state.pendingMessagingMediaUrls.has(toolCallId)).toBe(false);
    }
  });

  it("commits internal-ui source replies from successful message sends", async () => {
    const { ctx } = createTestContext();
    ctx.params.sourceReplyDeliveryMode = "message_tool_only";

    const startEvt: ToolExecutionStartEvent = {
      toolName: "message",
      toolCallId: "tool-internal-source-reply",
      args: { action: "send", message: "visible in tui" },
    };
    await startTool(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      toolName: "message",
      toolCallId: "tool-internal-source-reply",
      isError: false,
      result: {
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReplySink: "internal-ui",
          idempotencyKey: "stable-source-reply",
          sourceReply: {
            text: "visible in tui",
            mediaUrls: ["file:///tmp/reply.png"],
            channelData: { source: "tui" },
          },
        },
      },
    };
    await endTool(ctx, endEvt);

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "visible in tui",
        mediaUrls: ["file:///tmp/reply.png"],
        channelData: { source: "tui" },
        idempotencyKey: "stable-source-reply",
        sourceReplyFinal: true,
      },
    ]);
  });

  it("does not commit dry-run or external message sends as internal-ui source replies", async () => {
    const { ctx } = createTestContext();

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-dry-run-source-reply",
      args: { action: "send", message: "preview" },
      isError: false,
      result: {
        details: {
          status: "ok",
          deliveryStatus: "dry_run",
          sourceReplySink: "internal-ui",
          sourceReply: { text: "preview" },
        },
      },
    });

    await executeTool(ctx, {
      toolName: "message",
      toolCallId: "tool-external-source-reply",
      args: { action: "send", to: "channel:123", message: "sent externally" },
      isError: false,
      result: {
        details: {
          status: "ok",
          deliveryStatus: "sent",
          sourceReply: { text: "sent externally" },
        },
      },
    });

    expect(ctx.state.messagingToolSourceReplyPayloads).toHaveLength(0);
  });

  it("trims messagingToolSentMediaUrls to 200 on commit (FIFO)", async () => {
    const { ctx } = createTestContext();

    // Replace mock with a real trim that replicates production cap logic.
    const MAX = 200;
    ctx.trimMessagingToolSent = () => {
      if (ctx.state.messagingToolSentTexts.length > MAX) {
        const overflow = ctx.state.messagingToolSentTexts.length - MAX;
        ctx.state.messagingToolSentTexts.splice(0, overflow);
        ctx.state.messagingToolSentTextsNormalized.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentTargets.length > MAX) {
        const overflow = ctx.state.messagingToolSentTargets.length - MAX;
        ctx.state.messagingToolSentTargets.splice(0, overflow);
      }
      if (ctx.state.messagingToolSentMediaUrls.length > MAX) {
        const overflow = ctx.state.messagingToolSentMediaUrls.length - MAX;
        ctx.state.messagingToolSentMediaUrls.splice(0, overflow);
      }
    };

    // Pre-fill with 200 URLs (url-0 .. url-199)
    for (let i = 0; i < 200; i++) {
      ctx.state.messagingToolSentMediaUrls.push(`file:///img-${i}.jpg`);
    }
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);

    // Commit one more via start → end
    const startEvt: ToolExecutionStartEvent = {
      toolName: "message",
      toolCallId: "tool-cap",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img-new.jpg" },
    };
    await startTool(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      toolName: "message",
      toolCallId: "tool-cap",
      isError: false,
      result: { ok: true },
    };
    await endTool(ctx, endEvt);

    // Should be capped at 200, oldest removed, newest appended.
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);
    expect(ctx.state.messagingToolSentMediaUrls[0]).toBe("file:///img-1.jpg");
    expect(ctx.state.messagingToolSentMediaUrls[199]).toBe("file:///img-new.jpg");
    expect(ctx.state.messagingToolSentMediaUrls).not.toContain("file:///img-0.jpg");
  });

  it("discards pending media URL on tool error", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      toolName: "message",
      toolCallId: "tool-m3",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await startTool(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      toolName: "message",
      toolCallId: "tool-m3",
      isError: true,
      result: "Error: failed",
    };

    await endTool(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(0);
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-m3")).toBe(false);
  });
});

describe("control UI credential redaction (issue #72283)", () => {
  afterEach(() => {
    resetAgentEventsForTest();
  });

  it("redacts secrets in args before emitting the tool start event", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx } = createTestContext();

    await startTool(ctx, {
      toolName: "gateway",
      toolCallId: "tool-secret-args",
      args: {
        action: "config.apply",
        raw: 'apiKey: "sk-1234567890abcdefXYZ"',
        headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
      },
    });

    const startEvent = requireEvent(
      events,
      (evt) => evt.stream === "tool" && (evt.data as { phase?: string })?.phase === "start",
      "tool start",
    );
    const emittedArgs = (startEvent.data as { args?: Record<string, unknown> })?.args ?? {};
    const serialized = JSON.stringify(emittedArgs);
    expect(serialized).not.toContain("sk-1234567890abcdefXYZ");
    expect(serialized).not.toContain("abcdef0123456789QWERTY=");
    expect(serialized).toContain("config.apply");
  });

  it("redacts secrets in exec aggregated stdout before emitting command_output", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await executeTool(ctx, {
      toolName: "exec",
      toolCallId: "tool-exec-secret",
      args: { command: "cat ~/.openclaw/openclaw.json" },
      isError: false,
      result: {
        details: {
          status: "completed",
          aggregated:
            'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\napiKey: "ghp_abcdefghij1234567890"',
          exitCode: 0,
          durationMs: 12,
          cwd: "/tmp/work",
        },
      },
    });

    const commandOutputCalls = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((arg: unknown) => (arg as { stream?: string })?.stream === "command_output");
    expect(commandOutputCalls).toHaveLength(1);
    const lastOutput = commandOutputCalls.at(-1) as { data?: { output?: string } } | undefined;
    const output = requireString(lastOutput?.data?.output, "command output");
    expect(output).not.toContain("sk-or-v1-abcdef0123456789");
    expect(output).not.toContain("ghp_abcdefghij1234567890");
    expect(output).toContain("OPENROUTER_API_KEY=");
  });

  it("redacts details-only results before emitting the tool result event", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "gateway",
      toolCallId: "tool-details-secret",
      isError: false,
      result: {
        details: {
          config: { apiKey: "sk-1234567890abcdefXYZ", model: "gpt-4" },
        },
      },
    });

    const resultEvent = requireEvent(
      events,
      (evt) => evt.stream === "tool" && (evt.data as { phase?: string })?.phase === "result",
      "tool result",
    );
    const serialized = JSON.stringify(resultEvent.data?.result);
    expect(serialized).not.toContain("sk-1234567890abcdefXYZ");
    expect(serialized).toContain("gpt-4");
  });

  it("redacts primitive string results before emitting the tool result event", async () => {
    const events: Array<{ stream?: string; data?: Record<string, unknown> }> = [];
    registerAgentEventListener((evt) => {
      events.push(evt as never);
    });
    const { ctx } = createTestContext();

    await endTool(ctx, {
      toolName: "gateway",
      toolCallId: "tool-string-secret",
      isError: false,
      result: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789",
    });

    const resultEvent = requireEvent(
      events,
      (evt) => evt.stream === "tool" && (evt.data as { phase?: string })?.phase === "result",
      "tool result",
    );
    const emittedResult = resultEvent.data?.result;
    expect(typeof emittedResult).toBe("string");
    if (typeof emittedResult !== "string") {
      throw new Error("expected string result");
    }
    expect(emittedResult).not.toContain("sk-or-v1-abcdef0123456789");
    expect(emittedResult).toContain("OPENROUTER_API_KEY=");
  });

  it("emits primitive string results as visible tool output", async () => {
    const { ctx } = createTestContext();
    ctx.shouldEmitToolOutput = () => true;

    await endTool(ctx, {
      toolName: "gateway",
      toolCallId: "tool-string-output",
      isError: false,
      result: "plain result",
    });

    expect(ctx.emitToolOutput).toHaveBeenCalledWith(
      "gateway",
      undefined,
      "plain result",
      "plain result",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
