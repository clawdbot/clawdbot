// Exact-head real-behavior proof for the session-takeover silent-message-loss
// fix (#87180, PR #89039). Two scenarios in one runnable proof, both driven
// through the REAL orchestrator (runAgentTurnWithFallback), the REAL embedded
// prompt-lock controller + fence, the REAL openai-completions transport over
// real HTTP, and the REAL connection/transient classification + failover error
// routing. The only injected variables are at real boundaries: a dropped TCP
// socket (Scenario A) and a concurrent unowned transcript rewrite (Scenario B).
//
// What is REAL here (no hand-built errors, no mocked runner internals):
//   - A real temp session transcript file on disk.
//   - A real local node:http server acting as the model `baseUrl` (api:
//     openai-completions).
//   - The real openai-completions transport stream fn driving real HTTP I/O.
//   - The real embedded prompt-lock controller + fence
//     (createEmbeddedAttemptSessionLockController) wired through the real
//     installEmbeddedPromptRetryDefault (pins SDK maxRetries to 0) /
//     installPromptSubmissionLockRelease, exactly as
//     src/agents/embedded-agent-runner/run/attempt.ts wires them in production.
//   - The real connection/transient classification (isConnectionError /
//     isTransientHttpError / isTimeoutErrorMessage from
//     embedded-agent-helpers/errors.ts) and the real failover classification
//     (isNonProviderRuntimeCoordinationError), consumed by the real
//     runAgentTurnWithFallback retry gate and takeover catch.
//
// Scenario A (pure transient transport fault): the model server RESETS the
// socket on the first request, then succeeds on the retry. Because SDK retries
// are pinned to 0 inside the released-lock window, the SDK does NOT re-issue
// in-window; instead the orchestrator retries the whole cycle exactly once
// (consumeTransientHttpRetry). Proves: bounded request count (== 2), a visible
// assistant reply (not silent loss), and the transient-connection diagnostic.
//
// Scenario B (organic takeover -> resend guidance): while the real model call
// holds the released prompt lock, a concurrent unowned transcript rewrite
// changes the session-file fingerprint so reacquireAfterPrompt throws
// EmbeddedAttemptSessionTakeoverError ORGANICALLY. Proves: request count == 1
// (no silent in-window SDK retry), the exact resend-guidance literal, a
// run_failed record, and that the takeover is a non-provider coordination error
// (so the fallback chain aborts rather than burning model candidates).
//
// What is scaffolded (unavoidable reply-pipeline boundary, mirrors the existing
// agent-runner-execution.test.ts / agent-runner-session-takeover.real.test.ts
// mock surface): the surrounding reply helpers and a thin runWithModelFallback
// stand-in that runs the real candidate closure once and propagates exactly as
// the real runWithModelFallback does (re-throw on failure, return on success).
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedAttemptSessionLockController,
  installEmbeddedPromptRetryDefault,
  installPromptSubmissionLockRelease,
} from "../../agents/embedded-agent-runner/run/attempt.session-lock.js";
import { isNonProviderRuntimeCoordinationError } from "../../agents/failover-error.js";
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
  // The candidate runner. We re-implement only the propagation contract from the
  // real runWithModelFallback so the organic failures reach the real
  // runAgentTurnWithFallback gate/catch. Set per-test.
  runWithModelFallbackMock: vi.fn(),
  // Spy on the runtime error log so we can assert the transient-retry diagnostic.
  runtimeErrorMock: vi.fn(),
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

// Real connection/transient classification (isConnectionError,
// isTransientHttpError, isTimeoutErrorMessage) so Scenario A exercises the real
// orchestrator retry gate; the remaining helper stubs mirror the reference test.
vi.mock("../../agents/embedded-agent-helpers.js", async () => {
  const errors = await vi.importActual<
    typeof import("../../agents/embedded-agent-helpers/errors.js")
  >("../../agents/embedded-agent-helpers/errors.js");
  return {
    BILLING_ERROR_USER_MESSAGE: "billing",
    formatRateLimitOrOverloadedErrorCopy: () => undefined,
    isCompactionFailureError: () => false,
    isContextOverflowError: () => false,
    isBillingErrorMessage: () => false,
    isLikelyContextOverflowError: () => false,
    isOverloadedErrorMessage: () => false,
    isRateLimitErrorMessage: () => false,
    isConnectionError: errors.isConnectionError,
    isTransientHttpError: errors.isTransientHttpError,
    isTimeoutErrorMessage: errors.isTimeoutErrorMessage,
    sanitizeUserFacingText: (text?: string) => text ?? "",
  };
});

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
    error: (...args: unknown[]) => state.runtimeErrorMock(...args),
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
      hasOwnedSessionId: vi.fn((sessionId: string) => sessionId === "session"),
      abortSignal: new AbortController().signal,
      resetTriggered: false,
      acceptedSteeredInboundAudio: false,
      startedAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      phase: "running",
      result: null,
      recordActivity: vi.fn(),
      setPhase: vi.fn(),
      updateSessionId: vi.fn(),
      updateSessionKey: vi.fn<ReplyOperation["updateSessionKey"]>(),
      attachBackend: vi.fn(),
      detachBackend: vi.fn(),
      retainFailureUntilComplete: vi.fn(),
      complete: vi.fn(),
      completeThen: vi.fn((afterClear: () => void) => afterClear()),
      completeWithAfterClearBarrier: vi.fn(),
      fail: failMock,
      abortByUser: vi.fn(),
      abortForRestart: vi.fn(),
      freezeAbort: vi.fn(),
      terminalRecovery: false,
      markTerminalRecovery: vi.fn(),
      markAcceptedSteeredInboundAudio: vi.fn(),
      markWaitingForDeferredMaintenance: vi.fn(),
      markDeferredMaintenanceWaitEnded: vi.fn(),
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

