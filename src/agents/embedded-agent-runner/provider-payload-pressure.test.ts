import { describe, expect, it } from "vitest";
import { estimateProviderPayloadTokenPressure } from "./provider-payload-pressure.js";

describe("estimateProviderPayloadTokenPressure", () => {
  it("counts text content at the shared chars-per-token heuristic", () => {
    const estimate = estimateProviderPayloadTokenPressure({
      messages: [{ role: "user", content: "x".repeat(4_000) }],
    });
    expect(estimate).toBeGreaterThanOrEqual(1_000);
    expect(estimate).toBeLessThan(1_200);
  });

  it("flat-rates long data urls and media-key blobs regardless of byte length", () => {
    const dataUrl = estimateProviderPayloadTokenPressure({
      input: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(400_000)}` }],
    });
    expect(dataUrl).toBeLessThan(2_100);

    const mediaKey = estimateProviderPayloadTokenPressure({
      contents: [{ parts: [{ inline_data: { data: "B".repeat(400_000) } }] }],
    });
    expect(mediaKey).toBeLessThan(2_100);
  });

  it("counts short strings under media keys as ordinary text", () => {
    const estimate = estimateProviderPayloadTokenPressure({
      input: [{ type: "input_image", image_url: "https://example.test/small.png" }],
    });
    expect(estimate).toBeLessThan(100);
  });
});
