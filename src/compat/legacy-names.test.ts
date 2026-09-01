// Verifies legacy public names still map to current exports where supported.
import { describe, expect, it } from "vitest";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "./legacy-names.js";

describe("compat/legacy-names", () => {
  it("keeps the current manifest key primary while exposing legacy fallbacks", () => {
    expect(MANIFEST_KEY).toBe("openclaw");
    expect(LEGACY_MANIFEST_KEYS).toEqual(["clawdbot"]);
  });
});
