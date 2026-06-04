// Tests model picker item construction and provider endpoint labeling.
import { describe, expect, it } from "vitest";
import {
  buildModelPickerItems,
  resolveProviderEndpointLabel,
} from "./directive-handling.model-picker.js";

describe("directive-handling.model-picker", () => {
  it("preserves distinct provider ids when building picker items", () => {
    expect(
      buildModelPickerItems([
        { provider: "z.ai", id: "glm-5" },
        { provider: "z-ai", id: "glm-5" },
      ]),
    ).toEqual([
      { provider: "z-ai", model: "glm-5" },
      { provider: "z.ai", model: "glm-5" },
    ]);
  });

  it("matches provider endpoint labels for exact provider ids", () => {
    const result = resolveProviderEndpointLabel("z.ai", {
      models: {
        providers: {
          "z.ai": {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "responses",
          },
        },
      },
    } as never);

    expect(result).toEqual({
      endpoint: "https://api.z.ai/api/paas/v4",
      api: "responses",
    });
  });
});
