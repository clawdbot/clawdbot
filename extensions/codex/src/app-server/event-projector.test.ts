import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { resetAgentEventsForTest } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerEventProjector,
  type CodexAppServerToolTelemetry,
} from "./event-projector.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const tempDirs = new Set<string>();

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];

function assistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

async function createParams(): Promise<EmbeddedRunAttemptParams> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-projector-"));
  tempDirs.add(tempDir);
  const sessionFile = path.join(tempDir, "session.jsonl");
  SessionManager.open(sessionFile).appendMessage(assistantMessage("history", Date.now()));
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionFile,
    workspaceDir: tempDir,
    runId: "run-1",
    provider: "openai-codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel(),
    thinkLevel: "medium",
  } as EmbeddedRunAttemptParams;
}

async function createProjector(
  params?: EmbeddedRunAttemptParams,
): Promise<CodexAppServerEventProjector> {
  const resolvedParams = params ?? (await createParams());
  return new CodexAppServerEventProjector(resolvedParams, THREAD_ID, TURN_ID);
}

async function createProjectorWithAssistantHooks() {
  const onAssistantMessageStart = vi.fn();
  const onPartialReply = vi.fn();
  const params = await createParams();
  const projector = await createProjector({
    ...params,
    onAssistantMessageStart,
    onPartialReply,
  });
  return { onAssistantMessageStart, onPartialReply, projector };
}

beforeEach(() => {
  resetAgentEventsForTest();
});

afterEach(async () => {
  resetAgentEventsForTest();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  for (const tempDir of tempDirs) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function createProjectorWithHooks() {
  const beforeCompaction = vi.fn();
  const afterCompaction = vi.fn();
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      { hookName: "before_compaction", handler: beforeCompaction },
      { hookName: "after_compaction", handler: afterCompaction },
    ]),
  );
  const projector = await createProjector();
  return { projector, beforeCompaction, afterCompaction };
}

function buildEmptyToolTelemetry(): CodexAppServerToolTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
  };
}

function forCurrentTurn(
  method: ProjectorNotification["method"],
  params: Record<string, unknown>,
): ProjectorNotification {
  return {
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, ...params },
  } as ProjectorNotification;
}

function agentMessageDelta(delta: string, itemId = "msg-1"): ProjectorNotification {
  return forCurrentTurn("item/agentMessage/delta", { itemId, delta });
}

function appServerError(params: { message: string; willRetry: boolean }): ProjectorNotification {
  return forCurrentTurn("error", {
    error: {
      message: params.message,
      codexErrorInfo: null,
      additionalDetails: null,
    },
    willRetry: params.willRetry,
  });
}

function turnCompleted(items: unknown[] = []): ProjectorNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", items },
    },
  } as ProjectorNotification;
}

