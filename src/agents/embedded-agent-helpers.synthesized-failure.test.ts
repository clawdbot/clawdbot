import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import type { AssistantMessage, AssistantMessageEvent, Model, StreamFn } from "@openclaw/llm-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "../../packages/agent-core/src/agent-loop.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../gateway/session-lifecycle-state.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createDeferredCore } from "../shared/deferred.js";
import { toWorkerTranscriptMessage } from "../worker/transcript-message.js";
import { buildAgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import {
  createAgentAttemptLifecycleCallbacks,
  type AgentAttemptLifecycleState,
} from "./command/attempt-callbacks.js";
import { createAgentCommandLifecycle } from "./command/lifecycle.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import {
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
} from "./embedded-agent-helpers/error-text.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { Agent, runAgentLoop } from "./runtime/index.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

type EmitInput = Parameters<typeof import("../infra/agent-events.js").emitAgentEvent>[0];
const observed = vi.hoisted(() => ({
  configureHost: vi.fn<() => void>(),
  emit: vi.fn((event: EmitInput) => ({ ...event, seq: 1, ts: Date.now() })),
  log: {
    debug: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    info: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    warn: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    error: vi.fn<(message: string, meta?: Record<string, unknown>) => void>(),
    trace: vi.fn(),
    isEnabled: () => false,
  },
}));

vi.mock(import("../infra/agent-events.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  emitAgentEvent: observed.emit,
  getAgentEventLifecycleGeneration: () => "failure-copy-generation",
  isAgentEventLifecycleGenerationCurrent: () => true,
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => observed.log,
}));
vi.mock("./ai-transport-runtime-host.js", () => ({
  configureAiTransportRuntimeHost: observed.configureHost,
}));

const model: Model = {
  api: "fixture-api",
  provider: "fixture-provider",
  id: "fixture-model",
  name: "Fixture Model",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 256,
};
const canary = "Opaque failure PRIVATE_CANARY /private/fixture-state/session-canary";
const providerCopy = "⚠️ fixture-provider/fixture-model request failed.";

// Provider callbacks may throw any value; preserve it to test origin and identity.
function throwFailure(value: unknown): never {
  throw value;
}

function assistant(stopReason: "stop" | "error" = "stop"): AssistantMessage {
  return makeAssistantMessageFixture({
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    stopReason,
    errorMessage: stopReason === "error" ? canary : undefined,
  });
}

function terminalStream(message = assistant()) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === "error") {
    stream.push({ type: "error", reason: "error", error: message });
  } else {
    stream.push({ type: "done", reason: "stop", message });
  }
  return stream;
}

function interruptedProviderStream(boundary: "iterator" | "result", failure: unknown) {
  const cleanup = vi.fn();
  const order: string[] = [];
  const result = vi.fn(async (): Promise<AssistantMessage> => {
    order.push("result");
    return throwFailure(failure);
  });
  const stream = Object.assign(createAssistantMessageEventStream(), {
    async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      try {
        order.push("start");
        yield { type: "start", partial: assistant() };
        if (boundary === "iterator") {
          throwFailure(failure);
        }
      } finally {
        order.push("cleanup");
        cleanup();
      }
    },
    result,
  });
  return { stream, cleanup, order, result };
}

function lastAssistant(messages: readonly unknown[]): AssistantMessage {
  const message = messages.findLast(
    (value): value is AssistantMessage =>
      typeof value === "object" && value !== null && "role" in value && value.role === "assistant",
  );
  if (!message) {
    throw new Error("expected an actual terminal assistant message");
  }
  return message;
}

async function projectRun(agent: Agent, runId: string) {
  return projectFailure(
    runId,
    (listener) => agent.subscribe(listener),
    async () => {
      await agent.prompt("Exercise the failure boundary.");
      return lastAssistant(agent.state.messages);
    },
  );
}

