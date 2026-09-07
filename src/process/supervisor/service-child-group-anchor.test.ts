import { describe, expect, it } from "vitest";
import { shouldRequestLineageCleanup } from "./service-child-group-anchor-policy.js";

describe("service-child-group-anchor lineage cleanup", () => {
  it("does not reclaim the group when lineage closes before the root exits", () => {
    expect(shouldRequestLineageCleanup("active", false)).toBe(false);
  });

  it("reclaims the group after the root exit is observed", () => {
    expect(shouldRequestLineageCleanup("active", true)).toBe(true);
  });

  it("does not reclaim an anchor that is already closing or closed", () => {
    expect(shouldRequestLineageCleanup("closing", true)).toBe(false);
    expect(shouldRequestLineageCleanup("closed", true)).toBe(false);
  });
});
