import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { enablePluginInConfig } from "./enable.js";

function expectEnableResult(
  cfg: OpenClawConfig,
  pluginId: string,
  params: {
    enabled: boolean;
    assert: (result: ReturnType<typeof enablePluginInConfig>) => void;
  },
) {
  const result = enablePluginInConfig(cfg, pluginId);
  expect(result.enabled).toBe(params.enabled);
  params.assert(result);
}

function expectEnabledAllowlist(
  result: ReturnType<typeof enablePluginInConfig>,
  expected: string[],
) {
  expect(result.config.plugins?.allow).toEqual(expected);
}

function expectBuiltInChannelEnabled(result: ReturnType<typeof enablePluginInConfig>) {
  expect(result.config.channels?.telegram?.enabled).toBe(true);
  expect(result.config.plugins?.entries?.telegram?.enabled).toBe(true);
}

function expectBuiltInChannelEnabledWithAllowlist(
  result: ReturnType<typeof enablePluginInConfig>,
  expectedAllowlist?: string[],
) {
  expectBuiltInChannelEnabled(result);
  if (expectedAllowlist) {
    expectEnabledAllowlist(result, expectedAllowlist);
  }
}

describe("enablePluginInConfig", () => {
  it.each([
    {
      name: "enables a plugin entry",
      cfg: {} as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
      },
    },
    {
      name: "refuses enable when plugin is outside configured allowlist",
      cfg: {
        plugins: {
          allow: ["memory-core"],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: false,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.reason).toBe("blocked by allowlist");
        expectEnabledAllowlist(result, ["memory-core"]);
      },
    },
    {
      name: "enables plugin already present in configured allowlist",
      cfg: {
        plugins: {
          allow: ["google"],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.config.plugins?.entries?.google?.enabled).toBe(true);
        expectEnabledAllowlist(result, ["google"]);
      },
    },
    {
      name: "refuses enable when plugin is denylisted",
      cfg: {
        plugins: {
          deny: ["google"],
        },
      } as OpenClawConfig,
      pluginId: "google",
      expectedEnabled: false,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.reason).toBe("blocked by denylist");
      },
    },
    {
      name: "writes built-in channels to channels.<id>.enabled and plugins.entries",
      cfg: {} as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: expectBuiltInChannelEnabled,
    },
    {
      name: "refuses built-in channel enable when channel is outside configured allowlist",
      cfg: {
        plugins: {
          allow: ["memory-core"],
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: false,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expect(result.reason).toBe("blocked by allowlist");
        expect(result.config.plugins?.allow).toEqual(["memory-core"]);
        expect(result.config.channels?.telegram?.enabled).toBeUndefined();
      },
    },
    {
      name: "enables built-in channel already present in configured allowlist",
      cfg: {
        plugins: {
          allow: ["telegram"],
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: (result: ReturnType<typeof enablePluginInConfig>) => {
        expectBuiltInChannelEnabledWithAllowlist(result, ["telegram"]);
      },
    },
    {
      name: "re-enables built-in channels after explicit plugin-level disable",
      cfg: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            telegram: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      pluginId: "telegram",
      expectedEnabled: true,
      assert: expectBuiltInChannelEnabledWithAllowlist,
    },
  ])("$name", ({ cfg, pluginId, expectedEnabled, assert }) => {
    expectEnableResult(cfg, pluginId, {
      enabled: expectedEnabled,
      assert,
    });
  });

  it("can enable a built-in channel plugin entry without mutating channel config", () => {
    const result = enablePluginInConfig({} as OpenClawConfig, "twitch", {
      updateChannelConfig: false,
    });

    expect(result.enabled).toBe(true);
    expect(result.config.plugins?.entries?.twitch?.enabled).toBe(true);
    expect(result.config.channels?.twitch).toBeUndefined();
  });
});
