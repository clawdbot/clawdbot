// Codex tests cover run attempt.context engine plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  embeddedAgentLog,
  type HarnessContextEngine as ContextEngine,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "openclaw/plugin-sdk/message-tool-delivery-hints";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt as runCodexAppServerAttemptImpl } from "./run-attempt.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  adaptCodexTestClientFactory,
  createCodexTestModel,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";

const CODEX_TURN_START_TEXT_INPUT_MAX_CHARS = 1 << 20;

let tempDir: string;
let codexAppServerClientFactoryForTest: CodexTestAppServerClientFactory | undefined;

type RunCodexAppServerAttemptOptions = Omit<
  NonNullable<Parameters<typeof runCodexAppServerAttemptImpl>[1]>,
  "bindingStore"
>;

function setCodexAppServerClientFactoryForTest(factory: CodexTestAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunCodexAppServerAttemptOptions = {},
) {
  const clientFactory =
    options.clientFactory ??
    (codexAppServerClientFactoryForTest
      ? adaptCodexTestClientFactory(codexAppServerClientFactoryForTest)
      : undefined);
  return runCodexAppServerAttemptImpl(params, {
    ...options,
    bindingStore: testCodexAppServerBindingStore,
    ...(clientFactory ? { clientFactory } : {}),
  });
}

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
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
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createSqliteParams(workspaceDir: string, storeName: string): EmbeddedRunAttemptParams {
  const sessionId = "session-1";
  const sessionKey = "agent:main:session-1";
  const storePath = path.join(tempDir, `${storeName}.sqlite`);
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  const params = createParams(sessionFile, workspaceDir);
  params.sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  const message = userMessage("hello", Date.now());
  params.userTurnTranscriptRecorder = {
    message,
    resolveMessage: async () => message,
    markRuntimePersisted() {},
  } as EmbeddedRunAttemptParams["userTurnTranscriptRecorder"];
  return params;
}

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

function assistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    stopReason: "stop",
    timestamp,
  };
}

function userMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function toolResultMessage(payload: unknown, timestamp: number): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "bulk_context_probe",
    content: [
      {
        type: "toolResult",
        toolUseId: `call-${timestamp}`,
        output: payload,
      },
    ],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

function threadStartResult(threadId = "thread-1") {
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

function turnStartResult(turnId = "turn-1", status = "inProgress") {
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

function getMockServerVersion() {
  return "0.132.0";
}

function getMockRuntimeIdentity() {
  return { serverVersion: getMockServerVersion() };
}

function mockClientRuntimeMethods() {
  return {
    getInstanceId: () => "test-client-1",
    getRuntimeIdentity: getMockRuntimeIdentity,
    getServerVersion: getMockServerVersion,
  };
}

function createStartedThreadHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const notificationHandlers = new Set<
    (notification: CodexServerNotification) => Promise<void> | void
  >();
  const notify = async (notification: CodexServerNotification) => {
    await Promise.all(
      [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
    );
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    requests.push({ method, params });
    const override = await requestImpl(method, params);
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
  });

  setCodexAppServerClientFactoryForTest(
    async () =>
      ({
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: (
          handler: (notification: CodexServerNotification) => Promise<void> | void,
        ) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      }) as never,
  );

  return {
    requests,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain(method), {
        interval: 1,
      });
    },
    async notify(notification: CodexServerNotification) {
      await notify(notification);
    },
    async completeTurn(status: "completed" | "failed" = "completed", threadId = "thread-1") {
      await notify({
        method: "turn/completed",
        params: {
          threadId,
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            ...(status === "failed" ? { error: { message: "codex failed" } } : {}),
            items: [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
          },
        },
      });
    },
  };
}

function createContextEngine(overrides: Partial<ContextEngine> = {}): ContextEngine {
  const engine: ContextEngine = {
    info: {
      id: "lossless-claw",
      name: "Lossless Claw",
      ownsCompaction: true,
    },
    bootstrap: vi.fn(async () => ({ bootstrapped: true })),
    assemble: vi.fn(async ({ messages, prompt }) => ({
      messages: [...messages, userMessage(prompt ?? "", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
    })),
    ingest: vi.fn(async () => ({ ingested: true })),
    maintain: vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 })),
    compact: vi.fn(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 10 },
    })),
    ...overrides,
  };
  return engine;
}

