// Google tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import {
  buildGoogleStaticCatalogProvider,
  buildGoogleVertexStaticCatalogProvider,
} from "./provider-catalog.js";

describe("google provider catalog", () => {
  it("registers current Gemini rows for the Google Vertex provider", () => {
    const provider = buildGoogleVertexStaticCatalogProvider();

    expect(provider.api).toBe("google-vertex");
    expect(provider.baseUrl).toBe("https://{location}-aiplatform.googleapis.com");
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"]),
    );
    expect(provider.models.find((model) => model.id === "gemini-3.1-flash-lite")).toMatchObject({
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
    });
  });

  it("keeps Google AI Studio and Vertex model ids aligned", () => {
    expect(buildGoogleVertexStaticCatalogProvider().models.map((model) => model.id)).toEqual(
      buildGoogleStaticCatalogProvider().models.map((model) => model.id),
    );
  });
});