// Portable base model pointed at the local model server.
function createBaseModel(port: number) {
  return {
    id: "probe-model",
    name: "Probe",
    api: "openai-completions",
    provider: "mlx",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 256,
    requestTimeoutMs: 900_000,
  };
}

const REQUEST_CONTEXT = {
  systemPrompt: "system",
  messages: [{ role: "user", content: "hi", timestamp: 0 }],
  tools: [],
};

// Wire the REAL prompt-lock controller + fence around a custom streamFn exactly
// as production does (retry-default first, then lock-release), then invoke it.
// The custom streamFn drains the real transport so the released prompt-lock
// window stays open across the real HTTP round-trip. Returns after the wrapped
// call resolves (or throws) and disposes the controller.
async function withRealLockWindow(params: {
  sessionFile: string;
  port: number;
  onFirstRequestInFlight?: () => Promise<void>;
  drain: (event: { type: string; delta?: string; error?: { errorMessage?: string } }) => void;
}): Promise<void> {
  const controller = await createEmbeddedAttemptSessionLockController({
    acquireSessionWriteLock,
    lockOptions: {
      sessionFile: params.sessionFile,
      timeoutMs: 5_000,
      staleMs: 30_000,
      maxHoldMs: 30_000,
    },
  });

  const transport = createOpenAICompletionsTransportStreamFn();
  const baseModel = createBaseModel(params.port);

  const agent = {
    streamFn: async (...args: unknown[]) => {
      const stream = transport(args[0] as never, args[1] as never, args[2] as never);
      for await (const event of stream as AsyncIterable<{
        type: string;
        delta?: string;
        error?: { errorMessage?: string };
      }>) {
        params.drain(event);
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
    sessionFile: params.sessionFile,
    sessionKey: "main",
    withSessionWriteLock: (run, options) => controller.withSessionWriteLock(run, options),
  });

  const callPromise = (session.agent.streamFn as (...a: unknown[]) => Promise<unknown>)(
    baseModel,
    { ...REQUEST_CONTEXT, messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
    { apiKey: "test-key" },
  );

  try {
    if (params.onFirstRequestInFlight) {
      await params.onFirstRequestInFlight();
    }
    await callPromise;
  } finally {
    await controller.dispose();
  }
}

function streamCompletionResponse(res: import("node:http").ServerResponse): void {
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-real",
      object: "chat.completion.chunk",
      created,
      model: "probe-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
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
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing server address");
  }
  return address.port;
}

describe("runAgentTurnWithFallback — live takeover + transient-retry proof (#87180)", () => {
  let server: Server | undefined;
  let tmpDir: string | undefined;

  beforeEach(() => {
    state.runEmbeddedAgentMock.mockReset();
    state.runWithModelFallbackMock.mockReset();
    state.runtimeErrorMock.mockReset();
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

  // Scenario A — pure transient transport fault: socket reset on request #1,
  // clean completion on request #2. SDK retries pinned to 0, orchestrator
  // retries once, message is delivered. Bounded request count == 2.
  it("Scenario A: recovers from a transient connection reset with a bounded orchestrator retry", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "takeover-live-a-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, `{"type":"session","id":"s1"}\n`, "utf8");

    let requestCount = 0;
    server = createServer((req, res) => {
      req.setEncoding("utf8");
      // Swallow the reset noise from the intentional socket destroy so a stray
      // 'error' emission cannot surface as an unhandled failure.
      req.on("error", () => {});
      res.on("error", () => {});
      req.on("data", () => {});
      req.on("end", () => {
        requestCount += 1;
        if (requestCount === 1) {
          // Real transport fault: drop the socket before responding so the
          // client sees a bare connection error (ECONNRESET / socket hang up).
          res.socket?.destroy();
          return;
        }
        streamCompletionResponse(res);
      });
    });
    const port = await listen(server);

    // Drive the REAL lock window around the REAL transport call. On a transport
    // error event, surface it as a thrown error exactly as the embedded runner
    // does; on success, collect the streamed assistant text.
    const driveTransientRun = async () => {
      let collectedText = "";
      await withRealLockWindow({
        sessionFile,
        port,
        drain: (event) => {
          if (event.type === "text_delta") {
            collectedText += event.delta ?? "";
          }
          if (event.type === "error") {
            throw new Error(event.error?.errorMessage ?? "Connection error.");
          }
        },
      });
      return { payloads: [{ text: collectedText }], meta: { durationMs: 1 } };
    };

    state.runEmbeddedAgentMock.mockImplementation(() => driveTransientRun());
    // Thin runWithModelFallback stand-in: run the real candidate closure once,
    // return its result on success, propagate its error on failure — exactly the
    // single-candidate propagation contract of the real runWithModelFallback.
    state.runWithModelFallbackMock.mockImplementation(
      async (params: { run: (provider: string, model: string) => Promise<unknown> }) => {
        const result = await params.run("mlx", "probe-model");
        return { result, provider: "mlx", model: "probe-model", attempts: [] };
      },
    );

    const followupRun = createFollowupRun(sessionFile);
    const { replyOperation, failMock } = createMockReplyOperation();

    const runAgentTurnWithFallback = await getRunAgentTurnWithFallback();
    const result = await runAgentTurnWithFallback({
      ...createMinimalRunAgentTurnParams(followupRun),
      replyOperation,
    });

    // (1) Bounded request count: one failed + exactly one orchestrator retry.
    expect(requestCount).toBe(2);
    // (2) The turn succeeded with a VISIBLE assistant reply (not silent loss).
    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("expected success result");
    }
    const visibleTexts = (result.runResult?.payloads ?? [])
      .map((p) => p.text)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    expect(visibleTexts).toContain("OK");
    // (3) The transient-connection retry diagnostic was emitted exactly once.
    const transientLogs = state.runtimeErrorMock.mock.calls
      .map((call) => String(call[0]))
      .filter(
        (line) =>
          line.includes("Transient connection error before reply") &&
          line.includes("Retrying once in 2500ms"),
      );
    expect(transientLogs).toHaveLength(1);
    // No takeover / run failure on the recovery path.
    expect(failMock).not.toHaveBeenCalled();
  }, 60_000);

  // Scenario B — organic takeover: a concurrent unowned transcript rewrite
  // invalidates the fence so reacquireAfterPrompt throws
  // EmbeddedAttemptSessionTakeoverError. Single request, no silent SDK retry,
  // and the user gets explicit resend guidance instead of a lost message.
  it("Scenario B: surfaces resend guidance on an organic session takeover", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "takeover-live-b-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, `{"type":"session","id":"s1"}\n`, "utf8");

    const firstRequestReceived = deferred<void>();
    const releaseServer = deferred<void>();

    let requestCount = 0;
    // Real local model server: announce in-flight, then block before finishing.
    server = createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", () => {});
      req.on("end", () => {
        requestCount += 1;
        firstRequestReceived.resolve();
        void releaseServer.promise.then(() => {
          streamCompletionResponse(res);
        });
      });
    });
    const port = await listen(server);

    // Drive the REAL lock window; while the model call holds the released lock,
    // a concurrent "second user" rewrites the SAME session file out of band,
    // changing its fingerprint. reacquireAfterPrompt then throws the takeover
    // error ORGANICALLY inside withRealLockWindow's finally.
    const driveTakeoverRun = async (): Promise<never> => {
      await withRealLockWindow({
        sessionFile,
        port,
        onFirstRequestInFlight: async () => {
          await firstRequestReceived.promise;
          await fs.writeFile(
            sessionFile,
            `{"type":"session","id":"s1"}\n{"id":"steer","parentId":"s1","message":{"role":"user","content":"steering"}}\n`,
            "utf8",
          );
          releaseServer.resolve();
        },
        drain: () => {},
      });
      throw new Error("expected the wrapped prompt call to throw a takeover error");
    };

    state.runEmbeddedAgentMock.mockImplementation(() => driveTakeoverRun());
    // The real runWithModelFallback re-throws non-provider coordination errors
    // unchanged (model-fallback.ts isNonProviderRuntimeCoordinationError
    // re-throw); assert that contract holds for the organic takeover, then let
    // it propagate to the real runAgentTurnWithFallback catch + classification.
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

    // (1) The user-facing reply is the exact resend-guidance literal.
    expect(result.kind).toBe("final");
    if (result.kind !== "final") {
      throw new Error("expected final reply");
    }
    expect(result.payload.text).toBe(RESEND_GUIDANCE);
    // (2) Not an empty / silent payload.
    expect(result.payload.text).toContain("Please resend your message");
    // (3) Single request: no silent in-window SDK retry (retries pinned to 0).
    expect(requestCount).toBe(1);
    // The takeover was recorded as a run failure via the reply operation.
    const failCall = failMock.mock.calls[0];
    expect(failCall?.[0]).toBe("run_failed");
  }, 60_000);
});
