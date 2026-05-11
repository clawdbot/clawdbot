import { describe, expect, it } from "vitest";
import { getStaticVercelAiGatewayModelCatalog, VERCEL_AI_GATEWAY_BASE_URL } from "./api.js";
import {
  buildStaticVercelAiGatewayProvider,
  buildVercelAiGatewayProvider,
} from "./provider-catalog.js";

const STATIC_MODEL_IDS = [
  "anthropic/claude-opus-4.6",
  "openai/gpt-5.4",
  "openai/gpt-5.4-pro",
  "moonshotai/kimi-k2.6",
];

describe("vercel ai gateway provider catalog", () => {
  it("builds the bundled Vercel AI Gateway defaults", async () => {
    const provider = await buildVercelAiGatewayProvider();

    expect(provider).toStrictEqual({
      baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
      api: "anthropic-messages",
      models: getStaticVercelAiGatewayModelCatalog(),
    });
  });

  it("exposes the static fallback model catalog", () => {
    expect(getStaticVercelAiGatewayModelCatalog().map((model) => model.id)).toStrictEqual(
      STATIC_MODEL_IDS,
    );
  });

  it("builds an offline static provider catalog", () => {
    expect(buildStaticVercelAiGatewayProvider()).toStrictEqual({
      baseUrl: VERCEL_AI_GATEWAY_BASE_URL,
      api: "anthropic-messages",
      models: getStaticVercelAiGatewayModelCatalog(),
    });
  });
});
