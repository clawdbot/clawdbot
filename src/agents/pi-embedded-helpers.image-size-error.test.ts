import { describe, expect, it } from "vitest";

import { parseImageSizeError } from "./pi-embedded-helpers.js";

describe("parseImageSizeError", () => {
  it("parses max MB values from error text", () => {
    expect(parseImageSizeError("image exceeds 5 MB maximum")?.maxMb).toBe(5);
    expect(parseImageSizeError("Image exceeds 5.5 MB limit")?.maxMb).toBe(5.5);
  });

  it("returns null for unrelated errors", () => {
    expect(parseImageSizeError("context overflow")).toBeNull();
  });
});
