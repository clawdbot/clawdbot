import { describe, expect, it } from "vitest";
import { WidgetAssetTokens } from "./asset-tokens.js";

describe("WidgetAssetTokens", () => {
  it("scopes an unguessable token to one widget approval snapshot", () => {
    const tokens = new WidgetAssetTokens();
    const approved = { "index.html": "a".repeat(64) };
    const token = tokens.issue("chart", approved);

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(tokens.allows(token, "chart", approved)).toBe(true);
    expect(tokens.allows(token, "other", approved)).toBe(false);
    expect(tokens.allows(token, "chart", { "index.html": "b".repeat(64) })).toBe(false);
    expect(tokens.isIssued("not-a-token", "chart")).toBe(false);
  });

  it("issues distinct capabilities for repeated frame requests", () => {
    const tokens = new WidgetAssetTokens();
    const approved = { "index.html": "a".repeat(64) };

    expect(tokens.issue("chart", approved)).not.toBe(tokens.issue("chart", approved));
  });
});
