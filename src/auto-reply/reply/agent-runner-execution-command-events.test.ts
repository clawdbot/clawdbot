import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  setupAgentRunnerExecutionTestState,
  getRunAgentTurnWithFallback,
  createMockTypingSignaler,
  createFollowupRun,
} from "./agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();

describe("runAgentTurnWithFallback: command events", () => {
  it("forwards plan, approval, command output, and patch events", async () => {
    const onPlanUpdate = vi.fn();
    const onApprovalEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onPatchSummary = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "plan",
        data: {
          phase: "update",
          title: "Assistant proposed a plan",
          explanation: "Inspect code, patch it, run tests.",
          steps: [
            { step: "Inspect code", status: "completed" },
            { step: "Patch code", status: "in_progress" },
            { step: "Run tests", status: "pending" },
            { step: "Malformed", status: "unknown" },
            "legacy string",
          ],
        },
      });
      await params.onAgentEvent?.({
        stream: "approval",
        data: {
          phase: "requested",
          kind: "exec",
          status: "pending",
          title: "Command approval requested",
          approvalId: "approval-1",
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "delta",
          title: "command ls",
          toolCallId: "exec-1",
          output: "README.md",
        },
      });
      await params.onAgentEvent?.({
        stream: "patch",
        data: {
          itemId: "patch:patch-1",
          phase: "end",
          title: "apply patch",
          toolCallId: "patch-1",
          added: ["a.ts"],
          modified: ["b.ts"],
          deleted: [],
          summary: "1 added, 1 modified",
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const pendingToolTasks = new Set<Promise<void>>();
    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {
        onPlanUpdate,
        onApprovalEvent,
        onCommandOutput,
        onPatchSummary,
      } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(onPlanUpdate).toHaveBeenCalledWith({
      phase: "update",
      title: "Assistant proposed a plan",
      explanation: "Inspect code, patch it, run tests.",
      steps: [
        { step: "Inspect code", status: "completed" },
        { step: "Patch code", status: "in_progress" },
        { step: "Run tests", status: "pending" },
        { step: "legacy string", status: "pending" },
      ],
      source: undefined,
    });
    expect(onApprovalEvent).toHaveBeenCalledWith({
      phase: "requested",
      kind: "exec",
      status: "pending",
      title: "Command approval requested",
      itemId: undefined,
      toolCallId: undefined,
      approvalId: "approval-1",
      approvalSlug: undefined,
      command: undefined,
      host: undefined,
      reason: undefined,
      scope: undefined,
      message: undefined,
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      itemId: "command:exec-1",
      phase: "delta",
      title: "command ls",
      toolCallId: "exec-1",
      name: undefined,
      output: "README.md",
      status: undefined,
      exitCode: undefined,
      durationMs: undefined,
      cwd: undefined,
    });
    expect(onPatchSummary).toHaveBeenCalledWith({
      itemId: "patch:patch-1",
      phase: "end",
      title: "apply patch",
      toolCallId: "patch-1",
      name: undefined,
      added: ["a.ts"],
      modified: ["b.ts"],
      deleted: [],
      summary: "1 added, 1 modified",
    });
  });

  it("forwards Codex command tool results as command output completion", async () => {
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "result",
          itemId: "command:exec-1",
          toolCallId: "exec-1",
          name: "exec",
          status: "completed",
          result: {
            exitCode: 0,
            durationMs: 42,
          },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onCommandOutput } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(onCommandOutput).toHaveBeenCalledWith({
      itemId: "command:exec-1",
      phase: "end",
      title: undefined,
      toolCallId: "exec-1",
      name: "exec",
      output: undefined,
      status: "completed",
      exitCode: 0,
      durationMs: 42,
      cwd: undefined,
    });
  });

  it("marks Codex command tool result errors as failed command output", async () => {
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "result",
          itemId: "command:exec-1",
          toolCallId: "exec-1",
          name: "exec",
          isError: true,
          result: {
            content: [{ type: "text", text: "command failed" }],
          },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onCommandOutput } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "command:exec-1",
        phase: "end",
        toolCallId: "exec-1",
        name: "exec",
        status: "failed",
      }),
    );
  });

  it("does not synthesize command output from bare exec tool results", async () => {
    const onCommandOutput = vi.fn();
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "tool",
        data: {
          phase: "result",
          name: "exec",
          toolCallId: "exec-1",
          isError: false,
        },
      });
      await params.onAgentEvent?.({
        stream: "command_output",
        data: {
          itemId: "command:exec-1",
          phase: "end",
          title: "command ls",
          toolCallId: "exec-1",
          name: "exec",
          status: "completed",
          exitCode: 0,
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    await runAgentTurnWithFallback({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { onCommandOutput } satisfies GetReplyOptions,
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(onCommandOutput).toHaveBeenCalledTimes(1);
    expect(onCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "command:exec-1",
        phase: "end",
        status: "completed",
      }),
    );
  });
});