describe("CodexAppServerEventProjector", () => {
  it("projects assistant deltas and usage into embedded attempt results", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();

    await projector.handleNotification(agentMessageDelta("hel"));
    await projector.handleNotification(agentMessageDelta("lo"));
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          total: {
            totalTokens: 900_000,
            inputTokens: 700_000,
            cachedInputTokens: 100_000,
            outputTokens: 100_000,
          },
          last: {
            totalTokens: 12,
            inputTokens: 5,
            cachedInputTokens: 2,
            outputTokens: 7,
          },
        },
      }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "hello" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(result.assistantTexts).toEqual(["hello"]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.attemptUsage).toMatchObject({ input: 3, output: 7, cacheRead: 2, total: 12 });
    expect(result.lastAssistant?.usage).toMatchObject({
      input: 3,
      output: 7,
      cacheRead: 2,
      totalTokens: 12,
    });
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("does not treat cumulative-only token usage as fresh context usage", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          total: {
            totalTokens: 1_000_000,
            inputTokens: 999_000,
            cachedInputTokens: 500,
            outputTokens: 500,
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.attemptUsage).toBeUndefined();
    expect(result.lastAssistant?.usage).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      totalTokens: 0,
    });
  });

  it("uses raw assistant response items when turn completion omits items", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-1",
          role: "assistant",
          content: [{ type: "output_text", text: "OK from raw" }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["OK from raw"]);
    expect(result.lastAssistant?.content).toEqual([{ type: "text", text: "OK from raw" }]);
  });

  it("does not fail a completed reply after a retryable app-server error notification", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("still working"));
    await projector.handleNotification(
      appServerError({ message: "stream disconnected", willRetry: true }),
    );
    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "final answer" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.lastAssistant?.stopReason).toBe("stop");
    expect(result.lastAssistant?.errorMessage).toBeUndefined();
  });

  it("uses nested app-server error messages for terminal errors", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      appServerError({ message: "stream failed permanently", willRetry: false }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toBe("stream failed permanently");
    expect(result.promptErrorSource).toBe("prompt");
    expect(result.lastAssistant).toBeUndefined();
  });

  it("normalizes snake_case current token usage fields", async () => {
    const projector = await createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          total: { total_tokens: 1_000_000 },
          last_token_usage: {
            total_tokens: 17,
            input_tokens: 8,
            cached_input_tokens: 3,
            output_tokens: 9,
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.attemptUsage).toMatchObject({ input: 5, output: 9, cacheRead: 3, total: 17 });
    expect(result.lastAssistant?.usage).toMatchObject({
      input: 5,
      output: 9,
      cacheRead: 3,
      totalTokens: 17,
    });
  });

  it("keeps intermediate agentMessage items out of the final visible reply", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      await createProjectorWithAssistantHooks();

    await projector.handleNotification(
      agentMessageDelta(
        "checking thread context; then post a tight progress reply here.",
        "msg-commentary",
      ),
    );
    await projector.handleNotification(
      agentMessageDelta(
        "release fixes first. please drop affected PRs, failing checks, and blockers here.",
        "msg-final",
      ),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-commentary",
          text: "checking thread context; then post a tight progress reply here.",
        },
        {
          type: "agentMessage",
          id: "msg-final",
          text: "release fixes first. please drop affected PRs, failing checks, and blockers here.",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(result.assistantTexts).toEqual([
      "release fixes first. please drop affected PRs, failing checks, and blockers here.",
    ]);
    expect(result.lastAssistant?.content).toEqual([
      {
        type: "text",
        text: "release fixes first. please drop affected PRs, failing checks, and blockers here.",
      },
    ]);
    expect(JSON.stringify(result.messagesSnapshot)).not.toContain("checking thread context");
  });

  it("ignores notifications for other turns", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-2", itemId: "msg-1", delta: "wrong" },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([]);
  });

  it("ignores notifications that omit top-level thread and turn ids", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "turn/completed",
      params: {
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "wrong turn" }],
        },
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
  });

  it("preserves sessions_yield detection in attempt results", () => {
    const projector = new CodexAppServerEventProjector(
      {
        prompt: "hello",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        runId: "run-1",
        provider: "openai-codex",
        modelId: "gpt-5.4-codex",
        model: createCodexTestModel(),
        thinkLevel: "medium",
      } as EmbeddedRunAttemptParams,
      THREAD_ID,
      TURN_ID,
    );

    const result = projector.buildResult(buildEmptyToolTelemetry(), { yieldDetected: true });

    expect(result.yieldDetected).toBe(true);
  });

  it("projects guardian review lifecycle details into agent events", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/autoApprovalReview/started", {
        reviewId: "review-1",
        targetItemId: "cmd-1",
        review: { status: "inProgress" },
        action: {
          type: "execve",
          source: "shell",
          program: "/bin/printf",
          argv: ["printf", "hello"],
          cwd: "/tmp",
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/autoApprovalReview/completed", {
        reviewId: "review-1",
        targetItemId: "cmd-1",
        decisionSource: "agent",
        review: {
          status: "approved",
          riskLevel: "low",
          userAuthorization: "high",
          rationale: "Benign local probe.",
        },
        action: {
          type: "execve",
          source: "shell",
          program: "/bin/printf",
          argv: ["printf", "hello"],
          cwd: "/tmp",
        },
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.guardian",
      data: expect.objectContaining({
        phase: "started",
        reviewId: "review-1",
        targetItemId: "cmd-1",
        status: "inProgress",
        actionType: "execve",
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.guardian",
      data: expect.objectContaining({
        phase: "completed",
        reviewId: "review-1",
        targetItemId: "cmd-1",
        decisionSource: "agent",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "Benign local probe.",
        actionType: "execve",
      }),
    });
    expect(
      projector.buildResult(buildEmptyToolTelemetry()).didSendDeterministicApprovalPrompt,
    ).toBe(false);
  });

  it("projects reasoning end, plan updates, compaction state, and tool metadata", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const onAgentEvent = vi.fn();
    const params = {
      ...(await createParams()),
      onReasoningStream,
      onReasoningEnd,
      onAgentEvent,
    };
    const projector = await createProjector(params);

    await projector.handleNotification(
      forCurrentTurn("item/reasoning/textDelta", { itemId: "reason-1", delta: "thinking" }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/plan/delta", { itemId: "plan-1", delta: "- inspect\n" }),
    );
    await projector.handleNotification(
      forCurrentTurn("turn/plan/updated", {
        explanation: "next",
        plan: [{ step: "patch", status: "in_progress" }],
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(projector.isCompacting()).toBe(true);
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    expect(projector.isCompacting()).toBe(false);
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          tool: "sessions_send",
          status: "completed",
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onReasoningStream).toHaveBeenCalledWith({ text: "thinking" });
    expect(onReasoningEnd).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "plan",
        data: expect.objectContaining({ steps: ["patch (in_progress)"] }),
      }),
    );
    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "compaction",
        data: expect.objectContaining({ phase: "start", itemId: "compact-1" }),
      }),
    );
    expect(result.toolMetas).toEqual([{ toolName: "sessions_send" }]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(JSON.stringify(result.messagesSnapshot[1])).toContain("Codex reasoning");
    expect(JSON.stringify(result.messagesSnapshot[2])).toContain("Codex plan");
    expect(result.itemLifecycle).toMatchObject({ compactionCount: 1 });
  });

  it("emits verbose tool summaries through onToolResult", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ Bash: `` run tests (in /workspace), `pnpm test extensions/codex` ``",
    });
  });

  it("redacts secrets in verbose command summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "OPENAI_API_KEY=sk-1234567890abcdefZZZZ pnpm test",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    const text = onToolResult.mock.calls[0]?.[0]?.text;
    expect(text).toContain("sk-123…ZZZZ");
    expect(text).not.toContain("sk-1234567890abcdefZZZZ");
  });

  it("uses argument details instead of lifecycle status in verbose tool summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      onToolResult,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "lcm_grep",
          arguments: { query: "inProgress text" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      }),
    );

    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      text: "🧩 Lcm Grep: `inProgress text`",
    });
  });

  it("emits completed tool output only when verbose full is enabled", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "read",
          arguments: { path: "README.md" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "file contents" }],
          success: true,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenCalledTimes(2);
    expect(onToolResult).toHaveBeenNthCalledWith(1, {
      text: "📖 Read: `from README.md`",
    });
    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "📖 Read: `from README.md`\n```txt\nfile contents\n```",
    });
  });

  it("uses a safe markdown fence for verbose tool output", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    await projector.handleNotification(
      turnCompleted([
        {
          type: "dynamicToolCall",
          id: "tool-1",
          namespace: null,
          tool: "read",
          arguments: { path: "README.md" },
          status: "completed",
          contentItems: [{ type: "inputText", text: "line\n```\nMEDIA:/tmp/secret.png" }],
          success: true,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenNthCalledWith(2, {
      text: "📖 Read: `from README.md`\n````txt\nline\n```\nMEDIA:/tmp/secret.png\n````",
    });
  });

  it("bounds streamed verbose tool output", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "full",
      onToolResult,
    });

    for (let i = 0; i < 25; i += 1) {
      await projector.handleNotification(
        forCurrentTurn("item/commandExecution/outputDelta", {
          itemId: "cmd-1",
          delta: `line ${i}\n`,
        }),
      );
    }
    await projector.handleNotification(
      turnCompleted([
        {
          type: "commandExecution",
          id: "cmd-1",
          command: "pnpm test",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "final output should not duplicate streamed output",
          exitCode: 0,
          durationMs: 12,
        },
      ]),
    );

    expect(onToolResult).toHaveBeenCalledTimes(21);
    expect(onToolResult.mock.calls[19]?.[0]?.text).toContain("...(truncated)...");
    expect(JSON.stringify(onToolResult.mock.calls)).not.toContain(
      "final output should not duplicate",
    );
  });

  it("continues projecting turn completion when an event consumer throws", async () => {
    const onAgentEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
    });

    await expect(
      projector.handleNotification(
        turnCompleted([
          { type: "plan", id: "plan-1", text: "step one\nstep two" },
          { type: "agentMessage", id: "msg-1", text: "final answer" },
        ]),
      ),
    ).resolves.toBeUndefined();

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "plan",
        data: expect.objectContaining({ steps: ["step one", "step two"] }),
      }),
    );
    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(JSON.stringify(result.messagesSnapshot)).toContain("Codex plan");
  });

  it("fires before_compaction and after_compaction hooks for codex compaction items", async () => {
    const { projector, beforeCompaction, afterCompaction } = await createProjectorWithHooks();

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: { type: "contextCompaction", id: "compact-1" },
      }),
    );

    expect(beforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 1,
        sessionFile: expect.stringContaining("session.jsonl"),
        messages: [expect.objectContaining({ role: "assistant" })],
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
    );
    expect(afterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 1,
        compactedCount: -1,
        sessionFile: expect.stringContaining("session.jsonl"),
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
    );
  });

  it("projects codex hook started and completed notifications into agent events", async () => {
    const onAgentEvent = vi.fn();
    const params = await createParams();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("hook/started", {
        run: {
          id: "hook-1",
          eventName: "preToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "running",
          statusMessage: null,
          entries: [],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("hook/completed", {
        run: {
          id: "hook-1",
          eventName: "preToolUse",
          handlerType: "command",
          executionMode: "sync",
          scope: "turn",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "blocked",
          statusMessage: "blocked by hook",
          durationMs: 42,
          entries: [{ kind: "stderr", text: "blocked" }],
        },
      }),
    );

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.hook",
      data: expect.objectContaining({
        phase: "started",
        threadId: THREAD_ID,
        turnId: TURN_ID,
        hookRunId: "hook-1",
        eventName: "preToolUse",
        status: "running",
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.hook",
      data: expect.objectContaining({
        phase: "completed",
        hookRunId: "hook-1",
        status: "blocked",
        statusMessage: "blocked by hook",
        durationMs: 42,
        entries: [{ kind: "stderr", text: "blocked" }],
      }),
    });
  });

  it("projects thread-scoped codex hook notifications that omit a turn id", async () => {
    const onAgentEvent = vi.fn();
    const params = await createParams();
    const projector = await createProjector({ ...params, onAgentEvent });

    await projector.handleNotification({
      method: "hook/started",
      params: {
        threadId: THREAD_ID,
        turnId: null,
        run: {
          id: "hook-thread-1",
          eventName: "sessionStart",
          handlerType: "command",
          executionMode: "sync",
          scope: "thread",
          source: "project",
          sourcePath: "/repo/.codex/hooks.json",
          status: "running",
          statusMessage: null,
          entries: [],
        },
      },
    });

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "codex_app_server.hook",
      data: expect.objectContaining({
        phase: "started",
        threadId: THREAD_ID,
        turnId: null,
        hookRunId: "hook-thread-1",
        eventName: "sessionStart",
        scope: "thread",
      }),
    });
  });
});
