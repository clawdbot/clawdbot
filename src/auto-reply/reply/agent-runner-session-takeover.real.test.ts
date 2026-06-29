// Real-setup regression proof for the session-takeover silent-message-loss fix (#87180).
//
// What is REAL here (no hand-built takeover error, no mocked runner internals):
//   - A real temp session transcript file on disk.
//   - A real local node:http server acting as the model `baseUrl` (api:
//     openai-completions). On the first request it announces it is in-flight,
//     then BLOCKS before finishing the body.
//   - The real OpenAI-completions transport stream fn driving real HTTP I/O.
//   - The real embedded prompt-lock controller + fence
//     (createEmbeddedAttemptSessionLockController) wired through the real
//     installEmbeddedPromptRetryDefault / installPromptSubmissionLockRelease
//     helpers, exactly as src/agents/embedded-agent-runner/run/attempt.ts wires
//     them in production.
//   - The real failover classification (isEmbeddedAttemptSessionTakeoverError /
//     isNonProviderRuntimeCoordinationError) and the real
//     runAgentTurnWithFallback catch branch that produces the user-facing text.
//
// While the model call holds the released prompt lock, a concurrent "second
// user" steering write rewrites the same session file, changing its
// fingerprint. On reacquireAfterPrompt the fence mismatches and throws
// EmbeddedAttemptSessionTakeoverError ORGANICALLY — not constructed by hand.
//
// What is scaffolded (unavoidable reply-pipeline boundary, mirrors the existing
// agent-runner-execution.test.ts mock surface): the surrounding reply helpers
// and a thin runWithModelFallback that runs the candidate closure once and
// re-throws non-provider coordination errors, exactly like the real
// runWithModelFallback does at src/agents/model-fallback.ts (see
// isNonProviderRuntimeCoordinationError re-throw).
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedAttemptSessionLockController,
  installEmbeddedPromptRetryDefault,
  installPromptSubmissionLockRelease,
} from "../../agents/embedded-agent-runner/run/attempt.session-lock.js";
import { isNonProviderRuntimeCoordinationError } from "../../agents/failover-error.js";
import { createOpenAICompletionsTransportStreamFn } from "../../agents/openai-transport-stream.js";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { TypingSignaler } from "./typing-mode.js";

const state = vi.hoisted(() => ({
  // runEmbeddedAgent stand-in that drives the REAL prompt-lock release window
  // around a REAL model HTTP call. Set per-test.
  runEmbeddedAgentMock: vi.fn(),
  // The candidate runner. We re-implement only the non-provider coordination
  // re-throw contract from the real runWithModelFallback so the organic
  // takeover error reaches the real runAgentTurnWithFallback catch.
  runWithModelFallbackMock: vi.fn(),
}));

// Reply-pipeline boundary scaffolding (mirrors agent-runner-execution.test.ts).
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: (params: unknown) => state.runEmbeddedAgentMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: () => {
    throw new Error("runCliAgent not used");
  },
}));

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: unknown) => state.runWithModelFallbackMock(params),
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: () => false,
  };
});

vi.mock("../../agents/bootstrap-budget.js", () => ({
  resolveBootstrapWarningSignaturesSeen: () => [],
}));

vi.mock("../../agents/embedded-agent-helpers.js", () => ({
  BILLING_ERROR_USER_MESSAGE: "billing",
  formatRateLimitOrOverloadedErrorCopy: () => undefined,
  isCompactionFailureError: () => false,
  isContextOverflowError: () => false,
  isBillingErrorMessage: () => false,
  isLikelyContextOverflowError: () => false,
  isOverloadedErrorMessage: () => false,
  isRateLimitErrorMessage: () => false,
  isTransientHttpError: () => false,
  isConnectionError: () => false,
  isTimeoutErrorMessage: () => false,
  sanitizeUserFacingText: (text?: string) => text ?? "",
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn(() => null),
  resolveSessionTranscriptPath: vi.fn(),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: vi.fn(),
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
  },
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: () => true,
  resolveMessageChannel: () => "whatsapp",
  isInternalMessageChannel: () => false,
}));

vi.mock("../heartbeat.js", () => ({
  stripHeartbeatToken: (text: string) => ({
    text,
    didStrip: false,
    shouldSkip: false,
  }),
}));

