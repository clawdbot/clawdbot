import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onAgentEvent as registerAgentEventListener,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import type { MessagingToolSend } from "./pi-embedded-messaging.types.js";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type {
  ToolCallSummary,
  ToolHandlerContext,
} from "./pi-embedded-subscribe.handlers.types.js";

type ToolExecutionStartEvent = Extract<AgentEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;

function createTestContext(): {
  ctx: ToolHandlerContext;
  warn: ReturnType<typeof vi.fn>;
  onBlockReplyFlush: ReturnType<typeof vi.fn>;
  onAgentEvent: ReturnType<typeof vi.fn>;
  onExecutionPhase: ReturnType<typeof vi.fn>;
} {
  const onBlockReplyFlush = vi.fn();
  const onAgentEvent = vi.fn();
  const onExecutionPhase = vi.fn();
  const warn = vi.fn();
  const ctx: ToolHandlerContext = {
    params: {
      runId: "run-test",
      onBlockReplyFlush,
      onAgentEvent,
      onExecutionPhase,
      onToolResult: undefined,
    },
    flushBlockReplyBuffer: vi.fn(),
    hookRunner: undefined,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
    },
    state: {
      toolMetaById: new Map<string, ToolCallSummary>(),
      toolMetas: [],
      toolSummaryById: new Set<string>(),
      itemActiveIds: new Set<string>(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingMessagingTargets: new Map<string, MessagingToolSend>(),
      pendingMessagingTexts: new Map<string, string>(),
      pendingMessagingMediaUrls: new Map<string, string[]>(),
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      pendingToolTrustedLocalMedia: false,
      deterministicApprovalPromptPending: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      successfulCronAdds: 0,
      deterministicApprovalPromptSent: false,
      toolExecutionSinceLastBlockReply: false,
    },
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
  };

  return { ctx, warn, onBlockReplyFlush, onAgentEvent, onExecutionPhase };
}

type CapturedAgentEvent = { stream?: string; data?: Record<string, unknown> };

function requireEvent(
  events: CapturedAgentEvent[],
  predicate: (event: CapturedAgentEvent) => boolean,
  label: string,
): CapturedAgentEvent {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value;
}

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
  it("does not warn when read tool uses file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush, onExecutionPhase } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-1",
      args: { file_path: "/tmp/example.txt" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      tool: "read",
      toolCallId: "tool-1",
      source: "pi-embedded",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when read tool has neither path nor file_path", async () => {
    const { ctx, warn } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-2",
      args: {},
    };

    await handleToolExecutionStart(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("read tool called without path");
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
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-await-flush",
      args: { command: "echo hi" },
    };

    const pending = handleToolExecutionStart(ctx, evt);
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
});

describe("handleToolExecutionEnd cron.add commitment tracking", () => {
  it("increments successfulCronAdds when cron add succeeds", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-1",
        isError: false,
        result: { details: { status: "ok" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(1);
  });

  it("does not increment successfulCronAdds when cron add fails", async () => {
    const { ctx } = createTestContext();
    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        args: { action: "add", job: { name: "reminder" } },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "cron",
        toolCallId: "tool-cron-2",
        isError: true,
        result: { details: { status: "error" } },
      } as never,
    );

    expect(ctx.state.successfulCronAdds).toBe(0);
    expect(ctx.state.itemCompletedCount).toBe(1);
    expect(ctx.state.itemActiveIds.size).toBe(0);
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("clears edit failure when the retry succeeds through common file path aliases", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-1",
        args: {
          file_path: "/tmp/demo.txt",
          old_string: "beta stale",
          new_string: "beta fixed",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-1",
        isError: true,
        result: { error: "Could not find the exact text in /tmp/demo.txt" },
      } as never,
    );

    expect(ctx.state.lastToolError?.toolName).toBe("edit");

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-2",
        args: {
          file: "/tmp/demo.txt",
          oldText: "beta",
          newText: "beta fixed",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-2",
        isError: false,
        result: { ok: true },
      } as never,
    );

    expect(ctx.state.lastToolError).toBeUndefined();
  });

  it("marks successful mutating tool results as replay-invalid for terminal lifecycle truth", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-side-effect",
        args: {
          file_path: "/tmp/demo.txt",
          old_string: "beta",
          new_string: "gamma",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-side-effect",
        isError: false,
        result: { ok: true },
      } as never,
    );

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("marks successful subagents control actions as replay-invalid", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "subagents",
        toolCallId: "tool-subagents-kill",
        args: {
          action: "kill",
          target: "worker-1",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "subagents",
        toolCallId: "tool-subagents-kill",
        isError: false,
        result: { status: "ok", action: "kill", target: "worker-1" },
      } as never,
    );

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });

  it("keeps read-only subagents list actions replay-safe", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "subagents",
        toolCallId: "tool-subagents-list",
        args: {
          action: "list",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "subagents",
        toolCallId: "tool-subagents-list",
        isError: false,
        result: { status: "ok", action: "list", total: 0, text: "no active subagents." },
      } as never,
    );

    expect(ctx.state.replayState).toEqual({
      replayInvalid: false,
      hadPotentialSideEffects: false,
    });
  });

  it("keeps successful mutating retries replay-invalid after an earlier tool failure", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-fail-first",
        args: {
          file_path: "/tmp/demo.txt",
          old_string: "beta stale",
          new_string: "gamma",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-fail-first",
        isError: true,
        result: { error: "Could not find the exact text in /tmp/demo.txt" },
      } as never,
    );

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "edit",
        toolCallId: "tool-edit-retry-success",
        args: {
          file_path: "/tmp/demo.txt",
          old_string: "beta",
          new_string: "gamma",
        },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "edit",
        toolCallId: "tool-edit-retry-success",
        isError: false,
        result: { ok: true },
      } as never,
    );

    expect(ctx.state.lastToolError).toBeUndefined();
    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  });
});

