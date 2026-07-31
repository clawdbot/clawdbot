/**
 * Contract suite for bundled plugin package manifests and host version floors.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAtLeast, parseSemver } from "../../infra/runtime-guard.js";
import { parseMinHostVersionRequirement } from "../../plugins/min-host-version.js";

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
  minHostVersionBaseline?: string;
};

function readPackageManifest(relativePath: string): PackageManifest {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as PackageManifest;
}

function bundledPluginFile(pluginId: string, relativePath: string): string {
  return `extensions/${pluginId}/${relativePath}`;
}

/** Installs manifest contract tests for one bundled plugin package. */
export function describePackageManifestContract(params: PackageManifestContractParams) {
  const packagePath = bundledPluginFile(params.pluginId, "package.json");

  describe(`${params.pluginId} package manifest contract`, () => {
    if (params.pluginLocalRuntimeDeps?.length) {
      for (const dependencyName of params.pluginLocalRuntimeDeps) {
        it(`keeps ${dependencyName} plugin-local`, () => {
          const rootManifest = readPackageManifest("package.json");
          const pluginManifest = readPackageManifest(packagePath);
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

    const minHostVersionBaseline = params.minHostVersionBaseline;
    if (minHostVersionBaseline) {
      it("declares a parseable minHostVersion floor at or above the baseline", () => {
        const baseline = parseSemver(minHostVersionBaseline);
        expect(baseline).not.toBeNull();
        if (!baseline) {
          return;
        }

        const manifest = readPackageManifest(packagePath);
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
