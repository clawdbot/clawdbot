/** Covers the operator-policy filter shared by plugin auto-enable and channel schema ownership. */
import { describe, expect, it } from "vitest";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  isPluginExplicitlySelectedByAlias,
  isPluginPolicyDisabled,
} from "./plugin-replacement-eligibility.js";
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

describe("isPluginExplicitlySelectedByAlias", () => {
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
  const canonicalId = createManifestPluginAliasResolver(registry);

  // Codex review P1 on #123209: schema ownership canonicalized aliases while auto-enable's
  // preservation check still read the raw config, so an alias-selected fallback kept its strict
  // schema for validation and was written `enabled: false` for startup.
  it.each([
    { label: "a channel id in allow", config: { plugins: { allow: ["clickclack"] } } },
    { label: "a legacy id in allow", config: { plugins: { allow: ["clickclack-legacy"] } } },
    {
      label: "a legacy id entry",
      config: { plugins: { entries: { "clickclack-legacy": { enabled: true } } } },
    },
  ])("sees selection written as $label", ({ config }) => {
    expect(
      isPluginExplicitlySelectedByAlias(
        config as unknown as OpenClawConfig,
        "clickclack-plus",
        canonicalId,
      ),
    ).toBe(true);
  });

  // ClawSweeper P1 on #123209: folding alias spellings into one map by assignment let a later
  // empty alias overwrite an earlier material entry. Startup field-merges those collisions, so
  // every spelling has to be considered rather than the last one written.
  it("keeps a material entry when a later colliding alias entry is empty", () => {
    const config = {
      plugins: { entries: { "clickclack-plus": { enabled: true }, "clickclack-legacy": {} } },
    } as unknown as OpenClawConfig;

    expect(isPluginExplicitlySelectedByAlias(config, "clickclack-plus", canonicalId)).toBe(true);
  });

  // Codex review P1 on #123209: `config-activation-shared.ts` counts
  // `channels.<id>.enabled: true` on a bundled plugin as explicit selection
  // ("bundled-channel-enabled-in-config"). Reading only plugins.allow/entries here let
  // `disableImplicitPreferredOverPlugin` write `enabled: false` over that operator choice.
  it("sees a bundled fallback selected through its channel config", () => {
    const bundledRegistry = {
      diagnostics: [],
      plugins: [{ id: "telegram", origin: "bundled", channels: ["telegram"] }],
    } as unknown as PluginManifestRegistry;
    const config = { channels: { telegram: { enabled: true } } } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "telegram",
        createManifestPluginAliasResolver(bundledRegistry),
        bundledRegistry,
      ),
    ).toBe(true);
  });

  // The same channel flag on a non-bundled plugin is not explicit selection under that contract,
  // so widening this predicate must not widen it further than activation does.
  it("does not treat the channel flag as selection for a non-bundled plugin", () => {
    const externalRegistry = {
      diagnostics: [],
      plugins: [{ id: "telegram", origin: "workspace", channels: ["telegram"] }],
    } as unknown as PluginManifestRegistry;
    const config = { channels: { telegram: { enabled: true } } } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "telegram",
        createManifestPluginAliasResolver(externalRegistry),
        externalRegistry,
      ),
    ).toBe(false);
  });

  // Codex review P2 on #123209: `plugins.slots.memory` and `plugins.slots.contextEngine` are
  // explicit-selection causes in the activation contract, and activation checks entry disablement
  // before its slot branches. Missing them here let `disableImplicitPreferredOverPlugin` write
  // `enabled: false` for the operator's chosen memory or context engine.
  it.each([
    { slot: "memory", config: { plugins: { slots: { memory: "clickclack-plus" } } } },
    { slot: "contextEngine", config: { plugins: { slots: { contextEngine: "clickclack-plus" } } } },
  ])("sees a plugin pinned to the $slot slot", ({ config }) => {
    expect(
      isPluginExplicitlySelectedByAlias(
        config as unknown as OpenClawConfig,
        "clickclack-plus",
        canonicalId,
        registry,
      ),
    ).toBe(true);
  });

  it("does not treat an unrelated slot pin as selection", () => {
    const config = {
      plugins: { slots: { memory: "someone-else" } },
    } as unknown as OpenClawConfig;

    expect(isPluginExplicitlySelectedByAlias(config, "clickclack-plus", canonicalId, registry)).toBe(
      false,
    );
  });

  it("reports no selection when the operator wrote neither", () => {
    expect(
      isPluginExplicitlySelectedByAlias({} as OpenClawConfig, "clickclack-plus", canonicalId),
    ).toBe(false);
  });
});
