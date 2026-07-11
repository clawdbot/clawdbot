// Plugin package dependency tests cover bundled plugin runtime dependency helpers.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBundledPluginPackageDependencySpecs,
  collectRuntimeDependencySpecs,
  packageNameFromSpecifier,
} from "../../scripts/lib/plugin-package-dependencies.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writePackageJson(root: string, pluginId: string, packageJson: unknown): void {
  const pluginDir = join(root, pluginId);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
}

describe("scripts/lib/plugin-package-dependencies.mjs", () => {
  it("extracts dependency package names from bare import specifiers", () => {
    expect(packageNameFromSpecifier("@scope/pkg/subpath")).toBe("@scope/pkg");
    expect(packageNameFromSpecifier("plain-pkg/subpath")).toBe("plain-pkg");
    expect(packageNameFromSpecifier("@scope")).toBeNull();
    expect(packageNameFromSpecifier("@scope/")).toBeNull();
    expect(packageNameFromSpecifier("node:fs")).toBeNull();
    expect(packageNameFromSpecifier("./local")).toBeNull();
    expect(packageNameFromSpecifier("/absolute")).toBeNull();
    expect(packageNameFromSpecifier("#internal")).toBeNull();
  });

  it("collects only runtime dependency specs from package manifests", () => {
    expect([
      ...collectRuntimeDependencySpecs({
        dependencies: {
          empty: "",
          objectValue: { version: "1.0.0" },
          runtime: "^1.0.0",
        },
        devDependencies: {
          devOnly: "^3.0.0",
        },
        optionalDependencies: {
          optional: "~2.0.0",
        },
      }),
    ]).toEqual([
      ["runtime", "^1.0.0"],
      ["optional", "~2.0.0"],
    ]);
  });

  it("collects bundled plugin dependency owners and conflicts deterministically", () => {
    const root = makeTempDir(tempDirs, "openclaw-plugin-dependencies-");
    writePackageJson(root, "alpha", {
      dependencies: {
        shared: "^1.0.0",
      },
      optionalDependencies: {
        optional: "^2.0.0",
      },
    });
    writePackageJson(root, "beta", {
      dependencies: {
        shared: "^1.0.0",
      },
    });
    writePackageJson(root, "gamma", {
      dependencies: {
        shared: "^1.1.0",
      },
    });

    expect([...collectBundledPluginPackageDependencySpecs(root)]).toEqual([
      [
        "shared",
        {
          conflicts: [{ pluginId: "gamma", spec: "^1.1.0" }],
          pluginIds: ["alpha", "beta"],
          spec: "^1.0.0",
        },
      ],
      ["optional", { conflicts: [], pluginIds: ["alpha"], spec: "^2.0.0" }],
    ]);
  });
});
