// Tests model picker item construction and provider endpoint labeling.
import { describe, expect, it } from "vitest";
import { resolveProviderEndpointLabel } from "./directive-handling.model-picker.js";

describe("directive-handling.model-picker", () => {
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
