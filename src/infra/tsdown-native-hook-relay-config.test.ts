import { describe, expect, it } from "vitest";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mjs";
import tsdownConfig from "../../tsdown.config.ts";

type TsdownConfigEntry = {
  entry?: Record<string, string> | string[];
  name?: string;
  outDir?: string;
};

function asConfigArray(config: unknown): TsdownConfigEntry[] {
  return Array.isArray(config) ? (config as TsdownConfigEntry[]) : [config as TsdownConfigEntry];
}

function entrySources(config: TsdownConfigEntry): Record<string, string> {
  if (!config.entry || Array.isArray(config.entry)) {
    return {};
  }
  return config.entry;
}

describe("native hook relay tsdown config", () => {
  it("builds the native hook relay as an isolated one-entry graph", () => {
    const configs = asConfigArray(tsdownConfig);
    const relayGraph = configs.find((config) => config.outDir === "dist/native-hook-relay");
    const unifiedGraph = configs.find((config) =>
      Object.keys(entrySources(config)).includes("plugins/runtime/index"),
    );

    expect(relayGraph).toBeDefined();
    expect(entrySources(relayGraph ?? {})).toEqual({
      entry: "src/cli/native-hook-relay-entry.ts",
    });
    expect(unifiedGraph).toBeDefined();
    expect(relayGraph?.name).toBe(TSDOWN_UNIFIED_CONFIG_GROUP);
    expect(configs.indexOf(unifiedGraph ?? {})).toBeLessThan(configs.indexOf(relayGraph ?? {}));
    expect(Object.values(entrySources(unifiedGraph ?? {}))).not.toContain(
      "src/cli/native-hook-relay-entry.ts",
    );
  });
});
