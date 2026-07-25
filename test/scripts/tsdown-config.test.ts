// Tsdown config tests protect package artifact build contracts.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
} from "../../scripts/lib/tsdown-config-groups.mjs";
import config from "../../tsdown.config.ts";

const configs = Array.isArray(config) ? config : [config];

type TsdownConfig = (typeof configs)[number];
type OutExtensions = NonNullable<TsdownConfig["outExtensions"]>;

describe("tsdown config", () => {
  it.each(["tsdown.config.ts", "tsdown.ai.config.ts"])(
    "keeps %s free of runtime imports from tsdown",
    (configPath) => {
      const source = fs.readFileSync(configPath, "utf8");
      expect(source).not.toMatch(/^import(?!\s+type\b).*from ["']tsdown["'];?$/mu);
    },
  );

  it("enables declaration output explicitly for package artifact builds", () => {
    expect(configs).not.toHaveLength(0);
    expect(configs.map((entry) => entry.dts)).toEqual(configs.map(() => true));
  });

  it("isolates the unified graph from package declaration builds", () => {
    expect(configs.slice(0, -1).map((entry) => entry.name)).toEqual(
      configs.slice(0, -1).map(() => TSDOWN_PACKAGE_CONFIG_GROUP),
    );
    expect(configs.at(-1)?.name).toBe(TSDOWN_UNIFIED_CONFIG_GROUP);
  });

  it("keeps node package artifacts on the declared js and dts extensions", () => {
    const nodePackageConfigs = configs.filter((entry) => entry.fixedExtension === false);
    expect(nodePackageConfigs).not.toHaveLength(0);

    const context = {
      format: "es",
      options: {},
      pkgType: "module",
    } as Parameters<OutExtensions>[0];

    for (const entry of nodePackageConfigs) {
      expect(entry.outExtensions?.(context)).toEqual({ js: ".js", dts: ".d.ts" });
    }
  });
});
