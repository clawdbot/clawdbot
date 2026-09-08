import { describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import {
  createFollowupRun,
  initialFallbackAttemptOptions,
  createMockTypingSignaler,
  getExecuteAgentTurnForTest,
  loadActualRunCliAgentForTest,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

const scriptedCliProgram = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.trim()) process.exit(2);
  const events = [
    { type: "init", session_id: "scripted-commentary" },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "The subprocess findings are durable." },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-scripted", name: "Read", input: {} },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Subprocess final answer." },
      },
    },
    { type: "stream_event", event: { type: "message_stop" } },
    { type: "result", session_id: "scripted-commentary", result: "Subprocess final answer." },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
});
`;

function useClaudeCliFallback() {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await params.run(
      "claude-cli",
      "claude-opus-4-6",
      initialFallbackAttemptOptions(params),
    ),
    provider: "claude-cli",
    model: "claude-opus-4-6",
    attempts: [],
  }));
}

function useScriptedClaudeCliBackend() {
  const backend = {
    id: "claude-cli",
    modelProvider: "anthropic",
    pluginId: "anthropic",
    bundleMcp: false,
    contextEngineHostCapabilities: ["thread-bootstrap-projection"] as const,
    config: {
      command: process.execPath,
      args: ["-e", scriptedCliProgram],
      input: "stdin" as const,
      output: "jsonl" as const,
      jsonlDialect: "claude-stream-json" as const,
      sessionMode: "none" as const,
      systemPromptWhen: "never" as const,
    },
  };
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: ({ backend: id }) =>
      id === backend.id ? { pluginId: backend.pluginId, backend } : undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
  state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
    return await (
      await loadActualRunCliAgentForTest()
    )(params);
  });
}

function createClaudeCliFollowupRun() {
  const followupRun = createFollowupRun();
  followupRun.run.agentId = "agent";
  followupRun.run.provider = "claude-cli";
  followupRun.run.model = "claude-opus-4-6";
  followupRun.run.skillsSnapshot = { prompt: "", skills: [], version: 0 };
  followupRun.run.timeoutMs = 10_000;
  return followupRun;
}

function createTurnParams(opts: GetReplyOptions, blockStreamingEnabled: boolean) {
  return {
    commandBody: "hi",
    followupRun: createClaudeCliFollowupRun(),
    sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
    opts,
    typingSignals: createMockTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled,
    resolvedBlockStreamingBreak: "message_end" as const,
    applyReplyToMode: <T>(payload: T) => payload,
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    pendingToolTasks: new Set<Promise<void>>(),
    resetSessionAfterRoleOrderingConflict: async () => false,
    isHeartbeat: false,
    sessionKey: "main",
    getActiveSessionEntry: () => undefined,
    resolvedVerboseLevel: "off" as const,
  };
}

describe("executeAgentTurn: CLI durable commentary", () => {
  it("delivers commentary from a real JSONL CLI subprocess", async () => {
    useClaudeCliFallback();
    useScriptedClaudeCliBackend();
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) =>
        params.onBlockReply,
    );
    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => undefined);
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createTurnParams({ onBlockReply }, true));

    expect(state.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({ emitCommentaryText: true });
    const resolveContextEngineHost = state.runEmbeddedAgentEntryMock.mock.calls[0]?.[0]?.harness
      ?.resolveContextEngineHost as
      | ((
          provider: string,
          model: string,
        ) => {
          id: string;
          label: string;
          capabilities: readonly string[];
        })
      | undefined;
    expect(resolveContextEngineHost?.("claude-cli", "claude-opus-4-6")).toEqual({
      id: "cli:claude-cli",
      label: 'CLI backend "claude-cli"',
      capabilities: ["thread-bootstrap-projection"],
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Subprocess final answer." }]);
    }
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
      text: "The subprocess findings are durable.",
    });
  });

  it("delivers completed CLI commentary through block streaming", async () => {
    useClaudeCliFallback();
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) =>
        params.onBlockReply,
    );
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(true);
        const agentEvents = await import("../../infra/agent-events.js");
        agentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-durable-1",
            progressText: "The durable findings live here.",
          },
        });
        return { payloads: [{ text: "Short final wrap-up." }], meta: {} };
      },
    );

    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => undefined);
    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>(async () => undefined);
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createTurnParams(
        {
          onBlockReply,
          onItemEvent,
          commentaryProgressEnabled: false,
          progressPreambleEnabled: true,
        },
        true,
      ),
    );

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
        text: "The durable findings live here.",
      });
      expect(onItemEvent).toHaveBeenCalledExactlyOnceWith({
        itemId: "commentary-durable-1",
        kind: "preamble",
        progressText: "The durable findings live here.",
        suppressDurableProgress: true,
      });
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Short final wrap-up." }]);
    }
  });

  it("forwards channel presentation callbacks to native CLI input", async () => {
    useClaudeCliFallback();
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) =>
        params.onBlockReply,
    );
    state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
      await params.onBlockReply?.({
        text: "Which color?",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Blue",
                  action: { type: "question", questionId: "question-1", optionValue: "Blue" },
                },
              ],
            },
          ],
        },
      });
      await params.onPartialReply?.({ text: "Fallback question" });
      return { payloads: [{ text: "Answered." }], meta: {} };
    });

    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => undefined);
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async () => undefined,
    );
    const executeAgentTurn = await getExecuteAgentTurnForTest();

    await executeAgentTurn(createTurnParams({ onBlockReply, onPartialReply }, false));

    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Which color?", presentation: expect.any(Object) }),
    );
    expect(onPartialReply).toHaveBeenCalledWith({ text: "Fallback question" });
  });

  it("delivers commentary payloads without block streaming", async () => {
    useClaudeCliFallback();
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) =>
        params.onBlockReply,
    );
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(true);
        const agentEvents = await import("../../infra/agent-events.js");
        agentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-payload-1",
            progressText: "A durable commentary update.",
          },
        });
        return { payloads: [{ text: "Final answer." }], meta: {} };
      },
    );

    const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => undefined);
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createTurnParams({ onBlockReply, commentaryPayloadsEnabled: true }, false),
    );

    await vi.waitFor(() => {
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
        text: "A durable commentary update.",
        isCommentary: true,
      });
    });
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.runResult.payloads).toEqual([{ text: "Final answer." }]);
    }
  });
});
