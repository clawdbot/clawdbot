// Copilot tests cover attempt plugin behavior.
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CopilotClient, Tool as SdkTool } from "@github/copilot-sdk";
import {
  abortAgentHarnessRun,
  attachModelProviderRequestTransport,
  queueAgentHarnessMessage,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCopilotAttempt } from "./attempt.js";
import type { CopilotClientPool } from "./runtime.js";
import type { CopilotToolBridgeInput } from "./tool-bridge.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";

// Mock the dual-write transcript mirror so attempt tests do not touch the
// real filesystem. The mirror call site is exercised separately in
// dual-write-transcripts.test.ts and by the dedicated attempt
// dual-write tests below; the mocked module here just captures the
// invocation arguments without writing to disk.
const dualWriteMock = vi.hoisted(() => ({
  dualWriteCopilotTranscriptBestEffort: vi.fn().mockResolvedValue(undefined),
  attachCopilotMirrorIdentity: <T>(message: T, identity: string): T => {
    const record = message as unknown as Record<string, unknown>;
    return {
      ...record,
      __openclaw: { ...(record["__openclaw"] as object | undefined), mirrorIdentity: identity },
    } as unknown as T;
  },
}));
vi.mock("./dual-write-transcripts.js", () => dualWriteMock);

// Mock the workspace-bootstrap loader so attempt tests do not perform
// real filesystem reads (which add async ticks and would break the
// carefully-timed delta-ordering tests below). Real loader behavior is
// covered separately in workspace-bootstrap.test.ts. The dedicated
// "workspace bootstrap (systemMessage)" describe block below overrides
// the mock per-test to verify wiring into SessionConfig.systemMessage.
const workspaceBootstrapMock = vi.hoisted(() => ({
  resolveCopilotWorkspaceBootstrapContext: vi.fn().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
    instructions: undefined,
  }),
}));
vi.mock("./workspace-bootstrap.js", () => workspaceBootstrapMock);

type SessionEventShape = {
  data: Record<string, unknown>;
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};
type SendAndWaitFn = (options?: unknown) => Promise<SessionEventShape | undefined>;

type FakeSession = {
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  cfg: Record<string, unknown>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
  emit: (eventType: string, data: Record<string, unknown>) => void;
  id: string;
  off: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  rpc: {
    history: {
      cancelBackgroundCompaction: ReturnType<typeof vi.fn<() => Promise<{ cancelled: boolean }>>>;
    };
  };
  sendAndWait: ReturnType<typeof vi.fn<SendAndWaitFn>>;
  sessionId: string;
};

type FakeSdk = ReturnType<typeof makeFakeSdk>;

function createDeferred<T>() {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function flushAsync() {
  // Pump enough microtasks for the attempt to settle past every
  // pre-createSession `await` in attempt.ts (resolvePoolAcquire,
  // BYOK proxy setup, resolveCopilotWorkspaceBootstrapContext,
  // createSession, etc.).
  // Each chained `then` is one tick; tests rely on this to observe
  // `sdk.sessions[0]` being populated before they emit deltas.
  const tick = () => Promise.resolve();
  return tick().then(tick).then(tick).then(tick).then(tick);
}

function waitForEventLoopTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function getPromptErrorCode(result: AgentHarnessAttemptResult): string | undefined {
  return (result.promptError as { code?: string } | undefined)?.code;
}

function getSdkSessionId(result: AgentHarnessAttemptResult): string | undefined {
  return (result as AgentHarnessAttemptResult & { sdkSessionId?: string }).sdkSessionId;
}

function makeEvent(type: string, data: Record<string, unknown>): SessionEventShape {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
  };
}

function makeAssistantMessageEvent(
  content = "assistant text",
  overrides: Partial<Record<string, unknown>> = {},
): SessionEventShape {
  return makeEvent("assistant.message", {
    content,
    messageId: "msg-1",
    model: "gpt-4o",
    ...overrides,
  });
}

function createFakeSession(cfg: Record<string, unknown>, id: string): FakeSession {
  const listeners = new Map<string, Array<(event: SessionEventShape) => void>>();
  return {
    abort: vi.fn<() => Promise<void>>(async () => undefined),
    cfg,
    disconnect: vi.fn<() => Promise<void>>(async () => undefined),
    emit: (eventType: string, data: Record<string, unknown>) => {
      const event = makeEvent(eventType, data);
      for (const listener of listeners.get(eventType) ?? []) {
        listener(event);
      }
    },
    id,
    off: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      const handlers = listeners.get(eventType) ?? [];
      listeners.set(
        eventType,
        handlers.filter((existing) => existing !== handler),
      );
    }),
    on: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      const handlers = listeners.get(eventType) ?? [];
      handlers.push(handler);
      listeners.set(eventType, handlers);
    }),
    rpc: {
      history: {
        cancelBackgroundCompaction: vi.fn<() => Promise<{ cancelled: boolean }>>(async () => ({
          cancelled: true,
        })),
      },
    },
    sendAndWait: vi.fn<SendAndWaitFn>(async () => makeAssistantMessageEvent()),
    sessionId: id,
  };
}

function makeFakePool(sdk: FakeSdk) {
  const pool = {
    acquire: vi.fn(async (key, _options) => ({
      client: sdk.client as unknown as CopilotClient,
      key,
    })),
    dispose: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    size: vi.fn(() => 0),
  } satisfies CopilotClientPool;
  return pool;
}

function makeFakeSdk(
  options: {
    onCreateSession?: (session: FakeSession, cfg: Record<string, unknown>) => void | Promise<void>;
    onResumeSession?: (
      session: FakeSession,
      sessionId: string,
      cfg: Record<string, unknown>,
    ) => void | Promise<void>;
  } = {},
) {
  const sessions: FakeSession[] = [];

  const createSession = vi.fn(async (cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, `sess-${sessions.length + 1}`);
    await options.onCreateSession?.(session, cfg);
    sessions.push(session);
    return session;
  });

  const resumeSession = vi.fn(async (sessionId: string, cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, sessionId);
    await options.onResumeSession?.(session, sessionId, cfg);
    sessions.push(session);
    return session;
  });

  return {
    client: {
      createSession,
      deleteSession: vi.fn(async () => undefined),
      resumeSession,
      stop: vi.fn(async () => []),
    },
    createSession,
    resumeSession,
    sessions,
  };
}

function makeParams(
  overrides: Partial<
    AgentHarnessAttemptParams & {
      auth: {
        gitHubToken?: string;
        profileId?: string;
        profileVersion?: string;
        useLoggedInUser?: boolean;
      };
      initialReplayState: { sdkSessionId?: string };
      messages: Array<{ content: string; role: "user"; timestamp: number }>;
      model: { api: string; id: string; provider: string };
      onAssistantDelta: (payload: { delta: string; text: string }) => void | Promise<void>;
      profileVersion: string;
    }
  > = {},
): AgentHarnessAttemptParams {
  return {
    agentDir: "C:\\copilot-home",
    agentId: "agent-1",
    auth: { useLoggedInUser: true, ...(overrides as { auth?: object }).auth },
    initialReplayState: undefined,
    messages: [{ content: "hello", role: "user", timestamp: 1 }],
    model: {
      api: "openai-responses",
      id: "gpt-4o",
      provider: "github-copilot",
      ...(typeof overrides.model === "object" ? overrides.model : {}),
    },
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionTarget: {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: "openclaw-agent.sqlite",
    },
    timeoutMs: 5000,
    workspaceDir: "C:\\workspace",
    ...overrides,
  } as unknown as AgentHarnessAttemptParams;
}