type MockCallReader = { mock: { calls: unknown[][] } };

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requireFirstCallArg(mock: unknown, label: string): unknown {
  const call = (mock as MockCallReader).mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} to be called`);
  }
  return call[0];
}

function requireRequestParams(
  harness: ReturnType<typeof createStartedThreadHarness>,
  method: string,
): Record<string, unknown> {
  const request = harness.requests.find((entry) => entry.method === method);
  return requireRecord(request?.params, `${method} params`);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRequestInputTextContains(
  harness: ReturnType<typeof createStartedThreadHarness>,
  expected: string,
): void {
  expect(getRequestInputText(harness)).toContain(expected);
}

function getRequestInputText(harness: ReturnType<typeof createStartedThreadHarness>): string {
  return getRequestInputTextAt(harness, 0);
}

function getRequestInputTextAt(
  harness: ReturnType<typeof createStartedThreadHarness>,
  index: number,
): string {
  const request = harness.requests.filter((entry) => entry.method === "turn/start").at(index);
  const params = requireRecord(request?.params, "turn/start params");
  const input = requireArray(params.input, "turn/start input");
  return input
    .map((entry) => {
      const item = requireRecord(entry, "turn/start input entry");
      return item.type === "text" ? optionalString(item.text) : "";
    })
    .join("\n");
}

describe("runCodexAppServerAttempt context-engine lifecycle", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-context-engine-"));
  });

  afterEach(async () => {
    resetCodexAppServerClientFactoryForTest();
    resetGlobalHookRunner();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("bootstraps and assembles non-legacy context before the Codex turn starts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()) as never,
    );
    const openSpy = vi.spyOn(SessionManager, "open");
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 321;
    params.requestedModelId = "gpt-5.4-codex-primary";
    params.fallbackReason = "provider_unavailable";
    params.degradedReason = "context_overflow";
    params.config = { memory: { citations: "on" } } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (!contextEngine.bootstrap) {
      throw new Error("expected bootstrap hook");
    }
    expect(contextEngine["bootstrap"]).toHaveBeenCalledTimes(1);
    const bootstrapParams = requireFirstCallArg(
      contextEngine["bootstrap"],
      "bootstrap",
    ) as Parameters<NonNullable<ContextEngine["bootstrap"]>>[0];
    expect(bootstrapParams.sessionId).toBe("session-1");
    expect(bootstrapParams.sessionKey).toBe("agent:main:session-1");
    expect(bootstrapParams.sessionFile).toBe(sessionFile);
    expect(bootstrapParams.runtimeSettings).toMatchObject({
      runtime: { mode: "degraded" },
      model: {
        requested: "gpt-5.4-codex-primary",
        resolved: "gpt-5.4-codex",
      },
      diagnostics: {
        fallbackReason: "provider_unavailable",
        degradedReason: "context_overflow",
      },
    });

    expect(contextEngine["assemble"]).toHaveBeenCalledTimes(1);
    const assembleParams = requireFirstCallArg(contextEngine["assemble"], "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.sessionId).toBe("session-1");
    expect(assembleParams.sessionKey).toBe("agent:main:session-1");
    expect(assembleParams.tokenBudget).toBe(321);
    expect(assembleParams.citationsMode).toBe("on");
    expect(assembleParams.model).toBe("gpt-5.4-codex");
    expect(assembleParams.runtimeSettings).toMatchObject({
      runtime: { mode: "degraded" },
      model: {
        requested: "gpt-5.4-codex-primary",
        resolved: "gpt-5.4-codex",
      },
      diagnostics: {
        fallbackReason: "provider_unavailable",
        degradedReason: "context_overflow",
      },
    });
    expect(assembleParams.prompt).toBe("hello");
    expect(assembleParams.messages.map((message) => message.role)).toEqual(["assistant"]);
    expect(assembleParams.availableTools).toEqual(new Set());

    const threadStartParams = requireRequestParams(harness, "thread/start");
    expect(optionalString(threadStartParams.developerInstructions)).toContain(
      "context-engine system",
    );
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");

    await harness.completeTurn();
    await run;
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("keeps context-engine history bound to the run session when sandbox key differs", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("canonical main context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.sessionKey = "agent:main:main";
    params.sandboxSessionKey = "agent:main:telegram:default:direct:12345";
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (!contextEngine.bootstrap) {
      throw new Error("expected bootstrap hook");
    }
    const bootstrapParams = requireFirstCallArg(
      contextEngine["bootstrap"],
      "bootstrap",
    ) as Parameters<NonNullable<ContextEngine["bootstrap"]>>[0];
    expect(bootstrapParams.sessionKey).toBe("agent:main:main");

    const assembleParams = requireFirstCallArg(contextEngine["assemble"], "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.sessionKey).toBe("agent:main:main");

    await harness.completeTurn();
    await run;
  });

  it("uses the runtime token budget for large Codex context-engine projections", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const longContext = `large LCM context start ${"x".repeat(30_000)} LARGE_CONTEXT_END`;
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [assistantMessage(longContext, 10)],
        estimatedTokens: 10_000,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeGreaterThan(30_000);
    expect(inputText).toContain("LARGE_CONTEXT_END");
    expect(inputText).not.toContain("[truncated ");

    await harness.completeTurn();
    await run;
  });

  it("bounds active context-engine projections when prompt hooks append context", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async (event) => ({
            appendContext: `${(event as { prompt: string }).prompt}\n\nhook append marker`,
            prependContext: "hook prefix context",
          }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [
          ...Array.from({ length: 9 }, (_, index) =>
            assistantMessage(`older context ${index} ${"x".repeat(120_000)}`, index),
          ),
          assistantMessage("recent anchor", 10),
        ],
        estimatedTokens: 300_000,
      })),
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 300_000;
    params.prompt = "current prompt survives";
    params.currentInboundContext = { text: "current inbound context survives" };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBe(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("recent anchor");
    expect(inputText).toContain("current inbound context survives");
    expect(inputText).toContain("current prompt survives");
    expect(inputText).toContain("hook append marker");

    await harness.completeTurn();
    await run;
  });

  it("bounds hook-appended prompts without an active context engine", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => ({ appendContext: `hook context ${"h".repeat(1_100_000)}` }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "current prompt survives";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("current prompt survives");
    expect(inputText).not.toContain("hook context");

    await harness.completeTurn();
    await run;
  });

  it("bounds hook-appended prompts after delivery metadata is relocated", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => ({ appendContext: `hook context ${"h".repeat(1_100_000)}` }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session-delivery-hint.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-delivery-hint");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = `${MESSAGE_TOOL_DELIVERY_HINTS[0]}\n\ncurrent prompt survives`;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("Current user request:\ncurrent prompt survives");
    expect(inputText).not.toContain("hook context");

    await harness.completeTurn();
    await run;
  });

  it("bounds hook-appended output for an empty prompt without an active context engine", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => ({
            appendContext: `hook context ${"h".repeat(1_100_000)} hook tail`,
          }),
        },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.prompt = "";

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    expect(inputText).toContain("hook tail");

    await harness.completeTurn();
    await run;
  });

  it("projects thread-bootstrap context only once for a matching context-engine epoch", async () => {
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("bootstrap-only context", Date.now()) as never,
    );
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ messages, prompt }) => ({
        messages: [...messages, userMessage(prompt ?? "", 10)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
      })),
    });
    const firstHarness = createStartedThreadHarness();
    const firstParams = createParams(sessionFile, workspaceDir);
    firstParams.contextEngine = contextEngine;

    const firstRun = runCodexAppServerAttempt(firstParams);
    await firstHarness.waitForMethod("turn/start");
    expectRequestInputTextContains(firstHarness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(firstHarness, "bootstrap-only context");
    await firstHarness.completeTurn();
    await firstRun;

    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.contextEngine?.projection).toEqual({
      schemaVersion: 1,
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: undefined,
    });

    const secondHarness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-1");
      }
      return undefined;
    });
    const secondRun = runCodexAppServerAttempt(firstParams);
    await secondHarness.waitForMethod("turn/start");

    expect(secondHarness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    const secondInputText = getRequestInputText(secondHarness);
    expect(secondInputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(secondInputText).not.toContain("bootstrap-only context");
    expect(secondInputText).toBe("hello");
    const projectionLogs = info.mock.calls.filter(
      ([message]) => message === "codex app-server context-engine projection decision",
    );
    expect(projectionLogs).toEqual([
      [
        "codex app-server context-engine projection decision",
        expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          engineId: "lossless-claw",
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          projected: true,
          reason: "missing-thread-binding",
        }),
      ],
      [
        "codex app-server context-engine projection decision",
        expect.objectContaining({
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          engineId: "lossless-claw",
          mode: "thread_bootstrap",
          epoch: "epoch-1",
          previousThreadId: "thread-1",
          previousEpoch: "epoch-1",
          projected: false,
          reason: "matching-thread-bootstrap-binding",
        }),
      ],
    ]);

    await secondHarness.completeTurn();
    await secondRun;
  });

  it("resumes a matching thread-bootstrap binding even when the bootstrap turn exceeded the opt-in native byte guard", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-bootstrapped",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-bootstrapped.jsonl"),
      "x".repeat(2_000),
    );
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [
          assistantMessage("already bootstrapped context", 10),
          userMessage(prompt ?? "", 11),
        ],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-bootstrapped");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.contextEngine = contextEngine;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: 1_000,
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(inputText).not.toContain("already bootstrapped context");
    expect(inputText).toBe("hello");

    await harness.completeTurn("completed", "thread-bootstrapped");
    await run;
  });

  it("starts a fresh thread instead of resuming a token-pressured thread-bootstrap binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-bootstrapped",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-bootstrapped.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 241_198,
            },
            model_context_window: 258_400,
          },
        },
      })}\n`,
    );
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("reprojected context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-bootstrapped");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("reprojected context");

    await harness.completeTurn("completed", "thread-fresh");
    await run;
  });

  it("does not inject mirrored history when a stale thread-bootstrap binding has no active context engine", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(
      userMessage("previous stale-bootstrap request", Date.now()) as never,
    );
    sessionManager.appendMessage(
      assistantMessage("previous stale-bootstrap answer", Date.now() + 1) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-stale-bootstrap",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-stale",
        },
      },
    });
    await fs.writeFile(
      path.join(path.dirname(sessionFile), "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionFile,
          totalTokens: 12_000,
        },
      }),
    );
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-stale-bootstrap.jsonl"),
      `${JSON.stringify({
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 300_000,
            },
          },
        },
      })}\n`,
    );
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-stale-bootstrap");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).not.toContain("OpenClaw assembled context for this turn:");
    expect(inputText).not.toContain("previous stale-bootstrap request");
    expect(inputText).not.toContain("previous stale-bootstrap answer");
    expect(inputText).not.toContain("Current user request:");
    expect(inputText).toContain("hello");

    await harness.completeTurn("completed", "thread-fresh");
    await run;
  });

  it("keeps mirrored history when an inactive per-turn context-engine binding starts fresh", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(userMessage("previous per-turn request", 10) as never);
    sessionManager.appendMessage(assistantMessage("previous per-turn answer", 11) as never);
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-per-turn-context",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
      },
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (method === "thread/resume") {
        throw new Error("inactive context-engine bindings should start a fresh thread");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("previous per-turn request");
    expect(inputText).toContain("previous per-turn answer");
    expect(inputText).toContain("Current user request:");
    expect(inputText).toContain("hello");

    await harness.completeTurn("completed", "thread-fresh");
    await run;
  });

  it("starts a fresh Codex thread and reprojects when context-engine epoch changes", async () => {
    const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-old",
        },
      },
    });
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("new epoch context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-new" },
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, "new epoch context");

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    await run;

    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
    expect(savedBinding?.contextEngine?.projection?.epoch).toBe("epoch-new");
    expect(info).toHaveBeenCalledWith(
      "codex app-server context-engine projection decision",
      expect.objectContaining({
        sessionId: "session-1",
        engineId: "lossless-claw",
        epoch: "epoch-new",
        previousThreadId: "thread-old",
        previousEpoch: "epoch-old",
        projected: true,
        reason: "context-engine-binding-mismatch",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "codex app-server wrote context-engine thread binding",
      expect.objectContaining({
        sessionId: "session-1",
        threadId: "thread-new",
        engineId: "lossless-claw",
        epoch: "epoch-new",
        action: "rotated",
      }),
    );
  });

  it("reprojects thread-bootstrap context when context-engine policy changes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("policy changed context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 80_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, "policy changed context");

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    await run;
  });

  it("reprojects thread-bootstrap context for native-disabled transient Codex threads", async () => {
    const restoreSandboxBackend = registerSandboxBackend(
      "codex-context-test-sandbox",
      async () => ({
        id: "codex-context-test-sandbox",
        runtimeId: "codex-context-test-runtime",
        runtimeLabel: "Codex Context Test Sandbox",
        workdir: "/workspace",
        buildExecSpec: async () => ({
          argv: ["true"],
          env: {},
          stdinMode: "pipe-closed" as const,
        }),
        runShellCommand: async () => ({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          code: 0,
        }),
      }),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    try {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-old",
        cwd: workspaceDir,
        dynamicToolsFingerprint: "[]",
        contextEngine: {
          schemaVersion: 1,
          engineId: "lossless-claw",
          policyFingerprint:
            '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
          projection: {
            schemaVersion: 1,
            mode: "thread_bootstrap",
            epoch: "epoch-1",
          },
        },
      });
      const contextEngine = createContextEngine({
        assemble: vi.fn(async ({ prompt }) => ({
          messages: [
            assistantMessage("native-disabled context", 10),
            userMessage(prompt ?? "", 11),
          ],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
        })),
      });
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "thread/start") {
          return threadStartResult("thread-transient");
        }
        if (method === "thread/resume") {
          throw new Error("native-disabled turns should not resume the previous Codex thread");
        }
        return undefined;
      });
      const params = createParams(sessionFile, workspaceDir);
      params.contextEngine = contextEngine;
      params.config = {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              backend: "codex-context-test-sandbox",
              scope: "session",
              workspaceAccess: "rw",
              prune: { idleHours: 0, maxAgeDays: 0 },
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];

      let runError: unknown;
      const run = runCodexAppServerAttempt(params).catch((error: unknown) => {
        runError = error;
        throw error;
      });
      await vi.waitFor(
        () => {
          if (runError) {
            throw toLintErrorObject(runError, "Non-Error thrown");
          }
          expect(harness.requests.map((request) => request.method)).toContain("turn/start");
        },
        { interval: 1 },
      );

      expect(harness.requests.map((request) => request.method)).toEqual([
        "thread/start",
        "turn/start",
      ]);
      expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
      expectRequestInputTextContains(harness, "native-disabled context");

      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-transient",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "transient answer" }],
          },
        },
      });
      await run;
    } finally {
      restoreSandboxBackend();
    }
  });

  it("starts a fresh Codex thread when thread-bootstrap projection falls back to per-turn projection", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-1",
        },
      },
    });
    const contextEngine = createContextEngine({
      assemble: vi.fn(async ({ prompt }) => ({
        messages: [assistantMessage("per-turn context", 10), userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
      })),
    });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-new");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    expectRequestInputTextContains(harness, "OpenClaw assembled context for this turn:");
    expectRequestInputTextContains(harness, "per-turn context");

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-new",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    await run;

    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
    expect(savedBinding?.contextEngine?.projection).toBeUndefined();
  });

  it("retries a resumed context-engine thread on a fresh Codex thread without plugin compaction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    const compact = vi.fn(async () => {
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "summary",
          firstKeptEntryId: "entry-1",
          tokensBefore: 10,
          sessionId: "session-1-compacted",
        },
      };
    });
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [
          ...messages,
          assistantMessage("context epoch-before", 10),
          userMessage(prompt ?? "", 11),
        ],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      const request = requireRecord(requestParams, `${method} params`);
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start" && request.threadId === "thread-old") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (method === "turn/start" && request.threadId === "thread-fresh") {
        return turnStartResult("turn-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(harness.requests.map((request) => request.method)).toEqual([
        "thread/resume",
        "turn/start",
        "thread/start",
        "turn/start",
      ]),
    );
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-fresh",
        turnId: "turn-fresh",
        turn: {
          id: "turn-fresh",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    const result = await run;

    expect(result.assistantTexts).toContain("fresh answer");
    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(1);
    const retryInputText = getRequestInputTextAt(harness, -1);
    expect(retryInputText).toBe("hello");
    expect(retryInputText).not.toContain("successor compacted context");
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-fresh");
    expect(savedBinding?.contextEngine?.engineId).toBe("lossless-claw");
    expect(savedBinding?.contextEngine?.projection).toBeUndefined();
  });

  it("returns a replay-safe recovery result when the executable owner changes during overflow retry", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    const contextEngine = createContextEngine({
      assemble: async ({ messages, prompt }) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
      }),
    });
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      const request = requireRecord(requestParams, `${method} params`);
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start" && request.threadId === "thread-old") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      if (method === "thread/start") {
        throw Object.assign(new Error("managed executable selection changed during startup"), {
          code: "CODEX_APP_SERVER_START_SELECTION_CHANGED",
        });
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const result = await runCodexAppServerAttempt(params);

    expect(result.promptError).toContain("codex app-server client is closed");
    expect(result.codexAppServerFailure).toEqual({
      kind: "client_closed_before_turn_completed",
      transport: "stdio",
      threadId: "thread-old",
      replaySafe: true,
    });
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/start",
      "thread/unsubscribe",
    ]);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
  });

  it("preserves a newer context-engine binding when a stale resumed thread overflows", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      const request = requireRecord(requestParams, `${method} params`);
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start" && request.threadId === "thread-old") {
        await writeCodexAppServerBinding(sessionFile, {
          threadId: "thread-new",
          cwd: workspaceDir,
          dynamicToolsFingerprint: "[]",
        });
        throw new Error("Codex ran out of room in the model's context window");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex ran out of room in the model's context window",
    );

    expect(compact).not.toHaveBeenCalled();
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/unsubscribe",
    ]);
    const savedBinding = await readCodexAppServerBinding(sessionFile);
    expect(savedBinding?.threadId).toBe("thread-new");
  });

  it("clears a resumed context-engine binding when a turn terminally overflows", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-old");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-old",
        turnId: "turn-old",
        turn: {
          id: "turn-old",
          status: "failed",
          error: { message: "Codex ran out of room in the model's context window" },
          items: [],
        },
      },
    });
    const result = await run;

    expect(result.promptError).toBe("Codex ran out of room in the model's context window");
    expect(compact).not.toHaveBeenCalled();
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(await readCodexAppServerBinding(sessionFile)).toBeUndefined();
  });

  it("does not pre-compact over-budget rendered context-engine prompts before Codex turn/start", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    const hugePayload = {
      rows: Array.from({ length: 10 }, (_, index) => ({
        id: index,
        body: "0123456789abcdef".repeat(4000),
      })),
    };
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: Array.from({ length: 8 }, (_, index) => toolResultMessage(hugePayload, index + 1)),
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
    ]);
    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("0123456789abcdef");

    await harness.completeTurn();
    const result = await run;
    expect(result.assistantTexts).toContain("final answer");
  });

  it("fails first-turn Codex context overflow instead of falling back to OpenClaw compaction", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const compact = vi.fn<ContextEngine["compact"]>(async () => ({
      ok: true,
      compacted: true,
      result: { summary: "summary", firstKeptEntryId: "entry-1", tokensBefore: 100_000 },
    }));
    const assemble = vi.fn<ContextEngine["assemble"]>().mockResolvedValue({
      messages: [assistantMessage("large projected context", 10)],
      estimatedTokens: 100_000,
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-before" },
    });
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 16_000;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex ran out of room in the model's context window",
    );

    expect(compact).not.toHaveBeenCalled();
    expect(assemble).toHaveBeenCalledTimes(1);
    expect(harness.requests.map((request) => request.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
  });

  it("does not call hung owning context-engine compaction during Codex overflow recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("pre-compaction context", Date.now()) as never,
    );
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-old",
      cwd: workspaceDir,
      dynamicToolsFingerprint: "[]",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"contextTokenBudget":400000,"projectionMaxChars":1000000}',
        projection: {
          schemaVersion: 1,
          mode: "thread_bootstrap",
          epoch: "epoch-before",
        },
      },
    });
    const compact = vi.fn<ContextEngine["compact"]>(() => new Promise(() => {}));
    const assemble = vi.fn(
      async ({ messages, prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: [...messages, userMessage(prompt ?? "", 11)],
        estimatedTokens: 42,
        systemPromptAddition: "context-engine system",
        contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-before" },
      }),
    );
    const contextEngine = createContextEngine({ assemble, compact });
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      const request = requireRecord(requestParams, `${method} params`);
      if (method === "thread/resume") {
        return threadStartResult("thread-old");
      }
      if (method === "turn/start" && request.threadId === "thread-old") {
        throw new Error("Codex ran out of room in the model's context window");
      }
      if (method === "thread/start") {
        return threadStartResult("thread-fresh");
      }
      if (method === "turn/start" && request.threadId === "thread-fresh") {
        return turnStartResult("turn-fresh");
      }
      return undefined;
    });
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 400_000;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.requests.map((request) => request.method)).toEqual([
          "thread/resume",
          "turn/start",
          "thread/start",
          "turn/start",
        ]),
      { timeout: 4_000 },
    );
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-fresh",
        turnId: "turn-fresh",
        turn: {
          id: "turn-fresh",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-1", text: "fresh answer" }],
        },
      },
    });
    const result = await run;

    expect(result.assistantTexts).toContain("fresh answer");
    expect(compact).not.toHaveBeenCalled();
  });

  it("keeps current inbound context at the front of the Codex context-engine prompt", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("older context", Date.now()) as never,
    );
    const contextEngine = createContextEngine();
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.currentInboundContext = {
      text: [
        "Conversation context (untrusted, chronological, selected for current message):",
        "#6474 Sun 2026-05-10 22:22 GMT+5:30 [reply target] OpenClaw: anchor REPLYCTX this is the old message",
        "#6498 Sun 2026-05-10 22:22 GMT+5:30 OpenClaw: filler REPLYCTX 23",
      ].join("\n"),
    };

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const inputText = getRequestInputText(harness);
    expect(inputText).toContain("OpenClaw assembled context for this turn:");
    expect(inputText).toContain("Current user request:\nhello");
    expect(inputText).toContain("[reply target] OpenClaw: anchor REPLYCTX");
    expect(inputText.trim().startsWith("Conversation context (untrusted")).toBe(true);

    await harness.completeTurn();
    await run;
  });

  it.each([
    {
      name: "commitment-only",
      trigger: "heartbeat",
      bootstrapContextRunKind: "commitment-only",
    },
    {
      name: "Gateway-routed heartbeat",
      trigger: "user",
      bootstrapContextRunKind: "heartbeat",
    },
  ] as const)(
    "keeps $name turns heartbeat-classified through afterTurn maintenance",
    async (testCase) => {
      const workspaceDir = path.join(tempDir, "workspace");
      const afterTurn = vi.fn(
        async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
      );
      const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
      const contextEngine = createContextEngine({ afterTurn, maintain, bootstrap: undefined });
      const harness = createStartedThreadHarness();
      const params = createSqliteParams(
        workspaceDir,
        `heartbeat-${testCase.bootstrapContextRunKind}`,
      );
      params.contextEngine = contextEngine;
      params.trigger = testCase.trigger;
      params.bootstrapContextRunKind = testCase.bootstrapContextRunKind;
      params.contextTokenBudget = 111;
      params.requestedModelId = "gpt-5.4-codex-primary";
      params.fallbackReason = "provider_unavailable";
      params.degradedReason = "context_overflow";

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn();
      await run;

      expect(afterTurn).toHaveBeenCalledTimes(1);
      const afterTurnCall = requireFirstCallArg(afterTurn, "afterTurn") as Parameters<
        NonNullable<ContextEngine["afterTurn"]>
      >[0];
      expect(afterTurnCall.sessionId).toBe("session-1");
      expect(afterTurnCall.sessionKey).toBe("agent:main:session-1");
      expect(afterTurnCall.prePromptMessageCount).toBe(0);
      expect(afterTurnCall.tokenBudget).toBe(111);
      expect(afterTurnCall.isHeartbeat).toBe(true);
      expect(afterTurnCall.runtimeSettings).toMatchObject({
        runtime: { mode: "degraded" },
        model: {
          requested: "gpt-5.4-codex-primary",
          resolved: "gpt-5.4-codex",
        },
        diagnostics: {
          fallbackReason: "provider_unavailable",
          degradedReason: "context_overflow",
        },
      });
      expect(afterTurnCall.messages.some((message) => message.role === "user")).toBe(true);
      expect(afterTurnCall.messages.some((message) => message.role === "assistant")).toBe(true);
      expect(maintain).toHaveBeenCalledTimes(1);
      const maintainCall = requireFirstCallArg(maintain, "maintain") as Parameters<
        NonNullable<ContextEngine["maintain"]>
      >[0];
      expect(maintainCall.runtimeSettings).toBe(afterTurnCall.runtimeSettings);
    },
  );

  it("reloads mirrored history after bootstrap mutates the session transcript", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()) as never,
    );
    const afterTurn = vi.fn(
      async (_params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => undefined,
    );
    const bootstrap = vi.fn(
      async ({ sessionFile: file }: Parameters<NonNullable<ContextEngine["bootstrap"]>>[0]) => {
        SessionManager.open(file).appendMessage(
          assistantMessage("bootstrap context", Date.now() + 1) as never,
        );
        return { bootstrapped: true };
      },
    );
    const contextEngine = createContextEngine({
      bootstrap,
      afterTurn,
      maintain: undefined,
    });
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const assembleParams = requireFirstCallArg(contextEngine["assemble"], "assemble") as Parameters<
      ContextEngine["assemble"]
    >[0];
    expect(assembleParams.messages.map((message) => message.role)).toEqual([
      "assistant",
      "assistant",
    ]);
    const afterTurnParams = requireFirstCallArg(afterTurn, "afterTurn") as Parameters<
      NonNullable<ContextEngine["afterTurn"]>
    >[0];
    expect(afterTurnParams.prePromptMessageCount).toBe(2);
    expectRequestInputTextContains(harness, "bootstrap context");
  });

  it("logs assemble failures as a formatted message instead of the raw error object", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const rawError = new Error("Authorization: Bearer sk-abcdefghijklmnopqrstuv");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => {
        throw rawError;
      }),
      bootstrap: undefined,
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const warning = warn.mock.calls.find(
      ([message]) => message === "context engine assemble failed; using Codex baseline prompt",
    );
    const details = requireRecord(warning?.[1], "assemble warning details");
    expect(typeof details.error).toBe("string");
    expect(warning?.[1]).not.toEqual({ error: rawError });
    expect(String(details.error)).not.toContain("sk-abcdefghijklmnopqrstuv");
  });

  it("falls back to ingestBatch and skips turn maintenance on prompt failure", async () => {
    const workspaceDir = path.join(tempDir, "workspace");
    const ingestBatch = vi.fn(async () => ({ ingestedCount: 2 }));
    const maintain = vi.fn(async () => ({ changed: false, bytesFreed: 0, rewrittenEntries: 0 }));
    const contextEngine = createContextEngine({
      afterTurn: undefined,
      ingestBatch,
      maintain,
      bootstrap: undefined,
    });
    const harness = createStartedThreadHarness();
    const params = createSqliteParams(workspaceDir, "prompt-failure");
    params.contextEngine = contextEngine;

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn("failed");
    await run;

    expect(ingestBatch).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
  });
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
