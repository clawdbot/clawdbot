// @vitest-environment node
import { describe, expect, it } from "vitest";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";

describe("config form copy-on-write patching", () => {
  it("patches special own keys without changing object prototypes", () => {
    const current = JSON.parse(
      '{"constructor":{"value":"before"},"prototype":{"value":"before"},"__proto__":{"value":"before"},"untouched":{"stable":true}}',
    ) as Record<string, unknown>;

    for (const key of ["constructor", "prototype", "__proto__"]) {
      const result = copyWithPathPatch(current, [key, "value"], "after");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      const patched = result.value as Record<string, Record<string, unknown>>;
      expect(Object.hasOwn(patched, key)).toBe(true);
      expect(patched[key]?.value).toBe("after");
      expect(Object.getPrototypeOf(patched)).toBe(Object.prototype);
      expect(patched.untouched).toBe(current.untouched);
    }
  });

  it("creates an own __proto__ data property safely", () => {
    const result = copyWithPathPatch({}, ["__proto__", "value"], "safe");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const patched = result.value as Record<string, Record<string, unknown>>;
    expect(Object.hasOwn(patched, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(patched, "__proto__")?.value).toEqual({
      value: "safe",
    });
    expect(Object.getPrototypeOf(patched)).toBe(Object.prototype);
  });
});
