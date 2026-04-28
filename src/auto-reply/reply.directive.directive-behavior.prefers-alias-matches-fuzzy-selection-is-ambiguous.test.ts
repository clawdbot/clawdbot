import { describe, expect, it } from "vitest";
import type { ModelAliasIndex } from "../agents/model-selection-shared.js";
import { resolveModelDirectiveSelection } from "./reply/model-selection-directive.js";

const emptyAliasIndex: ModelAliasIndex = {
  byAlias: new Map(),
  byKey: new Map(),
};

function resolveModel(
  raw: string,
  params?: {
    allowedModelKeys?: string[];
    aliasIndex?: ModelAliasIndex;
    defaultProvider?: string;
    defaultModel?: string;
  },
) {
  return resolveModelDirectiveSelection({
    raw,
    defaultProvider: params?.defaultProvider ?? "anthropic",
    defaultModel: params?.defaultModel ?? "claude-opus-4-6",
    aliasIndex: params?.aliasIndex ?? emptyAliasIndex,
    allowedModelKeys: new Set(params?.allowedModelKeys ?? []),
  });
}

describe("directive behavior model fuzzy selection", () => {
  it("supports unambiguous fuzzy model matches across /model forms", () => {
    const allowedModelKeys = ["anthropic/claude-opus-4-6", "moonshot/kimi-k2-0905-preview"];

    for (const raw of ["kimi", "kimi-k2-0905-preview", "moonshot/kimi"]) {
      expect(resolveModel(raw, { allowedModelKeys }).selection).toEqual({
        provider: "moonshot",
        model: "kimi-k2-0905-preview",
        isDefault: false,
      });
    }
  });

  it("picks the best fuzzy match for global and provider-scoped minimax queries", () => {
    expect(
      resolveModel("minimax", {
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        allowedModelKeys: [
          "minimax/MiniMax-M2.7",
          "minimax/MiniMax-M2.7-highspeed",
          "lmstudio/minimax-m2.5-gs32",
        ],
      }).selection,
    ).toEqual({
      provider: "minimax",
      model: "MiniMax-M2.7",
      isDefault: true,
    });

    expect(
      resolveModel("minimax/highspeed", {
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        allowedModelKeys: ["minimax/MiniMax-M2.7", "minimax/MiniMax-M2.7-highspeed"],
      }).selection,
    ).toEqual({
      provider: "minimax",
      model: "MiniMax-M2.7-highspeed",
      isDefault: false,
    });
  });

  it("prefers alias matches when fuzzy selection is ambiguous", () => {
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "kimi",
          {
            alias: "Kimi",
            ref: { provider: "moonshot", model: "kimi-k2-0905-preview" },
          },
        ],
      ]),
      byKey: new Map([["moonshot/kimi-k2-0905-preview", ["Kimi"]]]),
    };

    expect(
      resolveModel("ki", {
        aliasIndex,
        allowedModelKeys: [
          "anthropic/claude-opus-4-6",
          "moonshot/kimi-k2-0905-preview",
          "lmstudio/kimi-k2-0905-preview",
        ],
      }).selection,
    ).toEqual({
      provider: "moonshot",
      model: "kimi-k2-0905-preview",
      isDefault: false,
      alias: "Kimi",
    });
  });
});
