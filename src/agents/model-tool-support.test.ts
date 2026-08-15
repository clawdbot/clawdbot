// Documents model tool-support compatibility defaults.
import { describe, expect, it } from "vitest";
import { buildModelToolsUnavailablePrompt, supportsModelTools } from "./model-tool-support.js";

describe("supportsModelTools", () => {
  it("defaults to true when the model has no compat override", () => {
    expect(supportsModelTools({} as never)).toBe(true);
  });

  it("returns true when compat.supportsTools is true", () => {
    expect(supportsModelTools({ compat: { supportsTools: true } } as never)).toBe(true);
  });

  it("returns false when compat.supportsTools is false", () => {
    expect(supportsModelTools({ compat: { supportsTools: false } } as never)).toBe(false);
  });
});

describe("buildModelToolsUnavailablePrompt", () => {
  it("tells chat-only models not to invent tool-backed work", () => {
    expect(buildModelToolsUnavailablePrompt(true)).toBeUndefined();
    expect(buildModelToolsUnavailablePrompt(false)).toContain(
      "Do not claim that you ran commands, read or wrote files, browsed the web, generated media",
    );
    expect(buildModelToolsUnavailablePrompt(false)).toContain("switch to a tool-capable model");
  });
});
