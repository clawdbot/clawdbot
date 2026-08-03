// Full-entry usage reporting coverage spans metadata attribution, runtime plugin
// bootstrap inputs, and forwarding fields into embedded attempts.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

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

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/test-model",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
      config,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        workspaceDir: "/tmp/workspace",
        runtimePluginSelections: expect.arrayContaining([
          expect.objectContaining({ provider: "openai", modelId: "gpt-5.5" }),
        ]),
      }),
      expect.anything(),
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
      workspaceDir: "/tmp/workspace",
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
    const config = {
      agents: {
        defaults: {
          model: {
            primary: "codex/test-model",
            fallbacks: ["openai/gpt-5.5"],
          },
        },
      },
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ assistantTexts: ["Response 1"] }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: "/tmp/workspace",
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
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-gateway-bind",
      allowGatewaySubagentBinding: true,
    });

    expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        workspaceDir: "/tmp/workspace",
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
      workspaceDir: "/tmp/workspace",
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
      workspaceDir: "/tmp/workspace",
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
      workspaceDir: "/tmp/workspace",
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

  it("uses current-attempt usage when the persisted assistant snapshot is zeroed", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1", "Response 2"],
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
          usage: { input: 150, output: 50, total: 200 } as unknown as AssistantMessage["usage"],
        }),
        attemptUsage: { input: 250, output: 100, total: 350 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "test-key",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-zeroed-persisted-usage",
    });

    expect(result.meta.agentMeta?.usage).toMatchObject({
      input: 250,
      output: 100,
      total: 350,
    });
    expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({
      input: 150,
      output: 50,
      total: 200,
    });
    expect(result.meta.agentMeta?.promptTokens).toBe(150);
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
      workspaceDir: "/tmp/workspace",
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
