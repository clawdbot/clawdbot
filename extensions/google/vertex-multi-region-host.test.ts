import { describe, expect, it } from "vitest";
import { isGoogleVertexHostname } from "./provider-policy.js";

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
