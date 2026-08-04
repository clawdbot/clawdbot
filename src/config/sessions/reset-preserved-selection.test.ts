import { describe, expect, it } from "vitest";
import { resolveResetPreservedSelection } from "./reset-preserved-selection.js";

describe("resolveResetPreservedSelection", () => {
  it("does not stamp legacy raw aliases as resolved during reset", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "legacy",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "sonnet",
        },
      }),
    ).toEqual({
      providerOverride: "anthropic",
      modelOverride: "sonnet",
      modelOverrideSource: "user",
    });
  });

  it("preserves canonical route provenance", () => {
    expect(
      resolveResetPreservedSelection({
        entry: {
          sessionId: "canonical",
          updatedAt: 1,
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      }),
    ).toMatchObject({
      modelOverride: "claude-sonnet-4-6",
      modelOverrideRouteResolution: "resolved",
    });
  });
});
