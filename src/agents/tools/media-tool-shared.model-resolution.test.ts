import { describe, expect, it, vi } from "vitest";
import { resolveModelFromRegistry } from "./media-tool-shared.js";

describe("resolveModelFromRegistry", () => {
  it("normalizes provider and model refs before registry lookup", () => {
    const foundModel = { provider: "ollama", id: "qwen3.5:397b-cloud" };
    const find = vi.fn(() => foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: { find },
      provider: " OLLAMA ",
      modelId: " qwen3.5:397b-cloud ",
    });

    expect(find).toHaveBeenCalledWith("ollama", "qwen3.5:397b-cloud");
    expect(result).toBe(foundModel);
  });

  it("reports the normalized ref when the registry lookup misses", () => {
    const find = vi.fn(() => null);

    expect(() =>
      resolveModelFromRegistry({
        modelRegistry: { find },
        provider: " OLLAMA ",
        modelId: " qwen3.5:397b-cloud ",
      }),
    ).toThrow("Unknown model: ollama/qwen3.5:397b-cloud");
  });

  it("falls back to provider-prefixed custom model IDs", () => {
    const foundModel = { provider: "kimchi", id: "kimchi/claude-opus-4-6" };
    const find = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: { find },
      provider: "kimchi",
      modelId: "claude-opus-4-6",
    });

    expect(find.mock.calls).toEqual([
      ["kimchi", "claude-opus-4-6"],
      ["kimchi", "kimchi/claude-opus-4-6"],
    ]);
    expect(result).toBe(foundModel);
  });
});
