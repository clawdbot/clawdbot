// Codex plugin module implements run attempt test harness behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import {
  abortAndDrainAgentHarnessRun,
  nativeHookRelayTesting,
  queueAgentHarnessMessage,
  resetAgentEventsForTest,
  runBeforeToolCallHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { clearInternalHooks, resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { clearPluginCommands } from "openclaw/plugin-sdk/plugin-runtime";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "./app-inventory-cache.js";
import type { CodexAppServerClient } from "./client.js";
import {
  mockClientRuntimeMethods as createMockClientRuntimeMethods,
  threadStartResult as createThreadStartResult,
  turnStartResult as createTurnStartResult,
} from "./codex-app-server.test-fixtures.js";
import * as codexRequirements from "./config-requirements.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import type { CodexServerNotification } from "./protocol.js";
import type { CodexEmbeddedRunAttemptParams as EmbeddedRunAttemptParams } from "./run-attempt-types.js";
import { runCodexAppServerAttempt as runCodexAppServerAttemptImpl } from "./run-attempt.js";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import {
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientFactory, CodexAppServerClientOptions } from "./shared-client.js";
import {
  adaptCodexTestClientFactory,
  createCodexTestModel,
  createCodexTestToolTerminalObserver,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";
import { codexWorkspaceDirCache } from "./workspace-dir-cache.js";

export {
  extractGenerationFromThreadRequest,
  extractRelayIdFromThreadRequest,
} from "./run-attempt-hook-test-support.js";

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

function createHarnessHostCapabilities(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams["hostCapabilities"] {
  return Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    createToolSurface: (options) => createOpenClawCodingTools(options),
    runBeforeToolCall: async ({ nativeOperation: _nativeOperation, approvalMode, ...request }) =>
      await runBeforeToolCallHook({
        ...request,
        approvalMode: approvalMode === "defer" ? "defer" : "request",
        ctx: Object.freeze({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.config ? { config: params.config } : {}),
          ...(params.workspaceDir
            ? { cwd: params.workspaceDir, workspaceDir: params.workspaceDir }
            : {}),
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
          runId: params.runId,
          trigger: params.trigger,
          approvalReviewerDeviceId: params.approvalReviewerDeviceId,
          turnSourceChannel: params.messageChannel ?? params.messageProvider,
          turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
          turnSourceAccountId: params.agentAccountId,
          turnSourceThreadId: params.currentThreadTs,
        }),
      }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
  });
}

vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovals: execApprovalsRuntimeMocks.loadExecApprovals,
  };
});

export let tempDir: string;
let codexAppServerClientFactoryForTest: CodexAppServerClientFactory | undefined;
const multiplexedTestClients = new WeakSet<CodexAppServerClient>();
export const fastWait = { interval: 1, timeout: 5_000 } as const;
const appServerHarnessWait = { interval: 1, timeout: 120_000 } as const;
const activeAppServerAttemptsForTest = new Set<{
  abortController?: AbortController;
  promise: Promise<unknown>;
  sessionId: string;
  sessionKey?: string;
}>();
const activeHarnessHostClosuresForTest = new Set<() => void>();

type RunCodexAppServerAttemptOptions = Omit<
  NonNullable<Parameters<typeof runCodexAppServerAttemptImpl>[1]>,
  "bindingStore"
> & {
  bindingStore?: NonNullable<Parameters<typeof runCodexAppServerAttemptImpl>[1]>["bindingStore"];
};

export function queueActiveRunMessageForTest(
  ...args: Parameters<typeof queueAgentHarnessMessage>
): boolean {
  return queueAgentHarnessMessage(...args);
}

export function setCodexAppServerClientFactoryForTest(
  factory: CodexTestAppServerClientFactory,
): void {
  codexAppServerClientFactoryForTest = adaptCodexTestClientFactory(async (...args) => {
    const client = await factory(...args);
    const testClient = client as unknown as {
      addCloseHandler?: (handler: (client: CodexAppServerClient) => void) => () => void;
    };
    // Narrow test doubles still need the client lifecycle hook installed by
    // the keyed router, even when the test never simulates transport closure.
    testClient.addCloseHandler ??= () => () => undefined;
    multiplexCodexTestClientHandlers(client);
    return client;
  });
}

