/** Covers bundled plugin compatibility modes and their activation defaults. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";

const readBundledDiscoveryModeMemoized = vi.hoisted(() => vi.fn<() => "compat" | "allowlist">());

vi.mock("./bundled-discovery-state.js", () => ({ readBundledDiscoveryModeMemoized }));

describe("withBundledPluginEnablementCompat", () => {
  beforeEach(() => {
    readBundledDiscoveryModeMemoized.mockClear();
    readBundledDiscoveryModeMemoized.mockReturnValue("allowlist");
  });

  it("returns unchanged config for an empty plugin list without reading upgrade state", () => {
    const config = { plugins: { allow: ["openai"] } } satisfies OpenClawConfig;

    expect(withBundledPluginEnablementCompat({ config, pluginIds: [] })).toBe(config);
    expect(readBundledDiscoveryModeMemoized).not.toHaveBeenCalled();
  });

  it("honors bundledDiscovery compat before plugin allowlists", () => {
    readBundledDiscoveryModeMemoized.mockReturnValue("compat");
    const config = {
      plugins: {
        allow: ["discord"],
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
    readBundledDiscoveryModeMemoized.mockReturnValue("compat");
    const config = {
      plugins: {
        allow: ["openai"],
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

  it("preserves explicit alias disables for canonical bundled plugin ids", () => {
    const config = {
      plugins: {
        entries: {
          "GOOGLE-GEMINI-CLI": {
            enabled: false,
            config: { projectId: "example" },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: ["google"],
      }),
    ).toEqual({
      plugins: {
        entries: {
          google: {
            enabled: false,
            config: { projectId: "example" },
          },
        },
      },
    });
  });

  it("canonicalizes compat aliases before extending the allowlist", () => {
    readBundledDiscoveryModeMemoized.mockReturnValue("compat");
    const config = {
      plugins: {
        allow: ["MINIMAX-PORTAL"],
        entries: {
          "MiNiMaX-PoRtAl-AuTh": { enabled: false },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      withBundledPluginEnablementCompat({
        config,
        pluginIds: [" MINIMAX-PORTAL-AUTH "],
      }),
    ).toEqual({
      plugins: {
        allow: ["minimax"],
        entries: {
          minimax: { enabled: false },
        },
      },
    });
  });

  it("preserves empty model policy arrays through repeated alias normalization", () => {
    const config = {
      plugins: {
        entries: {
          "GOOGLE-GEMINI-CLI": {
            subagent: { allowedModels: [] },
            llm: { allowedModels: [], allowedCompletionModels: [] },
          },
        },
      },
    } satisfies OpenClawConfig;

    const first = withBundledPluginEnablementCompat({ config, pluginIds: ["google"] });
    const second = withBundledPluginEnablementCompat({
      config: first,
      pluginIds: ["GOOGLE-GEMINI-CLI"],
    });

    const entry = second?.plugins?.entries?.google;
    expect(entry?.subagent?.allowedModels).toEqual([]);
    expect(entry?.llm?.allowedModels).toEqual([]);
    expect(entry?.llm?.allowedCompletionModels).toEqual([]);
  });
});
