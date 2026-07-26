import { describe, expect, it } from "vitest";
import {
  validatePluginsInstallParams,
  validatePluginsListParams,
  validatePluginsRefreshParams,
  validatePluginsSearchParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "./index.js";

describe("plugin lifecycle protocol validators", () => {
  it("validates plugin metadata refresh params", () => {
    expect(validatePluginsRefreshParams({})).toBe(true);
    expect(validatePluginsRefreshParams({ unexpected: true })).toBe(false);
  });

  it("keeps list params closed", () => {
    expect(validatePluginsListParams({})).toBe(true);
    expect(validatePluginsListParams({ unexpected: true })).toBe(false);
  });

  it("validates bounded plugin search requests", () => {
    expect(validatePluginsSearchParams({ query: "memory", limit: 20 })).toBe(true);
    expect(validatePluginsSearchParams({ query: "memory", limit: 101 })).toBe(false);
  });

  it("keeps official and ClawHub install requests distinct", () => {
    expect(
      validatePluginsInstallParams({
        source: "clawhub",
        packageName: "memory-plus",
        version: "2.1.0",
        acknowledgeClawHubRisk: true,
      }),
    ).toBe(true);
    expect(validatePluginsInstallParams({ source: "official", pluginId: "workboard" })).toBe(true);
    expect(
      validatePluginsInstallParams({
        source: "official",
        pluginId: "workboard",
        packageName: "memory-plus",
      }),
    ).toBe(false);
  });

  it("validates uninstall requests", () => {
    expect(validatePluginsUninstallParams({ pluginId: "memory-plus" })).toBe(true);
    expect(validatePluginsUninstallParams({ pluginId: "" })).toBe(false);
    expect(validatePluginsUninstallParams({})).toBe(false);
  });

  it("validates enablement mutations", () => {
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: true })).toBe(true);
    expect(validatePluginsSetEnabledParams({ pluginId: "workboard", enabled: "yes" })).toBe(false);
  });
});
