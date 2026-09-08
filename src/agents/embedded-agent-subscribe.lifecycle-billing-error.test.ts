// Lifecycle billing error tests ensure subscription error events include enough
// provider/model context for users to fix account or quota issues.
import { describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import { onAgentEventForRun } from "../infra/agent-events.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
} from "../logging/diagnostic-run-activity.js";
import {
  attachModelProviderRuntimePluginHandle,
  resolveProviderRuntimePluginHandle,
} from "../plugins/provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderFailoverErrorContext } from "../plugins/types.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { prepareEmbeddedAttemptStream } from "./embedded-agent-runner/run/attempt-stream-prepare.js";
import { clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import {
  createSubscribedSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  findLifecycleErrorAgentEvent,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./sessions/agent-session-loop-correctness.test-support.js";

describe("subscribeEmbeddedAgentSession lifecycle billing errors", () => {
  registerAgentSessionLoopTestLifecycle();

  function createAgentEventHarness(options?: { runId?: string; sessionKey?: string }) {
    // Harness captures lifecycle events only; stream/block reply paths are not
    // relevant to billing-error attribution.
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: options?.runId ?? "run",
      sessionKey: options?.sessionKey,
      onAgentEvent,
    });
    return { emit, onAgentEvent };
  }

  it("includes provider and model context in lifecycle billing errors", () => {
    const { emit, onAgentEvent } = createAgentEventHarness({
      runId: "run-billing-error",
      sessionKey: "test-session",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "insufficient credits",
      provider: "Anthropic",
      model: "claude-3-5-sonnet",
    });

    const lifecycleError = findLifecycleErrorAgentEvent(onAgentEvent.mock.calls);
    expect(lifecycleError?.stream).toBe("lifecycle");
    expect(lifecycleError?.data?.phase).toBe("error");
    expect(lifecycleError?.data?.error).toContain("Anthropic (claude-3-5-sonnet)");
  });

  it("defers error terminal ownership while preserving diagnostics", () => {
    const onAgentEvent = vi.fn();
    const { emit } = createSubscribedSessionHarness({
      runId: "run-deferred-error",
      onAgentEvent,
      terminalLifecyclePhase: "finishing",
    });

    emitAssistantLifecycleErrorAndEnd({
      emit,
      errorMessage: "insufficient credits",
      provider: "Anthropic",
      model: "claude-3-5-sonnet",
    });

    const lifecycleEvents = onAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          phase: "finishing",
          error: expect.stringContaining("Anthropic (claude-3-5-sonnet)"),
        }),
      }),
    ]);
  });

  it("preserves the prepared custom-route owner through real terminal dispatch", async () => {
    const config = {};
    const metadataSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const pluginRegistry = createEmptyPluginRegistry();
    const ownerId = "prepared-lifecycle-owner";
    const hookContexts: ProviderFailoverErrorContext[] = [];
    pluginRegistry.providers.push({
      pluginId: ownerId,
      source: "test",
      provider: {
        id: ownerId,
        label: "Prepared lifecycle owner",
        auth: [],
        classifyFailoverReason: (context) => {
          hookContexts.push(context);
          return context.provider === ownerId ? "overloaded" : undefined;
        },
      },
    });
    const onAgentEvent = vi.fn();
    const emitted = vi.fn();
    const runId = "run-prepared-lifecycle-owner";
    const sessionId = "session-prepared-lifecycle-owner";
    const sessionKey = "agent:main:prepared-lifecycle-owner";
    const unlisten = onAgentEventForRun(runId, emitted);
    const diagnosticOwner = createDiagnosticEmbeddedRunOwner({ runId, sessionId, sessionKey });
    try {
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
        // Runtime preparation can select an endpoint owner that differs from the route label.
        const runtimeHandle = resolveProviderRuntimePluginHandle({
          provider: "custom-lifecycle-route",
          providerOwner: ownerId,
          modelId: testModel.id,
          config,
        });
        expect(runtimeHandle.plugin?.id).toBe(ownerId);
        const model = attachModelProviderRuntimePluginHandle(
          { ...testModel, provider: "custom-lifecycle-route" },
          runtimeHandle,
        );
        streamMocks.streamSimple.mockImplementation((activeModel) =>
          createAssistantResultStream({
            ...createAssistant(activeModel, [], "error"),
            errorMessage: "403 fixture refusal",
            errorCode: "FIXTURE_REFUSAL",
          }),
        );
        const { session, modelRegistry } = await createTestSession({ model });
        const stream = prepareEmbeddedAttemptStream({
          attempt: {
            runId,
            sessionId,
            sessionKey,
            sessionFile: sessionKey,
            config,
            model,
            provider: model.provider,
            modelId: model.id,
            workspaceDir: process.cwd(),
            prompt: "exercise terminal provider failure",
            timeoutMs: 30_000,
            thinkLevel: "off",
            admittedRunContext: createTestAdmittedRunContext(runId),
            authStorage: modelRegistry.authStorage,
            modelRegistry,
            authProfileStore: { version: 1, profiles: {} },
            onAgentEvent,
          },
          activeSession: session,
          hookRunner: null,
          hookAgentId: "main",
          diagnosticTrace: { traceId: "11111111111111111111111111111111" },
          diagnosticOwner,
          clientToolCallSlots: [],
          nestedToolActivities: [],
          isReplaySafeTool: () => false,
          runAbortController: new AbortController(),
          abortRun: () => {
            void session.abort();
          },
          markExternalAbort: () => {},
          getRunState: () => ({
            aborted: false,
            promptError: undefined,
            timedOut: false,
            yieldDetected: false,
          }),
          hasDeliveredSourceReply: () => false,
          markSourceReplyDelivered: () => {},
          onBlockReply: undefined,
          onBlockReplyFlush: undefined,
          sandboxSessionKey: sessionKey,
          builtinToolNames: new Set(),
          replaySafeToolNames: new Set(),
        });
        try {
          await session.prompt("exercise terminal provider failure");
          expect(streamMocks.streamSimple).toHaveBeenCalledTimes(1);
          for (const observer of [emitted, onAgentEvent]) {
            const terminals = observer.mock.calls
              .map(([event]) => event)
              .filter((event) => event.stream === "lifecycle" && event.data.phase === "error");
            expect.soft(terminals).toEqual([
              expect.objectContaining({
                data: expect.objectContaining({
                  phase: "error",
                  error: "The AI service is temporarily overloaded. Please try again in a moment.",
                }),
              }),
            ]);
          }
          expect(hookContexts).toContainEqual(
            expect.objectContaining({
              provider: ownerId,
              status: 403,
              code: "FIXTURE_REFUSAL",
            }),
          );
        } finally {
          stream.subscription.unsubscribe();
          clearActiveEmbeddedRun(sessionId, stream.queueHandle, sessionKey, sessionKey);
        }
      });
    } finally {
      unlisten();
      closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
    }
  });
});
