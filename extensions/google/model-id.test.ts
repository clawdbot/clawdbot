import { describe, expect, it } from "vitest";
import { normalizeAntigravityModelId, normalizeGoogleModelId } from "./api.js";

describe("google model id helpers", () => {
  it.each(["gemini-3-pro", "gemini-3.1-pro", "gemini-3-1-pro"])(
    "adds default -low suffix to bare antigravity pro id: %s",
    (id) => {
      expect(normalizeAntigravityModelId(id)).toBe(`${id}-low`);
    },
  );

  it.each([
    "gemini-3-pro-low",
    "gemini-3-pro-high",
    "gemini-3.1-flash",
    "claude-opus-4-6-thinking",
  ])("keeps already-tiered and non-pro ids unchanged: %s", (id) => {
    expect(normalizeAntigravityModelId(id)).toBe(id);
  });

  it("maps the deprecated 3.1 flash alias to the real preview model", () => {
    expect(normalizeGoogleModelId("gemini-3.1-flash")).toBe("gemini-3-flash-preview");
    expect(normalizeGoogleModelId("gemini-3.1-flash-preview")).toBe("gemini-3-flash-preview");
  });

  it("keeps bare Gemini 3.1 Pro as an alias for Google's preview-suffixed API id", () => {
    expect(normalizeGoogleModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGoogleModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
  });

  it("adds the preview suffix for gemini 3.1 flash-lite", () => {
    expect(normalizeGoogleModelId("gemini-3.1-flash-lite")).toBe("gemini-3.1-flash-lite-preview");
  });
});
