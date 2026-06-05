// Usage reporting tests cover run-level metadata attribution, runtime plugin
// bootstrap inputs, and forwarding fields into embedded attempts.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedEnsureRuntimePluginsLoaded,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
} from "./run.overflow-compaction.harness.js";
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
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    mockedEnsureRuntimePluginsLoaded.mockReset();
    mockedRunEmbeddedAttempt.mockReset();
  });

  it("bootstraps runtime plugins with the resolved workspace before running", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1"],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-plugin-bootstrap",
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
    });
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
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-gateway-bind",
      allowGatewaySubagentBinding: true,
    });

    expect(mockedEnsureRuntimePluginsLoaded).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
    });
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
      sessionFile: "/tmp/session.json",
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

  it("forwards memory flush write paths into memory-triggered attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: [],
      }),
    );

    await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
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

  it("reports total usage from the last turn instead of accumulated total", async () => {
    // Billing metadata uses accumulated input/output but the reported total
    // remains the final provider call total, matching last-turn usage contracts.
    // Simulate a multi-turn run result.
    // Turn 1: Input 100, Output 50. Total 150.
    // Turn 2: Input 150, Output 50. Total 200.

    // The accumulated usage (attemptUsage) will be the sum:
    // Input: 100 + 150 = 250 (Note: runEmbeddedAttempt actually returns accumulated usage)
    // Output: 50 + 50 = 100
    // Total: 150 + 200 = 350

    // The last assistant usage (lastAssistant.usage) will be Turn 2:
    // Input: 150, Output 50, Total 200.

    // We expect result.meta.agentMeta.usage.total to be 200 (last turn total).
    // The bug causes it to be 350 (accumulated total).

    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        assistantTexts: ["Response 1", "Response 2"],
        lastAssistant: makeAssistantMessage({
          usage: { input: 150, output: 50, total: 200 } as unknown as AssistantMessage["usage"],
        }),
        attemptUsage: { input: 250, output: 100, total: 350 },
      }),
    );

    const result = await runEmbeddedAgent({
      sessionId: "test-session",
      sessionKey: "test-key",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "run-1",
    });

    // Check usage in meta
    const usage = result.meta.agentMeta?.usage;
    expect(usage?.input).toBe(250);
    expect(usage?.output).toBe(100);
    expect(usage?.total).toBe(200);

    // Check if total matches the last turn's total (200)
    // If the bug exists, it will likely be 350
    expect(usage?.total).toBe(200);
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
      sessionFile: "/tmp/session.json",
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
