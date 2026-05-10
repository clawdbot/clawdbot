import { describe, expect, it } from "vitest";
import {
  buildFallbackNotice,
  resolveActiveFallbackState,
  resolveFallbackTransition,
  type FallbackNoticeState,
} from "./fallback-state.js";

const baseAttempt = {
  provider: "demo-primary",
  model: "demo-primary/model-a",
  error: "Provider demo-primary is in cooldown (all profiles unavailable)",
  reason: "rate_limit" as const,
};

const activeFallbackState: FallbackNoticeState = {
  fallbackNoticeSelectedModel: "demo-primary/model-a",
  fallbackNoticeActiveModel: "demo-fallback/model-b",
  fallbackNoticeReason: "rate limit",
};

function resolveDemoFallbackTransition(
  overrides: Partial<Parameters<typeof resolveFallbackTransition>[0]> = {},
) {
  return resolveFallbackTransition({
    selectedProvider: "demo-primary",
    selectedModel: "model-a",
    activeProvider: "demo-fallback",
    activeModel: "model-b",
    attempts: [baseAttempt],
    state: {},
    ...overrides,
  });
}

describe("fallback-state", () => {
  it.each([
    {
      name: "treats fallback as active only when state matches selected and active refs",
      state: activeFallbackState,
      expected: { active: true, reason: "rate limit" },
    },
    {
      name: "does not treat runtime drift as fallback when persisted state does not match",
      state: {
        fallbackNoticeSelectedModel: "other-provider/other-model",
        fallbackNoticeActiveModel: "demo-fallback/model-b",
        fallbackNoticeReason: "rate limit",
      } satisfies FallbackNoticeState,
      expected: { active: false, reason: undefined },
    },
  ])("$name", ({ state, expected }) => {
    const resolved = resolveActiveFallbackState({
      selectedModelRef: "demo-primary/model-a",
      activeModelRef: "demo-fallback/model-b",
      state,
    });

    expect(resolved).toEqual(expected);
  });

  it("marks fallback transition when selected->active pair changes", () => {
    const resolved = resolveDemoFallbackTransition();

    expect(resolved.fallbackActive).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(true);
    expect(resolved.fallbackCleared).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.reasonSummary).toBe("rate limit");
    expect(resolved.nextState.selectedModel).toBe("demo-primary/model-a");
    expect(resolved.nextState.activeModel).toBe("demo-fallback/model-b");
  });

  it("normalizes fallback reason whitespace for summaries", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, reason: "rate_limit\n\tburst" }],
    });

    expect(resolved.reasonSummary).toBe("rate limit burst");
  });

  it("prefers formatted transient error details over generic rate-limit labels", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [
        {
          ...baseAttempt,
          error: "429 Too Many Requests: Claude Max usage limit reached, try again in 6 minutes.",
        },
      ],
    });

    expect(resolved.reasonSummary).toContain("HTTP 429: Too Many Requests");
    expect(resolved.reasonSummary).toContain("Claude Max usage limit reached");
  });

  it("refreshes reason when fallback remains active with same model pair", () => {
    const resolved = resolveDemoFallbackTransition({
      attempts: [{ ...baseAttempt, reason: "timeout" }],
      state: activeFallbackState,
    });

    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.reason).toBe("timeout");
  });

  it("marks fallback as cleared when runtime returns to selected model", () => {
    const resolved = resolveDemoFallbackTransition({
      activeProvider: "demo-primary",
      selectedModel: "model-a",
      activeModel: "model-a",
      attempts: [],
      state: activeFallbackState,
    });

    expect(resolved.fallbackActive).toBe(false);
    expect(resolved.fallbackCleared).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.selectedModel).toBeUndefined();
    expect(resolved.nextState.activeModel).toBeUndefined();
    expect(resolved.nextState.reason).toBeUndefined();
  });

  it("does not treat a CLI runtime alias as a model fallback", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-7",
      activeProvider: "claude-cli",
      activeModel: "claude-opus-4-7",
      attempts: [],
      state: {
        fallbackNoticeSelectedModel: "anthropic/claude-opus-4-7",
        fallbackNoticeActiveModel: "claude-cli/claude-opus-4-7",
        fallbackNoticeReason: "selected model unavailable",
      },
    });

    expect(resolved.fallbackActive).toBe(false);
    expect(resolved.fallbackCleared).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.selectedModel).toBeUndefined();
    expect(resolved.nextState.activeModel).toBeUndefined();
  });

  it("does not build a fallback notice for equivalent CLI runtime aliases", () => {
    expect(
      buildFallbackNotice({
        selectedProvider: "anthropic",
        selectedModel: "claude-opus-4-7",
        activeProvider: "claude-cli",
        activeModel: "claude-opus-4-7",
        attempts: [],
      }),
    ).toBeNull();
  });
});
