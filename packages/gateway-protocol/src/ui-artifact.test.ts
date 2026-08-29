import { describe, expect, it } from "vitest";
import { normalizeUiArtifact } from "./ui-artifact.js";

describe("normalizeUiArtifact", () => {
  it("preserves __proto__ as data without changing the normalized object prototype", () => {
    const structuredContent = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    const normalized = normalizeUiArtifact({
      version: 1,
      id: "artifact-prototype",
      revision: 1,
      structuredContent,
      views: [],
      state: "ready",
      source: { sessionKey: "agent:main:main" },
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      return;
    }
    expect(Object.getPrototypeOf(normalized.value.structuredContent)).toBe(Object.prototype);
    expect(Object.hasOwn(normalized.value.structuredContent as object, "__proto__")).toBe(true);
    expect(Reflect.get(normalized.value.structuredContent as object, "__proto__")).toEqual({
      polluted: true,
    });
    expect(
      (normalized.value.structuredContent as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });
});
