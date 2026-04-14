import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  normalizeModelRefMock: vi.fn(),
}));

vi.mock("../model-selection.js", async () => {
  const actual =
    await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js");
  return {
    ...actual,
    normalizeModelRef: (...args: Parameters<typeof actual.normalizeModelRef>) =>
      state.normalizeModelRefMock(...args),
  };
});

let resolveModelFromRegistry: typeof import("./media-tool-shared.js").resolveModelFromRegistry;

describe("resolveModelFromRegistry", () => {
  beforeAll(async () => {
    ({ resolveModelFromRegistry } = await import("./media-tool-shared.js"));
  });

  beforeEach(() => {
    state.normalizeModelRefMock
      .mockReset()
      .mockImplementation((provider: string, model: string) => ({
        provider: provider.trim().toLowerCase(),
        model: model.trim().replace(/^ollama\//, ""),
      }));
  });

  it("normalizes provider and model refs before registry lookup", () => {
    const foundModel = { provider: "ollama", id: "qwen3.5:397b-cloud" };
    const find = vi.fn(() => foundModel);

    const result = resolveModelFromRegistry({
      modelRegistry: { find },
      provider: " OLLAMA ",
      modelId: "ollama/qwen3.5:397b-cloud",
    });

    expect(state.normalizeModelRefMock).toHaveBeenCalledWith(
      " OLLAMA ",
      "ollama/qwen3.5:397b-cloud",
    );
    expect(find).toHaveBeenCalledWith("ollama", "qwen3.5:397b-cloud");
    expect(result).toBe(foundModel);
  });

  it("reports the normalized ref when the registry lookup misses", () => {
    const find = vi.fn(() => null);

    expect(() =>
      resolveModelFromRegistry({
        modelRegistry: { find },
        provider: " OLLAMA ",
        modelId: "ollama/qwen3.5:397b-cloud",
      }),
    ).toThrow("Unknown model: ollama/qwen3.5:397b-cloud");
  });
});
