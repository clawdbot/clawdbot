// Verifies config merge patches reject prototype pollution inputs.
import { describe, it, expect } from "vitest";
import { applyMergePatch } from "./merge-patch.js";

describe("applyMergePatch prototype pollution guard", () => {
  it("ignores __proto__ keys in patch", () => {
    const base = { a: 1 };
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "b": 2}');
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(result.a).toBe(1);
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(result.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores constructor key in patch", () => {
    const base = { a: 1 };
    const patch = { constructor: { polluted: true }, b: 2 };
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(Object.hasOwn(result, "constructor")).toBe(false);
  });

  it("ignores prototype key in patch", () => {
    const base = { a: 1 };
    const patch = { prototype: { polluted: true }, b: 2 };
    const result = applyMergePatch(base, patch) as Record<string, unknown>;
    expect(result.b).toBe(2);
    expect(Object.hasOwn(result, "prototype")).toBe(false);
  });

  it("ignores __proto__ in nested patches", () => {
    const base = { nested: { x: 1 } };
    const patch = JSON.parse('{"nested": {"__proto__": {"polluted": true}, "y": 2}}');
    const result = applyMergePatch(base, patch) as { nested: Record<string, unknown> };
    expect(result.nested.y).toBe(2);
    expect(result.nested.x).toBe(1);
    expect(Object.hasOwn(result.nested, "__proto__")).toBe(false);
    expect(result.nested.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("allows prototype-like names only as direct browser profile keys", () => {
    const names = ["constructor", "prototype"] as const;
    const profile = {
      cdpPort: 18801,
      color: "#0066CC",
      constructor: { polluted: true },
      prototype: { polluted: true },
    };
    const result = applyMergePatch(
      { browser: { profiles: {} } },
      {
        constructor: { polluted: true },
        browser: {
          prototype: { polluted: true },
          profiles: Object.fromEntries(names.map((name) => [name, profile])),
        },
      },
    ) as { browser?: { profiles?: Record<string, Record<string, unknown>> } };

    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(Object.hasOwn(result.browser ?? {}, "prototype")).toBe(false);
    const profiles = result.browser?.profiles ?? {};
    for (const name of names) {
      expect(profiles[name]?.cdpPort).toBe(18801);
      expect(Object.hasOwn(profiles[name] ?? {}, "constructor")).toBe(false);
      expect(Object.hasOwn(profiles[name] ?? {}, "prototype")).toBe(false);
    }
    const removed = applyMergePatch(result, {
      browser: { profiles: { constructor: null, prototype: null } },
    }) as { browser?: { profiles?: Record<string, unknown> } };
    expect(Object.keys(removed.browser?.profiles ?? {})).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
