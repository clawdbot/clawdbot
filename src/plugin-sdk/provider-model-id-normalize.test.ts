import { describe, expect, it } from "vitest";
import { normalizeGooglePreviewModelId } from "./provider-model-id-normalize.js";

describe("provider model id normalization", () => {
  it("routes bare Gemini 3 Pro to the current Gemini 3.1 Pro preview", () => {
    expect(normalizeGooglePreviewModelId("gemini-3-pro")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("does not rewrite already-current Gemini replacement ids", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });
});