afterEach(() => {
  resetGlobalHookRunner();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("runCopilotAttempt", () => {
  it("happy path", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.sessions[0]?.sendAndWait).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeUndefined();
    expect(result.lastAssistant?.role).toBe("assistant");
    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.messagesSnapshot.length).toBe(2);
    expect(getSdkSessionId(result)).toBe("sess-1");
  });

  it("runs generic prompt and lifecycle hooks through the standard harness helpers", async () => {
    const beforePromptBuild = vi.fn(() => ({
      prependContext: "Use the current repository state.",
      appendContext: "Finish with the current test status.",
      appendSystemContext: "Keep the final response concise.",
    }));
    const afterToolCall = vi.fn();
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", handler: beforePromptBuild },
        { hookName: "after_tool_call", handler: afterToolCall },
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const createToolBridge = vi.fn(async (input: CopilotToolBridgeInput) => {
      await input.onToolCompleted?.({
        args: { path: "README.md" },
        result: { content: [{ text: "read result", type: "text" }] },
        startedAt: Date.now(),
        toolCallId: "tool-call-1",
        toolName: "read",
      });
      return { sdkTools: [], sourceTools: [] };
    });

    await runCopilotAttempt(makeParams(), {
      createToolBridge,
      pool: makeFakePool(sdk),
    });
    await waitForEventLoopTurn();

    expect(beforePromptBuild).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "hello" }),
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
    const cfg = sdk.createSession.mock.calls[0]?.[0] as {
      systemMessage?: { content?: string };
    };
    expect(cfg.systemMessage?.content).toContain("Keep the final response concise.");
    const messageOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as { prompt?: string };
    expect(messageOptions.prompt).toBe(
      "Use the current repository state.\n\nhello\n\nFinish with the current test status.",
    );
    expect(llmInput).toHaveBeenCalledWith(
      expect.objectContaining({
        historyMessages: [],
        model: "gpt-4o",
        prompt:
          "Use the current repository state.\n\nhello\n\nFinish with the current test status.",
        provider: "github-copilot",
        runId: "run-1",
      }),
      expect.objectContaining({ agentId: "agent-1", sessionId: "session-1" }),
    );
    expect(llmOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantTexts: ["done"],
        model: "gpt-4o",
        provider: "github-copilot",
      }),
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
    expect(afterToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { path: "README.md" },
        toolCallId: "tool-call-1",
        toolName: "read",
      }),
      expect.objectContaining({ agentId: "agent-1", sessionId: "session-1" }),
    );
  });

  it("keeps generic compaction hooks attached through asynchronous SDK completion", async () => {
    const beforeCompaction = vi.fn();
    const afterCompaction = vi.fn();
    let computerContextEpoch: CopilotToolBridgeInput["computerContextEpoch"];
    const createToolBridge = vi.fn(async (input: CopilotToolBridgeInput) => {
      computerContextEpoch = input.computerContextEpoch;
      return { sdkTools: [], sourceTools: [] };
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_compaction", handler: beforeCompaction },
        { hookName: "after_compaction", handler: afterCompaction },
      ]),
    );
    let activeSession: FakeSession | undefined;
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        activeSession = session;
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return makeAssistantMessageEvent("done");
        });
      },
    });

    const attempt = runCopilotAttempt(makeParams(), {
      createToolBridge,
      pool: makeFakePool(sdk),
    });
    await vi.waitFor(() => {
      expect(activeSession?.sendAndWait).toHaveBeenCalled();
    });

    if (!activeSession) {
      throw new Error("expected Copilot session");
    }
    expect(computerContextEpoch?.value).toBe(0);
    if (!computerContextEpoch) {
      throw new Error("expected computer context epoch");
    }
    computerContextEpoch.frameToolCallId = "shot-1";
    computerContextEpoch.frameImageIdentity = "frame-digest";
    expect(activeSession.disconnect).not.toHaveBeenCalled();
    activeSession.emit("session.compaction_complete", { messagesRemoved: 4, success: true });
    expect(computerContextEpoch).toEqual({ value: 1 });

    await attempt;

    expect(beforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: -1,
        sessionFile: "session.json",
      }),
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
    expect(afterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        compactedCount: 4,
        messageCount: -1,
        sessionFile: "session.json",
      }),
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
    expect(beforeCompaction.mock.calls[0]?.[0]).not.toHaveProperty("messages");
  });

  it("does not await background compaction hooks before returning a turn", async () => {
    const releaseBeforeCompaction = createDeferred<void>();
    const beforeCompaction = vi.fn(async () => releaseBeforeCompaction.promise);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_compaction", handler: beforeCompaction }]),
    );
    let activeSession: FakeSession | undefined;
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        activeSession = session;
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return makeAssistantMessageEvent("done");
        });
      },
    });

    const result = await runCopilotAttempt(makeParams(), { pool: makeFakePool(sdk) });

    expect(result.timedOut).toBe(false);
    await vi.waitFor(() => {
      expect(beforeCompaction).toHaveBeenCalledTimes(1);
    });
    expect(activeSession?.disconnect).not.toHaveBeenCalled();

    releaseBeforeCompaction.resolve();
    activeSession?.emit("session.compaction_complete", { success: true });
    activeSession?.emit("session.idle", {});
    await vi.waitFor(() => {
      expect(activeSession?.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("returns a successful turn while background compaction remains observed", async () => {
    vi.useFakeTimers();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return makeAssistantMessageEvent("done");
        });
      },
    });
    const pool = makeFakePool(sdk);

    const attempt = runCopilotAttempt(makeParams(), { pool });
    const result = await attempt;

    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeUndefined();
    expect(sdk.sessions[0]?.disconnect).not.toHaveBeenCalled();
    expect(sdk.client.deleteSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(180_000);

    expect(sdk.sessions[0]?.rpc.history.cancelBackgroundCompaction).toHaveBeenCalledTimes(1);
    expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(sdk.client.deleteSession).toHaveBeenCalledWith("sess-1");
    expect(pool.release.mock.calls).toHaveLength(1);
  });

  it("cancels retained compaction when the caller aborts after a turn result", async () => {
    const controller = new AbortController();
    const onDeferredCompaction = vi.fn();
    let activeSession: FakeSession | undefined;
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        activeSession = session;
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          setTimeout(() => controller.abort(), 0);
          return makeAssistantMessageEvent("done");
        });
      },
    });

    const attempt = runCopilotAttempt(makeParams({ abortSignal: controller.signal }), {
      onDeferredCompaction,
      pool: makeFakePool(sdk),
    });

    const result = await attempt;

    expect(result.aborted).toBe(false);
    expect(activeSession?.abort).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(activeSession?.rpc.history.cancelBackgroundCompaction).toHaveBeenCalledTimes(1);
    });
    expect(activeSession?.disconnect).toHaveBeenCalledTimes(1);
    expect(sdk.client.deleteSession).toHaveBeenCalledWith("sess-1");
    expect(onDeferredCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        sdkSessionId: "sess-1",
      }),
    );
  });

  it("awaits deferred compaction cancellation before tearing down the SDK session", async () => {
    const controller = new AbortController();
    const cancellation = createDeferred<{ cancelled: boolean }>();
    let activeSession: FakeSession | undefined;
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        activeSession = session;
        session.rpc.history.cancelBackgroundCompaction.mockImplementationOnce(
          () => cancellation.promise,
        );
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return undefined;
        });
      },
    });

    const result = await runCopilotAttempt(makeParams({ abortSignal: controller.signal }), {
      pool: makeFakePool(sdk),
    });

    expect(result.timedOutDuringCompaction).toBe(true);
    controller.abort();
    await vi.waitFor(() => {
      expect(activeSession?.rpc.history.cancelBackgroundCompaction).toHaveBeenCalledTimes(1);
    });
    expect(activeSession?.disconnect).not.toHaveBeenCalled();

    cancellation.resolve({ cancelled: true });
    await vi.waitFor(() => {
      expect(activeSession?.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("reports the native prompt hook's effective input through llm_input", async () => {
    const llmInput = vi.fn();
    const onUserPromptSubmitted = vi.fn().mockResolvedValue({
      additionalContext: "Use the approved repository.",
      modifiedPrompt: "Review the authentication change.",
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_input", handler: llmInput }]),
    );
    const sdk = makeFakeSdk({
      onCreateSession: (session, cfg) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          const hooks = cfg.hooks as {
            onUserPromptSubmitted?: (
              input: { prompt: string },
              invocation: { sessionId: string },
            ) => Promise<unknown>;
          };
          await hooks.onUserPromptSubmitted?.(
            { prompt: "hello" },
            { sessionId: session.sessionId },
          );
          return makeAssistantMessageEvent("done");
        });
      },
    });

    await runCopilotAttempt(makeParams({ hooksConfig: { onUserPromptSubmitted } } as never), {
      pool: makeFakePool(sdk),
    });
    await waitForEventLoopTurn();

    expect(onUserPromptSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "hello" }),
      { sessionId: "sess-1" },
    );
    expect(llmInput).toHaveBeenCalledTimes(1);
    expect(llmInput).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Review the authentication change.\n\nUse the approved repository.",
      }),
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
  });

  it("reuses the precomputed legacy before_agent_start result", async () => {
    const beforeAgentStart = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_start", handler: beforeAgentStart }]),
    );
    const sdk = makeFakeSdk();

    await runCopilotAttempt(
      makeParams({
        beforeAgentStartResult: { prependContext: "Use the cached result." },
      } as never),
      { pool: makeFakePool(sdk) },
    );

    expect(beforeAgentStart).not.toHaveBeenCalled();
    const messageOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as { prompt?: string };
    expect(messageOptions.prompt).toBe("Use the cached result.\n\nhello");
  });

  it("preserves native Copilot SDK hooks alongside generic lifecycle hooks", async () => {
    const sdk = makeFakeSdk();
    const onPreToolUse = vi.fn();

    await runCopilotAttempt(
      makeParams({
        hooksConfig: { onPreToolUse },
      } as never),
      { pool: makeFakePool(sdk) },
    );

    const cfg = sdk.createSession.mock.calls[0]?.[0] as {
      hooks?: { onPreToolUse?: unknown };
    };
    expect(cfg.hooks?.onPreToolUse).toEqual(expect.any(Function));
  });

  it("does not emit llm_output when cancellation happens before the SDK turn starts", async () => {
    const llmOutput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_output", handler: llmOutput }]),
    );
    const controller = new AbortController();
    const sdk = makeFakeSdk();

    const result = await runCopilotAttempt(
      makeParams({ abortSignal: controller.signal } as never),
      {
        onSessionEstablished: () => controller.abort(),
        pool: makeFakePool(sdk),
      },
    );
    await waitForEventLoopTurn();

    expect(result.aborted).toBe(true);
    expect(sdk.sessions[0]?.sendAndWait).not.toHaveBeenCalled();
    expect(llmOutput).not.toHaveBeenCalled();
  });

  it("waits for agent_end hooks before resolving one-shot attempts", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });

    let settled = false;
    const run = runCopilotAttempt(makeParams(), { pool: makeFakePool(sdk) }).then((result) => {
      settled = true;
      return result;
    });
    await waitForEventLoopTurn();

    expect(agentEnd).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseAgentEnd();
    await expect(run).resolves.toMatchObject({ promptError: undefined });
    expect(settled).toBe(true);
  });

  it("forwards prompt images as SDK blob attachments", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        images: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      } as never),
      { pool },
    );

    const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as
      | { attachments?: unknown[]; prompt?: string }
      | undefined;
    expect(sendOptions?.prompt).toBe("hello");
    expect(sendOptions?.attachments).toEqual([
      {
        type: "blob",
        data: TINY_PNG_BASE64,
        mimeType: "image/png",
        displayName: "prompt-image-1",
      },
    ]);
  });

  it("hydrates offloaded prompt images before creating SDK blob attachments", async () => {
    const stateDir = await fsp.mkdtemp(path.join(tmpdir(), "copilot-offloaded-image-"));
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "telegram-photo.png";
    await fsp.mkdir(inboundDir, { recursive: true });
    await fsp.writeFile(path.join(inboundDir, mediaId), Buffer.from(TINY_PNG_BASE64, "base64"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    try {
      await runCopilotAttempt(
        makeParams({
          imageOrder: ["offloaded"],
          images: [],
          model: {
            api: "openai-responses",
            id: "gpt-4o",
            input: ["text", "image"],
            provider: "github-copilot",
          },
          prompt: `describe this\n[media attached: media://inbound/${mediaId}]`,
        } as never),
        { pool },
      );

      const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as
        | { attachments?: unknown[] }
        | undefined;
      expect(sendOptions?.attachments).toEqual([
        {
          type: "blob",
          data: TINY_PNG_BASE64,
          mimeType: "image/png",
          displayName: "prompt-image-1",
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      await fsp.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not hydrate prompt image paths outside workspace-only policy", async () => {
    const stateDir = await fsp.mkdtemp(path.join(tmpdir(), "copilot-image-policy-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const outsideDir = path.join(stateDir, "outside");
    const outsideImage = path.join(outsideDir, "secret.png");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(outsideImage, Buffer.from(TINY_PNG_BASE64, "base64"));
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    try {
      await runCopilotAttempt(
        makeParams({
          config: { tools: { fs: { workspaceOnly: true } } },
          model: {
            api: "openai-responses",
            id: "gpt-4o",
            input: ["text", "image"],
            provider: "github-copilot",
          },
          prompt: `inspect ${outsideImage}`,
          workspaceDir,
        } as never),
        { pool },
      );

      const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as
        | { attachments?: unknown[] }
        | undefined;
      expect(sendOptions?.attachments).toBeUndefined();
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates quoted prompt image paths through the shared detector", async () => {
    const stateDir = await fsp.mkdtemp(path.join(tmpdir(), "copilot-quoted-image-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const imagePath = path.join(workspaceDir, "quoted.png");
    await fsp.mkdir(workspaceDir, { recursive: true });
    await fsp.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    try {
      await runCopilotAttempt(
        makeParams({
          config: { tools: { fs: { workspaceOnly: true } } },
          model: {
            api: "openai-responses",
            id: "gpt-4o",
            input: ["text", "image"],
            provider: "github-copilot",
          },
          prompt: `inspect "${imagePath}"`,
          workspaceDir,
        } as never),
        { pool },
      );

      const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as
        | { attachments?: unknown[] }
        | undefined;
      expect(sendOptions?.attachments).toEqual([
        {
          type: "blob",
          data: TINY_PNG_BASE64,
          mimeType: "image/png",
          displayName: "prompt-image-1",
        },
      ]);
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves relative prompt image paths from task cwd", async () => {
    const stateDir = await fsp.mkdtemp(path.join(tmpdir(), "copilot-cwd-image-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const cwd = path.join(workspaceDir, "task-repo");
    const imagePath = path.join(cwd, "relative.png");
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    try {
      await runCopilotAttempt(
        makeParams({
          config: { tools: { fs: { workspaceOnly: true } } },
          cwd,
          model: {
            api: "openai-responses",
            id: "gpt-4o",
            input: ["text", "image"],
            provider: "github-copilot",
          },
          prompt: "inspect ./relative.png",
          workspaceDir,
        } as never),
        { pool },
      );

      const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as
        | { attachments?: unknown[] }
        | undefined;
      expect(sendOptions?.attachments).toEqual([
        {
          type: "blob",
          data: TINY_PNG_BASE64,
          mimeType: "image/png",
          displayName: "prompt-image-1",
        },
      ]);
    } finally {
      await fsp.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("subscribe-before-send", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams(), { pool });

    const session = sdk.sessions[0];
    expect(session.on.mock.calls[0]?.[0]).toBe("assistant.message_delta");
    expect(session.on.mock.invocationCallOrder[0]).toBeLessThan(
      session.sendAndWait.mock.invocationCallOrder[0],
    );
  });

  it("deltas forwarded in order via promise chain", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const onAssistantDelta = vi.fn(async (payload: { delta: string }) => {
      order.push(`start:${payload.delta}`);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          order.push(`end:${payload.delta}`);
          resolve();
        });
      });
    });
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotAttempt(makeParams({ onAssistantDelta }), {
      createToolBridge,
      pool,
    });
    await flushAsync();

    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "c", messageId: "msg-1" });
    await flushAsync();

    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await flushAsync();
    expect(onAssistantDelta).toHaveBeenCalledTimes(2);
    releases[1]?.();
    await flushAsync();
    expect(onAssistantDelta).toHaveBeenCalledTimes(3);
    releases[2]?.();
    sendDeferred.resolve(makeAssistantMessageEvent("abc"));

    const result = await runPromise;
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(result.assistantTexts).toEqual(["abc"]);
  });

  it("deltas forwarded even when no consumer", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotAttempt(makeParams(), { createToolBridge, pool });
    await flushAsync();

    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "c", messageId: "msg-1" });
    sendDeferred.resolve(makeAssistantMessageEvent("abc"));

    const result = await runPromise;
    expect(result.assistantTexts).toEqual(["abc"]);
  });

  it("resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-1" } as never }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    expect(sdk.resumeSession.mock.calls[0]?.[0]).toBe("resume-1");
    expect(
      (sdk.resumeSession.mock.calls[0][1] as { continuePendingWork?: boolean }).continuePendingWork,
    ).toBe(false);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("replay-shim: replayInvalid:true forces createSession even when sdkSessionId is present", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({
        initialReplayState: {
          sdkSessionId: "resume-stale",
          replayInvalid: true,
        } as never,
      }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    // Downgrade invalidates replay even when no side effects occurred.
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("replay-shim: recovers from missing-session resume failure by downgrading to createSession", async () => {
    let resumeCalls = 0;
    const sdk = makeFakeSdk({
      onResumeSession: () => {
        resumeCalls += 1;
        throw Object.assign(new Error("session not found"), { status: 404 });
      },
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("fresh"));
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-gone" } as never }),
      { pool },
    );

    expect(resumeCalls).toBe(1);
    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(result.promptError).toBeUndefined();
    // Recovery invalidates replay even though no side effects occurred.
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
    // The freshly-created session id is reported, not the stale resume id.
    expect(getSdkSessionId(result)).not.toBe("resume-gone");
  });

  it("replay-shim: unrecoverable resume failure surfaces as promptError (no downgrade)", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: () => {
        throw new Error("ECONNRESET network failure");
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-x" } as never }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect((result.promptError as Error | undefined)?.message).toContain("ECONNRESET");
  });

  it("replay-shim: prior hadPotentialSideEffects propagates into result replayMetadata", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({
        initialReplayState: { hadPotentialSideEffects: true } as never,
      }),
      { pool },
    );

    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("replay-shim: consolidated mutating tool metadata makes the attempt replay-unsafe", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("tool.execution_start", {
            toolCallId: "tool-1",
            toolName: "write",
          });
          session.emit("tool.execution_complete", {
            result: { content: "wrote file" },
            success: true,
            toolCallId: "tool-1",
          });
          return makeAssistantMessageEvent("done");
        });
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(result.toolMetas).toEqual([{ meta: "wrote file", toolName: "write" }]);
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("replay-shim: prior replayInvalid propagates even on an early-return failure", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
        initialReplayState: {
          replayInvalid: true,
          hadPotentialSideEffects: true,
        } as never,
      }),
      { pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("abort path (mid-stream)", async () => {
    const controller = new AbortController();
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sessionCreated = createDeferred<FakeSession>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
        session.abort.mockImplementationOnce(async () => {
          sendDeferred.resolve(undefined);
        });
        sessionCreated.resolve(session);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotAttempt(makeParams({ abortSignal: controller.signal }), {
      createToolBridge,
      pool,
    });
    const session = await sessionCreated.promise;
    for (let i = 0; i < 100 && session.sendAndWait.mock.calls.length === 0; i++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    expect(session.sendAndWait).toHaveBeenCalledTimes(1);

    controller.abort();
    const result = await runPromise;

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
  });

  it("active-run abort path marks the attempt as externally aborted", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sessionCreated = createDeferred<FakeSession>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
        session.abort.mockImplementationOnce(async () => {
          sendDeferred.resolve(undefined);
        });
        sessionCreated.resolve(session);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotAttempt(makeParams(), {
      createToolBridge,
      pool,
    });
    const session = await sessionCreated.promise;
    await vi.waitFor(() => expect(session.sendAndWait).toHaveBeenCalledTimes(1));

    expect(abortAgentHarnessRun("session-1")).toBe(true);
    const result = await runPromise;

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
  });

  it("abort path (signal already aborted)", async () => {
    const controller = new AbortController();
    controller.abort();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });

    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool["acquire"]).toHaveBeenCalledTimes(0);
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("abort path (signal fires after settled)", async () => {
    const controller = new AbortController();
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });
    controller.abort();

    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("tool bridge wiring: injected tools populate session config", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const sdkTools: SdkTool[] = [
      {
        description: "Fake SDK tool",
        handler: async () => ({ resultType: "success", textResultForLlm: "ok" }),
        name: "fake_sdk_tool",
        parameters: { type: "object" },
      },
    ];
    const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

    await runCopilotAttempt(makeParams(), { createToolBridge, pool });

    expect(createToolBridge).toHaveBeenCalledTimes(1);
    expect(createToolBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: undefined,
        agentDir: "C:\\copilot-home",
        agentId: "agent-1",
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        workspaceDir: "C:\\workspace",
      }),
    );
    // F6: attempt params and sessionRef are threaded through so the
    // bridge can build PI-parity tool context and wire onYield to the
    // live SDK session once it exists. See tool-bridge.ts.
    const bridgeCall = (createToolBridge.mock.calls[0] as unknown[] | undefined)?.[0] as {
      attemptParams?: unknown;
      sessionRef?: { current?: unknown };
    };
    expect(bridgeCall.attemptParams).toBeDefined();
    expect(bridgeCall.sessionRef).toBeDefined();
    expect(
      ((sdk.createSession.mock.calls[0] as unknown[] | undefined)![0] as { tools?: unknown[] })
        .tools,
    ).toBe(sdkTools);
  });

  it("F6: sessionRef is populated after createSession so the tool bridge's onYield can abort the live SDK session", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    let capturedRef: { current: { abort?: () => unknown } | undefined } | undefined;
    const createToolBridge = vi.fn(
      async (input: { sessionRef?: { current: { abort?: () => unknown } | undefined } }) => {
        capturedRef = input.sessionRef;
        return { sdkTools: [], sourceTools: [] };
      },
    );

    await runCopilotAttempt(makeParams(), { createToolBridge, pool });

    expect(capturedRef).toBeDefined();
    // After createSession resolves, attempt.ts binds the live session
    // to sessionRef.current so onYield can route to session.abort().
    expect(capturedRef?.current).toBeDefined();
    expect(capturedRef?.current).toBe(sdk.sessions[0]);
  });

  it("F6: sessionRef is populated after a successful resumeSession (resume path)", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    let capturedRef: { current: { abort?: () => unknown } | undefined } | undefined;
    const createToolBridge = vi.fn(
      async (input: { sessionRef?: { current: { abort?: () => unknown } | undefined } }) => {
        capturedRef = input.sessionRef;
        return { sdkTools: [], sourceTools: [] };
      },
    );

    await runCopilotAttempt(
      makeParams({
        initialReplayState: { sdkSessionId: "resume-target" } as never,
      }),
      { createToolBridge, pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    expect(capturedRef?.current).toBeDefined();
    expect(capturedRef?.current).toBe(sdk.sessions[0]);
  });

  it("F6: attemptParams carries the full input so the bridge can derive PI-parity tool context", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    let capturedParams: unknown;
    const createToolBridge = vi.fn(async (input: { attemptParams?: unknown }) => {
      capturedParams = input.attemptParams;
      return { sdkTools: [], sourceTools: [] };
    });

    const params = makeParams({
      senderIsOwner: true,
      groupId: "g-9",
      currentChannelId: "C-9",
    } as never);
    await runCopilotAttempt(params, { createToolBridge, pool });

    // The bridge receives the same params object so it can read every
    // identity/policy/channel field the wrapped-tool layer needs.
    expect(capturedParams).toBe(params);
  });

  it("F7: result.yieldDetected is true when the tool bridge fires onYieldDetected during the attempt", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async (input: { onYieldDetected?: (msg?: string) => void }) => {
      // Simulate a wrapped tool invoking sessions_yield before the
      // attempt settles. The bridge is responsible for notifying the
      // caller via onYieldDetected so the final result can carry the
      // flag (parent runner uses it to mark liveness paused /
      // stop_reason end_turn). Mirrors PI/codex parity.
      input.onYieldDetected?.("paused by tool");
      return { sdkTools: [], sourceTools: [] };
    });

    const result = await runCopilotAttempt(makeParams(), {
      createToolBridge,
      pool,
    });

    expect(result.yieldDetected).toBe(true);
  });

  it("F7: result.yieldDetected is false on a clean attempt (no sessions_yield fired)", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    // Default createToolBridge in deps falls back to the real one,
    // which only fires onYieldDetected when a wrapped tool yields. We
    // pass a bridge that never yields and assert the flag stays false.
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const result = await runCopilotAttempt(makeParams(), {
      createToolBridge,
      pool,
    });

    expect(result.yieldDetected).toBe(false);
  });

  it("tool bridge failures become prompt errors", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => {
      throw new Error("bridge failed");
    });

    const result = await runCopilotAttempt(makeParams(), { createToolBridge, pool });

    expect(getPromptErrorCode(result)).toBe("tool_bridge_failure");
    expect((result.promptError as Error | undefined)?.message).toBe(
      "[copilot-attempt] tool-bridge construction failed: bridge failed",
    );
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool["acquire"]).toHaveBeenCalledTimes(0);
    expect(pool["release"]).toHaveBeenCalledTimes(0);
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "[copilot-attempt] tool-bridge construction failed: bridge failed",
        success: false,
      }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("unsupported providers skip injected tool bridge wiring", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const result = await runCopilotAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
      }),
      { createToolBridge, pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(createToolBridge).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({ success: false }),
      expect.objectContaining({ modelId: "claude", modelProviderId: "anthropic" }),
    );
  });

  it("reports pool-release failures through agent_end before rejecting", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    pool.release.mockRejectedValueOnce(new Error("release failed"));

    await expect(runCopilotAttempt(makeParams(), { pool })).rejects.toThrow("release failed");

    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "release failed",
        success: false,
      }),
      expect.objectContaining({ sessionId: "session-1" }),
    );
  });

  it("default permission policy rejects fail-closed", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams(), { pool });

    const handler = (
      (sdk.createSession.mock.calls[0] as unknown[] | undefined)![0] as {
        onPermissionRequest: (
          request: { kind: string },
          invocation: { sessionId: string },
        ) => Promise<{ kind: string; feedback?: string }>;
      }
    ).onPermissionRequest;
    const result = await handler({ kind: "write" }, { sessionId: "sess-1" });
    expect(result.kind).toBe("reject");
    expect(result.feedback).toContain("no permission policy installed");
  });

  it("registers ask_user and resolves it from the active OpenClaw queue", async () => {
    const onBlockReply = vi.fn();
    const sdk = makeFakeSdk({
      onCreateSession: (session, cfg) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          const handler = cfg.onUserInputRequest;
          if (typeof handler !== "function") {
            throw new Error("expected onUserInputRequest handler");
          }
          const response = await handler(
            {
              question: "Pick a mode",
              choices: ["Fast", "Deep"],
              allowFreeform: false,
            },
            { sessionId: session.sessionId },
          );
          return makeAssistantMessageEvent(`selected ${response.answer}`);
        });
      },
    });
    const pool = makeFakePool(sdk);

    const attempt = runCopilotAttempt(makeParams({ onBlockReply }), { pool });

    await vi.waitFor(() => expect(onBlockReply).toHaveBeenCalledTimes(1));
    expect(queueAgentHarnessMessage("session-1", "2")).toBe(true);
    const result = await attempt;

    const cfg = sdk.createSession.mock.calls[0]?.[0];
    expect(typeof cfg.onUserInputRequest).toBe("function");
    expect(onBlockReply.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Pick a mode") }),
    );
    expect(result.assistantTexts).toEqual(["selected Deep"]);
    expect(queueAgentHarnessMessage("session-1", "late")).toBe(false);
  });

  it("enableSessionTelemetry is omitted from createSession when undefined (SDK default)", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams(), { pool });

    const cfg = sdk.createSession.mock.calls[0]?.[0];
    expect("enableSessionTelemetry" in cfg).toBe(false);
  });

  it("enableSessionTelemetry: true is propagated to createSession", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams({ enableSessionTelemetry: true } as never), { pool });

    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      enableSessionTelemetry?: boolean;
    };
    expect(cfg.enableSessionTelemetry).toBe(true);
  });

  it("enableSessionTelemetry: false is propagated to createSession", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams({ enableSessionTelemetry: false } as never), { pool });

    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      enableSessionTelemetry?: boolean;
    };
    expect(cfg.enableSessionTelemetry).toBe(false);
  });

  it("enableSessionTelemetry is propagated to resumeSession on resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        enableSessionTelemetry: false,
        initialReplayState: { sdkSessionId: "resume-2" },
      } as never),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    const cfg = sdk.resumeSession.mock.calls[0]?.[1] as { enableSessionTelemetry?: boolean };
    expect(cfg.enableSessionTelemetry).toBe(false);
  });

  it("infiniteSessions is omitted from createSession when host did not supply config", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams(), { pool });

    const cfg = sdk.createSession.mock.calls[0]?.[0];
    expect("infiniteSessions" in cfg).toBe(false);
  });

  describe("workspace bootstrap (systemMessage)", () => {
    beforeEach(() => {
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockReset();
      // Re-establish the default fast-path so unrelated tests in the
      // suite keep getting `instructions: undefined`. Tests in this
      // block override the mock locally to inject their own rendered
      // instructions string.
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockResolvedValue({
        bootstrapFiles: [],
        contextFiles: [],
        instructions: undefined,
      });
    });

    it("forwards rendered bootstrap instructions into SDK SessionConfig.systemMessage (append mode)", async () => {
      const rendered =
        "# Project Context\n## /ws/SOUL.md\n\nSoul voice goes here.\n\n## /ws/IDENTITY.md\n\nI am the agent.";
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockResolvedValueOnce({
        bootstrapFiles: [],
        contextFiles: [],
        instructions: rendered,
      });
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(makeParams(), { pool });

      // Regression: persona/identity bootstrap (SOUL.md, IDENTITY.md)
      // must reach SDK SessionConfig.systemMessage so the model
      // receives it as system context without having to read the file
      // via its read tool. The SDK's `append` mode keeps the SDK
      // foundation (identity/safety/tool-instruction sections) intact
      // while layering OpenClaw context after it. See
      // workspace-bootstrap.ts and @github/copilot-sdk types.d.ts
      // L1052 (SystemMessageConfig).
      const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
        systemMessage?: { mode?: string; content?: string };
      };
      expect(cfg.systemMessage).toBeDefined();
      expect(cfg.systemMessage?.mode).toBe("append");
      expect(cfg.systemMessage?.content).toBe(rendered);
    });

    it("omits systemMessage entirely when the loader returns no instructions", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(makeParams(), { pool });

      const cfg = sdk.createSession.mock.calls[0]?.[0];
      // No rendered instructions => skip the systemMessage field so
      // the SDK default (foundation only) applies. Avoids polluting
      // session logs with an empty `append` and removes a no-op SDK
      // codepath. Mirrors the omit-when-empty pattern used elsewhere
      // in createSessionConfig (hooks, infiniteSessions,
      // enableSessionTelemetry).
      expect("systemMessage" in cfg).toBe(false);
    });

    it("forwards extraSystemPrompt into SDK SessionConfig.systemMessage", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          extraSystemPrompt: "Tool and file actions are disabled for this sender.",
        }),
        { pool },
      );

      const cfg = sdk.createSession.mock.calls[0]?.[0] as {
        systemMessage?: { mode?: string; content?: string };
      };
      expect(cfg.systemMessage?.mode).toBe("append");
      expect(cfg.systemMessage?.content).toBe(
        "## Conversation Context\nTool and file actions are disabled for this sender.",
      );
    });

    it("omits extraSystemPrompt for raw model runs", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          extraSystemPrompt: "Do not leak into raw model probes.",
          modelRun: true,
        } as never),
        { pool },
      );

      const cfg = sdk.createSession.mock.calls[0]?.[0];
      expect("systemMessage" in cfg).toBe(false);
    });

    it("keeps raw model probes outside generic prompt hooks", async () => {
      const beforePromptBuild = vi.fn(() => ({
        appendContext: "must not reach raw model probes",
        prependSystemContext: "must not reach raw model probes",
      }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
      );
      const sdk = makeFakeSdk();

      await runCopilotAttempt(
        makeParams({
          modelRun: true,
        } as never),
        { pool: makeFakePool(sdk) },
      );

      expect(beforePromptBuild).not.toHaveBeenCalled();
      const messageOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as {
        prompt?: string;
      };
      expect(messageOptions.prompt).toBe("hello");
    });

    it("keeps promptMode none runs outside generic prompt hooks", async () => {
      const beforePromptBuild = vi.fn(() => ({
        appendContext: "must not reach raw model probes",
      }));
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "before_prompt_build", handler: beforePromptBuild }]),
      );
      const sdk = makeFakeSdk();

      await runCopilotAttempt(
        makeParams({
          promptMode: "none",
        } as never),
        { pool: makeFakePool(sdk) },
      );

      expect(beforePromptBuild).not.toHaveBeenCalled();
      const messageOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as {
        prompt?: string;
      };
      expect(messageOptions.prompt).toBe("hello");
    });

    it("appends extraSystemPrompt after rendered bootstrap instructions", async () => {
      const rendered = "# Project Context\n## /ws/SOUL.md\n\nSoul voice goes here.";
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockResolvedValueOnce({
        bootstrapFiles: [],
        contextFiles: [],
        instructions: rendered,
      });
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          extraSystemPrompt: "Only answer in the current group thread.",
        }),
        { pool },
      );

      const cfg = sdk.createSession.mock.calls[0]?.[0] as {
        systemMessage?: { mode?: string; content?: string };
      };
      expect(cfg.systemMessage?.content).toBe(
        `${rendered}\n\n## Conversation Context\nOnly answer in the current group thread.`,
      );
    });

    it("forwards rendered bootstrap instructions to resumeSession on the resume path", async () => {
      const rendered = "# Project Context\n## /ws/SOUL.md\n\nSoul voice goes here.";
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockResolvedValueOnce({
        bootstrapFiles: [],
        contextFiles: [],
        instructions: rendered,
      });
      const sdk = makeFakeSdk({
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({ initialReplayState: { sdkSessionId: "sess-resume-1" } } as never),
        { pool },
      );

      // SystemMessage is in ResumeSessionConfig's Pick set (per SDK
      // types.d.ts:1198), so it must be propagated on resume too,
      // otherwise resumed sessions would silently lose OpenClaw
      // persona/identity context after every reconnect.
      const cfg = sdk.resumeSession.mock.calls[0]?.[1] as {
        systemMessage?: { mode?: string; content?: string };
      };
      expect(cfg.systemMessage).toBeDefined();
      expect(cfg.systemMessage?.mode).toBe("append");
      expect(cfg.systemMessage?.content).toBe(rendered);
    });
  });

  it("infiniteSessions config is propagated to createSession when host supplies it", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        infiniteSessionConfig: {
          enabled: true,
          backgroundCompactionThreshold: 0.7,
          bufferExhaustionThreshold: 0.9,
        },
      } as never),
      { pool },
    );

    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      infiniteSessions?: Record<string, unknown>;
    };
    expect(cfg.infiniteSessions).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.7,
      bufferExhaustionThreshold: 0.9,
    });
  });

  it("infiniteSessions enabled:false explicitly disables infinite sessions", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams({ infiniteSessionConfig: { enabled: false } } as never), {
      pool,
    });

    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      infiniteSessions?: Record<string, unknown>;
    };
    expect(cfg.infiniteSessions).toEqual({ enabled: false });
  });

  it("infiniteSessions is propagated to resumeSession on resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        infiniteSessionConfig: { backgroundCompactionThreshold: 0.5 },
        initialReplayState: { sdkSessionId: "resume-3" },
      } as never),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    const cfg = sdk.resumeSession.mock.calls[0]?.[1] as {
      infiniteSessions?: Record<string, unknown>;
    };
    expect(cfg.infiniteSessions).toEqual({ backgroundCompactionThreshold: 0.5 });
  });

  it("timeout", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(undefined);
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(getSdkSessionId(result)).toBe("sess-1");
    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
    expect(agentEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Copilot SDK turn timed out.",
        success: false,
      }),
      expect.anything(),
    );
    sdk.sessions[0]?.emit("session.idle", {});
    await vi.waitFor(() => {
      expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("marks a timeout during active SDK compaction", async () => {
    const afterCompaction = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_compaction", handler: afterCompaction }]),
    );
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return undefined;
        });
      },
    });

    const result = await runCopilotAttempt(makeParams(), { pool: makeFakePool(sdk) });

    expect(result.timedOut).toBe(true);
    expect(result.timedOutDuringCompaction).toBe(true);
    expect(sdk.sessions[0]?.disconnect).not.toHaveBeenCalled();

    sdk.sessions[0]?.emit("session.compaction_complete", { messagesRemoved: 3, success: true });
    sdk.sessions[0]?.emit("session.idle", {});
    await vi.waitFor(() => {
      expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    });

    expect(sdk.client.deleteSession).not.toHaveBeenCalled();
    expect(afterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ compactedCount: 3, sessionFile: "session.json" }),
      expect.objectContaining({ runId: "run-1", sessionId: "session-1" }),
    );
  });

  it("retains a timed-out session until later compaction reaches session.idle", async () => {
    const afterCompaction = vi.fn();
    const onDeferredCompaction = vi.fn();
    const cleanupToolBridge = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_compaction", handler: afterCompaction }]),
    );
    let activeSession: FakeSession | undefined;
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        activeSession = session;
        session.sendAndWait.mockRejectedValueOnce(
          new Error("Timeout after 60000ms waiting for session.idle"),
        );
      },
    });
    const createToolBridge = vi.fn(async () => ({
      cleanup: cleanupToolBridge,
      sdkTools: [],
      sourceTools: [],
    }));

    const result = await runCopilotAttempt(makeParams(), {
      createToolBridge,
      onDeferredCompaction,
      pool: makeFakePool(sdk),
    });

    expect(result.timedOut).toBe(true);
    expect(result.timedOutDuringCompaction).toBe(false);
    expect(onDeferredCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ sdkSessionId: "sess-1" }),
    );
    expect(cleanupToolBridge).not.toHaveBeenCalled();
    expect(activeSession?.disconnect).not.toHaveBeenCalled();

    activeSession?.emit("session.compaction_start", {});
    activeSession?.emit("session.compaction_complete", { messagesRemoved: 3, success: true });
    await vi.waitFor(() => {
      expect(afterCompaction).toHaveBeenCalledTimes(1);
    });
    expect(activeSession?.disconnect).not.toHaveBeenCalled();

    activeSession?.emit("session.idle", {});
    await vi.waitFor(() => {
      expect(activeSession?.disconnect).toHaveBeenCalledTimes(1);
    });
    expect(cleanupToolBridge).toHaveBeenCalledTimes(1);
  });

  it("does not mark a timeout after SDK compaction has completed as active compaction", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          session.emit("session.compaction_complete", { success: true });
          session.emit("session.idle", {});
          return undefined;
        });
      },
    });

    const result = await runCopilotAttempt(makeParams(), { pool: makeFakePool(sdk) });

    expect(result.timedOut).toBe(true);
    expect(result.timedOutDuringCompaction).toBe(false);
  });

  it("bounds deferred cleanup when SDK compaction never completes", async () => {
    vi.useFakeTimers();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return undefined;
        });
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(result.timedOutDuringCompaction).toBe(true);
    expect(sdk.sessions[0]?.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(180_000);

    expect(sdk.sessions[0]?.rpc.history.cancelBackgroundCompaction).toHaveBeenCalledTimes(1);
    expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(sdk.client.deleteSession).toHaveBeenCalledWith("sess-1");
    expect(pool.release.mock.calls).toHaveLength(1);
  });

  it("cancels deferred cleanup when the timed-out caller aborts", async () => {
    const controller = new AbortController();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return undefined;
        });
      },
    });

    const result = await runCopilotAttempt(makeParams({ abortSignal: controller.signal }), {
      pool: makeFakePool(sdk),
    });

    expect(result.timedOutDuringCompaction).toBe(true);
    expect(sdk.sessions[0]?.disconnect).not.toHaveBeenCalled();

    controller.abort();
    await vi.waitFor(() => {
      expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    });

    expect(sdk.sessions[0]?.rpc.history.cancelBackgroundCompaction).toHaveBeenCalledTimes(1);
    expect(sdk.client.deleteSession).toHaveBeenCalledWith("sess-1");
  });

  it("keeps the compaction timeout classification after deferred completion", async () => {
    const mirror = createDeferred<void>();
    dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
    dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockImplementationOnce(() => mirror.promise);
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("session.compaction_start", {});
          return undefined;
        });
      },
    });

    const attempt = runCopilotAttempt(makeParams(), { pool: makeFakePool(sdk) });
    await vi.waitFor(() => {
      expect(dualWriteMock.dualWriteCopilotTranscriptBestEffort).toHaveBeenCalledTimes(1);
    });
    sdk.sessions[0]?.emit("session.compaction_complete", { success: true });
    sdk.sessions[0]?.emit("session.idle", {});
    mirror.resolve();

    const result = await attempt;

    expect(result.timedOut).toBe(true);
    expect(result.timedOutDuringCompaction).toBe(true);
  });

  it("G1: SDK timeout rejection (Error 'Timeout after Nms waiting for session.idle') sets timedOut, leaves promptError undefined, and does NOT abort the session", async () => {
    // @github/copilot-sdk@1.0.0-beta.4 actually REJECTS sendAndWait
    // with this exact message when the internal timer beats
    // session.idle (see node_modules/@github/copilot-sdk/dist/
    // session.js:156-164). Before round-5 we only handled the legacy
    // resolve(undefined) shape, which meant a real timeout fell into
    // the catch and surfaced as a generic prompt error with
    // timedOut=false — the replay metadata then incorrectly treated
    // the attempt as side-effect-safe.
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockRejectedValueOnce(
          new Error("Timeout after 60000ms waiting for session.idle"),
        );
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(result.timedOut).toBe(true);
    expect(result.promptError).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.externalAbort).toBe(false);
    // Do NOT abort on timeout: orchestrator may resume the in-flight
    // SDK session on the next attempt. Matches the existing
    // resolve(undefined) test above.
    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
    // Replay metadata must reflect that the timeout flipped the
    // side-effect-risky bit (and therefore replay-unsafe). Before
    // round-5 the SDK rejection fell through to a generic prompt
    // error path with timedOut=false and the orchestrator's
    // replay-shim incorrectly treated the attempt as side-effect-safe.
    expect(result.replayMetadata?.hadPotentialSideEffects).toBe(true);
    expect(result.replayMetadata?.replaySafe).toBe(false);
    sdk.sessions[0]?.emit("session.idle", {});
    await vi.waitFor(() => {
      expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("G1: SDK timeout flushes the in-flight delta chain before snapshot so assistant text is preserved", async () => {
    // If the SDK delivered streaming deltas before the timer fired
    // but the delta-chain promise had not yet resolved (slow async
    // onAssistantDelta consumer), the snapshot used to be built
    // without waiting for them. Round-5 awaits the delta chain inside
    // the timeout branch so the recorded assistantTexts reflect what
    // the model actually streamed.
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const release = createDeferred<void>();
    const onAssistantDelta = vi.fn(async (_payload: { delta: string }) => {
      await release.promise;
    });
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotAttempt(makeParams({ onAssistantDelta }), {
      createToolBridge,
      pool,
    });
    await flushAsync();
    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "partial-", messageId: "msg-1" });
    await flushAsync();
    // SDK timer fires before the slow delta consumer resolves.
    sendDeferred.reject(new Error("Timeout after 60000ms waiting for session.idle"));
    await flushAsync();
    // Release the delta consumer so the awaitDeltaChain in the
    // timeout branch can complete.
    release.resolve();
    const result = await runPromise;

    expect(result.timedOut).toBe(true);
    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
    expect(result.assistantTexts?.join("")).toContain("partial-");
    session.emit("session.idle", {});
    await vi.waitFor(() => {
      expect(session.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  it("model translation: unsupported provider", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
      }),
      { pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool["acquire"]).toHaveBeenCalledTimes(0);
    expect(pool["release"]).toHaveBeenCalledTimes(0);
  });

  it("acquire failure", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const error = new Error("acquire failed");
    pool.acquire = vi.fn(async () => {
      throw error;
    });

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(result.promptError).toBe(error);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool["release"]).toHaveBeenCalledTimes(0);
  });

  it("release failure after a successful send rejects the attempt", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    pool.release = vi.fn(async () => {
      throw toLintErrorObject("release failed", "Non-Error thrown");
    });

    await expect(runCopilotAttempt(makeParams(), { pool })).rejects.toThrow("release failed");

    expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("release failure after a primary prompt error warns without masking the error", async () => {
    const primaryError = new Error("send failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockRejectedValueOnce(primaryError);
      },
    });
    const pool = makeFakePool(sdk);
    pool.release = vi.fn(async () => {
      throw toLintErrorObject("release failed", "Non-Error thrown");
    });

    const result = await runCopilotAttempt(makeParams(), { pool });

    expect(result.promptError).toBe(primaryError);
    expect(warnSpy).toHaveBeenCalledWith(
      "[copilot-attempt] pool.release failed after primary error",
      expect.objectContaining({ message: "release failed" }),
    );
  });

  it("accepts string model ids and falls back to top-level provider metadata", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(
      makeParams({ model: "gpt-4.1" as never, provider: "github-copilot" } as never),
      { now: () => 123, pool },
    );

    expect(getPromptErrorCode(result)).toBeUndefined();
    expect(sdk.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4.1" }));
    expect(result.currentAttemptAssistant).toEqual(
      expect.objectContaining({ provider: "github-copilot", timestamp: 123 }),
    );
  });

  it("cleanup on success", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(makeParams(), { pool });

    const session = sdk.sessions[0];
    expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(pool["release"]).toHaveBeenCalledTimes(1);
  });

  it("cleanup on send error", async () => {
    const error = new Error("send failed");
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockRejectedValueOnce(error);
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotAttempt(makeParams(), { pool });
    const session = sdk.sessions[0];

    expect(result.promptError).toBe(error);
    expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(pool["release"]).toHaveBeenCalledTimes(1);
  });

  it("cleanup on disconnect throw", async () => {
    const primaryError = new Error("send failed");
    const sdkWithPrimaryError = makeFakeSdk({
      onCreateSession: (session) => {
        session.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
        session.sendAndWait.mockRejectedValueOnce(primaryError);
      },
    });
    const poolWithPrimaryError = makeFakePool(sdkWithPrimaryError);

    const first = await runCopilotAttempt(makeParams(), { pool: poolWithPrimaryError });
    expect(first.promptError).toBe(primaryError);

    const sdkWithoutPrimaryError = makeFakeSdk({
      onCreateSession: (session) => {
        session.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const poolWithoutPrimaryError = makeFakePool(sdkWithoutPrimaryError);

    const second = await runCopilotAttempt(makeParams(), { pool: poolWithoutPrimaryError });
    expect((second.promptError as Error | undefined)?.message).toBe("disconnect failed");
  });

  it("pool keying: useLoggedInUser", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({ auth: { gitHubToken: "ignored", useLoggedInUser: true } as never }),
      { pool },
    );

    const key = (vi.mocked(pool["acquire"]).mock.calls[0] as unknown[] | undefined)?.[0] as {
      authMode: string;
    };
    const options = (vi.mocked(pool["acquire"]).mock.calls[0] as unknown[] | undefined)?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    expect(key.authMode).toBe("useLoggedInUser");
    expect(options.useLoggedInUser).toBe(true);
    expect(options.gitHubToken).toBeUndefined();
  });

  it("pool keying: gitHubToken requires profileId+profileVersion", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await expect(
      runCopilotAttempt(makeParams({ auth: { gitHubToken: "token" } as never }), { pool }),
    ).rejects.toThrow(
      "[copilot-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)",
    );
    expect(pool["acquire"]).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("pool keying: gitHubToken with profile", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        auth: { gitHubToken: "token", profileId: "profile-1", profileVersion: "v1" } as never,
      }),
      { pool },
    );

    const key = (vi.mocked(pool["acquire"]).mock.calls[0] as unknown[] | undefined)?.[0] as {
      authMode: string;
      authProfileId?: string;
      authProfileVersion?: string;
    };
    const options = (vi.mocked(pool["acquire"]).mock.calls[0] as unknown[] | undefined)?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    expect(key.authMode).toBe("gitHubToken");
    expect(key.authProfileId).toBe("profile-1");
    expect(key.authProfileVersion).toBe("v1");
    expect(options.gitHubToken).toBe("token");
    expect(options.useLoggedInUser).toBe(false);
  });

  it("pool keying: BYOK does not resolve unrelated GitHub auth", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        auth: { gitHubToken: "unrelated-token" } as never,
        model: {
          api: "openai-responses",
          baseUrl: "https://api.example.test/v1",
          id: "gpt-test",
          provider: "custom-openai",
        } as never,
        resolvedApiKey: "byok-token",
        authProfileId: "custom-openai:main",
      } as never),
      { pool },
    );

    const key = (vi.mocked(pool["acquire"]).mock.calls[0] as unknown[] | undefined)?.[0] as {
      authMode: string;
      authProfileId?: string;
    };
    const options = (vi.mocked(pool["acquire"]).mock.calls[0] as unknown[] | undefined)?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      provider?: { apiKey?: string; baseUrl?: string };
    };

    expect(key.authMode).toBe("byok");
    expect(key.authProfileId).toBe("custom-openai:main");
    expect(options.gitHubToken).toBeUndefined();
    expect(options.useLoggedInUser).toBe(false);
    expect(cfg.provider).toEqual(
      expect.objectContaining({
        apiKey: "byok-token",
        baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{24}\/v1$/),
      }),
    );
  });

  it("forwards BYOK provider headers on the model request turn", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotAttempt(
      makeParams({
        model: {
          api: "anthropic-messages",
          baseUrl: "https://anthropic.example.test",
          headers: {
            "X-Tenant": "tenant-a",
            "X-Trace": "trace-1",
          },
          id: "claude-test",
          provider: "anthropic-proxy",
        } as never,
        resolvedApiKey: "byok-token",
        authProfileId: "anthropic-proxy:main",
      } as never),
      { pool },
    );

    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      provider?: { headers?: Record<string, string> };
    };
    const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as {
      requestHeaders?: Record<string, string>;
    };
    expect(cfg.provider?.headers).toEqual({
      "X-Tenant": "tenant-a",
      "X-Trace": "trace-1",
    });
    expect(sendOptions.requestHeaders).toEqual({
      "X-Tenant": "tenant-a",
      "X-Trace": "trace-1",
    });
  });

  it("preserves prepared BYOK header-auth without synthesizing SDK apiKey auth", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const model = attachModelProviderRequestTransport(
      {
        api: "openai-responses",
        baseUrl: "https://proxy.example.test/v1",
        headers: { "x-api-key": "header-secret" },
        id: "gpt-test",
        provider: "custom-header-proxy",
      },
      { auth: { mode: "header", headerName: "x-api-key", value: "header-secret" } },
    );

    await runCopilotAttempt(
      makeParams({
        model: model as never,
        resolvedApiKey: "header-secret",
        authProfileId: "custom-header-proxy:main",
      } as never),
      { pool },
    );

    const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
      provider?: { apiKey?: string; headers?: Record<string, string> };
    };
    const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as {
      requestHeaders?: Record<string, string>;
    };
    expect(cfg.provider).toEqual(
      expect.objectContaining({
        headers: { "x-api-key": "header-secret" },
      }),
    );
    expect(cfg.provider).not.toHaveProperty("apiKey");
    expect(sendOptions.requestHeaders).toEqual({ "x-api-key": "header-secret" });
  });

  it("rejects BYOK providers with request transport policy overrides before creating a SDK session", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const model = attachModelProviderRequestTransport(
      {
        api: "openai-responses",
        baseUrl: "https://proxy.example.test/v1",
        id: "gpt-test",
        provider: "custom-header-proxy",
      },
      { proxy: { mode: "env-proxy" } },
    );

    const result = await runCopilotAttempt(
      makeParams({
        model: model as never,
        resolvedApiKey: "header-secret",
        authProfileId: "custom-header-proxy:main",
      } as never),
      { pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect((result.promptError as Error | undefined)?.message).toContain("request proxy");
    expect(sdk.createSession).not.toHaveBeenCalled();
  });

  describe("session-level gitHubToken (independent of client-level)", () => {
    // The SDK contract (@github/copilot-sdk/dist/types.d.ts:1168-1178)
    // makes `SessionConfig.gitHubToken` independent of the client-level
    // `CopilotClientOptions.gitHubToken`. The session-level field is
    // what drives content exclusion, model routing, and quota for that
    // session. ResumeSessionConfig (types.d.ts:1198) also includes
    // `gitHubToken` in its Pick, so resume must carry it too.

    it("contract resolvedApiKey populates SessionConfig.gitHubToken on createSession", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          auth: {} as never,
          resolvedApiKey: "contract-token-xyz",
          authProfileId: "github-copilot:main",
        } as never),
        { pool },
      );

      const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
        gitHubToken?: string;
      };
      expect(cfg.gitHubToken).toBe("contract-token-xyz");
    });

    it("explicit auth.gitHubToken populates SessionConfig.gitHubToken on createSession", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          auth: { gitHubToken: "explicit-token", profileId: "p", profileVersion: "v1" } as never,
        }),
        { pool },
      );

      const cfg = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
        gitHubToken?: string;
      };
      expect(cfg.gitHubToken).toBe("explicit-token");
    });

    it("SessionConfig.gitHubToken is forwarded to resumeSession on a resumed session", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          auth: {} as never,
          resolvedApiKey: "contract-token-resume",
          authProfileId: "github-copilot:main",
          initialReplayState: { sdkSessionId: "resume-target" } as never,
        } as never),
        { pool },
      );

      expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
      const resumeCfg = sdk.resumeSession.mock.calls[0]?.[1] as { gitHubToken?: string };
      expect(resumeCfg.gitHubToken).toBe("contract-token-resume");
    });

    it("BYOK provider config is forwarded to resumeSession", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          auth: { gitHubToken: "unrelated-token" } as never,
          model: {
            api: "openai-responses",
            baseUrl: "https://api.example.test/v1",
            id: "gpt-test",
            provider: "custom-openai",
          } as never,
          resolvedApiKey: "byok-token",
          authProfileId: "custom-openai:main",
          initialReplayState: { sdkSessionId: "resume-target" } as never,
        } as never),
        { pool },
      );

      const resumeCfg = sdk.resumeSession.mock.calls[0]?.[1] as {
        provider?: { apiKey?: string; baseUrl?: string };
      };
      expect(resumeCfg.provider).toEqual(
        expect.objectContaining({
          apiKey: "byok-token",
          baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{24}\/v1$/),
        }),
      );
    });

    it("SessionConfig.gitHubToken is omitted when useLoggedInUser is the resolved mode", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(makeParams({ auth: { useLoggedInUser: true } as never }), { pool });

      const cfg = sdk.createSession.mock.calls[0]?.[0];
      // Per the SDK contract, passing both useLoggedInUser and a
      // session-level gitHubToken would be contradictory. The
      // logged-in identity already determines content exclusion /
      // routing / quota, so the field must be absent (not
      // empty-string, not undefined-as-key).
      expect("gitHubToken" in cfg).toBe(false);
    });

    it("SessionConfig.gitHubToken is omitted when default mode is useLoggedInUser (no auth signal)", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      // No env tokens, no contract token, no explicit token: falls
      // through to default useLoggedInUser mode.
      const prevOpenclaw = process.env.OPENCLAW_GITHUB_TOKEN;
      const prevGithub = process.env.GITHUB_TOKEN;
      delete process.env.OPENCLAW_GITHUB_TOKEN;
      delete process.env.GITHUB_TOKEN;
      try {
        await runCopilotAttempt(makeParams({ auth: {} as never }), { pool });
        const cfg = sdk.createSession.mock.calls[0]?.[0];
        expect("gitHubToken" in cfg).toBe(false);
      } finally {
        if (prevOpenclaw !== undefined) {
          process.env.OPENCLAW_GITHUB_TOKEN = prevOpenclaw;
        }
        if (prevGithub !== undefined) {
          process.env.GITHUB_TOKEN = prevGithub;
        }
      }
    });
  });

  describe("dual-write transcript mirror", () => {
    afterEach(() => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockResolvedValue(undefined);
    });

    it("invokes dual-write mirror with runtime identity and scoped idempotencyScope", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          sessionTarget: {
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            storePath: "sessions.json",
          },
        }),
        { pool },
      );

      expect(dualWriteMock.dualWriteCopilotTranscriptBestEffort).toHaveBeenCalledTimes(1);
      const args = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls[0]?.[0] as {
        sessionId: string;
        sessionKey: string;
        storePath?: string;
        messages: Array<{ role: string }>;
        idempotencyScope?: string;
      };
      expect(args.sessionId).toBe("session-1");
      expect(args.sessionKey).toBe("agent:main:session-1");
      expect(args.storePath).toBe("sessions.json");
      expect(args.idempotencyScope).toBe("copilot:sess-1");
      expect(args.messages.length).toBeGreaterThan(0);
      const roles = args.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });

    it("does not invoke dual-write mirror when runtime identity is absent", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const params = makeParams() as unknown as Record<string, unknown>;
      delete params.sessionTarget;

      await runCopilotAttempt(params as never, { pool });

      expect(dualWriteMock.dualWriteCopilotTranscriptBestEffort).not.toHaveBeenCalled();
    });

    it("tags mirrored messages with copilot mirror identity per role and position", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(makeParams(), { pool });

      const args = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{
          role: string;
          idempotencyKey?: string;
          __openclaw?: { mirrorIdentity?: string };
        }>;
      };
      for (const [index, message] of args.messages.entries()) {
        if (
          message.role !== "user" &&
          message.role !== "assistant" &&
          message.role !== "toolResult"
        ) {
          continue;
        }
        const identity = message["__openclaw"]?.mirrorIdentity ?? "";
        // The current user and terminal assistant carry turn-stable identities.
        // Caller-passed history without an identity falls through to
        // the positional `${scope}:role:idx`.
        if (message.role === "user" && message.idempotencyKey === "run-1:user") {
          expect(identity).toBe("run-1:prompt");
        } else if (message.role === "assistant" && index === args.messages.length - 1) {
          expect(identity).toMatch(/:assistant:final$/u);
          expect(identity).toContain("run-1");
        } else {
          expect(identity).toMatch(new RegExp(`:${message.role}:${index}$`, "u"));
        }
      }
    });

    it("dual-write failure does not surface from runCopilotAttempt", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockRejectedValueOnce(
        new Error("mirror boom"),
      );
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);

      // dualWriteCopilotTranscriptBestEffort is already best-effort
      // internally; this test asserts attempt.ts also awaits it without
      // letting an unexpected rejection escape.
      await expect(runCopilotAttempt(makeParams(), { pool })).resolves.toBeDefined();
    });

    // ---------------------------------------------------------------
    // Dogfood finding #3: synthetic current-turn user message in the
    // OpenClaw audit transcript (mirrors codex event-projector pattern).
    //
    // Without this synthesis the dashboard / CLI history shows only
    // assistant bubbles — the user's typed turn is lost — because the
    // OpenClaw shell's `persistTextTurnTranscript` skips its own user
    // write when `embeddedAssistantGapFill` is true, trusting the
    // harness to mirror the user turn.
    // ---------------------------------------------------------------
    it("injects synthetic user message with runId:prompt identity when caller passes no history", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const params = makeParams({
        messages: [],
        prompt: "what's my name?",
        runId: "run-A",
      } as never);

      await runCopilotAttempt(params, { pool });

      const args = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{
          role: string;
          content: unknown;
          idempotencyKey?: string;
          __openclaw?: { mirrorIdentity?: string };
        }>;
      };
      expect(args.messages.length).toBe(2);
      expect(args.messages[0]?.role).toBe("user");
      expect(args.messages[0]?.content).toBe("what's my name?");
      expect(args.messages[0]?.idempotencyKey).toBe("run-A:user");
      expect(args.messages[0]?.["__openclaw"]?.mirrorIdentity).toBe("run-A:prompt");
      expect(args.messages[1]?.role).toBe("assistant");
      expect(args.messages[1]?.["__openclaw"]?.mirrorIdentity).toBe("run-A:assistant:final");
    });

    it("does not duplicate synthetic user when caller passed the same prompt as the messages tail", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      // Default makeParams() seeds messages with the same text as
      // prompt, so the synthetic user should be suppressed and the
      // mirrored payload should contain exactly one user entry.
      await runCopilotAttempt(makeParams(), { pool });

      const args = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; idempotencyKey?: string }>;
      };
      const userCount = args.messages.filter((m) => m.role === "user").length;
      expect(userCount).toBe(1);
      expect(args.messages.find((message) => message.role === "user")?.idempotencyKey).toBe(
        "run-1:user",
      );
    });

    it("prefers transcriptPrompt over prompt for the synthetic user body", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const params = makeParams({
        messages: [],
        prompt: "EXPANDED: please answer with your real name",
        transcriptPrompt: "what's your name?",
        runId: "run-B",
      } as never);

      await runCopilotAttempt(params, { pool });

      const args = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const user = args.messages.find((m) => m.role === "user");
      expect(user?.content).toBe("what's your name?");
    });

    it("two attempts that share the same sdkSessionId but differ by runId produce distinct user/assistant mirror identities", async () => {
      // Simulates session reuse (Fix B): the SDK keeps `sess-1` across
      // both turns, so a session-relative `${sdkSessionId}:user:0`
      // identity would collide and drop the second turn's user message.
      // The runId-stable identity scheme avoids that collision.
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("turn-1-reply"));
        },
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("turn-2-reply"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({
          messages: [],
          prompt: "turn 1",
          runId: "run-1",
        } as never),
        { pool },
      );
      await runCopilotAttempt(
        makeParams({
          messages: [],
          prompt: "turn 2",
          runId: "run-2",
          initialReplayState: { sdkSessionId: "sess-1" },
        } as never),
        { pool },
      );

      const calls = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls;
      expect(calls.length).toBe(2);
      const turn1 = calls[0]?.[0] as {
        messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
      };
      const turn2 = calls[1]?.[0] as {
        messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
      };
      const turn1User = turn1.messages.find((m) => m.role === "user");
      const turn2User = turn2.messages.find((m) => m.role === "user");
      const turn1Assistant = turn1.messages.find((m) => m.role === "assistant");
      const turn2Assistant = turn2.messages.find((m) => m.role === "assistant");
      expect(turn1User?.["__openclaw"]?.mirrorIdentity).toBe("run-1:prompt");
      expect(turn2User?.["__openclaw"]?.mirrorIdentity).toBe("run-2:prompt");
      expect(turn1Assistant?.["__openclaw"]?.mirrorIdentity).toBe("run-1:assistant:final");
      expect(turn2Assistant?.["__openclaw"]?.mirrorIdentity).toBe("run-2:assistant:final");
    });

    it("two attempts with identical prompts but different runIds remain distinct (no content-fingerprint collapse)", async () => {
      dualWriteMock.dualWriteCopilotTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("first"));
        },
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("second"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotAttempt(
        makeParams({ messages: [], prompt: "same question", runId: "run-X" } as never),
        { pool },
      );
      await runCopilotAttempt(
        makeParams({
          messages: [],
          prompt: "same question",
          runId: "run-Y",
          initialReplayState: { sdkSessionId: "sess-1" },
        } as never),
        { pool },
      );

      const calls = dualWriteMock.dualWriteCopilotTranscriptBestEffort.mock.calls;
      const id1 = (
        calls[0][0] as {
          messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
        }
      ).messages.find((m) => m.role === "user")?.["__openclaw"]?.mirrorIdentity;
      const id2 = (
        calls[1][0] as {
          messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
        }
      ).messages.find((m) => m.role === "user")?.["__openclaw"]?.mirrorIdentity;
      expect(id1).toBe("run-X:prompt");
      expect(id2).toBe("run-Y:prompt");
      expect(id1).not.toBe(id2);
    });
  });

  describe("sandbox parity (PR #86155 [P1])", () => {
    function makeSandboxStub(overrides: Partial<SandboxContext> = {}): SandboxContext {
      return {
        enabled: true,
        workspaceAccess: "ro",
        workspaceDir: "/sandbox/copy",
        agentWorkspaceDir: "/sandbox/agent",
        scopeKey: "agent-1:session-1",
        sessionKey: "session-1",
        backend: { kind: "local" } as never,
        cfg: {} as never,
        ...overrides,
      } as unknown as SandboxContext;
    }

    it("forwards sandbox=null when resolveSandboxContext returns null", async () => {
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => null);

      await runCopilotAttempt(makeParams(), {
        createToolBridge,
        pool,
        resolveSandboxContextOverride,
      });

      expect(resolveSandboxContextOverride).toHaveBeenCalledTimes(1);
      const bridgeArgs = (createToolBridge.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(bridgeArgs?.sandbox).toBeNull();
      expect(bridgeArgs?.spawnWorkspaceDir).toBeUndefined();
      expect(bridgeArgs?.workspaceDir).toBe("C:\\workspace");
    });

    it("sandbox=null: SDK session workingDirectory matches original workspace", async () => {
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => null);

      await runCopilotAttempt(makeParams(), {
        createToolBridge,
        pool,
        resolveSandboxContextOverride,
      });

      const sessionConfig = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
        workingDirectory?: unknown;
      };
      expect(sessionConfig?.workingDirectory).toBe("C:\\workspace");
    });

    it("uses task cwd for SDK workingDirectory and bridged tools when unsandboxed", async () => {
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => null);

      await runCopilotAttempt(
        makeParams({
          cwd: "C:\\workspace\\task-repo",
          workspaceDir: "C:\\workspace",
        } as never),
        {
          createToolBridge,
          pool,
          resolveSandboxContextOverride,
        },
      );

      const bridgeArgs = (createToolBridge.mock.calls[0] as unknown[] | undefined)?.[0] as {
        cwd?: unknown;
        workspaceDir?: unknown;
      };
      expect(bridgeArgs?.workspaceDir).toBe("C:\\workspace");
      expect(bridgeArgs?.cwd).toBe("C:\\workspace\\task-repo");

      const sessionConfig = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
        instructionDirectories?: unknown;
        workingDirectory?: unknown;
      };
      expect(sessionConfig?.workingDirectory).toBe("C:\\workspace\\task-repo");
      expect(sessionConfig?.instructionDirectories).toEqual(["C:\\workspace"]);
    });

    it("normalizes task cwd before wiring SDK and bridged tools", async () => {
      const stateDir = await fsp.mkdtemp(path.join(tmpdir(), "copilot-cwd-normalize-"));
      const workspaceDir = path.join(stateDir, "workspace");
      const taskDir = path.join(workspaceDir, "task-repo");
      await fsp.mkdir(taskDir, { recursive: true });
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => null);

      try {
        await runCopilotAttempt(
          makeParams({
            cwd: path.join(taskDir, "."),
            workspaceDir: path.join(workspaceDir, "."),
          } as never),
          {
            createToolBridge,
            pool,
            resolveSandboxContextOverride,
          },
        );

        const bridgeArgs = (createToolBridge.mock.calls[0] as unknown[] | undefined)?.[0] as {
          cwd?: unknown;
          workspaceDir?: unknown;
        };
        expect(bridgeArgs?.workspaceDir).toBe(workspaceDir);
        expect(bridgeArgs?.cwd).toBe(taskDir);

        const sessionConfig = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
          instructionDirectories?: unknown;
          workingDirectory?: unknown;
        };
        expect(sessionConfig?.workingDirectory).toBe(taskDir);
        expect(sessionConfig?.instructionDirectories).toEqual([workspaceDir]);
      } finally {
        await fsp.rm(stateDir, { recursive: true, force: true });
      }
    });

    it("forwards rw sandbox: bridge sees original workspace and no spawn override", async () => {
      const sandbox = makeSandboxStub({ workspaceAccess: "rw" });
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => sandbox);

      await runCopilotAttempt(makeParams(), {
        createToolBridge,
        pool,
        resolveSandboxContextOverride,
      });

      const bridgeArgs = (createToolBridge.mock.calls[0] as unknown[] | undefined)?.[0] as {
        sandbox?: unknown;
        spawnWorkspaceDir?: unknown;
        workspaceDir?: unknown;
      };
      expect(bridgeArgs?.sandbox).toBe(sandbox);
      // rw sandbox keeps the original workspace; subagent spawn inherits the same path.
      expect(bridgeArgs?.workspaceDir).toBe("C:\\workspace");
      expect(bridgeArgs?.spawnWorkspaceDir).toBeUndefined();
    });

    it("forwards rw sandbox: SDK session workingDirectory stays on the original workspace", async () => {
      const sandbox = makeSandboxStub({ workspaceAccess: "rw" });
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => sandbox);

      await runCopilotAttempt(makeParams(), {
        createToolBridge,
        pool,
        resolveSandboxContextOverride,
      });

      const sessionConfig = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
        workingDirectory?: unknown;
      };
      expect(sessionConfig?.workingDirectory).toBe("C:\\workspace");
    });

    it("forwards ro sandbox: bridge sees sandbox copy, spawn keeps original workspace", async () => {
      const sandboxDir = `${tmpdir()}/copilot-sandbox-${Date.now()}`;
      const sandbox = makeSandboxStub({ workspaceAccess: "ro", workspaceDir: sandboxDir });
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => sandbox);

      const workspaceDir = `${tmpdir()}/copilot-orig-${Date.now()}`;
      try {
        await runCopilotAttempt(makeParams({ workspaceDir } as never), {
          createToolBridge,
          pool,
          resolveSandboxContextOverride,
        });

        const bridgeArgs = (createToolBridge.mock.calls[0] as unknown[] | undefined)?.[0] as {
          sandbox?: unknown;
          spawnWorkspaceDir?: unknown;
          workspaceDir?: unknown;
        };
        expect(bridgeArgs?.sandbox).toBe(sandbox);
        expect(bridgeArgs?.workspaceDir).toBe(sandboxDir);
        // The mkdir for the sandbox copy must have run as a side effect.
        await expect(fsp.stat(sandboxDir)).resolves.toBeTruthy();
        expect(bridgeArgs?.spawnWorkspaceDir).toBe(workspaceDir);
      } finally {
        const sessionConfig = (sdk.createSession.mock.calls[0] as unknown[] | undefined)?.[0] as {
          workingDirectory?: unknown;
        };
        // SDK session must point at the sandbox copy so native tool ops (shell,
        // write, AGENTS.md loader) cannot escape into the host workspace.
        expect(sessionConfig?.workingDirectory).toBe(sandboxDir);
        await fsp.rm(sandboxDir, { recursive: true, force: true });
        await fsp.rm(workspaceDir, { recursive: true, force: true });
      }
    });

    it("applies sandbox workspace-only guards when hydrating prompt image refs", async () => {
      const stateDir = await fsp.mkdtemp(path.join(tmpdir(), "copilot-sandbox-image-policy-"));
      const sandboxDir = path.join(stateDir, "sandbox");
      const outsideDir = path.join(stateDir, "agent");
      const outsideImage = path.join(outsideDir, "secret.png");
      await fsp.mkdir(sandboxDir, { recursive: true });
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(outsideImage, Buffer.from(TINY_PNG_BASE64, "base64"));
      const fsBridge = {
        mkdirp: vi.fn(async () => undefined),
        readFile: vi.fn(async () => Buffer.from(TINY_PNG_BASE64, "base64")),
        remove: vi.fn(async () => undefined),
        rename: vi.fn(async () => undefined),
        resolvePath: vi.fn(() => ({
          containerPath: "/agent/secret.png",
          hostPath: outsideImage,
          relativePath: "../agent/secret.png",
        })),
        stat: vi.fn(async () => ({ mtimeMs: 1, size: 1, type: "file" as const })),
        writeFile: vi.fn(async () => undefined),
      };
      const sandbox = makeSandboxStub({
        fsBridge,
        workspaceAccess: "ro",
        workspaceDir: sandboxDir,
      } as never);
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => sandbox);

      try {
        await runCopilotAttempt(
          makeParams({
            config: { tools: { fs: { workspaceOnly: true } } },
            model: {
              api: "openai-responses",
              id: "gpt-4o",
              input: ["text", "image"],
              provider: "github-copilot",
            },
            prompt: "inspect /agent/secret.png",
            workspaceDir: path.join(stateDir, "workspace"),
          } as never),
          {
            createToolBridge,
            pool,
            resolveSandboxContextOverride,
          },
        );

        const sendOptions = sdk.sessions[0]?.sendAndWait.mock.calls[0]?.[0] as
          | { attachments?: unknown[] }
          | undefined;
        expect(sendOptions?.attachments).toBeUndefined();
        expect(fsBridge.resolvePath).toHaveBeenCalled();
        expect(fsBridge.readFile).not.toHaveBeenCalled();
      } finally {
        await fsp.rm(stateDir, { recursive: true, force: true });
      }
    });

    it("fails closed when sandbox is enabled with a cwd override", async () => {
      const sandbox = makeSandboxStub({ workspaceAccess: "rw" });
      const agentEnd = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
      );
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => sandbox);

      const result = await runCopilotAttempt(
        makeParams({
          cwd: "C:\\workspace\\task-repo",
          workspaceDir: "C:\\workspace",
        } as never),
        {
          createToolBridge,
          pool,
          resolveSandboxContextOverride,
        },
      );

      expect(getPromptErrorCode(result)).toBe("sandbox_cwd_override_unsupported");
      expect(createToolBridge).not.toHaveBeenCalled();
      expect(sdk.createSession).not.toHaveBeenCalled();
      expect(agentEnd).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
        expect.objectContaining({ sessionId: "session-1" }),
      );
    });

    it("fails closed when sandbox resolution fails", async () => {
      const agentEnd = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
      );
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const resolveSandboxContextOverride = vi.fn(async () => {
        throw new Error("sandbox provisioning boom");
      });

      const result = await runCopilotAttempt(makeParams(), {
        createToolBridge,
        pool,
        resolveSandboxContextOverride,
      });

      expect(getPromptErrorCode(result)).toBe("sandbox_resolution_failure");
      expect((result.promptError as Error | undefined)?.message).toContain(
        "sandbox provisioning boom",
      );
      expect(createToolBridge).not.toHaveBeenCalled();
      expect(sdk.createSession).not.toHaveBeenCalled();
      expect(agentEnd).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
        expect.objectContaining({ sessionId: "session-1" }),
      );
    });

    it("fails closed when creating the sandbox copy workspace fails", async () => {
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));
      const blockingFile = path.join(tmpdir(), `copilot-sandbox-block-${Date.now()}`);
      await fsp.writeFile(blockingFile, "not a directory");
      const sandbox = makeSandboxStub({
        workspaceAccess: "ro",
        workspaceDir: path.join(blockingFile, "copy"),
      });

      try {
        const result = await runCopilotAttempt(makeParams(), {
          createToolBridge,
          pool,
          resolveSandboxContextOverride: async () => sandbox,
        });

        expect(getPromptErrorCode(result)).toBe("sandbox_resolution_failure");
        expect((result.promptError as Error | undefined)?.message).toContain("ENOTDIR");
        expect(createToolBridge).not.toHaveBeenCalled();
        expect(sdk.createSession).not.toHaveBeenCalled();
      } finally {
        await fsp.rm(blockingFile, { force: true });
      }
    });
  });

  // ClawSweeper PR #86155 [P1] round-8: the SDK SessionConfig accepts
  // `availableTools` as a hard catalog allowlist
  // (`@github/copilot-sdk/dist/types.d.ts:1059-1066`). Without it, the
  // CLI keeps its native read/write/shell/url/mcp/memory/hook tools
  // visible to the model alongside our bridged overrides, which would
  // bypass OpenClaw's wrapped-tool enforcement under any permissive
  // permission policy and pollute the catalog under the default reject
  // policy. `createSessionConfig` derives `availableTools` from the
  // post-filter `sdkTools` so create- and resume-session always carry
  // exactly the names of the tools the bridge actually exposed plus the
  // built-in `ask_user` tool owned by the registered user-input handler.
  describe("availableTools surface restriction (PR #86155 [P1] round-8)", () => {
    function makeFakeSdkTool(name: string): SdkTool {
      return {
        description: `Fake tool ${name}`,
        handler: async () => ({ resultType: "success", textResultForLlm: "ok" }),
        name,
        parameters: { type: "object" },
      };
    }

    function readAvailableTools(call: unknown): readonly string[] | undefined {
      const cfg = (call as unknown[] | undefined)?.[0] as { availableTools?: string[] };
      return cfg?.availableTools;
    }

    it("forwards exactly the bridged tool names when the bridge returns a narrow tool set", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);
      const sdkTools = [makeFakeSdkTool("read"), makeFakeSdkTool("edit")];
      const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

      await runCopilotAttempt(makeParams(), { createToolBridge, pool });

      expect(readAvailableTools(sdk.createSession.mock.calls[0])).toEqual([
        "read",
        "edit",
        "builtin:ask_user",
      ]);
    });

    it("keeps a host-scoped Crestodian create-session surface ring-zero", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);
      const sdkTools = [makeFakeSdkTool("crestodian")];
      const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

      await runCopilotAttempt(makeParams({ toolsAllow: ["crestodian"] }), {
        createToolBridge,
        isHostScopedToolActive: (toolName) => toolName === "crestodian",
        pool,
      });

      expect(readAvailableTools(sdk.createSession.mock.calls[0])).toEqual(["crestodian"]);
    });

    it("forwards `[]` to the SDK when the bridge returns no tools (disable / raw / fully filtered)", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);
      // The bridge already collapses `disableTools: true`, raw model runs
      // (`modelRun: true` or `promptMode: "none"`), an empty
      // `toolsAllow: []`, and an unsupported provider to `sdkTools: []`.
      // Whatever the upstream reason, `availableTools` must be the same
      // ask_user-only list so the SDK cannot fall back to its native
      // catalog while the registered user-input handler remains usable.
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

      await runCopilotAttempt(makeParams(), { createToolBridge, pool });

      expect(readAvailableTools(sdk.createSession.mock.calls[0])).toEqual(["builtin:ask_user"]);
    });

    it("forwards the full bridged set when the run is unrestricted (no toolsAllow)", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);
      const sdkTools = [
        makeFakeSdkTool("read"),
        makeFakeSdkTool("write"),
        makeFakeSdkTool("edit"),
        makeFakeSdkTool("exec"),
        makeFakeSdkTool("message"),
      ];
      const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

      await runCopilotAttempt(makeParams(), { createToolBridge, pool });

      // The bridge is the source of truth, not the raw `toolsAllow`
      // input: wildcard `["*"]` and unrestricted both flow through as
      // "all bridged tool names" so the SDK sees a concrete catalog.
      expect(readAvailableTools(sdk.createSession.mock.calls[0])).toEqual([
        "read",
        "write",
        "edit",
        "exec",
        "message",
        "builtin:ask_user",
      ]);
    });

    it("forwards the same `availableTools` on the resumeSession path", async () => {
      // `ResumeSessionConfig` picks `availableTools` per
      // `@github/copilot-sdk/dist/types.d.ts:1198`, so the spread into
      // `client.resumeSession(id, { ...sessionConfig })` must carry the
      // same surface restriction; otherwise resumed sessions would
      // silently restore the native catalog after every reconnect.
      const sdk = makeFakeSdk({
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
        },
      });
      const pool = makeFakePool(sdk);
      const sdkTools = [makeFakeSdkTool("read")];
      const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

      await runCopilotAttempt(
        makeParams({ initialReplayState: { sdkSessionId: "sess-resume-1" } } as never),
        { createToolBridge, pool },
      );

      const resumeCall = sdk.resumeSession.mock.calls[0] as unknown[] | undefined;
      const resumeCfg = resumeCall?.[1] as { availableTools?: string[] };
      expect(resumeCfg?.availableTools).toEqual(["read", "builtin:ask_user"]);
    });

    it("keeps a host-scoped Crestodian resume-session surface ring-zero", async () => {
      const sdk = makeFakeSdk({
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
        },
      });
      const pool = makeFakePool(sdk);
      const sdkTools = [makeFakeSdkTool("crestodian")];
      const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

      await runCopilotAttempt(
        makeParams({
          initialReplayState: { sdkSessionId: "sess-crestodian" },
          toolsAllow: ["crestodian"],
        } as never),
        {
          createToolBridge,
          isHostScopedToolActive: (toolName) => toolName === "crestodian",
          pool,
        },
      );

      const resumeCall = sdk.resumeSession.mock.calls[0] as unknown[] | undefined;
      const resumeCfg = resumeCall?.[1] as { availableTools?: string[] };
      expect(resumeCfg?.availableTools).toEqual(["crestodian"]);
    });

    it("forwards `[]` to resumeSession when the bridge returns no tools", async () => {
      const sdk = makeFakeSdk({
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
        },
      });
      const pool = makeFakePool(sdk);
      const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

      await runCopilotAttempt(
        makeParams({ initialReplayState: { sdkSessionId: "sess-resume-2" } } as never),
        { createToolBridge, pool },
      );

      const resumeCall = sdk.resumeSession.mock.calls[0] as unknown[] | undefined;
      const resumeCfg = resumeCall?.[1] as { availableTools?: string[] };
      expect(resumeCfg?.availableTools).toEqual(["builtin:ask_user"]);
    });
  });

  describe("bootstrap path remap wiring (PR #86155 [P2] round-9)", () => {
    // attempt.ts must forward the sandbox-resolved
    // `effectiveWorkspaceDir` to `resolveCopilotWorkspaceBootstrapContext`
    // so the helper can remap context-file paths from the host
    // workspace to the sandbox copy when sandbox `ro`/`none`
    // redirects the workingDirectory. The helper's own remap logic
    // and the rendered-systemMessage assertion live in
    // workspace-bootstrap.test.ts; this block locks in the integration
    // contract so future refactors cannot silently drop the parameter.
    beforeEach(() => {
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockReset();
      workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mockResolvedValue({
        bootstrapFiles: [],
        contextFiles: [],
        instructions: undefined,
      });
    });

    it("forwards effectiveWorkspaceDir matching params.workspaceDir for non-sandboxed runs", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      const params = makeParams();
      await runCopilotAttempt(params, { pool });

      const call = workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mock.calls[0];
      const arg = (call as unknown[] | undefined)?.[0] as {
        attempt: { workspaceDir?: string };
        effectiveWorkspaceDir?: string;
      };
      // No sandbox configured -> bootstrap sees the same workspace
      // the attempt was given. Remap is a no-op (helper fast path).
      expect(arg.effectiveWorkspaceDir).toBe(arg.attempt.workspaceDir);
    });

    it("forwards the sandbox copy directory as effectiveWorkspaceDir for readonly sandbox runs", async () => {
      const sdk = makeFakeSdk();
      const pool = makeFakePool(sdk);

      const params = makeParams();
      const hostWorkspace = (params as { workspaceDir?: string }).workspaceDir;
      const sandboxWorkspace = await fsp.mkdtemp(path.join(tmpdir(), "copilot-sbx-ro-"));
      try {
        await runCopilotAttempt(params, {
          pool,
          // Bypass the real plugin-bridge wiring; with a sandbox in play
          // attempt.ts would otherwise call the real createToolBridge which
          // requires plugin SDK fixtures we do not stand up here.
          createToolBridge: vi.fn(async () => ({ sdkTools: [], sourceTools: [] })),
          // Drive the sandbox resolution branch deterministically so the
          // test asserts the exact wiring rather than the orchestrator's
          // real sandbox discovery path. Include every SandboxContext
          // field attempt.ts touches (enabled, workspaceAccess,
          // workspaceDir) plus the structural fields the bridge wiring
          // expects.
          resolveSandboxContextOverride: async () =>
            ({
              enabled: true,
              workspaceAccess: "ro",
              workspaceDir: sandboxWorkspace,
              agentWorkspaceDir: sandboxWorkspace,
              scopeKey: "agent-1:session-1",
              sessionKey: "session-1",
              backend: { kind: "local" } as never,
              cfg: {} as never,
            }) as unknown as SandboxContext,
        });

        const call = workspaceBootstrapMock.resolveCopilotWorkspaceBootstrapContext.mock.calls[0];
        const arg = (call as unknown[] | undefined)?.[0] as {
          attempt: { workspaceDir?: string };
          effectiveWorkspaceDir?: string;
        };
        // Positive: bootstrap receives the sandbox path so the helper
        // remaps rendered paths into the sandbox copy.
        expect(arg.effectiveWorkspaceDir).toBe(sandboxWorkspace);
        // Negative: the host workspace must not appear as the effective
        // directory, otherwise the helper's fast path would suppress the
        // remap and the model would see host paths.
        expect(arg.effectiveWorkspaceDir).not.toBe(hostWorkspace);
      } finally {
        await fsp.rm(sandboxWorkspace, { force: true, recursive: true });
      }
    });
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
