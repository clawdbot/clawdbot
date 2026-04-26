import { describe, expect, it } from "vitest";
import {
  resolveCliStartupPolicy,
  shouldBypassConfigGuardForCommandPath,
  shouldEnsureCliPathForCommandPath,
  shouldHideCliBannerForCommandPath,
  shouldLoadPluginsForCommandPath,
  shouldSkipRouteConfigGuardForCommandPath,
} from "./command-startup-policy.js";

describe("command-startup-policy", () => {
  it("matches config guard bypass commands", () => {
    expect(shouldBypassConfigGuardForCommandPath(["backup", "create"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "validate"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "schema"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["status"])).toBe(false);
  });

  it("matches route-first config guard skip policy", () => {
    expect(
      shouldSkipRouteConfigGuardForCommandPath({
        commandPath: ["status"],
        suppressDoctorStdout: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipRouteConfigGuardForCommandPath({
        commandPath: ["gateway", "status"],
        suppressDoctorStdout: false,
      }),
    ).toBe(true);
    expect(
      shouldSkipRouteConfigGuardForCommandPath({
        commandPath: ["status"],
        suppressDoctorStdout: false,
      }),
    ).toBe(false);
  });

  it("matches plugin preload policy", () => {
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["status"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["status"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["health"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "status"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "list"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "add"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["channels", "logs"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["message", "send"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["message", "send"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "list"],
        jsonOutputMode: false,
      }),
    ).toBe(true);
    // text-only opts agents list out of plugin preload in --json mode so
    // dashboards/scripts that poll this command don't pay the bundled-plugin
    // import waterfall when they only consume config-derived fields. (#71739)
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "list"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "bind"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "bindings"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "unbind"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "set-identity"],
        jsonOutputMode: false,
      }),
    ).toBe(false);
    expect(
      shouldLoadPluginsForCommandPath({
        commandPath: ["agents", "delete"],
        jsonOutputMode: true,
      }),
    ).toBe(false);
  });

  it("matches banner suppression policy", () => {
    expect(shouldHideCliBannerForCommandPath(["update", "status"])).toBe(true);
    expect(shouldHideCliBannerForCommandPath(["completion"])).toBe(true);
    expect(
      shouldHideCliBannerForCommandPath(["status"], {
        ...process.env,
        OPENCLAW_HIDE_BANNER: "1",
      }),
    ).toBe(true);
    expect(shouldHideCliBannerForCommandPath(["status"], {})).toBe(false);
  });

  it("matches CLI PATH bootstrap policy", () => {
    expect(shouldEnsureCliPathForCommandPath(["status"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["sessions"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["config", "get"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["models", "status"])).toBe(false);
    expect(shouldEnsureCliPathForCommandPath(["message", "send"])).toBe(true);
    expect(shouldEnsureCliPathForCommandPath([])).toBe(true);
  });

  it("aggregates startup policy for commander and route-first callers", () => {
    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: false,
      loadPlugins: false,
    });

    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        routeMode: true,
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: true,
      loadPlugins: false,
    });
  });
});
