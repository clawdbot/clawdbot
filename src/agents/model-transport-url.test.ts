import { describe, expect, it } from "vitest";
import {
  formatModelTransportDebugBaseUrl,
  formatModelTransportDebugUrl,
} from "./model-transport-url.js";
import { __testing as openAITesting } from "./openai-transport-stream.js";

describe("model transport diagnostic URLs", () => {
  it("redacts credentials and request secrets from fetch URLs", () => {
    expect(
      formatModelTransportDebugUrl(
        "https://user:token@example.com/v1/responses?api-key=secret#fragment",
      ),
    ).toBe("https://example.com/v1/responses");
  });

  it("redacts credentials and query params from model base URLs", () => {
    const baseUrl = "https://tenant:password@example.openai.azure.com/openai/v1?api-version=secret";
    expect(formatModelTransportDebugBaseUrl(baseUrl)).toBe(
      "https://example.openai.azure.com/openai/v1",
    );
    expect(openAITesting.formatModelTransportDebugBaseUrl(baseUrl)).toBe(
      "https://example.openai.azure.com/openai/v1",
    );
  });

  it("does not echo unparsable URL strings", () => {
    expect(formatModelTransportDebugUrl("https://user:token@")).toBe("<invalid-url>");
    expect(formatModelTransportDebugBaseUrl(undefined)).toBe("default");
  });
});
