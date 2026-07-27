// Anthropic tests cover forward-compat resolution for unreleased Claude ids.
import { supportsClaudeAdaptiveThinking } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { buildAnthropicProvider } from "./register.runtime.js";

function resolveModel(modelId: string, provider = "anthropic") {
  return buildAnthropicProvider().resolveDynamicModel?.({
    provider,
    modelId,
    config: {},
    // Released point releases resolve by cloning a catalog template; an empty
    // registry keeps this test on the generation path under test.
    modelRegistry: { find: () => undefined },
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof buildAnthropicProvider>["resolveDynamicModel"]>
  >[0]);
}

describe("unreleased Claude generations", () => {
  it.each(["claude-opus-6", "claude-sonnet-6", "claude-opus-5-1"])(
    "resolves %s onto the newest known contract",
    (modelId) => {
      const model = resolveModel(modelId);
      expect(model).toBeDefined();
      // Without a canonical stamp the shared contracts fall through to pre-4.6
      // shaping (budget_tokens + caller sampling), which current models reject.
      expect(supportsClaudeAdaptiveThinking({ id: modelId, params: model?.params })).toBe(true);
    },
  );

  it("keeps the family when it recognizes one", () => {
    expect(resolveModel("claude-sonnet-6")?.params?.canonicalModelId).toBe("claude-sonnet-5");
    expect(resolveModel("claude-opus-6")?.params?.canonicalModelId).toBe("claude-opus-5");
  });

  it("does not stamp a canonical id onto released models", () => {
    // Released ids already carry their own contract; re-pointing them would
    // silently change shaping for models that work today.
    expect(resolveModel("claude-opus-5")?.params?.canonicalModelId).toBeUndefined();
    expect(resolveModel("claude-opus-4-8")?.params?.canonicalModelId).toBeUndefined();
  });

  it("leaves pre-4.6 and snapshot-dated ids alone", () => {
    // claude-opus-4-20250514 is 4.0; a naive parse reads 4.20 and would treat it
    // as newer than every released generation.
    expect(resolveModel("claude-opus-4-20250514")?.params?.canonicalModelId).toBeUndefined();
    expect(supportsClaudeAdaptiveThinking({ id: "claude-haiku-4-5-20251001" })).toBe(false);
  });

  it("does not claim non-Claude ids", () => {
    // Third-party models reach the Anthropic-compatible transport too.
    expect(resolveModel("mimo-v2-flash")).toBeUndefined();
    expect(resolveModel("kimi-k2.6")).toBeUndefined();
  });
});
