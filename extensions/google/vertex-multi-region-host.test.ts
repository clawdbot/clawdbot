import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { isGoogleVertexHostname } from "./provider-policy.js";
import { resolveGoogleVertexBaseOrigin } from "./transport-stream.js";

// Minimal Vertex model whose baseUrl carries the {location} template, so the
// base-origin resolver falls through to location-based host construction
// (the configured-baseUrl early return only fires for a literal host).
function buildModel(overrides: Partial<Model<"google-vertex">> = {}): Model<"google-vertex"> {
  return {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    api: "google-vertex",
    provider: "google-vertex",
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

describe("Google Vertex multi-region host construction", () => {
  const model = buildModel();

  it("routes the eu multi-region to the dedicated .rep.googleapis.com host", () => {
    expect(resolveGoogleVertexBaseOrigin(model, "eu")).toBe(
      "https://aiplatform.eu.rep.googleapis.com",
    );
  });

  it("routes the us multi-region to the dedicated .rep.googleapis.com host", () => {
    expect(resolveGoogleVertexBaseOrigin(model, "us")).toBe(
      "https://aiplatform.us.rep.googleapis.com",
    );
  });

  it("keeps the unprefixed host for the global location", () => {
    expect(resolveGoogleVertexBaseOrigin(model, "global")).toBe(
      "https://aiplatform.googleapis.com",
    );
  });

  it("keeps the regional prefix for normal regions", () => {
    expect(resolveGoogleVertexBaseOrigin(model, "europe-west1")).toBe(
      "https://europe-west1-aiplatform.googleapis.com",
    );
  });
});

describe("Google Vertex hostname recognition", () => {
  it("recognizes the multi-region rep host as a Vertex host", () => {
    expect(isGoogleVertexHostname("aiplatform.eu.rep.googleapis.com")).toBe(true);
    expect(isGoogleVertexHostname("aiplatform.us.rep.googleapis.com")).toBe(true);
  });

  it("does not classify unrelated rep hosts as Vertex hosts", () => {
    expect(isGoogleVertexHostname("discoveryengine.eu.rep.googleapis.com")).toBe(false);
    expect(isGoogleVertexHostname("not-aiplatform.eu.rep.googleapis.com")).toBe(false);
  });

  it("still recognizes the unprefixed and regional Vertex hosts", () => {
    expect(isGoogleVertexHostname("aiplatform.googleapis.com")).toBe(true);
    expect(isGoogleVertexHostname("europe-west1-aiplatform.googleapis.com")).toBe(true);
  });
});
