// Minimax tests cover model definitions plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildMinimaxApiModelDefinition,
  buildMinimaxModelDefinition,
  DEFAULT_MINIMAX_MAX_TOKENS,
  MINIMAX_API_COST,
  MINIMAX_HOSTED_MODEL_ID,
} from "./model-definitions.js";
import { MINIMAX_TEXT_MODEL_CATALOG } from "./provider-models.js";

const MINIMAX_M3_CATALOG_CONTEXT_WINDOW = MINIMAX_TEXT_MODEL_CATALOG["MiniMax-M3"].contextWindow;
const EXPECTED_DEFAULT_CONTEXT_WINDOW = 204800;

describe("minimax model definitions", () => {
  it("uses M3 as default hosted model", () => {
    expect(MINIMAX_HOSTED_MODEL_ID).toBe("MiniMax-M3");
  });

  it("uses the current upstream MiniMax context, token, and pricing defaults", () => {
    expect(MINIMAX_M3_CATALOG_CONTEXT_WINDOW).toBe(1_000_000);
    expect(buildMinimaxApiModelDefinition("MiniMax-Future").contextWindow).toBe(
      EXPECTED_DEFAULT_CONTEXT_WINDOW,
    );
    expect(DEFAULT_MINIMAX_MAX_TOKENS).toBe(131072);
    expect(MINIMAX_API_COST).toEqual({
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: 0,
    });
  });

  it("builds catalog model with M3 metadata from the catalog", () => {
    const model = buildMinimaxModelDefinition({
      id: "MiniMax-M3",
      cost: MINIMAX_API_COST,
      contextWindow: MINIMAX_M3_CATALOG_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toEqual({
      contextWindow: MINIMAX_M3_CATALOG_CONTEXT_WINDOW,
      cost: MINIMAX_API_COST,
      id: "MiniMax-M3",
      input: ["text", "image"],
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
      name: "MiniMax M3",
      reasoning: true,
    });
  });

  it("builds non-catalog model with generated name and default reasoning", () => {
    const model = buildMinimaxModelDefinition({
      id: "MiniMax-M2.5",
      cost: MINIMAX_API_COST,
      contextWindow: EXPECTED_DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
    });
    expect(model).toEqual({
      contextWindow: EXPECTED_DEFAULT_CONTEXT_WINDOW,
      cost: MINIMAX_API_COST,
      id: "MiniMax-M2.5",
      input: ["text"],
      maxTokens: DEFAULT_MINIMAX_MAX_TOKENS,
      name: "MiniMax MiniMax-M2.5",
      reasoning: false,
    });
  });

  it("builds API model definition with standard cost for M3", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M3");
    expect(model.cost).toEqual(MINIMAX_API_COST);
    expect(model.contextWindow).toBe(MINIMAX_M3_CATALOG_CONTEXT_WINDOW);
    expect(model.maxTokens).toBe(DEFAULT_MINIMAX_MAX_TOKENS);
    expect(model.input).toEqual(["text", "image"]);
  });

  it("falls back to generated name for unknown model id", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-Future");
    expect(model.name).toBe("MiniMax MiniMax-Future");
    expect(model.reasoning).toBe(false);
  });

  it("keeps M2.7 on its existing price and text-only metadata", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
    expect(model.contextWindow).toBe(EXPECTED_DEFAULT_CONTEXT_WINDOW);
  });

  it("keeps M2.7 text-only on the Anthropic-compatible chat path", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7");
    expect(model.input).toEqual(["text"]);
  });

  it("keeps M2.7-highspeed text-only on the Anthropic-compatible chat path", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.7-highspeed");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 });
  });

  it("M2.5 model remains text-only", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5");
    expect(model.input).toEqual(["text"]);
    expect(model.cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 });
  });

  it("M2.5-highspeed keeps the M2.5 cache-read pricing", () => {
    const model = buildMinimaxApiModelDefinition("MiniMax-M2.5-highspeed");
    expect(model.cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.03, cacheWrite: 0.375 });
  });
});
