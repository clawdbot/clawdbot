import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAtLeast, parseMinHostVersionRequirement, parseSemver } from "../testing.js";

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  openclaw?: {
    install?: {
      minHostVersion?: string;
    };
  };
};

type PackageManifestContractParams = {
  pluginId: string;
  pluginLocalRuntimeDeps?: string[];
  mirroredRootRuntimeDeps?: string[];
  minHostVersionBaseline?: string;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Test helper lets assertions ascribe package manifest shape.
function readJson<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as T;
}

function bundledPluginFile(pluginId: string, relativePath: string): string {
  return `extensions/${pluginId}/${relativePath}`;
}

export function describePackageManifestContract(params: PackageManifestContractParams) {
  const packagePath = bundledPluginFile(params.pluginId, "package.json");

  describe(`${params.pluginId} package manifest contract`, () => {
    if (params.pluginLocalRuntimeDeps?.length) {
      for (const dependencyName of params.pluginLocalRuntimeDeps) {
        it(`keeps ${dependencyName} plugin-local`, () => {
          const rootManifest = readJson("package.json") as PackageManifest;
          const pluginManifest = readJson(packagePath) as PackageManifest;
          const pluginSpec =
            pluginManifest.dependencies?.[dependencyName] ??
            pluginManifest.optionalDependencies?.[dependencyName];
          const rootSpec =
            rootManifest.dependencies?.[dependencyName] ??
            rootManifest.optionalDependencies?.[dependencyName];

          expect(pluginSpec).toBeTruthy();
          expect(rootSpec).toBeUndefined();
        });
      }
    }

    if (params.mirroredRootRuntimeDeps?.length) {
      for (const dependencyName of params.mirroredRootRuntimeDeps) {
        it(`mirrors ${dependencyName} at the root package`, () => {
          const rootManifest = readJson<PackageManifest>("package.json");
          const pluginManifest = readJson<PackageManifest>(packagePath);
          const pluginSpec =
            pluginManifest.dependencies?.[dependencyName] ??
            pluginManifest.optionalDependencies?.[dependencyName];
          const rootSpec =
            rootManifest.dependencies?.[dependencyName] ??
            rootManifest.optionalDependencies?.[dependencyName];

          expect(pluginSpec).toBeTruthy();
          expect(rootSpec).toBe(pluginSpec);
        });
      }
    }

    const minHostVersionBaseline = params.minHostVersionBaseline;
    if (minHostVersionBaseline) {
      it("declares a parseable minHostVersion floor at or above the baseline", () => {
        const baseline = parseSemver(minHostVersionBaseline);
        expect(baseline).not.toBeNull();
        if (!baseline) {
          return;
        }

        const manifest = readJson<PackageManifest>(packagePath);
        const requirement = parseMinHostVersionRequirement(
          manifest.openclaw?.install?.minHostVersion ?? null,
        );

        expect(
          requirement,
          `${packagePath} should declare openclaw.install.minHostVersion`,
        ).not.toBeNull();
        if (!requirement) {
          return;
        }

        const minimum = parseSemver(requirement.minimumLabel);
        expect(minimum, `${packagePath} should use a parseable semver floor`).not.toBeNull();
        if (!minimum) {
          return;
        }

        expect(
          isAtLeast(minimum, baseline),
          `${packagePath} should require at least OpenClaw ${minHostVersionBaseline}`,
        ).toBe(true);
      });
    }
  });
}
