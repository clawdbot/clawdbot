import { describe, expect, it } from "vitest";
import { isPlaceTopologyEvent } from "./new-session-runtime.ts";

describe("isPlaceTopologyEvent", () => {
  it.each([
    "config.changed",
    "node.pair.requested",
    "node.pair.resolved",
    "node.runnerInventory.changed",
    "device.pair.requested",
    "device.pair.resolved",
  ])("refreshes authoritative placement catalogs for %s", (event) => {
    expect(isPlaceTopologyEvent(event)).toBe(true);
  });

  it("ignores unrelated event traffic", () => {
    expect(isPlaceTopologyEvent("session.message")).toBe(false);
  });
});
