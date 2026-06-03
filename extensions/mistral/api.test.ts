import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  applyMistralModelCompat,
  MISTRAL_MEDIUM_3_5_ID,
  MISTRAL_MODEL_TRANSPORT_PATCH,
  MISTRAL_SMALL_LATEST_ID,
  resolveMistralCompatPatch,
} from "./api.js";
import mistralPlugin from "./index.js";

type MistralCompatShape = {
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  reasoningEffortMap?: Record<string, string>;
  supportsLongCacheRetention?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsReasoningEffort?: boolean;
  supportsStore?: boolean;
};

function readCompat(model: unknown): MistralCompatShape | undefined {
  return (model as { compat?: MistralCompatShape }).compat;
}

function supportsStore(model: unknown): boolean | undefined {
  return readCompat(model)?.supportsStore;
}

function supportsPromptCacheKey(model: unknown): boolean | undefined {
  return readCompat(model)?.supportsPromptCacheKey;
}

function supportsLongCacheRetention(model: unknown): boolean | undefined {
  return readCompat(model)?.supportsLongCacheRetention;
}

function supportsReasoningEffort(model: unknown): boolean | undefined {
  return readCompat(model)?.supportsReasoningEffort;
}

function maxTokensField(model: unknown): "max_completion_tokens" | "max_tokens" | undefined {
  return readCompat(model)?.maxTokensField;
}

function reasoningEffortMap(model: unknown): Record<string, string> | undefined {
  return readCompat(model)?.reasoningEffortMap;
}

const MISTRAL_REASONING_EFFORT_MAP = {
  off: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
  adaptive: "high",
  max: "high",
};

describe("resolveMistralCompatPatch", () => {
  it("enables reasoning_effort mapping for mistral-small-latest", () => {
    expect(resolveMistralCompatPatch({ id: MISTRAL_SMALL_LATEST_ID })).toEqual({
      supportsStore: false,
      supportsPromptCacheKey: true,
      supportsLongCacheRetention: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      reasoningEffortMap: MISTRAL_REASONING_EFFORT_MAP,
    });
  });

  it("enables reasoning_effort mapping for mistral-medium-3-5", () => {
    expect(resolveMistralCompatPatch({ id: MISTRAL_MEDIUM_3_5_ID })).toEqual({
      supportsStore: false,
      supportsPromptCacheKey: true,
      supportsLongCacheRetention: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      reasoningEffortMap: MISTRAL_REASONING_EFFORT_MAP,
    });
  });

  it("disables reasoning_effort for other Mistral model ids", () => {
    expect(resolveMistralCompatPatch({ id: "mistral-large-latest" })).toEqual({
      ...MISTRAL_MODEL_TRANSPORT_PATCH,
      supportsReasoningEffort: false,
    });
  });
});

describe("applyMistralModelCompat", () => {
  it("applies the Mistral request-shape compat flags", () => {
    const normalized = applyMistralModelCompat({});
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsPromptCacheKey(normalized)).toBe(true);
    expect(supportsLongCacheRetention(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(false);
    expect(maxTokensField(normalized)).toBe("max_tokens");
    expect(reasoningEffortMap(normalized)).toBeUndefined();
  });

  it("applies reasoning compat for mistral-small-latest", () => {
    const normalized = applyMistralModelCompat({ id: MISTRAL_SMALL_LATEST_ID });
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(reasoningEffortMap(normalized)?.high).toBe("high");
    expect(reasoningEffortMap(normalized)?.off).toBe("none");
  });

  it("applies reasoning compat for mistral-medium-3-5", () => {
    const normalized = applyMistralModelCompat({ id: MISTRAL_MEDIUM_3_5_ID });
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(reasoningEffortMap(normalized)?.high).toBe("high");
    expect(reasoningEffortMap(normalized)?.off).toBe("none");
  });

  it("overrides explicit compat values that would trigger 422s", () => {
    const normalized = applyMistralModelCompat({
      compat: {
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_completion_tokens" as const,
      },
    });
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(false);
    expect(maxTokensField(normalized)).toBe("max_tokens");
  });

  it("overrides explicit compat on mistral-small-latest except reasoning enablement", () => {
    const normalized = applyMistralModelCompat({
      id: MISTRAL_SMALL_LATEST_ID,
      compat: {
        supportsStore: true,
        supportsReasoningEffort: false,
        maxTokensField: "max_completion_tokens" as const,
      },
    });
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(maxTokensField(normalized)).toBe("max_tokens");
  });

  it("returns the same object when the compat patch is already present", () => {
    const model = {
      compat: {
        supportsStore: false,
        supportsPromptCacheKey: true,
        supportsLongCacheRetention: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens" as const,
      },
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("returns the same object when mistral-small-latest compat is fully normalized", () => {
    const model = {
      id: MISTRAL_SMALL_LATEST_ID,
      compat: resolveMistralCompatPatch({ id: MISTRAL_SMALL_LATEST_ID }),
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("returns the same object when mistral-medium-3-5 compat is fully normalized", () => {
    const model = {
      id: MISTRAL_MEDIUM_3_5_ID,
      compat: resolveMistralCompatPatch({ id: MISTRAL_MEDIUM_3_5_ID }),
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("exposes thinking profile levels for mistral-medium-3-5", async () => {
    const provider = await registerSingleProviderPlugin(mistralPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "mistral",
        modelId: MISTRAL_MEDIUM_3_5_ID,
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "high" }], defaultLevel: "off" });
  });
});
