import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { resetAgentEventsForTest } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerEventProjector,
  type CodexAppServerEventProjectorOptions,
  type CodexAppServerToolTelemetry,
} from "./event-projector.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";
import { rememberCodexRateLimits, resetCodexRateLimitCacheForTests } from "./rate-limit-cache.js";
import { createCodexTestModel } from "./test-support.js";

const THREAD_ID = "thread-1";
const TURN_ID = "turn-1";
const tempDirs = new Set<string>();

type ProjectorNotification = Parameters<CodexAppServerEventProjector["handleNotification"]>[0];

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

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
  options?: CodexAppServerEventProjectorOptions,
): Promise<CodexAppServerEventProjector> {
  const resolvedParams = params ?? (await createParams());
  return new CodexAppServerEventProjector(resolvedParams, THREAD_ID, TURN_ID, options);
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
  resetDiagnosticEventsForTest();
});

afterEach(async () => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  resetGlobalHookRunner();
  resetCodexRateLimitCacheForTests();
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function expectUsageFields(
  usage: unknown,
  expected: { input: number; output: number; cacheRead: number; total: number },
) {
  const record = requireRecord(usage, "usage");
  expect(record.input).toBe(expected.input);
  expect(record.output).toBe(expected.output);
  expect(record.cacheRead).toBe(expected.cacheRead);
  expect(record.total ?? record.totalTokens).toBe(expected.total);
}

function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error(`Expected ${label} mock calls`);
  }
  const call = calls[callIndex];
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function findAgentEvent(
  mock: unknown,
  params: { stream: string; phase?: string; itemId?: string; name?: string },
) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error("Expected onAgentEvent mock calls");
  }
  for (const call of calls) {
    const event = requireRecord(call[0], "agent event");
    const data = requireRecord(event.data, "agent event data");
    if (
      event.stream === params.stream &&
      (!params.phase || data.phase === params.phase) &&
      (!params.itemId || data.itemId === params.itemId) &&
      (!params.name || data.name === params.name)
    ) {
      return { event, data };
    }
  }
  throw new Error(`Expected agent event ${params.stream}`);
}

function findPlanEventWithSteps(mock: unknown, steps: string[]) {
  const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error("Expected onAgentEvent mock calls");
  }
  for (const call of calls) {
    const event = requireRecord(call[0], "agent event");
    if (event.stream !== "plan") {
      continue;
    }
    const data = requireRecord(event.data, "plan event data");
    if (JSON.stringify(data.steps) === JSON.stringify(steps)) {
      return data;
    }
  }
  throw new Error(`Expected plan event ${steps.join(", ")}`);
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