async function projectFailure(
  runId: string,
  subscribe: Agent["subscribe"],
  run: () => Promise<AssistantMessage>,
) {
  const state: AgentAttemptLifecycleState = {
    currentTurnUserMessagePersisted: false,
    lifecycleEnded: false,
    lifecycleFinishing: false,
  };
  const callbacks = createAgentAttemptLifecycleCallbacks(state);
  const onAgentEvent = vi.fn(callbacks.onAgentEvent);
  const { subscription } = createSubscribedSessionHarness({
    runId,
    sessionKey: `agent:qa:${runId}`,
    terminalLifecyclePhase: "finishing",
    onAgentEvent,
    sessionExtras: {
      // The session layer supplies retry eligibility; these single-attempt
      // producer runs have no session retry to schedule.
      subscribe: (listener) =>
        subscribe(async (event) => {
          await listener(event.type === "agent_end" ? { ...event, willRetry: false } : event);
        }),
    },
  });
  try {
    const message = await run();
    await subscription.waitForPendingEvents();
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: subscription.assistantTexts,
      currentAssistant: message,
      lastAssistant: message,
      sessionKey: `agent:qa:${runId}`,
      provider: model.provider,
      model: model.id,
    });
    const command = createAgentCommandLifecycle({
      runId,
      lifecycleGeneration: () => "failure-copy-generation",
      startedAt: 1,
      state,
    });
    command.emitResultError({ payloads, meta: { durationMs: 0 } }, false, {
      metadata: {},
      outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
    });
    const terminal = observed.emit.mock.calls.findLast(
      ([event]) => event.runId === runId && event.data.phase === "error",
    )?.[0];
    if (!terminal) {
      throw new Error("expected the command-owned terminal relay");
    }
    const snapshot = deriveGatewaySessionLifecycleSnapshot({
      event: { ...terminal, ts: Date.now() },
    });
    const consoleMessage = observed.log.warn.mock.calls.findLast(
      ([, meta]) => meta?.event === "embedded_run_agent_end" && meta.runId === runId,
    )?.[1]?.consoleMessage;
    return { message, payloads, state, onAgentEvent, terminal, snapshot, consoleMessage };
  } finally {
    subscription.unsubscribe();
  }
}

function expectPresentation(
  result: Awaited<ReturnType<typeof projectRun>>,
  runtime: boolean,
  expected = runtime ? GENERIC_ASSISTANT_ERROR_TEXT : providerCopy,
) {
  expect(result.message).toMatchObject({
    provider: model.provider,
    model: model.id,
    stopReason: "error",
  });
  expect(result.payloads).toEqual([expect.objectContaining({ text: expected, isError: true })]);
  expect(result.state.lifecycleError).toBe(expected);
  expect(result.terminal.data.error).toBe(expected);
  expect(result.snapshot.lastRunError).toBe(expected);
  expect(result.consoleMessage).toEqual(expect.stringContaining(expected));
  const publicErrors = JSON.stringify({
    payloads: result.payloads,
    callbacks: result.onAgentEvent.mock.calls,
    terminal: result.terminal,
    snapshot: result.snapshot,
  });
  expect(publicErrors).not.toMatch(/PRIVATE_CANARY|fixture-state|session-canary/);
  if (runtime) {
    expect(result.terminal.data.errorObservation).toBeUndefined();
    expect(publicErrors).not.toContain(model.provider);
    expect(result.consoleMessage).not.toMatch(/fixture-provider|fixture-model|PRIVATE_CANARY/);
  } else {
    expect(result.terminal.data.errorObservation).toMatchObject({
      provider: model.provider,
      model: model.id,
    });
  }
  // The worker and stored-message projections must retain the real producer's fact.
  const projection = toWorkerTranscriptMessage(result.message, "transcript");
  if (projection?.kind !== "complete" || projection.message.role !== "assistant") {
    throw new Error("expected a complete assistant worker projection");
  }
  expect(formatUserFacingAssistantErrorText(projection.message)).toBe(expected);
  const serialized = JSON.stringify(result.message);
  const restored: AssistantMessage = JSON.parse(serialized);
  expect(formatUserFacingAssistantErrorText(restored)).toBe(expected);
}

