/** Covers how the configured channel ownership policy reads operator intent. */
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index-types.js";
import { collectCededChannelIdsByPlugin } from "../plugins/loader-shared.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPluginRegistryIdNormalizer } from "../plugins/plugin-registry-id-normalizer.js";
import { collectRuntimeChannelOwnership } from "./channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "./channel-ownership-policy.js";
import {
  materializePluginAutoEnableCandidatesInternal,
  resolveConfiguredPluginAutoEnableCandidates,
} from "./plugin-auto-enable.shared.js";
import { setGatewayAmbientEnvTriggerPolicy } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const registry = {
  diagnostics: [],
  plugins: [
    { id: "zzproof-core", origin: "config", channels: ["zzproofchat"] },
    { id: "zzproof-plus", origin: "config", channels: ["zzproofchat"] },
  ],
} as unknown as PluginManifestRegistry;

function policyFor(params: { config: OpenClawConfig; sourceConfig?: OpenClawConfig }) {
  return createConfiguredChannelOwnershipPolicy({
    config: params.config,
    ...(params.sourceConfig ? { sourceConfig: params.sourceConfig } : {}),
    registry,
    env: {},
  });
}

afterEach(() => {
  setGatewayAmbientEnvTriggerPolicy("suppress");
});

const EMPTY_REGISTRY = { diagnostics: [], plugins: [] } as unknown as PluginManifestRegistry;

function ambientPolicyFor() {
  return createConfiguredChannelOwnershipPolicy({
    config: {} as OpenClawConfig,
    registry: EMPTY_REGISTRY,
    env: { TELEGRAM_BOT_TOKEN: "zz-proof" },
  });
}

