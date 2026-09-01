// Model Catalog Core tests cover provider model id normalize behavior.
import { describe, expect, it } from "vitest";
import { normalizeGooglePreviewModelId } from "./provider-model-id-normalize.js";

describe("provider model id normalization", () => {
  it("routes bare Gemini 3 Pro to the current Gemini 3.1 Pro preview", () => {
    expect(normalizeGooglePreviewModelId("gemini-3-pro")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("routes provider-prefixed Gemini 3 Pro to the current Gemini 3.1 Pro preview", () => {
    expect(normalizeGooglePreviewModelId("google/gemini-3-pro-preview")).toBe(
      "google/gemini-3.1-pro-preview",
    );
  });

  it("does not rewrite already-current Gemini replacement ids", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("maps deprecated flash-lite-preview to GA flash-lite", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-flash-lite-preview")).toBe(
      "gemini-3.1-flash-lite",
    );
    expect(normalizeGooglePreviewModelId("google/gemini-3.1-flash-lite-preview")).toBe(
      "google/gemini-3.1-flash-lite",
    );
  });

  it("does not rewrite stable GA flash-lite", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-flash-lite")).toBe("gemini-3.1-flash-lite");
  });

  it("routes Gemma 4 26B shorthand to Google's canonical API id", () => {
    expect(normalizeGooglePreviewModelId("gemma-4-26b")).toBe("gemma-4-26b-a4b-it");
    expect(normalizeGooglePreviewModelId("google/gemma-4-26b")).toBe("google/gemma-4-26b-a4b-it");
  });
});
