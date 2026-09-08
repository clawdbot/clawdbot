import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { iteratePluginRootContributions } from "./plugin-root-contributions.js";

function plugin(id: string, overrides: Partial<PluginManifestRecord> = {}): PluginManifestRecord {
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: ["./skills"],
    hooks: ["./hooks"],
    origin: "global",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}/index.js`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
    ...overrides,
  };
}

function metadata(plugins: PluginManifestRecord[]) {
  return {
    manifestRegistry: { plugins, diagnostics: [] },
    normalizePluginId: (id: string) => id,
  };
}

describe("plugin root contribution selection", () => {
  it.each([
    { contribution: "skills" as const, expected: ["bundled"] },
    { contribution: "hooks" as const, expected: [] },
  ])("preserves manifest default activation for $contribution", ({ contribution, expected }) => {
    const selected = iteratePluginRootContributions({
      metadataSnapshot: metadata([
        plugin("bundled", { origin: "bundled", enabledByDefault: true }),
      ]),
      contribution,
    });
    expect(Array.from(selected, ({ record }) => record.id)).toEqual(expected);
  });

  it("checks contribution eligibility and activation before availability, then applies the slot", () => {
    const checked: string[] = [];
    const selected = iteratePluginRootContributions({
      metadataSnapshot: metadata([
        plugin("empty", { skills: [] }),
        plugin("disabled"),
        plugin("acpx", { kind: "memory" }),
        plugin("other-memory", { kind: "memory" }),
        plugin("memory-core", { kind: "memory" }),
        plugin("ordinary"),
      ]),
      config: { plugins: { entries: { disabled: { enabled: false } } } },
      contribution: "skills",
      isAvailable: (record) => {
        checked.push(record.id);
        return record.id !== "acpx";
      },
    });

    expect(Array.from(selected, ({ record }) => record.id)).toEqual(["memory-core", "ordinary"]);
    expect(checked).toEqual(["acpx", "other-memory", "memory-core", "ordinary"]);
  });

  it.each([
    { slot: undefined, expected: ["memory-core", "dual", "ordinary"] },
    { slot: "alternate", expected: ["alternate", "dual", "ordinary"] },
    { slot: "none", expected: ["dual", "ordinary"] },
  ])("preserves memory slot $slot and other roles of dual-kind plugins", ({ slot, expected }) => {
    const selected = iteratePluginRootContributions({
      metadataSnapshot: metadata([
        plugin("memory-core", { kind: "memory" }),
        plugin("alternate", { kind: "memory" }),
        plugin("dual", { kind: ["memory", "context-engine"] }),
        plugin("ordinary"),
      ]),
      config: { plugins: { slots: { memory: slot } } },
      contribution: "hooks",
    });

    expect(Array.from(selected, ({ record }) => record.id)).toEqual(expected);
  });

  it("keeps declared root order and values for consumer-owned validation", () => {
    const selected = iteratePluginRootContributions({
      metadataSnapshot: metadata([
        plugin("first", { hooks: [" ", "./missing", "../outside", "./missing"] }),
        plugin("second", { hooks: ["./hooks"] }),
      ]),
      contribution: "hooks",
    });

    expect(Array.from(selected, ({ record, roots }) => ({ id: record.id, roots }))).toEqual([
      { id: "first", roots: [" ", "./missing", "../outside", "./missing"] },
      { id: "second", roots: ["./hooks"] },
    ]);
  });
});