describe("createConfiguredChannelOwnershipPolicy", () => {
  // `--ambient-channels` raises the policy to "allow" for the whole run, but ownership is rebuilt
  // per Control UI config request with no access to those startup options. Under "allow" a channel
  // seen only through inherited environment variables counts as configured, so ownership narrows to
  // the claimants activation selected from; under "suppress" it is not configured at all and every
  // claimant stays active. An unrelated claimant is active in exactly one of the two, which is the
  // disagreement this pins.
  it.each([
    { name: "allow narrows to the activated claimants", recorded: "allow" as const, active: false },
    {
      name: "suppress leaves the channel unconfigured",
      recorded: "suppress" as const,
      active: true,
    },
  ])("$name", ({ recorded, active }) => {
    setGatewayAmbientEnvTriggerPolicy(recorded);

    expect(ambientPolicyFor().isPluginActive("zz-claimant", "telegram")).toBe(active);
  });

  it("reads suppress when no Gateway recorded a policy", () => {
    expect(ambientPolicyFor().isPluginActive("zz-claimant", "telegram")).toBe(true);
  });

  // Found by a live `openclaw config schema` run, not by unit tests: auto-enable writes
  // `plugins.entries.<id>.enabled` for every plugin it turns on, so reading explicit selection from
  // the materialized config reported auto-enabled plugins as hand-picked. That suppressed the
  // replacement rule on the Gateway schema path while validation still applied it, and the two
  // surfaces disagreed again in the opposite direction.
  it("reads explicit selection from the operator's config, not the materialized one", () => {
    const materialized = {
      plugins: {
        entries: { "zzproof-core": { enabled: true }, "zzproof-plus": { enabled: true } },
      },
    } as unknown as OpenClawConfig;
    const sourceConfig = { channels: { zzproofchat: {} } } as unknown as OpenClawConfig;

    const policy = policyFor({ config: materialized, sourceConfig });

    expect(policy.isPluginExplicitlySelected("zzproof-core")).toBe(false);
    expect(policy.isPluginExplicitlySelected("zzproof-plus")).toBe(false);
  });

  it("still honors a plugin the operator selected by hand", () => {
    const sourceConfig = {
      plugins: { entries: { "zzproof-core": { enabled: true } } },
    } as unknown as OpenClawConfig;

    const policy = policyFor({ config: sourceConfig, sourceConfig });

    expect(policy.isPluginExplicitlySelected("zzproof-core")).toBe(true);
    expect(policy.isPluginExplicitlySelected("zzproof-plus")).toBe(false);
  });

  it("falls back to the validated config when no source config is supplied", () => {
    const config = {
      plugins: { entries: { "zzproof-plus": { enabled: true } } },
    } as unknown as OpenClawConfig;

    expect(policyFor({ config }).isPluginExplicitlySelected("zzproof-plus")).toBe(true);
  });

  // Codex review P1 on #123209: an installed plugin may claim a built-in legacy alias key
  // ("minimax-portal") as its exact manifest id. Gateway startup pre-seeds exact installed ids
  // before any alias fallback, so folding the written id first attributed that plugin's policy
  // and explicit selection to the bundled owner the legacy alias names.
  it("attributes policy to an installed plugin whose exact id is a built-in legacy alias", () => {
    const aliasRegistry = {
      diagnostics: [],
      plugins: [
        { id: "minimax", origin: "bundled", providers: ["minimax", "minimax-portal"] },
        { id: "minimax-portal", origin: "installed" },
      ],
    } as unknown as PluginManifestRegistry;
    const policyOn = (entry: { enabled: boolean }) =>
      createConfiguredChannelOwnershipPolicy({
        config: {
          plugins: { entries: { "minimax-portal": entry } },
        } as unknown as OpenClawConfig,
        registry: aliasRegistry,
        env: {},
      });

    const disabled = policyOn({ enabled: false });
    expect(disabled.isPluginPolicyDisabled("minimax-portal")).toBe(true);
    expect(disabled.isPluginPolicyDisabled("minimax")).toBe(false);

    const selected = policyOn({ enabled: true });
    expect(selected.isPluginExplicitlySelected("minimax-portal")).toBe(true);
    expect(selected.isPluginExplicitlySelected("minimax")).toBe(false);
  });

  // Codex review P1 on #123209: auto-enable also writes `enabled: false` — for the displaced
  // middle of a replacement chain — so disablement read from the materialized config misreported
  // a synthesized disable as operator policy. The displacement closure then refused to propagate
  // the middle claimant's edge and runtime ownership drifted from validation's.
  it("does not read a synthesized disable in the materialized config as operator policy", () => {
    const materialized = {
      plugins: {
        entries: { "zzproof-core": { enabled: true }, "zzproof-plus": { enabled: false } },
      },
    } as unknown as OpenClawConfig;
    const sourceConfig = { channels: { zzproofchat: {} } } as unknown as OpenClawConfig;

    const policy = policyFor({ config: materialized, sourceConfig });

    expect(policy.isPluginPolicyDisabled("zzproof-plus")).toBe(false);
  });

  // The guard in the other direction: everything the operator actually wrote lives in the source
  // config and must keep disabling, or the fix above trades one misclassification for another.
  it.each([
    {
      name: "an authored entry disable",
      authored: { plugins: { entries: { "zzproof-plus": { enabled: false } } } },
    },
    { name: "an authored deny list", authored: { plugins: { deny: ["zzproof-plus"] } } },
    { name: "the authored global plugin switch", authored: { plugins: { enabled: false } } },
  ])("still counts $name", ({ authored }) => {
    const sourceConfig = authored as unknown as OpenClawConfig;
    // Materialization preserves authored policy while enabling other plugins, so the effective
    // config carries both; disablement must still surface from the authored half.
    const config = {
      ...sourceConfig,
      plugins: {
        ...sourceConfig.plugins,
        entries: {
          ...sourceConfig.plugins?.entries,
          "zzproof-core": { enabled: true },
        },
      },
    } as unknown as OpenClawConfig;

    expect(policyFor({ config, sourceConfig }).isPluginPolicyDisabled("zzproof-plus")).toBe(true);
  });

  it("still counts an authored bundled channel disable", () => {
    const bundledRegistry = {
      diagnostics: [],
      plugins: [{ id: "telegram", origin: "bundled", channels: ["telegram"] }],
    } as unknown as PluginManifestRegistry;
    const sourceConfig = {
      channels: { telegram: { enabled: false } },
    } as unknown as OpenClawConfig;

    const policy = createConfiguredChannelOwnershipPolicy({
      config: sourceConfig,
      sourceConfig,
      registry: bundledRegistry,
      env: {},
    });

    expect(policy.isPluginPolicyDisabled("telegram")).toBe(true);
  });

  // The full P1 scenario, through the real materialization: alpha replaces beta replaces gamma on
  // one configured channel, auto-enable disables beta as superseded everywhere, and gamma sits at
  // the closer origin. Misreading beta's synthesized disable dropped its edge to gamma, so the
  // runtime plane picked gamma while validation of the raw config closed the chain on alpha —
  // two distinct strict schemas for whichever plugin lost.
  it("closes a replacement chain past a synthesized disable like validation does", () => {
    const chainClaimant = (id: string, origin: string, preferOver?: readonly string[]) => ({
      id,
      origin,
      channels: ["zzchainchat"],
      channelConfigs: { zzchainchat: preferOver ? { preferOver } : {} },
    });
    const chainRegistry = {
      diagnostics: [],
      plugins: [
        chainClaimant("zzchain-alpha", "global", ["zzchain-beta"]),
        chainClaimant("zzchain-beta", "global", ["zzchain-gamma"]),
        chainClaimant("zzchain-gamma", "config"),
      ],
    } as unknown as PluginManifestRegistry;
    const sourceConfig = {
      channels: { zzchainchat: { accountLabel: "zz-proof" } },
    } as unknown as OpenClawConfig;
    const materialized = materializePluginAutoEnableCandidatesInternal({
      config: sourceConfig,
      candidates: resolveConfiguredPluginAutoEnableCandidates({
        config: sourceConfig,
        env: {},
        registry: chainRegistry,
        configuredChannelIds: ["zzchainchat"],
      }),
      env: {},
      manifestRegistry: chainRegistry,
    }).config;
    // Fixture sanity: auto-enable really synthesized beta's disable into the effective config.
    expect(materialized.plugins?.entries?.["zzchain-beta"]?.enabled).toBe(false);

    const loaderPolicy = createConfiguredChannelOwnershipPolicy({
      config: materialized,
      sourceConfig,
      registry: chainRegistry,
      env: {},
    });

    expect(loaderPolicy.isPluginPolicyDisabled("zzchain-beta")).toBe(false);
    // Activity keeps reading the effective config: the synthesized disable really does keep beta
    // from loading, and reporting it active would surface a schema the runtime never serves.
    expect(loaderPolicy.isPluginActive("zzchain-beta", "zzchainchat")).toBe(false);

    const { winners } = collectRuntimeChannelOwnership(chainRegistry, loaderPolicy);
    expect(winners.get("zzchainchat")).toBe("zzchain-alpha");
  });

  // Codex review P1: with no `preferOver` declared, the candidate set names only the first claim
  // and never asks whether that claimant is disabled. Equating candidacy with activation then
  // reported the fallback inactive exactly when the operator disabled the first claimant, while
  // startup default-loads an installed plugin with no adverse policy — so validation kept the
  // disabled claimant's strict schema for a channel the fallback actually serves.
  it("keeps the default-loaded fallback active when the first claim is disabled", () => {
    const config = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
      plugins: { entries: { "zzproof-core": { enabled: false } } },
    } as unknown as OpenClawConfig;

    const policy = policyFor({ config, sourceConfig: config });

    expect(policy.isPluginActive("zzproof-plus", "zzproofchat")).toBe(true);
    // Both planes then hand the channel to the claimant the runtime actually serves.
    const { winners } = collectRuntimeChannelOwnership(registry, policy);
    expect(winners.get("zzproofchat")).toBe("zzproof-plus");
  });

  // The default-activation read above must canonicalize `plugins.entries` keys through the
  // REGISTRY resolver, where an exact manifest id beats the built-in legacy fold
  // (`BUILT_IN_PLUGIN_ALIAS_FALLBACKS` in `config-state.ts`). An installed plugin may claim a
  // fold key ("minimax-portal") as its exact manifest id, and startup pre-seeds exact installed
  // ids without ever folding, so its entry disable stays on the installed plugin at startup.
  // Folding the entries key — before the resolver or after it — rewrites that disable onto the
  // bundled owner the fold names and reports the default-enabled fallback inactive while the
  // runtime serves it.
  it("keeps a fold-key entry disable off the bundled fallback the fold names", () => {
    const foldKeyRegistry = {
      diagnostics: [],
      plugins: [
        { id: "zzproof-core", origin: "config", channels: ["zzproofchat"] },
        {
          id: "minimax",
          origin: "bundled",
          enabledByDefault: true,
          channels: ["zzproofchat"],
          providers: ["minimax", "minimax-portal"],
        },
        { id: "minimax-portal", origin: "config", channels: [] },
      ],
    } as unknown as PluginManifestRegistry;
    // Fixture reachability, asserted through startup's own normalizer: the registry normalizer
    // pre-seeds exact installed ids before any alias claim (`createPluginRegistryIdNormalizer`),
    // so the operator's "minimax-portal" entry key lands on the installed plugin at startup —
    // never on bundled "minimax", even though the bundled manifest lists the same id as a
    // provider alias and the built-in fold table names it too.
    const startupNormalizePluginId = createPluginRegistryIdNormalizer(
      { plugins: [{ pluginId: "minimax-portal" }] } as unknown as InstalledPluginIndex,
      { manifestRegistry: foldKeyRegistry },
    );
    expect(startupNormalizePluginId("minimax-portal")).toBe("minimax-portal");

    const config = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
      plugins: {
        entries: {
          "zzproof-core": { enabled: false },
          "minimax-portal": { enabled: false },
        },
      },
    } as unknown as OpenClawConfig;

    const policy = createConfiguredChannelOwnershipPolicy({
      config,
      sourceConfig: config,
      registry: foldKeyRegistry,
      env: {},
    });

    // Neither disable belongs to bundled "minimax", so its default enablement keeps it active
    // on the channel the first claimant no longer serves.
    expect(policy.isPluginActive("minimax", "zzproofchat")).toBe(true);
    const { winners } = collectRuntimeChannelOwnership(foldKeyRegistry, policy);
    expect(winners.get("zzproofchat")).toBe("minimax");
  });

  // Codex review P2: policy lists accept a plugin's manifest aliases, and Gateway startup
  // canonicalizes them through the registry resolver (`normalizePluginsConfigWithRegistry`)
  // before the activation decision. The default-activation check above normalized through the
  // built-in fold only, which cannot see `legacyPluginIds`, so an enabled-by-default bundled
  // fallback admitted by a restrictive `plugins.allow` list under such an alias loaded at
  // startup while ownership reported it "not-in-allowlist" and kept the disabled claimant's
  // schema.
  const makeAllowlistAliasRegistry = (enabledByDefault: boolean) =>
    ({
      diagnostics: [],
      plugins: [
        { id: "zzproof-core", origin: "config", channels: ["zzproofchat"] },
        {
          id: "zzfall-back",
          origin: "bundled",
          enabledByDefault,
          channels: ["zzproofchat"],
          legacyPluginIds: ["zzfall-legacy"],
        },
      ],
    }) as unknown as PluginManifestRegistry;

  it("admits the default-enabled fallback a restrictive allowlist names by manifest alias", () => {
    const config = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
      plugins: {
        allow: ["zzproof-core", "zzfall-legacy"],
        entries: { "zzproof-core": { enabled: false } },
      },
    } as unknown as OpenClawConfig;

    const aliasRegistry = makeAllowlistAliasRegistry(true);
    const policy = createConfiguredChannelOwnershipPolicy({
      config,
      sourceConfig: config,
      registry: aliasRegistry,
      env: {},
    });

    expect(policy.isPluginActive("zzfall-back", "zzproofchat")).toBe(true);
    const { winners } = collectRuntimeChannelOwnership(aliasRegistry, policy);
    expect(winners.get("zzproofchat")).toBe("zzfall-back");
  });

  // The admission above must come from default enablement passing the canonicalized allowlist,
  // not from reading the alias listing itself as activation: for a bundled plugin the allowlist
  // only permits loading, so without default enablement startup leaves the fallback off
  // ("bundled-disabled-by-default") and ownership must keep reporting it inactive.
  it("keeps an alias-allowlisted bundled fallback without default enablement inactive", () => {
    const config = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
      plugins: {
        allow: ["zzproof-core", "zzfall-legacy"],
        entries: { "zzproof-core": { enabled: false } },
      },
    } as unknown as OpenClawConfig;
    const policy = createConfiguredChannelOwnershipPolicy({
      config,
      sourceConfig: config,
      registry: makeAllowlistAliasRegistry(false),
      env: {},
    });

    expect(policy.isPluginActive("zzfall-back", "zzproofchat")).toBe(false);
  });

  // The narrowing this fallback must not undo: a claimant startup leaves off — a bundled plugin
  // without default enablement, a workspace plugin nothing trusts — never loads, so reporting it
  // active would surface a schema the runtime never serves.
  it.each([
    { name: "a bundled claimant without default enablement", origin: "bundled" },
    { name: "a workspace claimant nothing trusts", origin: "workspace" },
  ])("keeps $name narrowed out of a configured channel", ({ origin }) => {
    const narrowedRegistry = {
      diagnostics: [],
      plugins: [
        { id: "zzproof-core", origin: "config", channels: ["zzproofchat"] },
        { id: "zzproof-extra", origin, channels: ["zzproofchat"] },
      ],
    } as unknown as PluginManifestRegistry;
    const config = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
    } as unknown as OpenClawConfig;

    const policy = createConfiguredChannelOwnershipPolicy({
      config,
      sourceConfig: config,
      registry: narrowedRegistry,
      env: {},
    });

    expect(policy.isPluginActive("zzproof-extra", "zzproofchat")).toBe(false);
  });

  // The declared contest keeps the narrowing too: once a claimant declares `preferOver`, the
  // loader cedes every claimant outside the declaring pair to its winner, so a default-loaded
  // claimant outside the pair still never serves the channel and must not be reported active.
  it("keeps a default-loaded claimant outside a declared pair narrowed out", () => {
    const claimant = (id: string, preferOver?: readonly string[]) => ({
      id,
      origin: "config",
      channels: ["zzproofchat"],
      channelConfigs: { zzproofchat: preferOver ? { preferOver } : {} },
    });
    const declaredRegistry = {
      diagnostics: [],
      plugins: [
        claimant("zzproof-plus", ["zzproof-core"]),
        claimant("zzproof-core"),
        claimant("zzproof-other"),
      ],
    } as unknown as PluginManifestRegistry;
    const config = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
    } as unknown as OpenClawConfig;

    const policy = createConfiguredChannelOwnershipPolicy({
      config,
      sourceConfig: config,
      registry: declaredRegistry,
      env: {},
    });

    expect(policy.isPluginActive("zzproof-plus", "zzproofchat")).toBe(true);
    expect(policy.isPluginActive("zzproof-other", "zzproofchat")).toBe(false);
  });

  // Codex P1 3845532981: the narrowing above presumes some pair member serves. When the operator
  // disables EVERY narrowed candidate, auto-enable activates none of them, the computed winner is
  // inactive, and the loader stands no cede — the default-loaded claimant outside the pair
  // registers and serves the channel. Reporting it inactive validated the operator's config
  // against a disabled claimant's strict schema for a channel that fallback actually serves.
  it("falls back to the default-loaded claimant when every narrowed candidate is disabled", () => {
    const claimant = (id: string, preferOver?: readonly string[]) => ({
      id,
      origin: "config",
      channels: ["zzproofchat"],
      channelConfigs: { zzproofchat: preferOver ? { preferOver } : {} },
    });
    const declaredRegistry = {
      diagnostics: [],
      plugins: [
        claimant("zzproof-plus", ["zzproof-core"]),
        claimant("zzproof-core"),
        claimant("zzproof-other"),
      ],
    } as unknown as PluginManifestRegistry;
    const sourceConfig = {
      channels: { zzproofchat: { accountLabel: "zz-proof" } },
      plugins: {
        entries: {
          "zzproof-plus": { enabled: false },
          "zzproof-core": { enabled: false },
        },
      },
    } as unknown as OpenClawConfig;
    // The effective config through the real materialization: with every narrowed candidate
    // disabled, auto-enable enables nothing and leaves the outside claimant to default loading.
    const materialized = materializePluginAutoEnableCandidatesInternal({
      config: sourceConfig,
      candidates: resolveConfiguredPluginAutoEnableCandidates({
        config: sourceConfig,
        env: {},
        registry: declaredRegistry,
        configuredChannelIds: ["zzproofchat"],
      }),
      env: {},
      manifestRegistry: declaredRegistry,
    }).config;
    expect(materialized.plugins?.entries?.["zzproof-other"]).toBeUndefined();

    const policy = createConfiguredChannelOwnershipPolicy({
      config: materialized,
      sourceConfig,
      registry: declaredRegistry,
      env: {},
    });

    expect(policy.isPluginActive("zzproof-plus", "zzproofchat")).toBe(false);
    expect(policy.isPluginActive("zzproof-core", "zzproofchat")).toBe(false);
    expect(policy.isPluginActive("zzproof-other", "zzproofchat")).toBe(true);
    // Both planes then follow the claimant the runtime actually serves, and the loader lets its
    // registration stand instead of ceding it to a disabled winner.
    const { winners } = collectRuntimeChannelOwnership(declaredRegistry, policy);
    expect(winners.get("zzproofchat")).toBe("zzproof-other");
    const { cededChannelIdsByPlugin } = collectCededChannelIdsByPlugin({
      registry: declaredRegistry,
      config: materialized,
      sourceConfig,
      env: {},
      onlyPluginIdSet: null,
      dreamingSidecar: null,
    });
    expect(cededChannelIdsByPlugin.size).toBe(0);
  });

  // The displacement walk in `channel-config-metadata.ts` applies every resolved non-self
  // `preferOver` edge without asking whether the named target claims the channel, so an edge to
  // an uninstalled plugin still marks the channel contested and the loader cedes the bare
  // claimant's registration to the declarant. Deriving the narrowing flag from claimant-target
  // edges only reported that ceded claimant active — the schema/runtime split this policy exists
  // to close, reintroduced by the default-loaded fallback above.
  it("agrees with the loader cede when a preferOver edge names a non-claimant", () => {
    const edgeRegistry = {
      diagnostics: [],
      plugins: [
        {
          id: "zzedge-a",
          origin: "config",
          channels: ["zzedgechat"],
          channelConfigs: { zzedgechat: { preferOver: ["zzedge-ghost"] } },
        },
        { id: "zzedge-b", origin: "config", channels: ["zzedgechat"] },
      ],
    } as unknown as PluginManifestRegistry;
    const config = {
      channels: { zzedgechat: { accountLabel: "zz-proof" } },
    } as unknown as OpenClawConfig;

    const { cededChannelIdsByPlugin } = collectCededChannelIdsByPlugin({
      registry: edgeRegistry,
      config,
      sourceConfig: config,
      env: {},
      onlyPluginIdSet: null,
      dreamingSidecar: null,
    });
    // The loader really cedes the bare claimant on this edge; the fixture must keep exercising
    // the displacement it pins.
    expect(cededChannelIdsByPlugin.get("zzedge-b")).toEqual(["zzedgechat"]);

    const policy = createConfiguredChannelOwnershipPolicy({
      config,
      sourceConfig: config,
      registry: edgeRegistry,
      env: {},
    });
    // A claimant whose registration startup cedes away must not be reported active.
    expect(policy.isPluginActive("zzedge-b", "zzedgechat")).toBe(false);
    expect(policy.isPluginActive("zzedge-a", "zzedgechat")).toBe(true);
  });
});
