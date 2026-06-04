// Covers plugin config policy validation and ownership decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  hasExplicitPluginConfig,
  isBundledChannelEnabledByChannelConfig,
  normalizePluginsConfigWithResolver,
} from "./config-policy.js";

describe("normalizePluginsConfigWithResolver", () => {
  it("uses the provided plugin id resolver for allow deny and entry keys", () => {
    const normalized = normalizePluginsConfigWithResolver(
      {
        allow: [" alpha "],
        deny: [" beta "],
        entries: {
          " gamma ": {
            enabled: true,
          },
        },
      },
      (id) => id.trim().toUpperCase(),
    );

    expect(normalized.allow).toEqual(["ALPHA"]);
    expect(normalized.deny).toEqual(["BETA"]);
    expect(normalized.entries).toHaveProperty("GAMMA");
  });
});

describe("hasExplicitPluginConfig", () => {
  it("detects explicit config from slots and entry keys", () => {
    expect(hasExplicitPluginConfig({ slots: { memory: "none" } })).toBe(true);
    expect(hasExplicitPluginConfig({ entries: { foo: {} } })).toBe(true);
    expect(hasExplicitPluginConfig({})).toBe(false);
  });
});

describe("isBundledChannelEnabledByChannelConfig", () => {
  it("only treats enabled channel entries as bundled plugin enablement", () => {
    const cfg = {
      channels: {
        telegram: { enabled: true },
        slack: { enabled: false },
      },
    } as OpenClawConfig;

    expect(isBundledChannelEnabledByChannelConfig(cfg, "telegram")).toBe(true);
    expect(isBundledChannelEnabledByChannelConfig(cfg, "slack")).toBe(false);
    expect(isBundledChannelEnabledByChannelConfig(cfg, "not-a-channel")).toBe(false);
  });
});
