import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";

describe("withBundledPluginEnablementCompat", () => {
  it("honors bundledDiscovery compat before plugin allowlists", () => {
    const config = {
      plugins: {
        allow: ["discord"],
        bundledDiscovery: "compat",
      },
    } satisfies OpenClawConfig;

    const result = withBundledPluginEnablementCompat({
      config,
      pluginIds: ["openai", "anthropic"],
    });

    expect(result?.plugins?.allow).toEqual(["discord", "openai", "anthropic"]);
    expect(result?.plugins?.entries).toEqual({
      openai: { enabled: true },
      anthropic: { enabled: true },
    });
  });

  it("keeps allowlist mode restrictive for bundled plugin enablement", () => {
    const config = {
      plugins: {
        allow: ["openai"],
        bundledDiscovery: "allowlist",
      },
    } satisfies OpenClawConfig;

    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: ["openai", "anthropic"],
      })?.plugins?.entries,
    ).toEqual({
      openai: { enabled: true },
    });
  });

  it("adds compat allow entries for plugins that already have entries", () => {
    const config = {
      plugins: {
        allow: ["openai"],
        bundledDiscovery: "compat",
        entries: {
          deepseek: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: ["deepseek"],
      })?.plugins?.allow,
    ).toEqual(["openai", "deepseek"]);
  });
});