describe("synthesized failure presentation across runtime and channel owners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observed.configureHost.mockReset();
  });

  it.each(["runtime", "provider"] as const)(
    "preserves the prepared %s error without a lifecycle callback",
    async (origin) => {
      const agent = new Agent({
        initialState: { model },
        streamFn: () => terminalStream(assistant("error")),
        ...(origin === "runtime"
          ? { transformContext: async () => throwFailure(new Error(canary)) }
          : {}),
      });
      await agent.prompt("Exercise a harness without lifecycle callbacks.");
      const message = lastAssistant(agent.state.messages);
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: [],
        currentAssistant: message,
        lastAssistant: message,
        sessionKey: "agent:qa:result-only",
        provider: model.provider,
        model: model.id,
      });
      const result = {
        payloads,
        meta: { durationMs: 0, error: { kind: "incomplete_turn" as const, message: canary } },
      };
      const command = createAgentCommandLifecycle({
        runId: "result-only",
        lifecycleGeneration: () => "failure-copy-generation",
        startedAt: 1,
        state: {
          currentTurnUserMessagePersisted: false,
          lifecycleEnded: false,
          lifecycleFinishing: false,
        },
      });
      const expected = origin === "runtime" ? GENERIC_ASSISTANT_ERROR_TEXT : providerCopy;
      expect(command.resolveResultError(result, false)).toBe(expected);
      command.emitResultError(result, false, {
        metadata: {},
        outcome: buildAgentRunTerminalOutcome({ status: "error", stopReason: "error" }),
      });
      const terminal = observed.emit.mock.calls[0]?.[0];
      if (!terminal) {
        throw new Error("expected the command-owned terminal event");
      }
      expect(terminal.data.error).toBe(expected);
      expect(
        deriveGatewaySessionLifecycleSnapshot({ event: { ...terminal, ts: Date.now() } })
          .lastRunError,
      ).toBe(expected);
      expect(JSON.stringify(terminal)).not.toContain(canary);
    },
  );

  it.each([
    { name: "successful tool warning", failed: false, text: "An earlier tool failed." },
    { name: "failed result without a payload", failed: true, text: undefined },
    { name: "empty plugin hook failure", failed: true, text: "" },
    { name: "blank plugin hook failure", failed: true, text: " \t " },
  ])("keeps the safe fallback boundary for $name", ({ failed, text }) => {
    const command = createAgentCommandLifecycle({
      runId: "result-fallback",
      lifecycleGeneration: () => "failure-copy-generation",
      startedAt: 1,
      state: {
        currentTurnUserMessagePersisted: false,
        lifecycleEnded: false,
        lifecycleFinishing: false,
      },
    });
    // Native hook errors can reach blocked-run-result without text normalization.
    const error = failed ? { kind: "hook_block" as const, message: canary } : undefined;
    const payloads = text === undefined ? [] : [{ text, isError: true }];
    expect(command.resolveResultError({ payloads, meta: { durationMs: 0, error } }, false)).toBe(
      failed ? "Agent run failed" : undefined,
    );
  });

  it.each([
    { boundary: "context", shape: "opaque", raw: canary },
    { boundary: "context", shape: "empty", raw: "" },
    { boundary: "context", shape: "long", raw: `${canary} ${"private detail ".repeat(60)}` },
    { boundary: "listener", shape: "opaque", raw: canary },
  ])("keeps an internal $boundary failure neutral ($shape)", async ({ boundary, raw }) => {
    const failure = new Error(raw);
    const streamFn = vi.fn(() => terminalStream());
    const agent = new Agent({
      initialState: { model },
      streamFn,
      ...(boundary === "context"
        ? {
            transformContext: async () => {
              return throwFailure(failure);
            },
          }
        : {}),
    });
    // Session persistence listeners run before the delivery subscriber in production.
    const detach = agent.subscribe((event) => {
      if (
        boundary === "listener" &&
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.stopReason === "stop"
      ) {
        throwFailure(failure);
      }
    });
    try {
      expectPresentation(await projectRun(agent, boundary), true);
      expect(streamFn).toHaveBeenCalledTimes(boundary === "context" ? 0 : 1);
      expect(
        observed.log.warn.mock.calls.filter(([message]) =>
          message.startsWith("Long error truncated:"),
        ),
      ).toEqual([]);
    } finally {
      detach();
    }
  });

  it.each(["sync-start", "async-start", "iterator", "result", "terminal"] as const)(
    "retains opaque provider attribution at %s",
    async (boundary) => {
      const failure = Object.freeze(new Error(canary));
      const cleanup = vi.fn();
      const streamFn: StreamFn = () => {
        if (boundary === "sync-start") {
          return throwFailure(failure);
        }
        if (boundary === "async-start") {
          return Promise.reject(failure);
        }
        if (boundary === "terminal") {
          return terminalStream(assistant("error"));
        }
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
            try {
              if (boundary === "iterator") {
                throwFailure(failure);
              }
              yield { type: "done", reason: "stop", message: assistant() };
            } finally {
              cleanup();
            }
          },
          result: async () => {
            return throwFailure(failure);
          },
        };
      };
      const agent = new Agent({ initialState: { model }, streamFn });
      expectPresentation(await projectRun(agent, boundary), false);
      if (boundary === "iterator" || boundary === "result") {
        expect(cleanup).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["primitive", "frozen-error"] as const)(
    "isolates concurrent runtime and provider failures sharing a %s",
    async (shape) => {
      const failure = shape === "primitive" ? canary : Object.freeze(new Error(canary));
      const providerEntered = createDeferredCore();
      const runtimeStream = vi.fn(() => terminalStream());
      const runtimeAgent = new Agent({
        initialState: { model },
        streamFn: runtimeStream,
        transformContext: async () => {
          await providerEntered.promise;
          return throwFailure(failure);
        },
      });
      const providerStream = vi.fn(() => {
        providerEntered.resolve();
        return throwFailure(failure);
      });
      const providerAgent = new Agent({ initialState: { model }, streamFn: providerStream });
      const [runtimeResult, providerResult] = await Promise.all([
        projectRun(runtimeAgent, `concurrent-runtime-${shape}`),
        projectRun(providerAgent, `concurrent-provider-${shape}`),
      ]);
      expectPresentation(runtimeResult, true);
      expectPresentation(providerResult, false);
      expect(runtimeStream).not.toHaveBeenCalled();
      expect(providerStream).toHaveBeenCalledOnce();
    },
  );

  it.each(["primitive", "frozen-error"] as const)(
    "keeps listener ownership when iterator cleanup throws the same %s",
    async (shape) => {
      const failure = shape === "primitive" ? canary : Object.freeze(new Error(canary));
      const message = assistant();
      const cleanup = vi.fn(async (): Promise<IteratorResult<AssistantMessageEvent>> => {
        return throwFailure(failure);
      });
      const iterator: AsyncIterator<AssistantMessageEvent> = {
        next: async () => ({ value: { type: "done", reason: "stop", message }, done: false }),
        return: cleanup,
      };
      const agent = new Agent({
        initialState: { model },
        streamFn: () => ({
          [Symbol.asyncIterator]: () => iterator,
          result: async () => message,
        }),
      });
      const listenerFailure = vi.fn(() => {
        return throwFailure(failure);
      });
      const detach = agent.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "stop"
        ) {
          listenerFailure();
        }
      });
      try {
        expectPresentation(await projectRun(agent, `listener-cleanup-${shape}`), true);
        expect(listenerFailure).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
      } finally {
        detach();
      }
    },
  );

  it.each([
    {
      kind: "auth",
      raw: "HTTP 401: upstream refusal",
      copy:
        "⚠️ fixture-provider/fixture-model request failed (authentication failed, HTTP 401). " +
        "Re-authenticate the provider and try again.",
    },
    {
      kind: "rate-limit",
      raw: '429 {"error":{"type":"rate_limit_error","message":"Too many requests"}}',
      copy: "⚠️ API rate limit reached. Please try again later.",
    },
    {
      kind: "server",
      raw: "HTTP 500: upstream refusal",
      copy:
        "⚠️ fixture-provider/fixture-model request failed (provider internal error, HTTP 500). " +
        "This is usually temporary — try again shortly.",
    },
  ])(
    "preserves classified $kind copy for an actual runtime failure",
    async ({ kind, raw, copy }) => {
      const streamFn = vi.fn(() => terminalStream());
      const agent = new Agent({
        initialState: { model },
        streamFn,
        transformContext: async () => {
          throw new Error(raw);
        },
      });
      expectPresentation(await projectRun(agent, `classified-${kind}`), false, copy);
      expect(streamFn).not.toHaveBeenCalled();
    },
  );

  describe.each(["stream", "streamSimple"] as const)("%s adapter boundaries", (entrypoint) => {
    it.each(["initialization", "start", "iterator"] as const)(
      "distinguishes deferred host %s failure from provider failure",
      async (boundary) => {
        // Host initialization is process-cached, including rejection. A fresh module
        // reproduces each lifecycle without adding a production reset hook.
        vi.resetModules();
        const [hostStreams, { bindModelLlmRuntime }] = await Promise.all([
          import("../llm/stream.js"),
          import("../llm/model-runtime-binding.js"),
        ]);
        const failure = Object.freeze(new Error(canary));
        const interrupted = interruptedProviderStream("iterator", failure);
        const providerStart = vi.fn(() => {
          expect(observed.configureHost).toHaveBeenCalledOnce();
          if (boundary === "start") {
            return throwFailure(failure);
          }
          return interrupted.stream;
        });
        observed.configureHost.mockImplementation(() => {
          if (boundary === "initialization") {
            throwFailure(failure);
          }
        });
        const registry = createApiRegistry();
        registry.registerApiProvider({
          api: model.api,
          stream: providerStart,
          streamSimple: providerStart,
        });
        const boundModel = bindModelLlmRuntime(model, createLlmRuntime(registry));
        const agent = new Agent({
          initialState: { model: boundModel },
          streamFn: (streamModel, context) => {
            const stream = hostStreams[entrypoint](streamModel, context);
            expect(providerStart).not.toHaveBeenCalled();
            return stream;
          },
        });
        expectPresentation(
          await projectRun(agent, `host-${entrypoint}-${boundary}`),
          boundary === "initialization",
        );
        expect(observed.configureHost).toHaveBeenCalledOnce();
        expect(providerStart).toHaveBeenCalledTimes(boundary === "initialization" ? 0 : 1);
        if (boundary === "iterator") {
          expect(interrupted.order).toEqual(["start", "cleanup"]);
          expect(interrupted.cleanup).toHaveBeenCalledOnce();
          expect(interrupted.result).not.toHaveBeenCalled();
        }
      },
    );

    it.each([false, true])(
      "retains attribution for custom provider start failures (async=%s)",
      async (asyncFactory) => {
        const registry = createApiRegistry();
        const failure = Object.freeze(new Error(canary));
        ensureCustomApiRegistered(registry, model.api, () => {
          if (asyncFactory) {
            return Promise.reject(failure);
          }
          return throwFailure(failure);
        });
        const provider = registry.getApiProvider(model.api);
        if (!provider) {
          throw new Error("expected the registered custom provider");
        }
        const agent = new Agent({ initialState: { model }, streamFn: provider[entrypoint] });
        expectPresentation(await projectRun(agent, `custom-${entrypoint}-${asyncFactory}`), false);
      },
    );

    it.each(["iterator", "result"] as const)(
      "retains custom provider attribution after factory resolution at %s",
      async (boundary) => {
        const registry = createApiRegistry();
        const failure = Object.freeze(new Error(canary));
        const interrupted = interruptedProviderStream(boundary, failure);
        ensureCustomApiRegistered(registry, model.api, async () => interrupted.stream);
        const provider = registry.getApiProvider(model.api);
        if (!provider) {
          throw new Error("expected the registered custom provider");
        }
        const agent = new Agent({ initialState: { model }, streamFn: provider[entrypoint] });
        expectPresentation(await projectRun(agent, `custom-${entrypoint}-${boundary}`), false);
        expect(interrupted.order).toEqual(
          boundary === "iterator" ? ["start", "cleanup"] : ["start", "cleanup", "result"],
        );
        expect(interrupted.cleanup).toHaveBeenCalledOnce();
        expect(interrupted.result).toHaveBeenCalledTimes(boundary === "result" ? 1 : 0);
      },
    );
  });

  it.each([agentLoop, agentLoopContinue])(
    "keeps public streaming loop runtime failures neutral",
    async (loop) => {
      const signal = new AbortController().signal;
      const prompt = { role: "user" as const, content: "probe", timestamp: 1 };
      const context = { systemPrompt: "", messages: [prompt] };
      const config = {
        model,
        convertToLlm: () => [prompt],
        transformContext: async () => {
          throw new Error(canary);
        },
      };
      const stream =
        loop === agentLoop
          ? agentLoop([prompt], { ...context, messages: [] }, config, signal)
          : agentLoopContinue(context, config, signal);
      const listeners = new Set<Parameters<Agent["subscribe"]>[0]>();
      const result = await projectFailure(
        `public-${loop.name}`,
        (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async () => {
          for await (const event of stream) {
            for (const listener of listeners) {
              await listener(event, signal);
            }
          }
          return lastAssistant(await stream.result());
        },
      );
      expectPresentation(result, true);
    },
  );

  it("preserves direct loop rejection values", async () => {
    const failure = Object.freeze({ message: canary, code: "provider-code" });
    await expect(
      runAgentLoop(
        [{ role: "user", content: "probe", timestamp: 1 }],
        { systemPrompt: "", messages: [] },
        { model, convertToLlm: () => [] },
        () => {},
        undefined,
        () => {
          return throwFailure(failure);
        },
      ),
    ).rejects.toBe(failure);
  });
});
