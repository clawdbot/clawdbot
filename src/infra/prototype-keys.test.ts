// Covers prototype-pollution key blocking.
import { describe, expect, it } from "vitest";
import { isBlockedObjectKey } from "./prototype-keys.js";

describe("isBlockedObjectKey", () => {
  it("blocks prototype-pollution keys and allows ordinary keys", () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      expect(isBlockedObjectKey(key)).toBe(true);
    }

    for (const key of ["toString", "value", "constructorName", "__proto__x", "Prototype"]) {
      expect(isBlockedObjectKey(key)).toBe(false);
    }
  });
});
