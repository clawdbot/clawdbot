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

  // `channels.<id>.enabled` is a policy switch only for the bundled owner of the built-in channel:
  // activation has no channel-level disable arm for any other origin. Reading it wide disabled an
  // installed plugin whose id (or an alias of it) is a built-in channel id, and ownership flipped
  // every channel it claims away from the plugin the runtime keeps running.
  it.each([
    { label: "its exact id", pluginId: "telegram", channelKey: "telegram" },
    { label: "a channel alias of its id", pluginId: "lark", channelKey: "feishu" },
  ])(
    "does not read the channel flag as policy for an external plugin matching $label",
    ({ pluginId, channelKey }) => {
      const externalRegistry = {
        diagnostics: [],
        plugins: [{ id: pluginId, origin: "workspace", channels: ["zzgamma"] }],
      } as unknown as PluginManifestRegistry;
      const config = {
        channels: { [channelKey]: { enabled: false } },
      } as unknown as OpenClawConfig;

      expect(
        isPluginPolicyDisabled(
          config,
          pluginId,
          createManifestPluginAliasResolver(externalRegistry),
          externalRegistry,
        ),
      ).toBe(false);
    },
  );

  // The registry narrows the arm to the bundled owner; it must not lose that owner's own flag.
  // The registry-less caller above keeps the wide reading because it cannot see origin.
  it("still reads the channel flag for the bundled owner when a registry is supplied", () => {
    const bundledRegistry = {
      diagnostics: [],
      plugins: [{ id: "telegram", origin: "bundled", channels: ["telegram"] }],
    } as unknown as PluginManifestRegistry;
    const config = { channels: { telegram: { enabled: false } } } as unknown as OpenClawConfig;

    expect(
      isPluginPolicyDisabled(
        config,
        "telegram",
        createManifestPluginAliasResolver(bundledRegistry),
        bundledRegistry,
      ),
    ).toBe(true);
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

  // Codex review P1 on #123209: an installed plugin may claim a built-in legacy alias key
  // ("minimax-portal") as its exact manifest id. Gateway startup pre-seeds exact installed ids
  // before any alias fallback, so policy written against that id must stay on the installed
  // plugin instead of folding onto the bundled owner the legacy alias names.
  it("keeps policy on an installed plugin whose exact id is a built-in legacy alias", () => {
    const registry = {
      diagnostics: [],
      plugins: [
        { id: "minimax", origin: "bundled", providers: ["minimax", "minimax-portal"] },
        { id: "minimax-portal", origin: "installed" },
      ],
    } as unknown as PluginManifestRegistry;
    const resolveAlias = createManifestPluginAliasResolver(registry);
    const config = {
      plugins: { entries: { "minimax-portal": { enabled: false } } },
    } as unknown as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "minimax-portal", resolveAlias)).toBe(true);
    expect(isPluginPolicyDisabled(config, "minimax", resolveAlias)).toBe(false);
  });

  // The fold is the fallback, not gone: with no registry claimant for the key, a policy entry
  // written under the legacy id still lands on the bundled plugin it names.
  it("still folds a built-in legacy alias the registry does not know", () => {
    const registry = {
      diagnostics: [],
      plugins: [{ id: "other", origin: "workspace" }],
    } as unknown as PluginManifestRegistry;
    const config = { plugins: { deny: ["minimax-portal"] } } as OpenClawConfig;

    expect(
      isPluginPolicyDisabled(config, "minimax", createManifestPluginAliasResolver(registry)),
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

  // Activation gates its allowlist cause on non-bundled origin (`src/plugins/config-activation-shared.ts`,
  // "selected-in-allowlist"): for a bundled plugin the allowlist only permits loading, so a
  // disabled-by-default bundled fallback merely listed there stays off
  // ("bundled-disabled-by-default"). Counting the listing as selection here set aside the
  // replacement's edge and preserved a fallback the runtime never loads.
  it("does not treat an allow listing as selection for a bundled plugin", () => {
    const bundledRegistry = {
      diagnostics: [],
      plugins: [{ id: "telegram", origin: "bundled", channels: ["telegram"] }],
    } as unknown as PluginManifestRegistry;
    const config = { plugins: { allow: ["telegram"] } } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "telegram",
        createManifestPluginAliasResolver(bundledRegistry),
        bundledRegistry,
      ),
    ).toBe(false);
  });

  // For a non-bundled plugin the listing is the activation cause itself, registry or not.
  it("still treats an allow listing as selection for a non-bundled plugin", () => {
    const config = { plugins: { allow: ["clickclack"] } } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(config, "clickclack-plus", canonicalId, registry),
    ).toBe(true);
  });

  // Codex review P2 on #123209: `plugins.slots.memory` and `plugins.slots.contextEngine` are
  // explicit-selection causes in the activation contract, and activation checks entry disablement
  // before its slot branches. Missing them here let `disableImplicitPreferredOverPlugin` write
  // `enabled: false` for the operator's chosen memory or context engine.
  it.each([
    { slot: "memory", config: { plugins: { slots: { memory: "clickclack-plus" } } } },
    { slot: "contextEngine", config: { plugins: { slots: { contextEngine: "clickclack-plus" } } } },
  ])("sees a plugin pinned to the $slot slot", ({ config }) => {
    // Global origin on purpose: the workspace gate below covers the untrusted-workspace case, and
    // this one is about the slot arms themselves.
    const globalRegistry = {
      diagnostics: [],
      plugins: [{ id: "clickclack-plus", origin: "global", channels: ["clickclack"] }],
    } as unknown as PluginManifestRegistry;

    expect(
      isPluginExplicitlySelectedByAlias(
        config as unknown as OpenClawConfig,
        "clickclack-plus",
        createManifestPluginAliasResolver(globalRegistry),
        globalRegistry,
      ),
    ).toBe(true);
  });

  // Codex review P2 on #123209: my first version of the slot arm resolved both slots through
  // `resolveSlotSelection`, which answers with the slot default when nothing is authored. Startup
  // does that for memory (`resolveMemorySlotStartupPluginId` falls back to the resolved default)
  // but NOT for the context engine, which returns undefined when the slot is blank. Promoting the
  // unset context-engine default marked a plugin named `legacy` explicitly selected, suppressing a
  // replacement's edge for a plugin startup never selects.
  it("does not promote the unset context-engine default", () => {
    const legacyRegistry = {
      diagnostics: [],
      plugins: [{ id: "legacy", origin: "workspace", channels: ["clickclack"] }],
    } as unknown as PluginManifestRegistry;

    expect(
      isPluginExplicitlySelectedByAlias(
        {} as OpenClawConfig,
        "legacy",
        createManifestPluginAliasResolver(legacyRegistry),
        legacyRegistry,
      ),
    ).toBe(false);
  });

  it("still honours an authored context-engine slot", () => {
    const legacyRegistry = {
      diagnostics: [],
      plugins: [{ id: "legacy", origin: "workspace", channels: ["clickclack"] }],
    } as unknown as PluginManifestRegistry;
    const config = {
      plugins: { slots: { contextEngine: "legacy" } },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "legacy",
        createManifestPluginAliasResolver(legacyRegistry),
        legacyRegistry,
      ),
    ).toBe(true);
  });

  // Codex review P2 on #123209: startup canonicalizes an authored slot only to decide which
  // plugins to consider (`resolveContextEngineSlotStartupPluginId`); the activation cause is an
  // exact match on the authored spelling (`config-normalization-shared.ts` leaves slot values
  // raw, `config-activation-shared.ts` compares `slots.contextEngine === params.id`). A slot
  // authored as a legacy alias therefore selects nothing and the workspace gate disables the
  // claimant. Resolving the alias in the predicate marked that claimant hand-picked, kept its
  // replacement's edge suppressed, and validation retained the schema of a plugin the runtime
  // never loads.
  it("does not resolve aliases for the context-engine slot startup matches exactly", () => {
    const config = {
      plugins: { slots: { contextEngine: "clickclack-legacy" } },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(config, "clickclack-plus", canonicalId, registry),
    ).toBe(false);
  });

  // The memory activation cause is the same exact match on the authored spelling: normalization
  // hands activation `resolveSlotSelection`'s reading untouched (`config-normalization-shared.ts`)
  // and `config-activation-shared.ts` compares `slots.memory === params.id`. A slot authored as a
  // legacy alias therefore selects nothing at startup; resolving the alias here marked the plugin
  // hand-picked while the allowlist gate keeps it disabled.
  it("does not resolve aliases for the memory slot startup matches exactly", () => {
    const memoryRegistry = {
      diagnostics: [],
      plugins: [{ id: "recall-plus", origin: "global", legacyPluginIds: ["recall-legacy"] }],
    } as unknown as PluginManifestRegistry;
    const config = {
      plugins: { slots: { memory: "recall-legacy" } },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "recall-plus",
        createManifestPluginAliasResolver(memoryRegistry),
        memoryRegistry,
      ),
    ).toBe(false);
  });

  // An unset slot resolves to the default owner on both sides: `resolveSlotSelection` answers
  // "memory-core" here and normalization feeds activation the same resolved default, so the exact
  // compare still selects it.
  it("still selects the default memory owner when the slot is unset", () => {
    const memoryRegistry = {
      diagnostics: [],
      plugins: [{ id: "memory-core", origin: "bundled" }],
    } as unknown as PluginManifestRegistry;

    expect(
      isPluginExplicitlySelectedByAlias(
        {} as OpenClawConfig,
        "memory-core",
        createManifestPluginAliasResolver(memoryRegistry),
        memoryRegistry,
      ),
    ).toBe(true);
  });

  // Codex review P2 on #123209: the workspace gate in `resolvePluginActivationDecisionShared` runs
  // BEFORE the memory-slot branch and exempts only `selected-context-engine-slot`
  // (`config-activation-shared.ts:186-201`). So for an untrusted workspace plugin the memory slot
  // does not rescue it and the context-engine slot does — pinned both ways by
  // `config-state.test.ts:671-690`.
  it("does not let the memory slot select an untrusted workspace plugin", () => {
    const workspaceRegistry = {
      diagnostics: [],
      plugins: [{ id: "memory-core", origin: "workspace", channels: ["clickclack"] }],
    } as unknown as PluginManifestRegistry;
    const config = {
      plugins: { slots: { memory: "memory-core" } },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "memory-core",
        createManifestPluginAliasResolver(workspaceRegistry),
        workspaceRegistry,
      ),
    ).toBe(false);
  });

  it.each([
    { how: "plugins.allow", extra: { allow: ["memory-core"] } },
    { how: "an enabled entry", extra: { entries: { "memory-core": { enabled: true } } } },
  ])("lets the memory slot select a workspace plugin trusted through $how", ({ extra }) => {
    const workspaceRegistry = {
      diagnostics: [],
      plugins: [{ id: "memory-core", origin: "workspace", channels: ["clickclack"] }],
    } as unknown as PluginManifestRegistry;
    const config = {
      plugins: { slots: { memory: "memory-core" }, ...extra },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "memory-core",
        createManifestPluginAliasResolver(workspaceRegistry),
        workspaceRegistry,
      ),
    ).toBe(true);
  });

  it("still lets the context-engine slot select an untrusted workspace plugin", () => {
    const workspaceRegistry = {
      diagnostics: [],
      plugins: [{ id: "lossless-claw", origin: "workspace", channels: ["clickclack"] }],
    } as unknown as PluginManifestRegistry;
    const config = {
      plugins: { slots: { contextEngine: "lossless-claw" } },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(
        config,
        "lossless-claw",
        createManifestPluginAliasResolver(workspaceRegistry),
        workspaceRegistry,
      ),
    ).toBe(true);
  });

  it("does not treat an unrelated slot pin as selection", () => {
    const config = {
      plugins: { slots: { memory: "someone-else" } },
    } as unknown as OpenClawConfig;

    expect(
      isPluginExplicitlySelectedByAlias(config, "clickclack-plus", canonicalId, registry),
    ).toBe(false);
  });

  it("reports no selection when the operator wrote neither", () => {
    expect(
      isPluginExplicitlySelectedByAlias({} as OpenClawConfig, "clickclack-plus", canonicalId),
    ).toBe(false);
  });
});
