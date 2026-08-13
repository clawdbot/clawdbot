/** Covers the operator-policy filter shared by plugin auto-enable and channel schema ownership. */
import { describe, expect, it } from "vitest";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isPluginPolicyDisabled } from "./plugin-replacement-eligibility.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("isPluginPolicyDisabled", () => {
  // #123209: the loader compares against the normalized policy view, so a raw lookup here let
  // schema ownership treat a plugin as active that the runtime never loads.
  it.each([
    { label: "padded, upper-cased deny entry", config: { plugins: { deny: [" MODERN "] } } },
    {
      label: "padded entry key disabled",
      config: { plugins: { entries: { " Modern ": { enabled: false } } } },
    },
  ])("treats $label as disabled", ({ config }) => {
    expect(isPluginPolicyDisabled(config as OpenClawConfig, "modern")).toBe(true);
  });

  it("resolves built-in plugin aliases before matching policy", () => {
    const config = { plugins: { deny: ["google-gemini-cli"] } } as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "google")).toBe(true);
  });

  it("reads a bundled channel plugin disabled through its channel config", () => {
    const config = { channels: { telegram: { enabled: false } } } as unknown as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "telegram")).toBe(true);
  });

  // Codex review P2 on #123209: the global switch stops all plugin discovery and load work, so no
  // plugin is active enough to take a channel from another. Auto-enable returns early on it.
  it("treats every plugin as disabled when plugins are switched off globally", () => {
    const config = { plugins: { enabled: false } } as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "modern")).toBe(true);
  });

  // Codex review P2 on #123209: Gateway startup canonicalizes policy lists through the registry
  // (normalizePluginsConfigForInstalledIndex), so an operator may deny a plugin by any alias it
  // declares. The default normalizer knows built-in aliases only.
  it.each([
    { label: "a channel id", denied: "clickclack" },
    { label: "a legacy plugin id", denied: "clickclack-legacy" },
  ])("resolves $label to the owning plugin through the registry", ({ denied }) => {
    const registry = {
      diagnostics: [],
      plugins: [
        {
          id: "clickclack-plus",
          origin: "workspace",
          channels: ["clickclack"],
          legacyPluginIds: ["clickclack-legacy"],
        },
      ],
    } as unknown as PluginManifestRegistry;
    const config = { plugins: { deny: [denied] } } as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "clickclack-plus")).toBe(false);
    expect(
      isPluginPolicyDisabled(
        config,
        "clickclack-plus",
        createManifestPluginAliasResolver(registry),
      ),
    ).toBe(true);
  });

  // Codex review P2 on #123209: `normalizePluginEntries` merges colliding keys and keeps an
  // earlier boolean when the later entry omits one, so an alias entry must not erase it.
  it("keeps a disabled entry when a colliding alias entry omits enabled", () => {
    const config = {
      plugins: { entries: { modern: { enabled: false }, MODERN: { config: {} } } },
    } as unknown as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "modern")).toBe(true);
  });

  it("leaves an untouched plugin enabled", () => {
    const config = {
      plugins: { deny: ["other"], entries: { modern: { enabled: true } } },
    } as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "modern")).toBe(false);
  });
});
