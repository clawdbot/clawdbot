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

  it("does not mistake snapshot dates for minor versions", () => {
    // claude-opus-4-20250514 is 4.0; a naive parse reads 4.20 and would treat it
    // as newer than every released generation.
    expect(resolveModel("claude-opus-4-20250514")?.params?.canonicalModelId).toBeUndefined();
    expect(supportsClaudeAdaptiveThinking({ id: "claude-haiku-4-5-20251001" })).toBe(false);
  });

  it("clones released snapshot ids from their dateless manifest template", () => {
    expect(resolveModel("claude-haiku-4-5-20251001")).toEqual({
      id: "claude-haiku-4-5-20251001",
      name: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      mediaInput: {
        image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
      compat: { codeMode: "preferred" },
    });
    expect(resolveModel("claude-haiku-4-9-20251001")).toBeUndefined();
  });

  it("carries manifest catalog compat onto hand-built modern rows", () => {
    // The hand-built forward-compat row replaces the catalog row when the
    // runtime prefers plugin-resolved modern models. Dropping compat here
    // silently disables catalog-driven behavior such as codeMode "auto",
    // including on env-key-only runs whose model registry is empty.
    expect(resolveModel("claude-opus-5")?.compat).toEqual({ codeMode: "preferred" });
    expect(resolveModel("claude-sonnet-5")?.compat).toEqual({ codeMode: "preferred" });
    // The Claude CLI provider rows are intentionally unflagged: those runs use
    // the CLI harness where OpenClaw code mode does not apply.
    expect(resolveModel("claude-opus-5", "claude-cli")?.compat).toBeUndefined();
  });

  it("prefers registry compat over the manifest index", () => {
    const model = buildAnthropicProvider().resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-opus-5",
      config: {},
      modelRegistry: {
        find: () => ({ compat: { codeMode: "capable" } }),
      },
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof buildAnthropicProvider>["resolveDynamicModel"]>
    >[0]);
    expect(model?.compat).toEqual({ codeMode: "capable" });
  });

  it("does not claim non-Claude ids", () => {
    // Third-party models reach the Anthropic-compatible transport too.
    expect(resolveModel("mimo-v2-flash")).toBeUndefined();
    expect(resolveModel("kimi-k2.6")).toBeUndefined();
  });
});
