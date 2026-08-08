// MiniMax tests cover plugin-owned doctor compatibility migrations.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";

const M3_IMAGE_CAPABLE_MODEL = {
  id: "MiniMax-M3",
  name: "MiniMax M3",
  input: ["text", "image"],
};

describe("MiniMax doctor contract", () => {
  it("repairs persisted Anthropic-compatible M3 image metadata", () => {
    const config = {
      models: {
        providers: {
          minimax: {
            api: "anthropic-messages",
            models: [M3_IMAGE_CAPABLE_MODEL, { id: "custom", input: ["text", "image"] }],
          },
          "minimax-cn": {
            models: [{ ...M3_IMAGE_CAPABLE_MODEL }],
          },
          "minimax-portal": {
            models: [{ ...M3_IMAGE_CAPABLE_MODEL }],
          },
          "minimax-portal-cn": {
            api: "anthropic-messages",
            models: [{ ...M3_IMAGE_CAPABLE_MODEL }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      legacyConfigRules.filter((rule) => rule.match(readPath(config, rule.path))),
    ).toHaveLength(4);

    const result = normalizeCompatibilityConfig({ cfg: config });

    expect(result.changes).toEqual([
      "Removed the unsupported image input from models.providers.minimax.models MiniMax-M3.",
      "Removed the unsupported image input from models.providers.minimax-cn.models MiniMax-M3.",
      "Removed the unsupported image input from models.providers.minimax-portal.models MiniMax-M3.",
      "Removed the unsupported image input from models.providers.minimax-portal-cn.models MiniMax-M3.",
    ]);
    expect(result.config.models?.providers?.minimax?.models).toEqual([
      { ...M3_IMAGE_CAPABLE_MODEL, input: ["text"] },
      { id: "custom", input: ["text", "image"] },
    ]);
    expect(result.config.models?.providers?.["minimax-portal"]?.models).toEqual([
      { ...M3_IMAGE_CAPABLE_MODEL, input: ["text"] },
    ]);
    expect(result.config.models?.providers?.["minimax-cn"]?.models).toEqual([
      { ...M3_IMAGE_CAPABLE_MODEL, input: ["text"] },
    ]);
    expect(result.config.models?.providers?.["minimax-portal-cn"]?.models).toEqual([
      { ...M3_IMAGE_CAPABLE_MODEL, input: ["text"] },
    ]);
    expect(config.models?.providers?.minimax?.models?.[0]?.input).toEqual(["text", "image"]);
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("leaves explicit OpenAI-compatible M3 metadata unchanged", () => {
    const config = {
      models: {
        providers: {
          minimax: {
            api: "openai-completions",
            models: [M3_IMAGE_CAPABLE_MODEL],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(normalizeCompatibilityConfig({ cfg: config })).toEqual({ config, changes: [] });
  });
});

function readPath(root: unknown, path: readonly (string | number)[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}
