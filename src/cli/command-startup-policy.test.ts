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
        commandPath: ["agents", "list"],
        jsonOutputMode: false,
      }),
    ).toBe(true);
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
