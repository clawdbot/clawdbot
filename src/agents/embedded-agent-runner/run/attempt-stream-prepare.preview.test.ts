import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnLocalBeforeAgentFinalize } from "../../../auto-reply/reply/source-finalization.types.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../../plugins/hooks.test-helpers.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
} from "../../embedded-agent-subscribe.e2e-harness.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { SessionManager } from "../../sessions/session-manager.js";

const mocks = vi.hoisted(() => ({
  runBeforeFinalizeHook: vi.fn(),
  clearActiveRun: vi.fn(),
  setActiveRun: vi.fn(),
}));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));

import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";

const cases = [
  { owner: "local", action: "continue", provisional: true, accepted: true },
  { owner: "local", action: "revise", provisional: true, accepted: false },
  { owner: "local", action: "discard", provisional: true, accepted: false },
  { owner: "global", action: "continue", provisional: false, accepted: true },
  { owner: "global+local", action: "discard", provisional: false, accepted: false },
] as const;

describe("attempt stream provisional source previews", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });

  it.each(cases)(
    "$owner $action preserves preview and committed-delivery boundaries",
    async (testCase) => {
      const onPartialReply = vi.fn();
      const onBlockReply = vi.fn();
      const onAgentEvent = vi.fn();
      const onBeforeAgentFinalize = vi.fn<TurnLocalBeforeAgentFinalize>(async () =>
        testCase.action === "revise"
          ? { action: "revise", instruction: "Use the updated room message.", disableTools: true }
          : { action: testCase.action },
      );
      const runId = `preview-${testCase.owner}-${testCase.action}`;
      const authStorage = AuthStorage.inMemory();
      const candidate = {
        role: "assistant",
        content: [{ type: "text", text: "Provisional answer." }],
        stopReason: "stop",
      };
      const { session, emit } = createStubSessionHarness();
      Object.assign(session, {
        agent: { hasQueuedMessages: () => false },
        messages: [candidate],
        pendingMessageCount: 0,
        isStreaming: false,
        isCompacting: false,
        sessionManager: SessionManager.inMemory(),
      });
      const prepared = prepareEmbeddedAttemptStream({
        // This boundary fixture does not execute a provider or authenticate a model.
        attempt: {
          runId,
          admittedRunContext: createTestAdmittedRunContext(runId),
          sessionId: runId,
          sessionFile: "/test/session.jsonl",
          sessionKey: "agent:main:main",
          workspaceDir: "/test/workspace",
          prompt: "Answer the room message.",
          timeoutMs: 1_000,
          provider: "test-provider",
          modelId: "test-model",
          model: {
            id: "test-model",
            name: "Test model",
            api: "openai-responses",
            provider: "test-provider",
            baseUrl: "https://example.invalid",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 1_024,
          },
          authStorage,
          authProfileStore: { version: 1, profiles: {} },
          modelRegistry: ModelRegistry.inMemory(authStorage),
          thinkLevel: "off",
          blockReplyBreak: "message_end",
          onPartialReply,
          onAgentEvent,
          ...(testCase.owner !== "global" ? { onBeforeAgentFinalize } : {}),
        },
        activeSession: session,
        hookRunner:
          testCase.owner === "local"
            ? null
            : createHookRunner(
                createMockPluginRegistry([{ hookName: "before_agent_finalize", handler: vi.fn() }]),
              ),
        hookAgentId: "main",
        diagnosticTrace: { traceId: "00000000000000000000000000000001" },
        diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId: runId, runId }),
        clientToolCallSlots: [],
        nestedToolActivities: [],
        isReplaySafeTool: () => false,
        runAbortController: new AbortController(),
        abortRun: vi.fn(),
        markExternalAbort: vi.fn(),
        getRunState: () => ({
          aborted: false,
          promptError: undefined,
          timedOut: false,
          yieldDetected: false,
        }),
        hasDeliveredSourceReply: () => false,
        markSourceReplyDelivered: vi.fn(),
        onBlockReply,
        onBlockReplyFlush: vi.fn(),
        sandboxSessionKey: "agent:main:main",
        builtinToolNames: new Set(),
        replaySafeToolNames: new Set(),
      });
      const hasCommittedAssistant = () =>
        onAgentEvent.mock.calls.some(([event]) => event.stream === "assistant");
      try {
        emitAssistantTextDelta({ emit, delta: "Provisional answer." });
        await prepared.subscription.waitForPendingEvents();
        expect(onPartialReply).toHaveBeenCalledTimes(testCase.provisional ? 1 : 0);
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(hasCommittedAssistant()).toBe(false);
        expect(onBeforeAgentFinalize).not.toHaveBeenCalled();

        emit({ type: "message_end", message: candidate });
        emit({
          type: "agent_end",
          messages: [candidate],
          willRetry: false,
          assistantEntryId: "draft-entry",
        });
        await prepared.subscription.waitForPendingEvents();

        expect(onBeforeAgentFinalize).toHaveBeenCalledTimes(testCase.owner === "global" ? 0 : 1);
        expect(hasCommittedAssistant()).toBe(testCase.accepted);
        expect(onBlockReply).toHaveBeenCalledTimes(testCase.accepted ? 1 : 0);
        expect(onPartialReply).toHaveBeenCalledTimes(
          testCase.provisional || testCase.accepted ? 1 : 0,
        );
        if (testCase.provisional || testCase.accepted) {
          expect(onPartialReply).toHaveBeenCalledWith(
            expect.objectContaining({ text: "Provisional answer." }),
          );
        }
      } finally {
        prepared.subscription.unsubscribe();
      }
    },
  );
});