// The keyed router, client runtime, and subagent monitor each register their
// own handlers; single-slot test doubles would silently drop all but the last.
export function multiplexCodexTestClientHandlers(client: CodexAppServerClient): void {
  if (multiplexedTestClients.has(client)) {
    return;
  }
  multiplexedTestClients.add(client);
  const notificationHandlers = new Set<
    Parameters<CodexAppServerClient["addNotificationHandler"]>[0]
  >();
  const requestHandlers = new Set<Parameters<CodexAppServerClient["addRequestHandler"]>[0]>();
  const addNotificationHandler = client.addNotificationHandler.bind(client);
  const addRequestHandler = client.addRequestHandler.bind(client);
  addNotificationHandler(async (notification) => {
    await Promise.all(
      [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
    );
  });
  addRequestHandler(async (request) => {
    for (const handler of requestHandlers) {
      const result = await handler(request);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  });
  client.addNotificationHandler = (handler) => {
    notificationHandlers.add(handler);
    return () => notificationHandlers.delete(handler);
  };
  client.addRequestHandler = (handler) => {
    requestHandlers.add(handler);
    return () => requestHandlers.delete(handler);
  };
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

export function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunCodexAppServerAttemptOptions = {},
) {
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
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
  const promise = runCodexAppServerAttemptImpl(trackedParams, {
    ...options,
    bindingStore: options.bindingStore ?? testCodexAppServerBindingStore,
    ...(clientFactory ? { clientFactory } : {}),
  }).finally(() => {
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

export function createParams(
  sessionFile: string,
  workspaceDir: string,
  identity: {
    prompt?: string;
    provider?: string;
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
  } = {},
): EmbeddedRunAttemptParams {
  const sessionId = identity.sessionId ?? "session-1";
  const sessionKey = identity.sessionKey ?? "agent:main:session-1";
  const provider = identity.provider ?? "codex";
  const model = createCodexTestModel(provider);
  const params = {
    prompt: identity.prompt ?? "hello",
    sessionId,
    sessionKey,
    sessionFile,
    workspaceDir,
    runId: identity.runId ?? "run-1",
    provider,
    modelId: "gpt-5.4-codex",
    model: {
      ...model,
      compat: { ...model.compat, supportsTools: false },
    } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } },
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: false,
    config: { tools: { web: { search: { enabled: false } } } },
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    observeToolTerminal: createCodexTestToolTerminalObserver(),
  } as unknown as EmbeddedRunAttemptParams;
  params.hostCapabilities = createHarnessHostCapabilities(params);
  return params;
}

export function createTestParams(): EmbeddedRunAttemptParams {
  return createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace"));
}

/** Replaces the lightweight default with the admitted host boundary used in production. */
export async function bindProductionHarnessHostCapabilitiesForTest(
  params: EmbeddedRunAttemptParams,
): Promise<() => void> {
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
  params.hostCapabilities = host.capabilities;
  let active = true;
  const close = () => {
    if (!active) {
      return;
    }
    active = false;
    activeHarnessHostClosuresForTest.delete(close);
    host.close();
  };
  activeHarnessHostClosuresForTest.add(close);
  return close;
}

export function setCodexTestModelSupportsTools(
  params: EmbeddedRunAttemptParams,
  supportsTools: boolean,
): void {
  params.model = {
    ...params.model,
    compat: { ...params.model.compat, supportsTools },
  } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } };
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

function getMockServerVersion() {
  return CODEX_APP_SERVER_VERSION;
}

export function getMockRuntimeIdentity() {
  return { serverVersion: getMockServerVersion() };
}

export function mockClientRuntimeMethods() {
  return createMockClientRuntimeMethods();
}

export function turnStartResult(turnId = "turn-1", status = "inProgress") {
  return createTurnStartResult(turnId, status);
}

export function threadStartResult(threadId = "thread-1", options: { cwd?: string } = {}) {
  const cwd = options.cwd ?? tempDir ?? "/tmp/openclaw-codex-test";
  return createThreadStartResult(threadId, cwd);
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
    onStart?: (
      authProfileId: string | undefined,
      agentDir: string | undefined,
      options: CodexAppServerClientOptions | undefined,
    ) => void;
  } = {},
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notificationHandlers = new Set<
    (notification: CodexServerNotification) => Promise<void> | void
  >();
  const serverRequestHandlers = new Set<AppServerRequestHandler>();
  const closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  let closeError: Error | undefined;
  const request = vi.fn(async (method: string, params?: unknown, requestOptions?: unknown) => {
    requests.push({ method, params });
    const result = await requestImpl(
      method,
      params,
      requestOptions as { signal?: AbortSignal } | undefined,
    );
    if (method === "turn/interrupt") {
      const { threadId, turnId } = params as { threadId?: string; turnId?: string };
      if (threadId && turnId) {
        // Codex publishes this terminal after acknowledging interruption;
        // test clients must preserve the same lifecycle instead of orphaning turns.
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            void handler({
              method: "turn/completed",
              params: {
                threadId,
                turn: { id: turnId, status: "interrupted" },
              },
            });
          }
        });
      }
    }
    return result;
  });

  const client = {
    ...mockClientRuntimeMethods(),
    request,
    addNotificationHandler: (
      handler: (notification: CodexServerNotification) => Promise<void> | void,
    ) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    addRequestHandler: (handler: AppServerRequestHandler) => {
      serverRequestHandlers.add(handler);
      return () => serverRequestHandlers.delete(handler);
    },
    addCloseHandler: (handler: (client: CodexAppServerClient) => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    getCloseError: () => closeError,
  } as unknown as CodexAppServerClient;
  setCodexAppServerClientFactoryForTest(
    async (_startOptions, authProfileId, agentDir, _config, clientOptions) => {
      options.onStart?.(authProfileId, agentDir, clientOptions);
      return client;
    },
  );

  const waitForServerRequestHandler = async () => {
    await vi.waitFor(() => expect(serverRequestHandlers.size).toBeGreaterThan(0), {
      interval: 1,
      timeout: appServerHarnessWait.timeout,
    });
    return async (requestLocal: Parameters<AppServerRequestHandler>[0]) => {
      for (const handler of serverRequestHandlers) {
        const result = await handler(requestLocal);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    };
  };

  const waitForNotificationHandler = async () => {
    await vi.waitFor(() => expect(notificationHandlers.size).toBeGreaterThan(0), {
      interval: 1,
      timeout: appServerHarnessWait.timeout,
    });
  };
  const dispatchNotification = async (notification: CodexServerNotification) => {
    await Promise.all(
      [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
    );
  };
  const sendNotification = async (notification: CodexServerNotification) => {
    // Dispatch synchronously when handlers exist so wire-order interactions
    // (for example completeTurn immediately followed by close) stay faithful.
    if (notificationHandlers.size === 0) {
      await waitForNotificationHandler();
    }
    await dispatchNotification(notification);
  };

  return {
    client,
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
    close: (error?: Error) => {
      closeError = error;
      for (const handler of closeHandlers) {
        handler(client);
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
    onStart?: (
      authProfileId: string | undefined,
      agentDir: string | undefined,
      options: CodexAppServerClientOptions | undefined,
    ) => void;
  } = {},
) {
  return createAppServerHarness(async (method, params, requestOptions) => {
    const override = await requestImpl(method, params, requestOptions);
    if (override !== undefined) {
      return override;
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "config/read") {
      return { config: {}, origins: {} };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    if (method === "thread/backgroundTerminals/list") {
      return { data: [], nextCursor: null };
    }
    return {};
  }, options);
}

export function createResumeHarness() {
  return createAppServerHarness(async (method, params) => {
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "config/read") {
      return { config: {}, origins: {} };
    }
    if (method === "thread/resume") {
      // Resume must echo the requested thread; a different id is rejected as
      // an unsafe subscription.
      return threadStartResult((params as { threadId?: string })?.threadId ?? "thread-existing");
    }
    if (method === "turn/start") {
      return turnStartResult();
    }
    return {};
  });
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
    // Machine-managed sandbox requirements must not leak into policy fixtures.
    vi.spyOn(codexRequirements, "readCodexRequirementsToml").mockReturnValue(undefined);
    // An uninitialized real host approvals store intentionally fails closed.
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    defaultCodexAppInventoryCache.clear();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
    clearRuntimeAuthProfileStoreSnapshots();
    vi.useRealTimers();
    clearInternalHooks();
    clearMemoryPluginState();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-codex-run-"));
  });

  afterEach(async () => {
    await drainActiveAppServerAttemptsForTest();
    for (const close of activeHarnessHostClosuresForTest) {
      close();
    }
    await sandboxExecServerRegistry.closeAll();
    resetCodexAppServerClientFactoryForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    dynamicToolBuildState.openClawCodingToolsFactory = undefined;
    codexWorkspaceDirCache.clear();
    nativeHookRelayUnregisterQueue.clear();
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    clearMemoryPluginState();
    clearPluginCommands();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    resetGlobalHookRunner();
    clearInternalHooks();
    defaultCodexAppInventoryCache.clear();
    defaultCodexPluginMetadataCache.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await sandboxExecServerRegistry.closeAll();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
}
