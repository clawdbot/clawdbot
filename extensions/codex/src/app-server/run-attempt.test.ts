import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  abortAgentHarnessRun,
  queueAgentHarnessMessage,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness";
import {
  buildAgentRuntimePlan,
  nativeHookRelayTesting,
  onAgentEvent,
  resetAgentEventsForTest,
  type AgentEventPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_GPT5_BEHAVIOR_CONTRACT } from "../../prompt-overlay.js";
import * as elicitationBridge from "./elicitation-bridge.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";
import { writeCodexAppServerBinding } from "./session-binding.js";
import { createCodexTestModel } from "./test-support.js";
import {
  buildThreadResumeParams,
  buildTurnStartParams,
  startOrResumeThread,
} from "./thread-lifecycle.js";

let tempDir: string;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
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
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function createParamsWithRuntimePlan(
  sessionFile: string,
  workspaceDir: string,
): EmbeddedRunAttemptParams {
  const params = createParams(sessionFile, workspaceDir);
  return {
    ...params,
    runtimePlan: buildAgentRuntimePlan({
      provider: params.provider,
      modelId: params.modelId,
      model: params.model,
      modelApi: params.model.api,
      harnessId: "codex",
      harnessRuntime: "codex",
      config: params.config,
      workspaceDir,
      agentDir: tempDir,
      thinkingLevel: params.thinkLevel,
    }),
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
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

function createAppServerHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown>,
  options: { onStart?: (authProfileId: string | undefined) => void } = {},
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
  const request = vi.fn(async (method: string, params?: unknown) => {
    requests.push({ method, params });
    return requestImpl(method, params);
  });

  __testing.setCodexAppServerClientFactoryForTests(async (_startOptions, authProfileId) => {
    options.onStart?.(authProfileId);
    return {
      request,
      addNotificationHandler: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      addRequestHandler: () => () => undefined,
    } as never;
  });

  return {
    request,
    requests,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.some((entry) => entry.method === method)).toBe(true), {
        interval: 1,
      });
    },
    async notify(notification: CodexServerNotification) {
      await notify(notification);
    },
    async completeTurn(params: { threadId: string; turnId: string }) {
      await notify({
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: { id: params.turnId, status: "completed" },
        },
      });
    },
  };
}

function createStartedThreadHarness(
  requestImpl: (method: string, params: unknown) => Promise<unknown> = async () => undefined,
  options: { onStart?: (authProfileId: string | undefined) => void } = {},
) {
  return createAppServerHarness(async (method, params) => {
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
  }, options);
}

function expectResumeRequest(
  requests: Array<{ method: string; params: unknown }>,
  params: Record<string, unknown>,
) {
  expect(requests).toEqual(
    expect.arrayContaining([
      {
        method: "thread/resume",
        params: expect.objectContaining(params),
      },
    ]),
  );
}