function rateLimitsUpdated(resetsAt: number): ProjectorNotification {
  return {
    method: "account/rateLimits/updated",
    params: {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
    },
  } as ProjectorNotification;
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
    expectUsageFields(result.attemptUsage, { input: 3, output: 7, cacheRead: 2, total: 12 });
    expectUsageFields(result.lastAssistant?.usage, {
      input: 3,
      output: 7,
      cacheRead: 2,
      total: 12,
    });
    expect(result.replayMetadata.replaySafe).toBe(true);
  });

  it("records canonical OpenAI Codex app-server turns with Codex local attribution", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      provider: "openai",
      modelId: "gpt-5.5",
      model: {
        ...createCodexTestModel("openai"),
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-responses",
      } as EmbeddedRunAttemptParams["model"],
      runtimePlan: {
        auth: {},
        observability: {
          resolvedRef: "openai/gpt-5.5",
          provider: "openai",
          modelId: "gpt-5.5",
          harnessId: "codex",
        },
        prompt: {
          resolveSystemPromptContribution: () => undefined,
        },
        tools: {
          normalize: (tools: unknown[]) => tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as EmbeddedRunAttemptParams["runtimePlan"],
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.lastAssistant?.provider).toBe("openai-codex");
    expect(result.lastAssistant?.api).toBe("openai-codex-responses");
    expect(result.lastAssistant?.model).toBe("gpt-5.5");
  });

  it("preserves OpenAI attribution for Codex app-server OpenAI API-key fallback profiles", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      provider: "openai",
      authProfileId: "openai:work",
      modelId: "gpt-5.5",
      model: {
        ...createCodexTestModel("openai"),
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-responses",
      } as EmbeddedRunAttemptParams["model"],
      runtimePlan: {
        auth: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          harnessAuthProvider: "openai-codex",
          forwardedAuthProfileId: "openai:work",
        },
        observability: {
          resolvedRef: "openai/gpt-5.5",
          provider: "openai",
          modelId: "gpt-5.5",
          harnessId: "codex",
        },
        prompt: {
          resolveSystemPromptContribution: () => undefined,
        },
        tools: {
          normalize: (tools: unknown[]) => tools,
          logDiagnostics: () => undefined,
        },
      } as unknown as EmbeddedRunAttemptParams["runtimePlan"],
    });

    await projector.handleNotification(
      turnCompleted([{ type: "agentMessage", id: "msg-1", text: "done" }]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.lastAssistant?.provider).toBe("openai");
    expect(result.lastAssistant?.api).toBe("openai-responses");
    expect(result.lastAssistant?.model).toBe("gpt-5.5");
  });

  it("preserves inbound sender metadata on the mirrored user prompt", async () => {
    const params = await createParams();
    const projector = await createProjector({
      ...params,
      messageChannel: "discord",
      messageProvider: "discord-voice",
      senderId: "user-123",
      senderName: "Test User",
      senderUsername: "testuser",
      inputProvenance: {
        kind: "external_user",
        sourceChannel: "discord",
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());

    const userMessage = requireRecord(result.messagesSnapshot[0], "user message");
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toBe("hello");
    expect(userMessage.sourceChannel).toBe("discord");
    expect(userMessage.senderId).toBe("user-123");
    expect(userMessage.senderName).toBe("Test User");
    expect(userMessage.senderUsername).toBe("testuser");
    expect(userMessage.senderLabel).toBe("Test User (user-123)");
    expect(userMessage.provenance).toEqual({
      kind: "external_user",
      sourceChannel: "discord",
    });
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
    expectUsageFields(result.lastAssistant?.usage, {
      input: 0,
      output: 0,
      cacheRead: 0,
      total: 0,
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

  it("attaches native Codex image-generation saved paths as reply media", async () => {
    const projector = await createProjector();
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: "A tiny blue square",
          result: "Zm9v",
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toStrictEqual([]);
    expect(result.toolMediaUrls).toEqual([savedPath]);
  });

  it("does not append native Codex image-generation media after explicit media delivery", async () => {
    const projector = await createProjector();
    const savedPath = "/tmp/codex-home/generated_images/session-1/ig_123.png";

    await projector.handleNotification(
      turnCompleted([
        {
          type: "imageGeneration",
          id: "ig_123",
          status: "completed",
          revisedPrompt: null,
          result: "Zm9v",
          savedPath,
        },
      ]),
    );

    const result = projector.buildResult({
      ...buildEmptyToolTelemetry(),
      messagingToolSentMediaUrls: [savedPath],
      toolMediaUrls: [],
    });

    expect(result.toolMediaUrls).toStrictEqual([]);
  });

  it("does not promote repeated tool progress text to the final assistant reply", async () => {
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
    const toolProgressText = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string })
      .text;
    expect(toolProgressText).toBe("🛠️ `run tests (workspace)`");

    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-tool-progress",
          role: "assistant",
          content: [{ type: "output_text", text: toolProgressText }],
        },
      }),
    );
    await projector.handleNotification(turnCompleted());

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual([]);
    expect(result.lastAssistant).toBeUndefined();
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

  it("uses Codex rate-limit resets for usage-limit app-server errors", async () => {
    const projector = await createProjector();
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;

    await projector.handleNotification(rateLimitsUpdated(resetsAt));
    await projector.handleNotification(
      forCurrentTurn("error", {
        error: {
          message: "You've reached your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
        willRetry: false,
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptError).toContain("Run /codex account");
    expect(result.promptErrorSource).toBe("prompt");
  });

  it("uses Codex rate-limit resets for failed turns", async () => {
    const projector = await createProjector();
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;

    await projector.handleNotification(rateLimitsUpdated(resetsAt));
    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptErrorSource).toBe("prompt");
  });

  it("uses a recent Codex rate-limit snapshot when failed turns omit reset details", async () => {
    const projector = await createProjector();
    const resetsAt = Math.ceil(Date.now() / 1000) + 120;
    rememberCodexRateLimits({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: null,
        credits: null,
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
      rateLimitsByLimitId: null,
    });

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: {
            message: "You've reached your usage limit.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Next reset in");
    expect(result.promptErrorSource).toBe("prompt");
  });

  it("preserves Codex retry hints when failed turns omit structured reset details", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      forCurrentTurn("turn/completed", {
        turn: {
          id: TURN_ID,
          status: "failed",
          error: {
            message:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 9:00 AM.",
            codexErrorInfo: "usageLimitExceeded",
            additionalDetails: null,
          },
          items: [],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.promptError).toContain("You've reached your Codex subscription usage limit.");
    expect(result.promptError).toContain("Codex says to try again at May 11th, 2026 9:00 AM.");
    expect(result.promptError).not.toContain("Codex did not return a reset time");
    expect(result.promptErrorSource).toBe("prompt");
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

    expectUsageFields(result.attemptUsage, { input: 5, output: 9, cacheRead: 3, total: 17 });
    expectUsageFields(result.lastAssistant?.usage, {
      input: 5,
      output: 9,
      cacheRead: 3,
      total: 17,
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

  it("streams commentary agent messages as keyed progress events", async () => {
    const onAgentEvent = vi.fn();
    const onPartialReply = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      onAgentEvent,
      onPartialReply,
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "",
        },
      }),
    );
    await projector.handleNotification(agentMessageDelta("Checking", "msg-commentary"));
    await projector.handleNotification(
      agentMessageDelta(" the app-server stream", "msg-commentary"),
    );
    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "Checking the app-server stream",
        },
        {
          type: "agentMessage",
          id: "msg-final",
          phase: "final_answer",
          text: "final answer",
        },
      ]),
    );

    const progressEvents = onAgentEvent.mock.calls
      .map((call) => call[0])
      .filter((event) => event.stream === "item" && event.data.kind === "preamble");

    expect(onPartialReply).not.toHaveBeenCalled();
    expect(progressEvents.map((event) => event.data)).toEqual([
      {
        itemId: "msg-commentary",
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText: "Checking",
        source: "codex-app-server",
      },
      {
        itemId: "msg-commentary",
        kind: "preamble",
        title: "Preamble",
        phase: "update",
        progressText: "Checking the app-server stream",
        source: "codex-app-server",
      },
    ]);

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual(["final answer"]);
  });

  it("does not resolve commentary-phase assistant text as the final reply", async () => {
    const projector = await createProjector();

    await projector.handleNotification(
      turnCompleted([
        {
          type: "agentMessage",
          id: "msg-final",
          phase: "final_answer",
          text: "final answer",
        },
        {
          type: "agentMessage",
          id: "msg-commentary",
          phase: "commentary",
          text: "I am checking one more thing.",
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.assistantTexts).toEqual(["final answer"]);
  });

  it("ignores notifications for other turns", async () => {
    const projector = await createProjector();

    await projector.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn-2", itemId: "msg-1", delta: "wrong" },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toStrictEqual([]);
  });

  it("mirrors native subagent notifications before current-turn filtering", async () => {
    const projector = await createProjector({
      ...(await createParams()),
      sessionKey: "agent:main:main",
    } as EmbeddedRunAttemptParams);
    const mirrorSpy = vi.spyOn(CodexNativeSubagentTaskMirror.prototype, "handleNotification");
    const notification = {
      method: "item/completed",
      params: {
        threadId: THREAD_ID,
        turnId: "child-turn",
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          senderThreadId: THREAD_ID,
          receiverThreadIds: ["child-thread"],
          agentsStates: {
            "child-thread": { status: "completed", message: "done" },
          },
        },
      },
    } as ProjectorNotification;

    await projector.handleNotification(notification);

    expect(mirrorSpy).toHaveBeenCalledWith(notification);
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
    expect(result.assistantTexts).toStrictEqual([]);
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

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "started",
    }).data;
    expect(started.reviewId).toBe("review-1");
    expect(started.targetItemId).toBe("cmd-1");
    expect(started.status).toBe("inProgress");
    expect(started.actionType).toBe("execve");
    const completed = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.guardian",
      phase: "completed",
    }).data;
    expect(completed.reviewId).toBe("review-1");
    expect(completed.targetItemId).toBe("cmd-1");
    expect(completed.decisionSource).toBe("agent");
    expect(completed.status).toBe("approved");
    expect(completed.riskLevel).toBe("low");
    expect(completed.userAuthorization).toBe("high");
    expect(completed.rationale).toBe("Benign local probe.");
    expect(completed.actionType).toBe("execve");
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
    expect(findPlanEventWithSteps(onAgentEvent, ["patch (in_progress)"]).steps).toEqual([
      "patch (in_progress)",
    ]);
    expect(findAgentEvent(onAgentEvent, { stream: "compaction", phase: "start" }).data.itemId).toBe(
      "compact-1",
    );
    expect(findAgentEvent(onAgentEvent, { stream: "compaction", phase: "end" }).data).toMatchObject(
      {
        itemId: "compact-1",
        completed: true,
      },
    );
    expect(result.toolMetas).toEqual([{ toolName: "sessions_send" }]);
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(JSON.stringify(result.messagesSnapshot[1])).toContain("Codex reasoning");
    expect(JSON.stringify(result.messagesSnapshot[2])).toContain("Codex plan");
    expect(requireRecord(result.itemLifecycle, "item lifecycle").compactionCount).toBe(1);
  });

  it("synthesizes normalized tool progress for Codex-native tool items", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
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
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "commandExecution",
            id: "cmd-1",
            command: "pnpm test extensions/codex",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "completed",
            commandActions: [],
            aggregatedOutput: "ok",
            exitCode: 0,
            durationMs: 42,
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const itemStart = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "start",
      itemId: "cmd-1",
    }).data;
    expect(itemStart.kind).toBe("command");
    expect(itemStart.name).toBe("bash");
    expect(itemStart.suppressChannelProgress).toBe(true);
    const toolStart = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "start",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolStart.toolCallId).toBe("cmd-1");
    expect(toolStart.args).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-1",
      name: "bash",
    }).data;
    expect(toolResult.toolCallId).toBe("cmd-1");
    expect(toolResult.status).toBe("completed");
    expect(toolResult.isError).toBe(false);
    const toolResultPayload = requireRecord(toolResult.result, "tool result payload");
    expect(toolResultPayload.exitCode).toBe(0);
    expect(toolResultPayload.durationMs).toBe(42);
    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        {
          type:
            | "tool.execution.started"
            | "tool.execution.completed"
            | "tool.execution.error"
            | "tool.execution.blocked";
        }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        durationMs: "durationMs" in event ? event.durationMs : undefined,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "bash",
        toolCallId: "cmd-1",
        durationMs: undefined,
      },
      {
        type: "tool.execution.completed",
        toolName: "bash",
        toolCallId: "cmd-1",
        durationMs: 42,
      },
    ]);
    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    expect(assistant.role).toBe("assistant");
    const assistantContent = requireArray(assistant.content, "assistant content");
    expect(assistantContent[0]).toEqual({
      type: "toolCall",
      id: "cmd-1",
      name: "bash",
      arguments: { command: "pnpm test extensions/codex", cwd: "/workspace" },
      input: { command: "pnpm test extensions/codex", cwd: "/workspace" },
    });
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.role).toBe("toolResult");
    expect(toolResultMessage.toolCallId).toBe("cmd-1");
    expect(toolResultMessage.toolName).toBe("bash");
    expect(toolResultMessage.isError).toBe(false);
    const toolResultContent = requireArray(toolResultMessage.content, "tool result content");
    const toolResultContentItem = requireRecord(toolResultContent[0], "tool result content item");
    expect(toolResultContentItem.type).toBe("toolResult");
    expect(toolResultContentItem.id).toBe("cmd-1");
    expect(toolResultContentItem.name).toBe("bash");
    expect(toolResultContentItem.toolName).toBe("bash");
    expect(toolResultContentItem.toolCallId).toBe("cmd-1");
    expect(toolResultContentItem.content).toBe("ok");
  });

  it("orders declined native tool diagnostics after their start event", async () => {
    const projector = await createProjector();
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => diagnosticEvents.push(event));

    try {
      await projector.handleNotification(
        forCurrentTurn("item/started", {
          item: {
            type: "commandExecution",
            id: "cmd-declined",
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
      await projector.handleNotification(
        forCurrentTurn("item/completed", {
          item: {
            type: "commandExecution",
            id: "cmd-declined",
            command: "pnpm test extensions/codex",
            cwd: "/workspace",
            processId: null,
            source: "agent",
            status: "declined",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: 1,
          },
        }),
      );
      await flushDiagnosticEvents();
    } finally {
      unsubscribe();
    }

    const toolDiagnosticEvents = diagnosticEvents.filter(
      (
        event,
      ): event is Extract<
        DiagnosticEventPayload,
        {
          type:
            | "tool.execution.started"
            | "tool.execution.completed"
            | "tool.execution.error"
            | "tool.execution.blocked";
        }
      > => event.type.startsWith("tool.execution."),
    );
    expect(
      toolDiagnosticEvents.map((event) => ({
        type: event.type,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      })),
    ).toEqual([
      {
        type: "tool.execution.started",
        toolName: "bash",
        toolCallId: "cmd-declined",
      },
      {
        type: "tool.execution.blocked",
        toolName: "bash",
        toolCallId: "cmd-declined",
      },
    ]);
  });

  it("emits after_tool_call observations for Codex-native tool item completions", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector({
      ...(await createParams()),
      agentId: "main",
      sessionKey: "agent:main:session-1",
    });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-observed",
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
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-observed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("bash");
    expect(event.params).toEqual({ command: "pnpm test extensions/codex", cwd: "/workspace" });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("cmd-observed");
    expect(event.result).toEqual({ status: "completed", exitCode: 0, durationMs: 42 });
    expect(event.durationMs).toBeGreaterThanOrEqual(42);
    const context = requireRecord(
      mockCallArg(afterToolCall, 0, 1, "after_tool_call context"),
      "after_tool_call context",
    );
    expect(context.agentId).toBe("main");
    expect(context.sessionId).toBe("session-1");
    expect(context.sessionKey).toBe("agent:main:session-1");
    expect(context.runId).toBe("run-1");
    expect(context.toolName).toBe("bash");
    expect(context.toolCallId).toBe("cmd-observed");
  });

  it("does not duplicate native items already covered by PostToolUse relay", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );
    const projector = await createProjector(
      { ...(await createParams()), sessionKey: "agent:main:session-1" },
      { nativePostToolUseRelayEnabled: true },
    );

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-relayed",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "completed",
          commandActions: [],
          aggregatedOutput: "ok",
          exitCode: 0,
          durationMs: 42,
        },
      }),
    );
    expect(afterToolCall).not.toHaveBeenCalled();

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "webSearch",
          id: "search-observed",
          query: "native tool observability",
          status: "completed",
          durationMs: 5,
        },
      }),
    );

    await vi.waitFor(() => expect(afterToolCall).toHaveBeenCalledTimes(1));
    const event = requireRecord(
      mockCallArg(afterToolCall, 0, 0, "after_tool_call event"),
      "after_tool_call event",
    );
    expect(event.toolName).toBe("web_search");
    expect(event.params).toEqual({ query: "native tool observability" });
    expect(event.runId).toBe("run-1");
    expect(event.toolCallId).toBe("search-observed");
    expect(event.result).toEqual({ status: "completed" });
  });

  it("records dynamic OpenClaw tool calls in mirrored transcript snapshots", async () => {
    const projector = await createProjector();

    projector.recordDynamicToolCall({
      callId: "call-browser-1",
      tool: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
    });
    projector.recordDynamicToolResult({
      callId: "call-browser-1",
      tool: "browser",
      success: true,
      contentItems: [{ type: "inputText", text: "opened" }],
    });
    await projector.handleNotification(agentMessageDelta("done"));

    const result = projector.buildResult(buildEmptyToolTelemetry());

    expect(result.messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const assistant = requireRecord(result.messagesSnapshot[1], "assistant tool call message");
    expect(assistant.role).toBe("assistant");
    expect(requireArray(assistant.content, "assistant content")[0]).toEqual({
      type: "toolCall",
      id: "call-browser-1",
      name: "browser",
      arguments: { action: "open", url: "http://127.0.0.1:3000" },
      input: { action: "open", url: "http://127.0.0.1:3000" },
    });
    const toolResultMessage = requireRecord(result.messagesSnapshot[2], "tool result message");
    expect(toolResultMessage.role).toBe("toolResult");
    expect(toolResultMessage.toolCallId).toBe("call-browser-1");
    expect(toolResultMessage.toolName).toBe("browser");
    expect(toolResultMessage.isError).toBe(false);
    const toolResultContent = requireRecord(
      requireArray(toolResultMessage.content, "tool result content")[0],
      "tool result content item",
    );
    expect(toolResultContent.type).toBe("toolResult");
    expect(toolResultContent.id).toBe("call-browser-1");
    expect(toolResultContent.name).toBe("browser");
    expect(toolResultContent.toolName).toBe("browser");
    expect(toolResultContent.toolCallId).toBe("call-browser-1");
    expect(toolResultContent.content).toBe("opened");
  });

  it("marks declined Codex-native tool results as non-success", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-declined",
          command: "pnpm test extensions/codex",
          cwd: "/workspace",
          processId: null,
          source: "agent",
          status: "declined",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      }),
    );

    const itemEnd = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "end",
      itemId: "cmd-declined",
    }).data;
    expect(itemEnd.kind).toBe("command");
    expect(itemEnd.name).toBe("bash");
    expect(itemEnd.status).toBe("blocked");
    expect(itemEnd.suppressChannelProgress).toBe(true);
    const toolResult = findAgentEvent(onAgentEvent, {
      stream: "tool",
      phase: "result",
      itemId: "cmd-declined",
      name: "bash",
    }).data;
    expect(toolResult.toolCallId).toBe("cmd-declined");
    expect(toolResult.status).toBe("blocked");
    expect(toolResult.isError).toBe(true);
  });

  it("leaves Codex dynamic tool item progress to item/tool/call normalization", async () => {
    const onAgentEvent = vi.fn();
    const projector = await createProjector({ ...(await createParams()), onAgentEvent });

    await projector.handleNotification(
      forCurrentTurn("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "call-1",
          namespace: null,
          tool: "message",
          arguments: { action: "send" },
          status: "inProgress",
          contentItems: null,
          success: null,
          durationMs: null,
        },
      }),
    );

    const itemStart = findAgentEvent(onAgentEvent, {
      stream: "item",
      phase: "start",
      name: "message",
    }).data;
    expect(itemStart.kind).toBe("tool");
    expect(itemStart.suppressChannelProgress).toBe(true);
    const calls = (onAgentEvent as { mock: { calls: unknown[][] } }).mock.calls;
    const toolStart = calls.some((call) => {
      const event = requireRecord(call[0], "agent event");
      if (event.stream !== "tool") {
        return false;
      }
      const data = requireRecord(event.data, "agent event data");
      return data.phase === "start" && data.name === "message";
    });
    expect(toolStart).toBe(false);
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
      text: "🛠️ `run tests (workspace)`",
    });
  });

  it("can emit raw verbose tool summaries through onToolResult", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      toolProgressDetail: "raw",
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

    expect(onToolResult).toHaveBeenCalledWith({
      text: "🛠️ `` run tests (workspace), `pnpm test extensions/codex` ``",
    });
  });

  it("redacts secrets in verbose command summaries", async () => {
    const onToolResult = vi.fn();
    const projector = await createProjector({
      ...(await createParams()),
      verboseLevel: "on",
      toolProgressDetail: "raw",
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

    const text = (mockCallArg(onToolResult, 0, 0, "onToolResult") as { text?: string }).text;
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
    const truncatedOutput = mockCallArg(onToolResult, 19, 0, "onToolResult") as {
      text?: string;
    };
    expect(truncatedOutput.text).toContain("...(truncated)...");
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

    expect(findAgentEvent(onAgentEvent, { stream: "plan" }).data.steps).toEqual([
      "step one",
      "step two",
    ]);
    expect(result.assistantTexts).toEqual(["final answer"]);
    expect(JSON.stringify(result.messagesSnapshot)).toContain("Codex plan");
  });

  it("fires before_compaction and after_compaction hooks for codex compaction items", async () => {
    const { projector, beforeCompaction, afterCompaction } = await createProjectorWithHooks();
    const openSpy = vi.spyOn(SessionManager, "open");

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
    expect(openSpy).not.toHaveBeenCalled();

    const beforePayload = requireRecord(
      mockCallArg(beforeCompaction, 0, 0, "beforeCompaction"),
      "before payload",
    );
    expect(beforePayload.messageCount).toBe(1);
    expect(String(beforePayload.sessionFile)).toContain("session.jsonl");
    const beforeMessages = requireArray(beforePayload.messages, "before messages");
    expect(requireRecord(beforeMessages[0], "before message").role).toBe("assistant");
    const beforeContext = requireRecord(
      mockCallArg(beforeCompaction, 0, 1, "beforeCompaction"),
      "before context",
    );
    expect(beforeContext.runId).toBe("run-1");
    expect(beforeContext.sessionId).toBe("session-1");
    const afterPayload = requireRecord(
      mockCallArg(afterCompaction, 0, 0, "afterCompaction"),
      "after payload",
    );
    expect(afterPayload.messageCount).toBe(1);
    expect(afterPayload.compactedCount).toBe(-1);
    expect(String(afterPayload.sessionFile)).toContain("session.jsonl");
    const afterContext = requireRecord(
      mockCallArg(afterCompaction, 0, 1, "afterCompaction"),
      "after context",
    );
    expect(afterContext.runId).toBe("run-1");
    expect(afterContext.sessionId).toBe("session-1");
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

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "started",
    }).data;
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.turnId).toBe(TURN_ID);
    expect(started.hookRunId).toBe("hook-1");
    expect(started.eventName).toBe("preToolUse");
    expect(started.status).toBe("running");
    const completed = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "completed",
    }).data;
    expect(completed.hookRunId).toBe("hook-1");
    expect(completed.status).toBe("blocked");
    expect(completed.statusMessage).toBe("blocked by hook");
    expect(completed.durationMs).toBe(42);
    expect(completed.entries).toEqual([{ kind: "stderr", text: "blocked" }]);
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

    const started = findAgentEvent(onAgentEvent, {
      stream: "codex_app_server.hook",
      phase: "started",
    }).data;
    expect(started.threadId).toBe(THREAD_ID);
    expect(started.turnId).toBeNull();
    expect(started.hookRunId).toBe("hook-thread-1");
    expect(started.eventName).toBe("sessionStart");
    expect(started.scope).toBe("thread");
  });
});
