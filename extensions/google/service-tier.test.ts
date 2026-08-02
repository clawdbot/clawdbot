import { describe, expect, it } from "vitest";
import { applyGoogleServiceTierToPayload, resolveGoogleServiceTier } from "./service-tier.js";

describe("resolveGoogleServiceTier", () => {
  it.each([
    { label: "lowercase flex", params: { serviceTier: "flex" }, expected: "FLEX" },
    { label: "uppercase FLEX", params: { serviceTier: "FLEX" }, expected: "FLEX" },
    { label: "padded priority", params: { serviceTier: " priority " }, expected: "PRIORITY" },
    { label: "standard", params: { serviceTier: "standard" }, expected: "STANDARD" },
    { label: "snake_case alias", params: { service_tier: "flex" }, expected: "FLEX" },
    {
      label: "camelCase wins",
      params: { serviceTier: "priority", service_tier: "flex" },
      expected: "PRIORITY",
    },
    { label: "invalid value", params: { serviceTier: "turbo" }, expected: undefined },
    { label: "empty value", params: { serviceTier: "" }, expected: undefined },
    { label: "non-string value", params: { serviceTier: 42 }, expected: undefined },
    { label: "missing params", params: undefined, expected: undefined },
    { label: "unrelated params", params: { temperature: 0.2 }, expected: undefined },
  ] as const)("resolves $label", ({ params, expected }) => {
    expect(resolveGoogleServiceTier(params)).toBe(expected);
  });
});

describe("applyGoogleServiceTierToPayload", () => {
  it("sets serviceTier when the payload does not define one", () => {
    const payload: Record<string, unknown> = {};
    applyGoogleServiceTierToPayload(payload, "FLEX");
    expect(payload.serviceTier).toBe("FLEX");
  });

  it("keeps an explicit payload serviceTier", () => {
    const payload: Record<string, unknown> = { serviceTier: "PRIORITY" };
    applyGoogleServiceTierToPayload(payload, "FLEX");
    expect(payload.serviceTier).toBe("PRIORITY");
  });
});