describe("handleToolExecutionEnd timeout metadata", () => {
  it("records timeout metadata for failed exec results", async () => {
    const { ctx } = createTestContext();

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
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
      } as never,
    );

    expectRecordFields(ctx.state.lastToolError, "last tool error", {
      toolName: "exec",
      timedOut: true,
    });
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
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
      } as never,
    );

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

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
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
      } as never,
    );

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
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-unavailable",
        isError: false,
        result: {
          details: {
            status: "approval-unavailable",
            reason: "initiating-platform-disabled",
            channel: "discord",
            channelLabel: "Discord",
            accountId: "work",
          },
        },
      } as never,
    );

    const text = requireString(
      requireMockCallArg(onToolResult, 0, "tool result").text,
      "tool result text",
    );
    expect(text).toContain("native chat exec approvals are not configured on Discord");
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
    expect(text).not.toContain("Host:");
    expect(text).not.toContain("CWD:");
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("emits the shared approver-DM notice when another approval client received the request", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
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
      } as never,
    );

    expect(requireMockCallArg(onToolResult, 0, "tool result").text).toBe(
      "Approval required. I sent approval DMs to the approvers for this account.",
    );
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
  });

  it("does not suppress assistant output when deterministic prompt delivery rejects", async () => {
    const { ctx } = createTestContext();
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
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
      } as never,
    );

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
  });

  it("emits approval + blocked command item events when exec needs approval", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "tool-exec-approval-events",
        args: { command: "npm test" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-approval-events",
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
      } as never,
    );

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
  it("emits command output deltas for exec update results", async () => {
    const { ctx, onAgentEvent } = createTestContext();

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "tool-exec-update-output",
        args: { command: "npm test" },
      } as never,
    );

    handleToolExecutionUpdate(
      ctx as never,
      {
        type: "tool_execution_update",
        toolName: "exec",
        toolCallId: "tool-exec-update-output",
        partialResult: {
          details: {
            status: "running",
            aggregated: "RUN  src/example.test.ts",
          },
        },
      } as never,
    );

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

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "tool-exec-large-update",
        args: { command: "yes" },
      } as never,
    );

    handleToolExecutionUpdate(
      ctx as never,
      {
        type: "tool_execution_update",
        toolName: "exec",
        toolCallId: "tool-exec-large-update",
        partialResult: {
          details: {
            status: "running",
            aggregated: largeOutput,
          },
        },
      } as never,
    );
    handleToolExecutionUpdate(
      ctx as never,
      {
        type: "tool_execution_update",
        toolName: "exec",
        toolCallId: "tool-exec-large-update",
        partialResult: {
          details: {
            status: "running",
            aggregated: `${largeOutput}again`,
          },
        },
      } as never,
    );

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

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
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
      } as never,
    );

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

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "tool-exec-output",
        args: { command: "ls" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-output",
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
      } as never,
    );

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

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "apply_patch",
        toolCallId: "tool-patch-summary",
        args: { patch: "*** Begin Patch" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "apply_patch",
        toolCallId: "tool-patch-summary",
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
      } as never,
    );

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
  it("tracks media arg from messaging tool as pending", async () => {
    const { ctx } = createTestContext();

    const evt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m1",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, evt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-m1")).toEqual(["file:///img.jpg"]);
  });

  it("commits pending media URL on tool success", async () => {
    const { ctx } = createTestContext();

    // Simulate start
    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    // Simulate successful end
    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2",
      isError: false,
      result: { ok: true },
    };

    await handleToolExecutionEnd(ctx, endEvt);

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
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m2b",
      args: { action: "send", to: "channel:123", content: "hi" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m2b",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
            }),
          },
        ],
      },
    };
    await handleToolExecutionEnd(ctx, endEvt);

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

  it("commits upload-file args as message delivery evidence", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-upload-file",
      args: {
        action: "upload-file",
        channel: "discord",
        to: "channel:123",
        message: "track ready",
        path: "/tmp/generated-song.mp3",
      },
    };
    await handleToolExecutionStart(ctx, startEvt);

    expect(ctx.state.pendingMessagingMediaUrls.get("tool-upload-file")).toEqual([
      "/tmp/generated-song.mp3",
    ]);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-upload-file",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/generated-song.mp3"]);
    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "discord",
      to: "channel:123",
      text: "track ready",
      mediaUrls: ["/tmp/generated-song.mp3"],
    });
    expect(ctx.state.pendingMessagingMediaUrls.has("tool-upload-file")).toBe(false);
  });

  it("commits message attachment aliases as delivery evidence", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-attachment-aliases",
      args: {
        action: "send",
        to: "channel:123",
        content: "track ready",
        media: "/tmp/generated-song.mp3",
        attachments: [{ filePath: "/tmp/generated-cover.png" }],
      },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-attachment-aliases",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual([
      "/tmp/generated-song.mp3",
      "/tmp/generated-cover.png",
    ]);
    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      to: "channel:123",
      text: "track ready",
      mediaUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
    });
  });

  it("commits sendAttachment args as message delivery evidence", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-send-attachment",
      args: {
        action: "sendAttachment",
        provider: "discord",
        to: "channel:123",
        content: "track ready",
        filePath: "/tmp/generated-song.mp3",
      },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-send-attachment",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    expect(ctx.state.messagingToolSentMediaUrls).toEqual(["/tmp/generated-song.mp3"]);
    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "discord",
      to: "channel:123",
      text: "track ready",
      mediaUrls: ["/tmp/generated-song.mp3"],
    });
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
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-cap",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img-new.jpg" },
    };
    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-cap",
      isError: false,
      result: { ok: true },
    };
    await handleToolExecutionEnd(ctx, endEvt);

    // Should be capped at 200, oldest removed, newest appended.
    expect(ctx.state.messagingToolSentMediaUrls).toHaveLength(200);
    expect(ctx.state.messagingToolSentMediaUrls[0]).toBe("file:///img-1.jpg");
    expect(ctx.state.messagingToolSentMediaUrls[199]).toBe("file:///img-new.jpg");
    expect(ctx.state.messagingToolSentMediaUrls).not.toContain("file:///img-0.jpg");
  });

  it("discards pending media URL on tool error", async () => {
    const { ctx } = createTestContext();

    const startEvt: ToolExecutionStartEvent = {
      type: "tool_execution_start",
      toolName: "message",
      toolCallId: "tool-m3",
      args: { action: "send", to: "channel:123", content: "hi", media: "file:///img.jpg" },
    };

    await handleToolExecutionStart(ctx, startEvt);

    const endEvt: ToolExecutionEndEvent = {
      type: "tool_execution_end",
      toolName: "message",
      toolCallId: "tool-m3",
      isError: true,
      result: "Error: failed",
    };

    await handleToolExecutionEnd(ctx, endEvt);

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

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "gateway",
        toolCallId: "tool-secret-args",
        args: {
          action: "config.apply",
          raw: 'apiKey: "sk-1234567890abcdefXYZ"',
          headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
        },
      } as never,
    );

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

    await handleToolExecutionStart(
      ctx as never,
      {
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "tool-exec-secret",
        args: { command: "cat ~/.openclaw/openclaw.json" },
      } as never,
    );

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "tool-exec-secret",
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
      } as never,
    );

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

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "gateway",
        toolCallId: "tool-details-secret",
        isError: false,
        result: {
          details: {
            config: { apiKey: "sk-1234567890abcdefXYZ", model: "gpt-4" },
          },
        },
      } as never,
    );

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

    await handleToolExecutionEnd(
      ctx as never,
      {
        type: "tool_execution_end",
        toolName: "gateway",
        toolCallId: "tool-string-secret",
        isError: false,
        result: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789",
      } as never,
    );

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
});
