import { describe, expect, it } from "vitest";
import { buildNvidiaProvider } from "./provider-catalog.js";

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.apiKey).toBe("NVIDIA_API_KEY");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
    expect(provider.models.every((model) => model.compat?.requiresStringContent === true)).toBe(
      true,
    );
  });
});
