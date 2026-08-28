import { describe, expect, it } from "vitest";
import { sortPluginEntriesById, sortPluginEntriesForAutoDetect } from "./plugin-entry-order.js";

type TestEntry = {
  id: string;
  pluginId: string;
  autoDetectOrder?: number;
};

function toKeys(entries: readonly TestEntry[]): string[] {
  return entries.map((entry) => `${entry.id}:${entry.pluginId}`);
}

describe("plugin entry order", () => {
  it("sorts identities without mutating the input", () => {
    const entries = [
      { id: "beta", pluginId: "plugin-b" },
      { id: "alpha", pluginId: "plugin-z" },
      { id: "alpha", pluginId: "plugin-a" },
    ] satisfies TestEntry[];

    expect(toKeys(sortPluginEntriesById(entries))).toEqual([
      "alpha:plugin-a",
      "alpha:plugin-z",
      "beta:plugin-b",
    ]);
    expect(toKeys(entries)).toEqual(["beta:plugin-b", "alpha:plugin-z", "alpha:plugin-a"]);
  });

  it("sorts auto-detect priorities before deterministic identity ties", () => {
    const entries = [
      { id: "unordered", pluginId: "plugin-u" },
      { id: "beta", pluginId: "plugin-b", autoDetectOrder: 10 },
      { id: "alpha", pluginId: "plugin-z", autoDetectOrder: 10 },
      { id: "alpha", pluginId: "plugin-a", autoDetectOrder: 10 },
      { id: "first", pluginId: "plugin-f", autoDetectOrder: 1 },
    ] satisfies TestEntry[];

    expect(toKeys(sortPluginEntriesForAutoDetect(entries))).toEqual([
      "first:plugin-f",
      "alpha:plugin-a",
      "alpha:plugin-z",
      "beta:plugin-b",
      "unordered:plugin-u",
    ]);
    expect(toKeys(entries)).toEqual([
      "unordered:plugin-u",
      "beta:plugin-b",
      "alpha:plugin-z",
      "alpha:plugin-a",
      "first:plugin-f",
    ]);
  });
});
