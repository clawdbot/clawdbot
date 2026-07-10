import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  providerAuthAliases?: Record<string, string>;
  modelIdNormalization?: {
    providers?: Record<string, { aliases?: Record<string, string> }>;
  };
  modelCatalog?: {
    suppressions?: Array<{ provider?: string; model?: string }>;
  };
};

const XAI_MULTI_AGENT_MODELS = [
  "grok-4.20-multi-agent-0309",
  "grok-4.20-multi-agent",
  "grok-4.20-multi-agent-latest",
  "grok-4.20-multi-agent-beta-latest",
  "grok-4.20-multi-agent-experimental-beta-0304",
  "grok-4.20-multi-agent-experimental-beta-latest",
  "grok-4.20-multi-agent-beta-0309",
] as const;

describe("xAI plugin manifest", () => {
  it("owns the shipped x-ai auth alias", () => {
    expect(manifest.providerAuthAliases).toEqual({ "x-ai": "xai" });
  });

  it("normalizes the Grok Build latest alias to Grok 4.5", () => {
    expect(manifest.modelIdNormalization?.providers?.xai?.aliases?.["grok-build-latest"]).toBe(
      "grok-4.5",
    );
  });

  it("normalizes current flagship aliases", () => {
    expect(manifest.modelIdNormalization?.providers?.xai?.aliases).toMatchObject({
      "grok-4.3-latest": "grok-4.3",
      "grok-4.5-latest": "grok-4.5",
    });
    expect(manifest.modelIdNormalization?.providers?.xai?.aliases).not.toHaveProperty(
      "grok-latest",
    );
  });

  it("preserves all provider-owned Grok 4.20 aliases", () => {
    for (const id of [
      "grok-4.20-reasoning",
      "grok-4.20-non-reasoning",
      "grok-4.20-beta-latest-reasoning",
      "grok-4.20-beta-latest-non-reasoning",
      "grok-4.20-experimental-beta-0304-reasoning",
      "grok-4.20-experimental-beta-0304-non-reasoning",
    ]) {
      expect(manifest.modelIdNormalization?.providers?.xai?.aliases).not.toHaveProperty(id);
    }
  });

  it("suppresses the unsupported multi-agent model aliases", () => {
    const suppressionRefs = new Set(
      (manifest.modelCatalog?.suppressions ?? []).map(
        (suppression) => `${suppression.provider}/${suppression.model}`,
      ),
    );

    for (const model of XAI_MULTI_AGENT_MODELS) {
      expect(suppressionRefs).toContain(`xai/${model}`);
    }
  });
});