vi.mock("./agent-runner-utils.js", () => ({
  buildEmbeddedRunExecutionParams: (params: { provider: string; model: string }) => ({
    embeddedContext: {},
    senderContext: {},
    runBaseParams: {
      provider: params.provider,
      model: params.model,
    },
  }),
  resolveQueuedReplyRuntimeConfig: <T>(config: T) => config,
  resolveModelFallbackOptions: (run: {
    provider?: string;
    model?: string;
    config?: unknown;
    agentDir?: string;
  }) => ({
    provider: run.provider,
    model: run.model,
    cfg: run.config,
    agentDir: run.agentDir,
  }),
  resolveRunFastModeForFallbackCandidate: (params: {
    run: { fastMode?: unknown; fastModeAutoOnSeconds?: unknown };
  }) => ({
    fastMode: params.run.fastMode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSeconds,
  }),
}));

vi.mock("./reply-delivery.js", () => ({
  createBlockReplyDeliveryHandler: () => undefined,
}));

vi.mock("./reply-media-paths.runtime.js", () => ({
  createReplyMediaContext: () => ({
    normalizePayload: (payload: unknown) => payload,
  }),
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

async function getRunAgentTurnWithFallback() {
  return (await import("./agent-runner-execution.js")).runAgentTurnWithFallback;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createMockTypingSignaler(): TypingSignaler {
  return {
    mode: "message",
    shouldStartImmediately: false,
    shouldStartOnMessageStart: true,
    shouldStartOnText: true,
    shouldStartOnReasoning: false,
    signalRunStart: vi.fn(async () => {}),
    signalMessageStart: vi.fn(async () => {}),
    signalTextDelta: vi.fn(async () => {}),
    signalReasoningDelta: vi.fn(async () => {}),
    signalToolStart: vi.fn(async () => {}),
  };
}

function createFollowupRun(sessionFile: string): FollowupRun {
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      sessionFile,
      workspaceDir: "/tmp",
      config: {},
      skillsSnapshot: {},
      provider: "mlx",
      model: "probe-model",
      thinkLevel: "low",
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  } as unknown as FollowupRun;
}

function createMockReplyOperation(): {
  replyOperation: ReplyOperation;
  failMock: ReturnType<typeof vi.fn>;
} {
  const failMock = vi.fn();
  return {
    failMock,
    replyOperation: {
      key: "main",
      sessionId: "session",
      abortSignal: new AbortController().signal,
      resetTriggered: false,
      phase: "running",
      result: null,
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
      attachBackend: vi.fn(),
      detachBackend: vi.fn(),
      retainFailureUntilComplete: vi.fn(),
      complete: vi.fn(),
      completeThen: vi.fn((afterClear: () => void) => afterClear()),
      completeWithAfterClearBarrier: vi.fn(),
      fail: failMock,
      abortByUser: vi.fn(),
      abortForRestart: vi.fn(),
    },
  };
}

function createMinimalRunAgentTurnParams(followupRun: FollowupRun) {
  return {
    commandBody: "fix it",
    followupRun,
    sessionCtx: {
      Provider: "whatsapp",
      MessageSid: "msg",
    } as unknown as TemplateContext,
    opts: {} satisfies GetReplyOptions,
    typingSignals: createMockTypingSignaler(),
    blockReplyPipeline: null,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end" as const,
    applyReplyToMode: (payload: ReplyPayload) => payload,
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

const RESEND_GUIDANCE =
  "⚠️ Your message was interrupted because new input arrived while the previous turn was still in progress. Please resend your message.";

describe("runAgentTurnWithFallback — real session takeover (#87180)", () => {
  let server: Server | undefined;
  let tmpDir: string | undefined;

  beforeEach(() => {
    state.runEmbeddedAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    vi.clearAllMocks();
  });

  it("surfaces resend guidance after an organic EmbeddedAttemptSessionTakeoverError", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "takeover-real-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, `{"type":"session","id":"s1"}\n`, "utf8");

    const firstRequestReceived = deferred<void>();
    const releaseServer = deferred<void>();

    // Real local model server: announce in-flight, then block before finishing.
    server = createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", () => {});
      req.on("end", () => {
        firstRequestReceived.resolve();
        void releaseServer.promise.then(() => {
          const created = Math.floor(Date.now() / 1000);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-real",
              object: "chat.completion.chunk",
              created,
              model: "probe-model",
              choices: [
                { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
              ],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-real",
              object: "chat.completion.chunk",
              created,
              model: "probe-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });
    });
    await new Promise<void>((resolve) => {
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing server address");
    }

    // The candidate closure drives the REAL embedded prompt-lock release window
    // around a REAL model HTTP call, then performs the concurrent steering write
    // and lets the call finish — producing the organic takeover error on
    // reacquire. This stands in for runEmbeddedAgent's lock orchestration while
    // exercising the same real lock/fence helpers it uses.
    const driveEmbeddedRunWithRealLock = async (): Promise<never> => {
      const controller = await createEmbeddedAttemptSessionLockController({
        acquireSessionWriteLock,
        lockOptions: {
          sessionFile,
          timeoutMs: 5_000,
          staleMs: 30_000,
          maxHoldMs: 30_000,
        },
      });

      const transport = createOpenAICompletionsTransportStreamFn();
      const baseModel = {
        id: "probe-model",
        name: "Probe",
        api: "openai-completions",
        provider: "mlx",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 256,
        requestTimeoutMs: 900_000,
      };

      // streamFn drains the real transport stream so the released prompt-lock
      // window stays open across the real HTTP round-trip.
      const agent = {
        streamFn: async (...args: unknown[]) => {
          const stream = transport(args[0] as never, args[1] as never, args[2] as never);
          for await (const event of stream as AsyncIterable<unknown>) {
            void event; // drain real HTTP events
          }
          return stream;
        },
      };
      const session = { agent };

      installEmbeddedPromptRetryDefault(session);
      installPromptSubmissionLockRelease({
        session,
        waitForSessionEvents: () => controller.waitForSessionEvents(session),
        releaseForPrompt: () => controller.releaseForPrompt(),
        reacquireAfterPrompt: () => controller.reacquireAfterPrompt(),
        sessionFile,
        sessionKey: "main",
        withSessionWriteLock: (run, options) => controller.withSessionWriteLock(run, options),
      });

      const callPromise = (session.agent.streamFn as (...a: unknown[]) => Promise<unknown>)(
        baseModel,
        {
          systemPrompt: "system",
          messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
          tools: [],
        },
        { apiKey: "test-key" },
      );

      await firstRequestReceived.promise;
      // Concurrent "second user" steering write to the SAME session file.
      await fs.writeFile(
        sessionFile,
        `{"type":"session","id":"s1"}\n{"id":"steer","parentId":"s1","message":{"role":"user","content":"steering"}}\n`,
        "utf8",
      );
      releaseServer.resolve();
      try {
        await callPromise;
      } finally {
        await controller.dispose();
      }
      throw new Error("expected the wrapped prompt call to throw a takeover error");
    };

    // Thin stand-in for runWithModelFallback: invoke the REAL runner-provided
    // candidate closure (which calls runEmbeddedAgent through the real IIFE
    // catch/rethrow), then propagate exactly as the real fallback would. The
    // real fallback re-throws non-provider coordination errors unchanged (see
    // model-fallback.ts isNonProviderRuntimeCoordinationError re-throw); we
    // assert that contract holds for the organic error here, then let it
    // propagate to the real runAgentTurnWithFallback catch + classification.
    state.runEmbeddedAgentMock.mockImplementation(() => driveEmbeddedRunWithRealLock());
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        try {
          const result = await params.run("mlx", "probe-model");
          return { result, provider: "mlx", model: "probe-model", attempts: [] };
        } catch (err) {
          expect(isNonProviderRuntimeCoordinationError(err)).toBe(true);
          throw err;
        }
      },
    );

    const followupRun = createFollowupRun(sessionFile);
    const { replyOperation, failMock } = createMockReplyOperation();

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(followupRun),
      replyOperation,
    });

    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).toBe(RESEND_GUIDANCE);
    expect(result.payload.text).toContain("Please resend your message");
    const failCall = failMock.mock.calls[0];
    expect(failCall?.[0]).toBe("run_failed");
  }, 60_000);
});
