import { describe, expect, it } from "vitest";
import {
  validateOpenClawPackageInstallCompatibility,
  type PluginInstallRuntime,
} from "./install-shared.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";

function createCompatibilityRuntime(
  hostVersion: string,
): Pick<PluginInstallRuntime, "checkMinHostVersion" | "resolveCompatibilityHostVersion"> {
  return {
    checkMinHostVersion,
    resolveCompatibilityHostVersion: () => hostVersion,
  };
}

describe("plugin package install compatibility", () => {
  it("accepts independent package compatibility floors without requiring package-host equality", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      runtime: createCompatibilityRuntime("2026.5.21"),
      pluginId: "example-plugin",
      packageMetadata: {
        install: { minHostVersion: ">=2026.5.1-beta.1" },
        compat: { pluginApi: ">=2026.5.19" },
      },
    });

    expect(result).toBeNull();
  });

  it("rejects a package whose minimum host floor exceeds the current host", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      runtime: createCompatibilityRuntime("2026.5.21"),
      pluginId: "example-plugin",
      packageMetadata: { install: { minHostVersion: ">=2026.5.22" } },
    });

    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
    });
    expect(result?.error).toContain("requires OpenClaw >=2026.5.22");
  });

  it("rejects a package whose plugin API range excludes the current runtime", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      runtime: createCompatibilityRuntime("2026.5.21"),
      pluginId: "example-plugin",
      packageMetadata: { compat: { pluginApi: ">=2026.5.22" } },
    });

    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    });
    expect(result?.error).toContain("requires plugin API >=2026.5.22");
  });

  it.each([
    {
      packageMetadata: { install: { minHostVersion: "2026.5.22" } },
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_MIN_HOST_VERSION,
    },
    {
      packageMetadata: { compat: { pluginApi: 20260522 } },
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_PLUGIN_API,
    },
  ])("rejects malformed compatibility metadata with $code", ({ packageMetadata, code }) => {
    const result = validateOpenClawPackageInstallCompatibility({
      runtime: createCompatibilityRuntime("2026.5.21"),
      pluginId: "example-plugin",
      packageMetadata: packageMetadata as OpenClawPackageManifest,
    });

    expect(result).toMatchObject({ ok: false, code });
  });
});
