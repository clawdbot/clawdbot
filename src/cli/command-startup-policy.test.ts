// Command startup policy tests cover which CLI commands require startup side effects.
import { describe, expect, it } from "vitest";
import {
  resolveCliStartupPolicy,
  shouldBypassConfigGuardForCommandPath,
} from "./command-startup-policy.js";

function resolvePolicy(params: {
  argv?: string[];
  commandPath: string[];
  jsonOutputMode?: boolean;
  env?: NodeJS.ProcessEnv;
  routeMode?: boolean;
}) {
  return resolveCliStartupPolicy({
    jsonOutputMode: false,
    ...params,
  });
}

describe("command-startup-policy", () => {
  it("matches config guard bypass commands", () => {
    expect(shouldBypassConfigGuardForCommandPath(["backup", "create"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "validate"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "schema"])).toBe(true);
    expect(shouldBypassConfigGuardForCommandPath(["config", "set"])).toBe(false);
    expect(shouldBypassConfigGuardForCommandPath(["status"])).toBe(false);
  });

  it("matches route-first config guard skip policy", () => {
    expect(
      resolvePolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        routeMode: true,
      }).skipConfigGuard,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["gateway", "status"],
        routeMode: true,
      }).skipConfigGuard,
    ).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        routeMode: true,
      }).skipConfigGuard,
    ).toBe(false);
  });

  it("matches plugin preload policy", () => {
    expect(
      resolvePolicy({
        commandPath: ["status"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["health"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "status"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "list"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "add"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["channels", "logs"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["message", "send"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["message", "send"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--json"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent", "--json", "--local"],
        commandPath: ["agent"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(true);
    expect(
      resolvePolicy({
        argv: ["node", "openclaw", "agent"],
        commandPath: ["agent"],
      }).loadPlugins,
    ).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["agents"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "list"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "list"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "bind"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "bindings"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "unbind"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "set-identity"],
      }).loadPlugins,
    ).toBe(false);
    expect(
      resolvePolicy({
        commandPath: ["agents", "delete"],
        jsonOutputMode: true,
      }).loadPlugins,
    ).toBe(false);
  });

  it("matches banner suppression policy", () => {
    expect(resolvePolicy({ commandPath: ["update", "status"], env: {} }).hideBanner).toBe(true);
    expect(resolvePolicy({ commandPath: ["completion"], env: {} }).hideBanner).toBe(true);
    expect(
      resolvePolicy({
        commandPath: ["status"],
        env: {
          ...process.env,
          OPENCLAW_HIDE_BANNER: "1",
        },
      }).hideBanner,
    ).toBe(true);
    expect(resolvePolicy({ commandPath: ["status"], env: {} }).hideBanner).toBe(false);
  });

  it("uses process env banner suppression when startup env is omitted", () => {
    const originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
    try {
      process.env.OPENCLAW_HIDE_BANNER = "1";

      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
        }).hideBanner,
      ).toBe(true);
      expect(
        resolveCliStartupPolicy({
          commandPath: ["status"],
          jsonOutputMode: false,
          env: {},
        }).hideBanner,
      ).toBe(false);
    } finally {
      if (originalHideBanner === undefined) {
        delete process.env.OPENCLAW_HIDE_BANNER;
      } else {
        process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
      }
    }
  });

  it("aggregates startup policy for commander and route-first callers", () => {
    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        env: {},
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: false,
      loadPlugins: false,
      pluginRegistry: { scope: "channels" },
    });

    expect(
      resolveCliStartupPolicy({
        commandPath: ["status"],
        jsonOutputMode: true,
        env: {},
        routeMode: true,
      }),
    ).toEqual({
      suppressDoctorStdout: true,
      hideBanner: false,
      skipConfigGuard: false,
      loadPlugins: false,
      pluginRegistry: { scope: "channels" },
    });
  });

  it("suppresses startup stdout for the mcp serve protocol", () => {
    expect(resolvePolicy({ commandPath: ["mcp", "serve"] }).suppressDoctorStdout).toBe(true);
  });

  it("reserves stdout for the node worker protocol", () => {
    const policy = resolvePolicy({ commandPath: ["node", "worker"] });

    expect(policy.hideBanner).toBe(true);
    expect(policy.loadPlugins).toBe(false);
    expect(policy.suppressDoctorStdout).toBe(true);
  });

  it("suppresses startup stdout for the bare acp protocol", () => {
    expect(resolvePolicy({ commandPath: ["acp"] }).suppressDoctorStdout).toBe(true);
  });

  it("keeps startup stdout for non-protocol commands", () => {
    expect(resolvePolicy({ commandPath: ["mcp", "list"] }).suppressDoctorStdout).toBe(false);
    expect(resolvePolicy({ commandPath: ["acp", "client"] }).suppressDoctorStdout).toBe(false);
    expect(resolvePolicy({ commandPath: ["status"] }).suppressDoctorStdout).toBe(false);
  });
});
