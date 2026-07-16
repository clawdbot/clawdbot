import { describe, expect, it } from "vitest";
import { getStaticVercelAiGatewayModelCatalog, VERCEL_AI_GATEWAY_BASE_URL } from "./api.js";
import { buildVercelAiGatewayProvider } from "./provider-catalog.js";

describe("vercel ai gateway provider catalog", () => {
  it("builds the bundled Vercel AI Gateway defaults", async () => {
    const provider = await buildVercelAiGatewayProvider();

    expect(provider.baseUrl).toBe(VERCEL_AI_GATEWAY_BASE_URL);
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.models?.map((model) => model.id)).toEqual(
      expect.arrayContaining(["anthropic/claude-opus-4.6", "openai/gpt-5.4", "openai/gpt-5.4-pro"]),
    );
  });

  it("exposes the static fallback model catalog", () => {
    expect(getStaticVercelAiGatewayModelCatalog().map((model) => model.id)).toEqual(
      expect.arrayContaining(["anthropic/claude-opus-4.6", "openai/gpt-5.4", "openai/gpt-5.4-pro"]),
    );
  });
});
