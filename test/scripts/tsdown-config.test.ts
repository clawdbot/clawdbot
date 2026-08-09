// Tsdown config tests protect package artifact build contracts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import {
  TSDOWN_PACKAGE_CONFIG_GROUP,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
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

  it("isolates runtime output from bounded declaration-only graphs", () => {
    const packageConfigs = configs.filter((entry) => entry.name === TSDOWN_PACKAGE_CONFIG_GROUP);
    const unifiedRuntimeConfig = configs.find(
      (entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP,
    );
    const unifiedDeclarationConfigs = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.map((name) =>
      configs.find((entry) => entry.name === name),
    );

    expect(packageConfigs).not.toHaveLength(0);
    expect(packageConfigs.map((entry) => entry.dts)).toEqual(packageConfigs.map(() => true));
    expect(unifiedRuntimeConfig?.dts).toBe(false);
    expect(unifiedDeclarationConfigs.every(Boolean)).toBe(true);
    for (const declarationConfig of unifiedDeclarationConfigs) {
      expect(declarationConfig?.dts).toMatchObject({ emitDtsOnly: true });
      expect(Object.keys(declarationConfig?.entry ?? {})).toEqual(
        Object.keys(unifiedRuntimeConfig?.entry ?? {}),
      );
    }
  });

  it("assigns every unified entry to exactly one bounded declaration graph", () => {
    const unifiedRuntimeConfig = configs.find(
      (entry) => entry.name === TSDOWN_UNIFIED_CONFIG_GROUP,
    );
    const runtimeSources = Object.values(unifiedRuntimeConfig?.entry ?? {}).map((source) => {
      const sourceString = String(source);
      return (
        path.isAbsolute(sourceString) ? path.relative(process.cwd(), sourceString) : sourceString
      ).replaceAll("\\", "/");
    });
    const declarationSources = TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.flatMap((name) => {
      const declarationConfig = configs.find((entry) => entry.name === name);
      const dts = declarationConfig?.dts;
      if (!dts || typeof dts !== "object" || !Array.isArray(dts.entry)) {
        return [];
      }
      expect(dts.entry.length).toBeLessThanOrEqual(200);
      return dts.entry;
    });

    expect(declarationSources.toSorted()).toEqual(runtimeSources.toSorted());
    expect(new Set(declarationSources).size).toBe(declarationSources.length);
  });

  it("keeps public SDK declarations together and isolates private runtime declarations", () => {
    const [publicDeclarationSources = [], privateDeclarationSources = []] =
      TSDOWN_UNIFIED_DTS_CONFIG_GROUPS.filter((name) =>
        name.startsWith("openclaw-dts-plugin-sdk-"),
      ).map((name) => {
        const dts = configs.find((entry) => entry.name === name)?.dts;
        return dts && typeof dts === "object" && Array.isArray(dts.entry) ? dts.entry : [];
      });
    const publicSources = publicPluginSdkEntrypoints.map((entry) => `src/plugin-sdk/${entry}.ts`);
    const publicSourceSet = new Set(publicSources);

    expect(publicDeclarationSources.toSorted()).toEqual(publicSources.toSorted());
    expect(privateDeclarationSources.some((source) => publicSourceSet.has(source))).toBe(false);
    expect(privateDeclarationSources).toContain("src/plugin-sdk/tts-runtime.ts");
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
