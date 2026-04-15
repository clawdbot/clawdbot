import { describe, expect, it } from "vitest";
import { resolveAnthropicVertexRegion, resolveAnthropicVertexRegionFromBaseUrl } from "./api.js";

describe("anthropic vertex region helpers", () => {
  it("accepts well-formed regional env values", () => {
    expect(
      resolveAnthropicVertexRegion({
        GOOGLE_CLOUD_LOCATION: "us-east1",
      } as NodeJS.ProcessEnv),
    ).toBe("us-east1");
  });

  it("falls back to the default region for malformed env values", () => {
    expect(
      resolveAnthropicVertexRegion({
        GOOGLE_CLOUD_LOCATION: "us-central1.attacker.example",
      } as NodeJS.ProcessEnv),
    ).toBe("global");
  });

  it("parses regional Vertex endpoints", () => {
    expect(
      resolveAnthropicVertexRegionFromBaseUrl("https://europe-west4-aiplatform.googleapis.com"),
    ).toBe("europe-west4");
  });

  it("treats the global Vertex endpoint as global", () => {
    expect(resolveAnthropicVertexRegionFromBaseUrl("https://aiplatform.googleapis.com")).toBe(
      "global",
    );
  });

  it("does not infer a Vertex region from custom proxy hosts", () => {
    expect(
      resolveAnthropicVertexRegionFromBaseUrl("https://proxy.example.com/google/aiplatform"),
    ).toBeUndefined();
  });
});
