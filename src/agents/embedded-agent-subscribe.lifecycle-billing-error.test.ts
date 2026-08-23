// Lifecycle billing error tests ensure subscription error events include enough
// provider/model context for users to fix account or quota issues.
import { describe, expect, it, vi } from "vitest";
import {
  createSubscribedSessionHarness,
  emitAssistantLifecycleErrorAndEnd,
  findLifecycleErrorAgentEvent,
} from "./embedded-agent-subscribe.e2e-harness.js";

describe("subscribeEmbeddedAgentSession lifecycle billing errors", () => {
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
});
