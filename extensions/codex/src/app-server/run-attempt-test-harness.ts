// Codex plugin module implements run attempt test harness behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  abortAndDrainAgentHarnessRun,
  nativeHookRelayTesting,
  queueAgentHarnessMessage,
  resetAgentEventsForTest,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { clearInternalHooks, resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { clearPluginCommands } from "openclaw/plugin-sdk/plugin-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { CodexServerNotification } from "./protocol.js";
import { resetCodexRateLimitCacheForTests } from "./rate-limit-cache.js";
import {
  runCodexAppServerAttempt as runCodexAppServerAttemptImpl,
  testing,
} from "./run-attempt.js";
import { closeCodexSandboxExecServersForTests } from "./sandbox-exec-server.js";
import { createCodexTestModel } from "./test-support.js";

export let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;
export const fastWait = { interval: 1, timeout: 5_000 } as const;
const appServerHarnessWait = { interval: 1, timeout: 120_000 } as const;
const activeAppServerAttemptsForTest = new Set<{
  abortController?: AbortController;
  promise: Promise<unknown>;
  sessionId: string;
  sessionKey?: string;
}>();

type RunCodexAppServerAttemptOptions = NonNullable<
  Parameters<typeof runCodexAppServerAttemptImpl>[1]
>;

export function queueActiveRunMessageForTest(
  ...args: Parameters<typeof queueAgentHarnessMessage>
): boolean {
  return queueAgentHarnessMessage(...args);
}

export function setCodexAppServerClientFactoryForTest(factory: CodexAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

export function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunCodexAppServerAttemptOptions = {},
) {
  const clientFactory = options.clientFactory ?? codexAppServerClientFactoryForTest;
  const abortController = params.abortSignal ? undefined : new AbortController();
  const trackedParams = abortController
    ? ({ ...params, abortSignal: abortController.signal } as EmbeddedRunAttemptParams)
    : params;
  const entry = {
    abortController,
    promise: undefined as unknown as Promise<unknown>,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  };
  const promise = runCodexAppServerAttemptImpl(
    trackedParams,
    clientFactory ? { ...options, clientFactory } : options,
  ).finally(() => {
    activeAppServerAttemptsForTest.delete(entry);
  });
  entry.promise = promise;
  activeAppServerAttemptsForTest.add(entry);
  promise.catch(() => undefined);
  return promise;
}

async function drainActiveAppServerAttemptsForTest(): Promise<void> {
  vi.useRealTimers();
  const attempts = [...activeAppServerAttemptsForTest];
  if (attempts.length === 0) {
    return;
  }
  for (const attempt of attempts) {
    attempt.abortController?.abort("test_cleanup");
  }
  const drainedSessions = new Set<string>();
  const sessionDrains = attempts.flatMap((attempt) => {
    if (!attempt.sessionId || drainedSessions.has(attempt.sessionId)) {
      return [];
    }
    drainedSessions.add(attempt.sessionId);
    return [
      abortAndDrainAgentHarnessRun({
        sessionId: attempt.sessionId,
        sessionKey: attempt.sessionKey,
        settleMs: 1_000,
        forceClear: true,
        reason: "test_cleanup",
      }).catch(() => undefined),
    ];
  });
  const drainResult = await Promise.race([
    Promise.allSettled([...attempts.map((attempt) => attempt.promise), ...sessionDrains]).then(
      () => "settled" as const,
    ),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 5_000);
    }),
  ]);
  if (drainResult === "settled") {
    activeAppServerAttemptsForTest.clear();
  }
}

export function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

export function createCodexRuntimePlanFixture(): NonNullable<
  EmbeddedRunAttemptParams["runtimePlan"]
> {
  return {
    auth: {},
    observability: {
      resolvedRef: "codex/gpt-5.4-codex",
      provider: "codex",
      modelId: "gpt-5.4-codex",
      harnessId: "codex",
    },
    prompt: {
      resolveSystemPromptContribution: () => undefined,
    },
    tools: {
      normalize: (tools: unknown[]) => tools,
      logDiagnostics: () => undefined,
    },
  } as unknown as NonNullable<EmbeddedRunAttemptParams["runtimePlan"]>;
}

export function assistantMessage(text: string, timestamp: number) {
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

export function userMessage(text: string, timestamp: number) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp,
  };
}

export function mockCall(mock: unknown, label: string, index = 0): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.at(index);
  if (!call) {
    throw new Error(`Expected ${label} call ${index + 1}`);
  }
  return call;
}

export function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-test",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir || "/tmp/openclaw-codex-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

export function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

export function rateLimitsUpdated(resetsAt: number): CodexServerNotification {
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
  };
}

type AppServerRequestHandler = (request: {
  id: string | number;
  method: string;
  params?: unknown;
}) => Promise<unknown>;

