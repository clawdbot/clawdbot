// Anthropic tests cover provider manifest model catalog behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type AnthropicCatalogModel = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  mediaInput?: {
    image?: {
      maxSidePx?: number;
      preferredSidePx?: number;
      tokenMode?: string;
    };
  };
  contextWindow?: number;
  contextWindows?: Array<{ id: string; label: string; contextWindow: number }>;
  contextWindowDefault?: string;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  thinkingLevelMap?: Record<string, string | null>;
  status?: string;
  replacedBy?: string;
  compat?: { codeMode?: string };
};

type AnthropicManifest = {
  modelCatalog?: {
    providers?: {
      anthropic?: { models?: AnthropicCatalogModel[] };
    };
    discovery?: Record<string, string>;
  };
};

const manifest = JSON.parse(
  readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as AnthropicManifest;
const selectableContextWindowMetadata = {
  contextWindows: [
    { id: "200k", label: "200K", contextWindow: 200_000 },
    { id: "1m", label: "1M", contextWindow: 1_000_000 },
  ],
  contextWindowDefault: "1m",
};

describe("Anthropic plugin manifest", () => {
  it("flags every static Anthropic API model as code-mode preferred", () => {
    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.compat?.codeMode, model.id).toBe("preferred");
    }
  });

  it.each([
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
    {
      id: "claude-fable-5-1",
      name: "Claude Fable 5.1",
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    },
    {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    },
  ])("publishes $name API contracts", ({ id, name, cost, thinkingLevelMap }) => {
    const metadata = {
      id,
      reasoning: true,
      input: ["text", "image"],
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
      contextWindow: 1_000_000,
      ...selectableContextWindowMetadata,
      maxTokens: 128_000,
    };
    const providers = manifest.modelCatalog?.providers;
    expect(providers?.anthropic?.models?.find((model) => model.id === id)).toEqual({
      ...metadata,
      name,
      cost,
      thinkingLevelMap,
      compat: { codeMode: "preferred" },
    });
  });

  it("preserves older Claude API contracts without overstating bare context", () => {
    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    expect(models.find((model) => model.id === "claude-opus-4-8")).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      status: "deprecated",
      replacedBy: "claude-opus-5",
    });
  });

  it("keeps only the dateless Claude Haiku 4.5 identifier in the static catalog", () => {
    expect(manifest.modelCatalog?.discovery?.anthropic).toBe("refreshable");

    const models = manifest.modelCatalog?.providers?.anthropic?.models ?? [];
    expect(models.find((model) => model.id === "claude-haiku-4-5")).toEqual({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: true,
      input: ["text", "image"],
      mediaInput: {
        image: {
          maxSidePx: 1568,
          preferredSidePx: 1568,
          tokenMode: "provider",
        },
      },
      contextWindow: 200000,
      maxTokens: 64000,
      compat: { codeMode: "preferred" },
    });
    expect(models.find((model) => model.id === "claude-haiku-4-5-20251001")).toBeUndefined();
  });
});
