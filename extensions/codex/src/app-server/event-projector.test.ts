import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerEventProjector,
  type CodexAppServerToolTelemetry,
} from "./event-projector.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];

function createParams(): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    provider: "openai-codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel(),
    thinkLevel: "medium",
  } as unknown as EmbeddedRunAttemptParams;
}

function createProjector(params = createParams()): CodexAppServerEventProjector {
  return new CodexAppServerEventProjector(params, THREAD_ID, TURN_ID);
}

function createProjectorWithAssistantHooks() {
  const onAssistantMessageStart = vi.fn();
  const onPartialReply = vi.fn();
  return {
    onAssistantMessageStart,
    onPartialReply,
    projector: createProjector({
      ...createParams(),
      onAssistantMessageStart,
      onPartialReply,
    }),
  };
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

function turnCompleted(items: unknown[] = []): ProjectorNotification {
  return forCurrentTurn("turn/completed", {
    turn: { id: TURN_ID, status: "completed", items },
  });
}

describe("CodexAppServerEventProjector", () => {
  it("projects assistant deltas and usage into embedded attempt results", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      createProjectorWithAssistantHooks();

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
            totalTokens: 14,
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
    expect(result.attemptUsage).toMatchObject({ input: 5, output: 7, cacheRead: 2, total: 14 });
    expect(result.lastAssistant?.usage).toMatchObject({
      input: 5,
      output: 7,
      cacheRead: 2,
      totalTokens: 14,
    });
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("does not treat cumulative-only token usage as fresh context usage", async () => {
    const projector = createProjector();

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

  it("normalizes snake_case current token usage fields", async () => {
    const projector = createProjector();

    await projector.handleNotification(agentMessageDelta("done"));
    await projector.handleNotification(
      forCurrentTurn("thread/tokenUsage/updated", {
        tokenUsage: {
          total: { total_tokens: 1_000_000 },
          last_token_usage: {
            total_tokens: 20,
            input_tokens: 8,
            cached_input_tokens: 3,
            output_tokens: 9,
          },
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.attemptUsage).toMatchObject({ input: 8, output: 9, cacheRead: 3, total: 20 });
    expect(result.lastAssistant?.usage).toMatchObject({
      input: 8,
      output: 9,
      cacheRead: 3,
      totalTokens: 20,
    });
  });

  it("keeps intermediate agentMessage items out of the final visible reply", async () => {
    const { onAssistantMessageStart, onPartialReply, projector } =
      createProjectorWithAssistantHooks();

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
    const projector = createProjector();

    await projector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-2", itemId: "msg-1", delta: "wrong" },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([]);
  });

  it("preserves sessions_yield detection in attempt results", () => {
    const projector = createProjector();

    const result = projector.buildResult(buildEmptyToolTelemetry(), { yieldDetected: true });

    expect(result.yieldDetected).toBe(true);
  });

  it("projects reasoning end, plan updates, compaction state, and tool metadata", async () => {
    const onReasoningStream = vi.fn();
    const onReasoningEnd = vi.fn();
    const onAgentEvent = vi.fn();
    const params = {
      ...createParams(),
      onReasoningStream,
      onReasoningEnd,
      onAgentEvent,
    };
    const projector = createProjector(params);

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
    expect(result.toolMetas).toEqual([{ toolName: "sessions_send", meta: "completed" }]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(JSON.stringify(result.messagesSnapshot[1])).toContain("Codex reasoning");
    expect(JSON.stringify(result.messagesSnapshot[2])).toContain("Codex plan");
    expect(result.itemLifecycle).toMatchObject({ compactionCount: 1 });
  });

  it("continues projecting turn completion when an event consumer throws", async () => {
    const onAgentEvent = vi.fn(() => {
      throw new Error("consumer failed");
    });
    const projector = createProjector({
      ...createParams(),
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
});