export function createAppServerHarness(
  requestImpl: (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>,
  options: {
    onStart?: (authProfileId: string | undefined, agentDir: string | undefined) => void;
  } = {},
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let notifyHandler: ((notification: CodexServerNotification) => Promise<void>) | undefined;
  let handleServerRequest: AppServerRequestHandler | undefined;
  const closeHandlers = new Set<() => void>();
  const request = vi.fn(async (method: string, params?: unknown, requestOptions?: unknown) => {
    requests.push({ method, params });
    return requestImpl(method, params, requestOptions as { signal?: AbortSignal } | undefined);
  });

  setCodexAppServerClientFactoryForTest(async (_startOptions, authProfileId, agentDir) => {
    options.onStart?.(authProfileId, agentDir);
    return {
      getServerVersion: () => "0.132.0",
      request,
      addNotificationHandler: (
        handler: (notification: CodexServerNotification) => Promise<void>,
      ) => {
        notifyHandler = handler;
        return () => {
          if (notifyHandler === handler) {
            notifyHandler = undefined;
          }
        };
      },
      addRequestHandler: (handler: AppServerRequestHandler) => {
        handleServerRequest = handler;
        return () => undefined;
      },
      addCloseHandler: (handler: () => void) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
    } as never;
  });

  const waitForServerRequestHandler = async () => {
    await vi.waitFor(() => expect(handleServerRequest).toBeTypeOf("function"), {
      interval: 1,
      timeout: appServerHarnessWait.timeout,
    });
    return handleServerRequest!;
  };

  const waitForNotificationHandler = async () => {
    await vi.waitFor(() => expect(notifyHandler).toBeTypeOf("function"), {
      interval: 1,
      timeout: appServerHarnessWait.timeout,
    });
    return notifyHandler!;
  };
  const sendNotification = async (notification: CodexServerNotification) => {
    const handler = notifyHandler ?? (await waitForNotificationHandler());
    await handler(notification);
  };

  return {
    request,
    requests,
    waitForMethod: async (method: string, timeoutMs: number = appServerHarnessWait.timeout) => {
      await vi.waitFor(
        () => {
          if (!requests.some((entry) => entry.method === method)) {
            const mockMethods = request.mock.calls.map((call) => call[0]);
            throw new Error(
              "expected app-server method " +
                method +
                "; saw " +
                requests.map((entry) => entry.method).join(", ") +
                "; mock saw " +
                mockMethods.join(", "),
            );
          }
        },
        { interval: 1, timeout: timeoutMs },
      );
    },
    notify: async (notification: CodexServerNotification) => {
      await sendNotification(notification);
    },
    waitForServerRequestHandler,
    handleServerRequest: async (requestLocal: Parameters<AppServerRequestHandler>[0]) => {
      const handler = await waitForServerRequestHandler();
      return handler(requestLocal);
    },
    completeTurn: async (params: { threadId: string; turnId: string }) => {
      await sendNotification({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: { id: params.turnId, status: "completed" },
        },
      });
    },
    close: () => {
      for (const handler of closeHandlers) {
        handler();
      }
    },
  };
}

export function createStartedThreadHarness(
  requestImpl: (
    method: string,
    params: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown> = async () => undefined,
  options: {
    onStart?: (authProfileId: string | undefined, agentDir: string | undefined) => void;
  } = {},
) {
  return createAppServerHarness(async (method, params, requestOptions) => {
    const override = await requestImpl(method, params, requestOptions);
    if (override !== undefined) {
      return override;
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  }, options);
}

export function createResumeHarness() {
  return createAppServerHarness(async (method) => {
    if (method === "thread/resume") {
      return threadStartResult("thread-existing");
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  });
}

export function extractRelayIdFromThreadRequest(params: unknown): string {
  const command = extractNativeHookRelayCommandFromThreadRequest(params);
  const match = command.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

export function extractGenerationFromThreadRequest(params: unknown): string {
  const command = extractNativeHookRelayCommandFromThreadRequest(params);
  const match = command.match(/--generation ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay generation missing from command: ${command}`);
  }
  return match[1];
}

function extractNativeHookRelayCommandFromThreadRequest(params: unknown): string {
  const config = (params as { config?: Record<string, unknown> }).config;
  let command: string | undefined;
  for (const key of [
    "hooks.PreToolUse",
    "hooks.PostToolUse",
    "hooks.PermissionRequest",
    "hooks.Stop",
  ]) {
    const entries = config?.[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries as Array<{ hooks?: Array<{ command?: string }> }>) {
      command = entry.hooks?.find((hook) => typeof hook.command === "string")?.command;
      if (command) {
        break;
      }
    }
    if (command) {
      break;
    }
  }
  if (!command) {
    throw new Error("native hook relay command missing from thread request");
  }
  return command;
}

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

export function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: name + " test tool",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: name + " done" }],
      details: {},
    })),
  };
}

export function setupRunAttemptTestHooks(): void {
  beforeEach(async () => {
    vi.useRealTimers();
    clearInternalHooks();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-run-"));
  });

  afterEach(async () => {
    await drainActiveAppServerAttemptsForTest();
    await closeCodexSandboxExecServersForTests();
    resetCodexAppServerClientFactoryForTest();
    testing.resetOpenClawCodingToolsFactoryForTests();
    testing.resetEnsuredCodexWorkspaceDirsForTests();
    testing.clearPendingCodexNativeHookRelayUnregistersForTests();
    resetCodexRateLimitCacheForTests();
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    clearPluginCommands();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    clearInternalHooks();
    defaultCodexAppInventoryCache.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeCodexSandboxExecServersForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
}
