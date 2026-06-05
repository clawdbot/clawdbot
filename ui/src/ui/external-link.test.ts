// Control UI tests cover external link behavior.
import { describe, expect, it } from "vitest";
import { buildExternalLinkRel } from "./external-link.ts";

describe("buildExternalLinkRel", () => {
  it("always includes required security tokens", () => {
    expect(buildExternalLinkRel()).toBe("noopener noreferrer");
  });

  it("preserves extra rel tokens while deduping required ones", () => {
    expect(buildExternalLinkRel("noreferrer nofollow NOOPENER")).toBe(
      "noopener noreferrer nofollow",
    );
  });

  it("ignores whitespace-only rel input", () => {
    expect(buildExternalLinkRel("   ")).toBe("noopener noreferrer");
  });
});
