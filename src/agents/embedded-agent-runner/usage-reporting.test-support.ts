// Full-entry usage reporting coverage spans metadata attribution, runtime plugin
// bootstrap inputs, and forwarding fields into embedded attempts.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function makeAssistantMessage(
  overrides: Partial<AssistantMessage> = {},
): NonNullable<EmbeddedRunAttemptResult["lastAssistant"]> {
  // Minimal assistant fixture lets tests override provider/model/usage without
  // recreating the full attempt result shape.
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: { input: 0, output: 0 } as AssistantMessage["usage"],
    stopReason: "end_turn" as AssistantMessage["stopReason"],
    timestamp: Date.now(),
    content: [],
    ...overrides,
  };
}

function firstAttemptInput(): Record<string, unknown> {
  // Harness calls are single-attempt in these tests; expose the first input so
  // forwarding assertions stay readable.
  const call = mockedRunEmbeddedAttempt.mock.calls[0];
  if (!call) {
    throw new Error("Expected embedded attempt");
  }
  return call[0] as Record<string, unknown>;
}

describe("runEmbeddedAgent usage reporting", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "usage-reporting" });
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    const config = createModelFallbackConfig("anthropic/test-model", ["openai/gpt-5.5"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
      config,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        workspaceDir: state.workspaceDir,
        runtimePluginSelections: expect.arrayContaining([
          expect.objectContaining({ provider: "openai", modelId: "gpt-5.5" }),
        ]),
      }),
      expect.objectContaining({ catalogMode: "static" }),
    );
  });

  it("includes named-agent fallback owners in the runtime plugin plan", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "anthropic/test-model" } },
        list: [
          {
            id: "support",
            model: { fallbacks: ["openai/gpt-5.5"] },
          },
        ],
      },
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Response 1"] }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "agent:support:test-key",
      sessionFile: "agent:support:test-key",
      agentId: "support",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-agent-fallback-plugin-bootstrap",
      config,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        runtimePluginSelections: expect.arrayContaining([
          expect.objectContaining({ provider: "openai", modelId: "gpt-5.5" }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("preserves an explicitly pinned harness across fallback plugin planning", async () => {
    const config = createModelFallbackConfig("codex/test-model", ["openai/gpt-5.5"]);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Response 1"] }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-pinned-fallback-plugin-bootstrap",
      agentHarnessId: "codex",
      config,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePluginSelections: expect.arrayContaining([
          expect.objectContaining({
            provider: "openai",
            modelId: "gpt-5.5",
            runtime: "codex",
          }),
        ]),
      }),
      expect.anything(),
    );
  });

  it("forwards gateway subagent binding opt-in to runtime plugin bootstrap", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-gateway-bind",
      config: {},
      allowGatewaySubagentBinding: true,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        workspaceDir: state.workspaceDir,
        allowGatewaySubagentBinding: true,
      }),
      expect.anything(),
    );
    expect(firstAttemptInput().allowGatewaySubagentBinding).toBe(true);
  });

  it("forwards sender identity fields into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-sender-forwarding",
      senderId: "user-123",
      senderName: "Josh Lehman",
      senderUsername: "josh",
      senderE164: "+15551234567",
    });

    const attemptInput = firstAttemptInput();
    expect(attemptInput.senderId).toBe("user-123");
    expect(attemptInput.senderName).toBe("Josh Lehman");
    expect(attemptInput.senderUsername).toBe("josh");
    expect(attemptInput.senderE164).toBe("+15551234567");
  });

  it("forwards the current-turn message action capability into embedded attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-message-action-capability",
      messageActionTurnCapability: "turn-capability",
    });

    expect(firstAttemptInput().messageActionTurnCapability).toBe("turn-capability");
  });

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "flush",
      timeoutMs: 30000,
      runId: "run-memory-forwarding",
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-03-10.md",
    });

    const attemptInput = firstAttemptInput();
    expect(attemptInput.trigger).toBe("memory");
    expect(attemptInput.memoryFlushWritePath).toBe("memory/2026-03-10.md");
  });

  it("keeps Anthropic multi-call billing usage separate from the final context snapshot", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Tool loop complete"],
        lastAssistant: makeAssistantMessage({
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          } as unknown as AssistantMessage["usage"],
        }),
        currentAttemptAssistant: makeAssistantMessage({
          api: "anthropic-messages",
          provider: "minimax",
          model: "Minimax-M3",
          usage: {
            input: 67_932,
            output: 2_000,
            cacheRead: 18_944,
            totalTokens: 88_876,
          } as unknown as AssistantMessage["usage"],
        }),
        // Three model calls in one tool loop; this remains cumulative billing data.
        attemptUsage: { input: 110_337, output: 4_000, cacheRead: 40_000, total: 154_337 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-anthropic-multi-call-usage",
    });

    expect(result.meta.agentMeta?.usage).toMatchObject({
      input: 110_337,
      output: 4_000,
      cacheRead: 40_000,
      total: 154_337,
    });
    expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({
      input: 67_932,
      output: 2_000,
      cacheRead: 18_944,
    });
    expect(result.meta.agentMeta?.promptTokens).toBe(86_876);
  });

  it("reports the resolved model provider when OpenClaw marks the assistant message as the native runtime", async () => {
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "openai/gpt-5.4",
        provider: "openrouter",
        contextWindow: 200000,
        api: "openai-completions",
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
        lastAssistant: makeAssistantMessage({
          provider: "openclaw",
          model: "openclaw",
          usage: { input: 100, output: 50, total: 150 } as unknown as AssistantMessage["usage"],
        }),
        attemptUsage: { input: 100, output: 50, total: 150 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: state.workspaceDir,
      prompt: "hello",
      provider: "openrouter",
      model: "openai/gpt-5.4",
      timeoutMs: 30000,
      runId: "run-provider-attribution",
    });

    expect(result.meta.agentMeta?.provider).toBe("openrouter");
    expect(result.meta.agentMeta?.model).toBe("openai/gpt-5.4");
    expect(result.meta.executionTrace?.winnerProvider).toBe("openrouter");
    expect(result.meta.executionTrace?.winnerModel).toBe("openai/gpt-5.4");
  });
});