function createResumeHarness() {
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

async function writeExistingBinding(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<Parameters<typeof writeCodexAppServerBinding>[1]> = {},
) {
  await writeCodexAppServerBinding(sessionFile, {
    threadId: "thread-existing",
    cwd: workspaceDir,
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    ...overrides,
  });
}

function createThreadLifecycleAppServerOptions(): Parameters<
  typeof startOrResumeThread
>[0]["appServer"] {
  return {
    start: {
      transport: "stdio",
      command: "codex",
      args: ["app-server"],
      headers: {},
    },
    requestTimeoutMs: 60_000,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
}

function createMessageDynamicTool(
  description: string,
  actions: string[] = ["send"],
): Parameters<typeof startOrResumeThread>[0]["dynamicTools"][number] {
  return {
    name: "message",
    description,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: actions,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

function extractRelayIdFromThreadRequest(params: unknown): string {
  const command = (
    params as {
      config?: {
        "hooks.PreToolUse"?: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    }
  ).config?.["hooks.PreToolUse"]?.[0]?.hooks?.[0]?.command;
  const match = command?.match(/--relay-id ([^ ]+)/);
  if (!match?.[1]) {
    throw new Error(`relay id missing from command: ${command}`);
  }
  return match[1];
}

describe("runCodexAppServerAttempt", () => {
  beforeEach(async () => {
    resetAgentEventsForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-"));
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    nativeHookRelayTesting.clearNativeHookRelaysForTests();
    resetAgentEventsForTest();
    resetGlobalHookRunner();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("applies before_prompt_build to Codex developer instructions and turn input", async () => {
    const beforePromptBuild = vi.fn(async () => ({
      systemPrompt: "custom codex system",
      prependSystemContext: "pre system",
      appendSystemContext: "post system",
      prependContext: "queued context",
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(assistantMessage("previous turn", Date.now()));
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await harness.waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(beforePromptBuild).toHaveBeenCalledWith(
      {
        prompt: "hello",
        messages: [expect.objectContaining({ role: "assistant" })],
      },
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
    );
    expect(harness.requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          params: expect.objectContaining({
            developerInstructions: expect.stringContaining("pre system\n\ncustom codex system"),
          }),
        },
        {
          method: "turn/start",
          params: expect.objectContaining({
            input: [{ type: "text", text: "queued context\n\nhello", text_elements: [] }],
          }),
        },
      ]),
    );
  });

  it("fires llm_input, llm_output, and agent_end hooks for codex turns", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
    const harness = createStartedThreadHarness();

    const params = createParamsWithRuntimePlan(sessionFile, workspaceDir);
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await vi.waitFor(() => expect(llmInput).toHaveBeenCalledTimes(1), { interval: 1 });

    expect(llmInput).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        prompt: "hello",
        imagesCount: 0,
        historyMessages: [expect.objectContaining({ role: "assistant" })],
        systemPrompt: expect.stringContaining(CODEX_GPT5_BEHAVIOR_CONTRACT),
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
      }),
    );

    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hello back",
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.assistantTexts).toEqual(["hello back"]);
    await vi.waitFor(() => expect(llmOutput).toHaveBeenCalledTimes(1), { interval: 1 });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), { interval: 1 });
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event);
    expect(agentEvents).toEqual(
      expect.arrayContaining([
        {
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "start",
            startedAt: expect.any(Number),
          }),
        },
        {
          stream: "assistant",
          data: { text: "hello back" },
        },
        {
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "end",
            startedAt: expect.any(Number),
            endedAt: expect.any(Number),
          }),
        },
      ]),
    );
    const startIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    const assistantIndex = agentEvents.findIndex((event) => event.stream === "assistant");
    const endIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(startIndex);
    expect(endIndex).toBeGreaterThan(assistantIndex);
    expect(globalAgentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-1",
          sessionKey: "agent:main:session-1",
          stream: "assistant",
          data: { text: "hello back" },
        }),
        expect.objectContaining({
          runId: "run-1",
          sessionKey: "agent:main:session-1",
          stream: "lifecycle",
          data: expect.objectContaining({ phase: "end" }),
        }),
      ]),
    );

    expect(llmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        resolvedRef: "codex/gpt-5.4-codex",
        harnessId: "codex",
        assistantTexts: ["hello back"],
        lastAssistant: expect.objectContaining({
          role: "assistant",
        }),
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
    );
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
        ]),
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
    );
  });

  it("registers native hook relay config for an enabled Codex turn and cleans it up", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: {
        enabled: true,
        events: ["pre_tool_use"],
        gatewayTimeoutMs: 4321,
        hookTimeoutSec: 9,
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    expect(startRequest?.params).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          "features.codex_hooks": true,
          "hooks.PreToolUse": [
            expect.objectContaining({
              hooks: [
                expect.objectContaining({
                  type: "command",
                  timeout: 9,
                  command: expect.stringContaining("--event pre_tool_use --timeout 4321"),
                }),
              ],
            }),
          ],
        }),
      }),
    );
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("sends clearing Codex native hook config when the relay is disabled", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: false },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    expect(startRequest?.params).toEqual(
      expect.objectContaining({
        config: {
          "features.codex_hooks": false,
          "hooks.PreToolUse": [],
          "hooks.PostToolUse": [],
          "hooks.PermissionRequest": [],
          "hooks.Stop": [],
        },
      }),
    );
  });

  it("cleans up native hook relay state when turn/start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        nativeHookRelay: { enabled: true },
      }),
    ).rejects.toThrow("turn start exploded");

    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("cleans up native hook relay state when the Codex turn aborts", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      nativeHookRelay: { enabled: true },
    });
    await harness.waitForMethod("turn/start");
    const startRequest = harness.requests.find((request) => request.method === "thread/start");
    const relayId = extractRelayIdFromThreadRequest(startRequest?.params);
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;

    expect(result.aborted).toBe(true);
    expect(nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId)).toBeUndefined();
  });

  it("fires agent_end with failure metadata when the codex turn fails", async () => {
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "codex exploded" },
        },
      },
    });

    const result = await run;

    expect(result.promptError).toBe("codex exploded");
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), { interval: 1 });
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event);
    expect(agentEvents).toEqual(
      expect.arrayContaining([
        {
          stream: "lifecycle",
          data: expect.objectContaining({ phase: "start", startedAt: expect.any(Number) }),
        },
        {
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "error",
            startedAt: expect.any(Number),
            endedAt: expect.any(Number),
            error: "codex exploded",
          }),
        },
      ]),
    );
    expect(agentEvents.some((event) => event.stream === "assistant")).toBe(false);
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "codex exploded",
      }),
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
      }),
    );
  });

  it("fires llm_output and agent_end when turn/start fails", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.open(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()),
    );
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    await expect(
      runCodexAppServerAttempt(createParamsWithRuntimePlan(sessionFile, workspaceDir)),
    ).rejects.toThrow("turn start exploded");

    await vi.waitFor(() => expect(llmInput).toHaveBeenCalledTimes(1), { interval: 1 });
    await vi.waitFor(() => expect(llmOutput).toHaveBeenCalledTimes(1), { interval: 1 });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(llmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantTexts: [],
        model: "gpt-5.4-codex",
        provider: "codex",
        resolvedRef: "codex/gpt-5.4-codex",
        harnessId: "codex",
        runId: "run-1",
        sessionId: "session-1",
      }),
      expect.any(Object),
    );
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: "turn start exploded",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "user" }),
        ]),
      }),
      expect.any(Object),
    );
  });

  it("fires agent_end with success false when the codex turn is aborted", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const { waitForMethod } = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );

    await waitForMethod("turn/start");
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;
    expect(result.aborted).toBe(true);
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
      }),
      expect.any(Object),
    );
  });

  it("forwards queued user input and aborts the active app-server turn", async () => {
    const { requests, waitForMethod } = createStartedThreadHarness();

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await waitForMethod("turn/start");

    expect(queueAgentHarnessMessage("session-1", "more context")).toBe(true);
    await vi.waitFor(
      () => expect(requests.some((entry) => entry.method === "turn/steer")).toBe(true),
      { interval: 1 },
    );
    expect(abortAgentHarnessRun("session-1")).toBe(true);
    await vi.waitFor(
      () => expect(requests.some((entry) => entry.method === "turn/interrupt")).toBe(true),
      { interval: 1 },
    );

    const result = await run;
    expect(result.aborted).toBe(true);
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          params: expect.objectContaining({
            model: "gpt-5.4-codex",
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            approvalsReviewer: "user",
            developerInstructions: expect.stringContaining(CODEX_GPT5_BEHAVIOR_CONTRACT),
          }),
        },
        {
          method: "turn/steer",
          params: {
            threadId: "thread-1",
            expectedTurnId: "turn-1",
            input: [{ type: "text", text: "more context", text_elements: [] }],
          },
        },
        {
          method: "turn/interrupt",
          params: { threadId: "thread-1", turnId: "turn-1" },
        },
      ]),
    );
  });

  it("routes MCP approval elicitations through the native bridge", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const bridgeSpy = vi
      .spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest")
      .mockResolvedValue({
        action: "accept",
        content: null,
        _meta: null,
      });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const result = await handleRequest?.({
      id: "request-elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps__github",
        mode: "form",
      },
    });

    expect(result).toEqual({
      action: "accept",
      content: null,
      _meta: null,
    });
    expect(bridgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;
  });

  it("routes request_user_input prompts through the active run follow-up queue", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onBlockReply = vi.fn();
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () => expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(true),
      { interval: 1 },
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), { interval: 1 });

    const response = handleRequest?.({
      id: "request-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ask-1",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1), { interval: 1 });
    expect(queueAgentHarnessMessage("session-1", "2")).toBe(true);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    expect(request).not.toHaveBeenCalledWith(
      "turn/steer",
      expect.objectContaining({ expectedTurnId: "turn-1" }),
    );

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;
  });

  it("does not leak unhandled rejections when shutdown closes before interrupt", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const { waitForMethod } = createStartedThreadHarness(async (method) => {
        if (method === "turn/interrupt") {
          throw new Error("codex app-server client is closed");
        }
      });
      const abortController = new AbortController();
      const params = createParams(
        path.join(tempDir, "session.jsonl"),
        path.join(tempDir, "workspace"),
      );
      params.abortSignal = abortController.signal;

      const run = runCodexAppServerAttempt(params);
      await waitForMethod("turn/start");
      abortController.abort("shutdown");

      await expect(run).resolves.toMatchObject({ aborted: true });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("forwards image attachments to the app-server turn input", async () => {
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.model = createCodexTestModel("codex", ["text", "image"]);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2UtYnl0ZXM=",
      },
    ];

    const run = runCodexAppServerAttempt(params);
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "turn/start",
          params: expect.objectContaining({
            input: [
              { type: "text", text: "hello", text_elements: [] },
              { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
            ],
          }),
        },
      ]),
    );
  });

  it("does not drop turn completion notifications emitted while turn/start is in flight", async () => {
    let harness: ReturnType<typeof createAppServerHarness>;
    harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        return turnStartResult("turn-1", "completed");
      }
      return {};
    });

    await expect(
      runCodexAppServerAttempt(
        createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      ),
    ).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
    });
  });

  it("completes when turn/start returns a terminal turn without a follow-up notification", async () => {
    const harness = createAppServerHarness(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "done from response" }],
          },
        };
      }
      return {};
    });

    const result = await runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );

    expect(harness.requests.map((entry) => entry.method)).toContain("turn/start");
    expect(result).toMatchObject({
      assistantTexts: ["done from response"],
      aborted: false,
      timedOut: false,
    });
  });

  it("does not complete on unscoped turn/completed notifications", async () => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    let resolved = false;
    void run.then(() => {
      resolved = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-wrong", text: "wrong completion" }],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resolved).toBe(false);

    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "msg-right", text: "final completion" }],
        },
      },
    });

    await expect(run).resolves.toMatchObject({
      assistantTexts: ["final completion"],
      aborted: false,
      timedOut: false,
    });
  });

  it("releases completion when a projector callback throws during turn/completed", async () => {
    // Regression for openclaw/openclaw#67996: a throw inside the projector's
    // turn/completed handler must not strand resolveCompletion, otherwise the
    // gateway session lane stays locked and every follow-up message queues
    // behind a run that will never resolve.
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = () => {
      throw new Error("downstream consumer exploded");
    };
    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() =>
      expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(true),
    );
    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          items: [{ id: "plan-1", type: "plan", text: "step one\nstep two" }],
        },
      },
    });
    await expect(run).resolves.toMatchObject({
      aborted: false,
      timedOut: false,
    });
  });

  it("routes MCP approval elicitations through the native bridge", async () => {
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const bridgeSpy = vi
      .spyOn(elicitationBridge, "handleCodexAppServerElicitationRequest")
      .mockResolvedValue({
        action: "accept",
        content: { approve: true },
        _meta: null,
      });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-1");
      }
      if (method === "turn/start") {
        return turnStartResult("turn-1", "inProgress");
      }
      return {};
    });
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
    );
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"));

    const result = await handleRequest?.({
      id: "request-elicitation-1",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        serverName: "codex_apps__github",
        mode: "form",
      },
    });

    expect(result).toEqual({
      action: "accept",
      content: { approve: true },
      _meta: null,
    });
    expect(bridgeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    );

    await notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });
    await run;
  });

  it("times out app-server startup before thread setup can hang forever", async () => {
    __testing.setCodexAppServerClientFactoryForTests(() => new Promise<never>(() => undefined));
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1;

    await expect(runCodexAppServerAttempt(params, { startupTimeoutFloorMs: 1 })).rejects.toThrow(
      "codex app-server startup timed out",
    );
    expect(queueAgentHarnessMessage("session-1", "after timeout")).toBe(false);
  });

  it("passes the selected auth profile into app-server startup", async () => {
    const seenAuthProfileIds: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createStartedThreadHarness(undefined, {
      onStart: (authProfileId) => seenAuthProfileIds.push(authProfileId),
    });
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.authProfileId = "openai-codex:work";

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:work"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;

    expect(seenAuthProfileIds).toEqual(["openai-codex:work"]);
    expect(requests.map((entry) => entry.method)).toContain("turn/start");
  });

  it("times out turn start before the active run handle is installed", async () => {
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method === "thread/start") {
          return threadStartResult("thread-1");
        }
        if (method === "turn/start") {
          return await new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("turn/start timed out")), options?.timeoutMs ?? 0);
          });
        }
        return {};
      },
    );
    __testing.setCodexAppServerClientFactoryForTests(
      async () =>
        ({
          request,
          addNotificationHandler: () => () => undefined,
          addRequestHandler: () => () => undefined,
        }) as never,
    );
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.timeoutMs = 1;

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn/start timed out");
    expect(queueAgentHarnessMessage("session-1", "after timeout")).toBe(false);
  });

  it("keeps extended history enabled when resuming a bound Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { dynamicToolsFingerprint: "[]" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expectResumeRequest(requests, {
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      developerInstructions: expect.stringContaining(CODEX_GPT5_BEHAVIOR_CONTRACT),
      persistExtendedHistory: true,
    });
  });

  it("resumes a bound Codex thread when only dynamic tool descriptions change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send and manage messages for the current Slack thread."),
      ],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [
        createMessageDynamicTool("Send and manage messages for the current Discord channel."),
      ],
      appServer,
    });

    expect(binding.threadId).toBe("thread-existing");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/resume"]);
  });

  it("passes native hook relay config on thread start and resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult("thread-existing");
      }
      if (method === "thread/resume") {
        return threadStartResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const config = {
      "features.codex_hooks": true,
      "hooks.PreToolUse": [],
    };

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config,
    });
    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer,
      config,
    });

    expect(request.mock.calls).toEqual([
      [
        "thread/start",
        expect.objectContaining({
          config,
        }),
      ],
      [
        "thread/resume",
        expect.objectContaining({
          config,
        }),
      ],
    ]);
  });

  it("starts a new Codex thread when dynamic tool schemas change", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    const appServer = createThreadLifecycleAppServerOptions();
    let nextThread = 1;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult(`thread-${nextThread++}`);
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.", ["send"])],
      appServer,
    });
    const binding = await startOrResumeThread({
      client: { request } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [createMessageDynamicTool("Send and manage messages.", ["send", "read"])],
      appServer,
    });

    expect(binding.threadId).toBe("thread-2");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start", "thread/start"]);
  });

  it("passes configured app-server policy, sandbox, service tier, and model on resume", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          approvalPolicy: "on-request",
          approvalsReviewer: "guardian_subagent",
          sandbox: "danger-full-access",
          serviceTier: "fast",
        },
      },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expectResumeRequest(requests, {
      threadId: "thread-existing",
      model: "gpt-5.4-codex",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "danger-full-access",
      serviceTier: "fast",
      developerInstructions: expect.stringContaining(CODEX_GPT5_BEHAVIOR_CONTRACT),
      persistExtendedHistory: true,
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        {
          method: "turn/start",
          params: expect.objectContaining({
            approvalPolicy: "on-request",
            approvalsReviewer: "guardian_subagent",
            sandboxPolicy: { type: "dangerFullAccess" },
            serviceTier: "fast",
            model: "gpt-5.4-codex",
          }),
        },
      ]),
    );
  });

  it("drops invalid legacy service tiers before app-server resume and turn requests", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, { model: "gpt-5.2" });
    const { requests, waitForMethod, completeTurn } = createResumeHarness();

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      pluginConfig: {
        appServer: {
          approvalPolicy: "on-request",
          sandbox: "danger-full-access",
          serviceTier: "priority",
        },
      },
    });
    await waitForMethod("turn/start");
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    const resumeRequest = requests.find((request) => request.method === "thread/resume");
    expect(resumeRequest?.params).toEqual(
      expect.not.objectContaining({ serviceTier: expect.anything() }),
    );
    const turnRequest = requests.find((request) => request.method === "turn/start");
    expect(turnRequest?.params).toEqual(
      expect.not.objectContaining({ serviceTier: expect.anything() }),
    );
  });

  it("builds resume and turn params from the currently selected OpenClaw model", () => {
    const params = createParams("/tmp/session.jsonl", "/tmp/workspace");
    const appServer = {
      start: {
        transport: "stdio" as const,
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
      },
      requestTimeoutMs: 60_000,
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "danger-full-access" as const,
      serviceTier: "flex" as const,
    };

    expect(buildThreadResumeParams(params, { threadId: "thread-1", appServer })).toEqual({
      threadId: "thread-1",
      model: "gpt-5.4-codex",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      sandbox: "danger-full-access",
      serviceTier: "flex",
      developerInstructions: expect.stringContaining(CODEX_GPT5_BEHAVIOR_CONTRACT),
      persistExtendedHistory: true,
    });
    expect(
      buildTurnStartParams(params, { threadId: "thread-1", cwd: "/tmp/workspace", appServer }),
    ).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/tmp/workspace",
        model: "gpt-5.4-codex",
        approvalPolicy: "on-request",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: { type: "dangerFullAccess" },
        serviceTier: "flex",
      }),
    );
  });

  it("preserves the bound auth profile when resume params omit authProfileId", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:bound",
    });
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;

    const binding = await startOrResumeThread({
      client: {
        request: async (method: string) => {
          if (method === "thread/resume") {
            return threadStartResult("thread-existing");
          }
          throw new Error(`unexpected method: ${method}`);
        },
      } as never,
      params,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: {
        start: {
          transport: "stdio",
          command: "codex",
          args: ["app-server"],
          headers: {},
        },
        requestTimeoutMs: 60_000,
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });

    expect(binding.authProfileId).toBe("openai-codex:bound");
  });

  it("reuses the bound auth profile for app-server startup when params omit it", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeExistingBinding(sessionFile, workspaceDir, {
      authProfileId: "openai-codex:bound",
      dynamicToolsFingerprint: "[]",
    });
    const seenAuthProfileIds: Array<string | undefined> = [];
    const { requests, waitForMethod, completeTurn } = createAppServerHarness(
      async (method: string) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-existing");
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        throw new Error(`unexpected method: ${method}`);
      },
      { onStart: (authProfileId) => seenAuthProfileIds.push(authProfileId) },
    );
    const params = createParams(sessionFile, workspaceDir);
    delete params.authProfileId;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(seenAuthProfileIds).toEqual(["openai-codex:bound"]), {
      interval: 1,
    });
    await waitForMethod("turn/start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
    await run;

    expect(seenAuthProfileIds).toEqual(["openai-codex:bound"]);
    expect(requests.map((entry) => entry.method)).toContain("turn/start");
  });
});
