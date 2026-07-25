// Codex tests cover event projector plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  formatToolAggregate,
  inferToolMetaFromArgs,
  resetAgentEventsForTest,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
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
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerEventProjector } from "./event-projector.js";
import { createCodexTestModel, createCodexTestToolTerminalObserver } from "./test-support.js";

export { readAttemptTerminal } from "./attempt-terminal.test-helper.js";

export {
  CodexAppServerEventProjector,
  createCodexTestModel,
  createCodexTestToolTerminalObserver,
  createMockPluginRegistry,
  describe,
  embeddedAgentLog,
  expect,
  formatToolAggregate,
  fs,
  inferToolMetaFromArgs,
  initializeGlobalHookRunner,
  it,
  onInternalDiagnosticEvent,
  os,
  path,
  SessionManager,
  vi,
  withTempDir,
};
export type { EmbeddedRunAttemptParams, DiagnosticEventPayload };

export const THREAD_ID = "thread-1";
export const TURN_ID = "turn-1";
const tempDirs = new Set<string>();
export const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

export type ProjectorNotification = Parameters<
  CodexAppServerEventProjector["handleNotification"]
>[0];
type CodexAppServerEventProjectorOptions = ConstructorParameters<
  typeof CodexAppServerEventProjector
>[3];
type CodexAppServerToolTelemetry = Parameters<CodexAppServerEventProjector["buildResult"]>[0];

export function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function assistantMessage(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-chatgpt-responses",
    provider: "openai",
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

export async function createParams(): Promise<EmbeddedRunAttemptParams> {
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
    provider: "openai",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel(),
    thinkLevel: "medium",
    observeToolTerminal: createCodexTestToolTerminalObserver(),
  } as EmbeddedRunAttemptParams;
}

export function trackTempDir(tempDir: string): void {
  tempDirs.add(tempDir);
}

export async function createProjector(
  params?: EmbeddedRunAttemptParams,
  options?: CodexAppServerEventProjectorOptions,
): Promise<CodexAppServerEventProjector> {
  const resolvedParams = params ?? (await createParams());
  return new CodexAppServerEventProjector(resolvedParams, THREAD_ID, TURN_ID, options);
}

export async function createProjectorWithAssistantHooks() {
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

export function registerCodexEventProjectorTestLifecycle(): void {
  beforeEach(() => {
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(async () => {
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const tempDir of tempDirs) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });
}

export async function createProjectorWithHooks() {
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

export function buildEmptyToolTelemetry(): CodexAppServerToolTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
  };
}

export function expectUsageLimitPromptError(value: unknown): Error & { status: 429 } {
  expect(value).toBeInstanceOf(Error);
  const error = value as Error & { status?: unknown };
  expect(error.status).toBe(429);
  return error as Error & { status: 429 };
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

export function expectUsageFields(
  usage: unknown,
  expected: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite?: number;
    total: number;
  },
) {
  const record = requireRecord(usage, "usage");
  expect(record.input).toBe(expected.input);
  expect(record.output).toBe(expected.output);
  expect(record.cacheRead).toBe(expected.cacheRead);
  if (expected.cacheWrite !== undefined) {
    expect(record.cacheWrite).toBe(expected.cacheWrite);
  }
  expect(record.total ?? record.totalTokens).toBe(expected.total);
}

export function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
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

export function findAgentEvent(
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

export function findPlanEventWithSteps(
  mock: unknown,
  steps: Array<{ step: string; status: string }>,
) {
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
  throw new Error(`Expected plan event ${JSON.stringify(steps)}`);
}

export function forCurrentTurn(
  method: ProjectorNotification["method"],
  params: Record<string, unknown>,
): ProjectorNotification {
  return {
    method,
    params: { threadId: THREAD_ID, turnId: TURN_ID, ...params },
  } as ProjectorNotification;
}

export function agentMessageDelta(delta: string, itemId = "msg-1"): ProjectorNotification {
  return forCurrentTurn("item/agentMessage/delta", { itemId, delta });
}

export function appServerError(params: {
  message: string;
  willRetry: boolean;
}): ProjectorNotification {
  return forCurrentTurn("error", {
    error: {
      message: params.message,
      codexErrorInfo: null,
      additionalDetails: null,
    },
    willRetry: params.willRetry,
  });
}

export function rateLimitsUpdated(resetsAt: number): ProjectorNotification {
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

export function turnCompleted(items: unknown[] = []): ProjectorNotification {
  return turnWithStatus("completed", items);
}

export function turnWithStatus(status: string, items: unknown[] = []): ProjectorNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status, items },
    },
  } as ProjectorNotification;
}

export function pendingCommandStarted(id: string): ProjectorNotification {
  return forCurrentTurn("item/started", {
    item: {
      type: "commandExecution",
      id,
      command: "/bin/bash -lc 'sleep 600'",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    },
  });
}
