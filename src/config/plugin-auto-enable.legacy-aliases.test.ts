// Legacy plugin id aliases: a manifest's documented `legacyPluginIds` name the SAME plugin under
// its old key, and the runtime's registry-aware normalizer folds operator config written under
// them onto the current id. Every planner selection, disablement, deny, allowlist, and entry-key
// read must honor the same alias contract — and never let a declared alias capture config that
// belongs to a DIFFERENT installed plugin whose current id collides with it.
import { beforeEach, describe, expect, it } from "vitest";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import {
  makeIsolatedEnv,
  makeRegistry,
  resetPluginAutoEnableTestState,
} from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type RegistryPlugins = Parameters<typeof makeRegistry>[0];

beforeEach(() => {
  resetPluginAutoEnableTestState();
});

// #120332 round 36 (P1): selection reads honor legacy aliases — an operator's material entry
// under the documented old id selects the incumbent, so a replacement supersedes it as KEPT.
describe("legacy plugin ids select the incumbent", () => {
  const CURRENT_INC: RegistryPlugins[number] = {
    id: "acme-current",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    legacyPluginIds: ["acme-old"],
  };
  const CASE_REP: RegistryPlugins[number] = {
    id: "acme-case-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["Acme-Current"] } },
  };

  it("keeps the incumbent configured under its legacy id", () => {
    const registry = makeRegistry([CURRENT_INC, CASE_REP]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-old": { config: { keep: true } } } },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // The legacy entry is the operator's selection of the incumbent: superseded it lands KEPT,
    // and no disable is appended under the current id for folding to invert.
    expect(result.config.plugins?.entries?.["acme-current"]?.enabled).not.toBe(false);
    expect(result.config.plugins?.entries?.["acme-old"]?.enabled).not.toBe(false);
  });
});

// #120332 round 38 (P1): a legacy-keyed entry's disablement folds onto the current id the way
// the runtime's registry-aware normalizer folds it before enablement reads. A plain fold leaves
// `enabled: false` stranded under the alias key while the alias-aware selection read still sees
// the entry's material config, so validation projects the incumbent kept-live and awards it
// ownership by discovery order — the runtime disables it and serves only the replacement.
describe("legacy-keyed disablement folds onto the current id", () => {
  const LEG_INC: RegistryPlugins[number] = {
    id: "acme-leg-inc",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    legacyPluginIds: ["acme-leg-old"],
  };
  const LEG_REP: RegistryPlugins[number] = {
    id: "acme-leg-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-leg-inc"] } },
  };

  it("projects the disabled incumbent dead and awards ownership to the replacement", () => {
    const registry = makeRegistry([LEG_INC, LEG_REP]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      // enabled:false beside material config: only an alias-aware disablement read keeps the
      // projection off the incumbent the material fields otherwise mark explicitly selected.
      plugins: { entries: { "acme-leg-old": { enabled: false, config: { keep: true } } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-leg-rep");
    // The pass never resurrects the disabled incumbent; the replacement serves the channel.
    expect(result.config.plugins?.entries?.["acme-leg-inc"]?.enabled).not.toBe(true);
    expect(result.config.plugins?.entries?.["acme-leg-rep"]?.enabled).toBe(true);
  });
});

// #120332 round 39 (P1): the deny read honors legacy aliases like the runtime's policy-list
// normalization. Denying a plugin's documented old id forbids the current plugin at load, so a
// planner that misses the alias enables the denied replacement and disables its victim — the
// gateway then blocks the replacement too and the configured channel loses every owner.
describe("legacy-keyed deny forbids the current plugin", () => {
  const DENIED_CURRENT: RegistryPlugins[number] = {
    id: "acme-deny-cur",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-deny-victim"] } },
    legacyPluginIds: ["acme-deny-old"],
  };
  const DENY_VICTIM: RegistryPlugins[number] = {
    id: "acme-deny-victim",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("keeps the victim live when the superseder is denied under its legacy id", () => {
    const registry = makeRegistry([DENY_VICTIM, DENIED_CURRENT]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { deny: ["acme-deny-old"] },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // The denied replacement never activates, so its claim must not disable the victim.
    expect(result.config.plugins?.entries?.["acme-deny-cur"]?.enabled).not.toBe(true);
    expect(result.config.plugins?.entries?.["acme-deny-victim"]?.enabled).not.toBe(false);
    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-deny-victim");
  });
});

// #120332 round 39 (P2): a restrictive allowlist that already contains a plugin's documented
// legacy id admits the current plugin at load, so the apply step must not append the current id
// beside it — removing the operator's original entry would then still leave the plugin allowed.
describe("legacy allowlist entries already admit the plugin", () => {
  const ALLOWED_CURRENT: RegistryPlugins[number] = {
    id: "acme-allow-cur",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    legacyPluginIds: ["acme-allow-old"],
  };

  it("does not append the current id beside the operator's legacy allow entry", () => {
    const registry = makeRegistry([ALLOWED_CURRENT]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { allow: ["acme-allow-old"] },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    expect(result.config.plugins?.allow).toEqual(["acme-allow-old"]);
  });
});

// #120332 round 44 (P2): the built-in fallback alias map (google-gemini-cli -> google) exists
// for configs naming plugins that are NOT installed. When both ids are installed as DISTINCT
// plugins, the runtime registry normalizer preserves each current id — the fold must not
// collapse them, or one plugin's disable lands on the other.
describe("installed current ids are never collapsed by built-in fallback aliases", () => {
  const GOOGLE_CURRENT: RegistryPlugins[number] = {
    id: "google",
    origin: "global",
    channels: ["acme-g"],
    channelConfigs: { "acme-g": { schema: { type: "object" } } },
  };
  const GEMINI_CLI_CURRENT: RegistryPlugins[number] = {
    id: "google-gemini-cli",
    origin: "global",
    channels: ["acme-h"],
    channelConfigs: { "acme-h": { schema: { type: "object" } } },
  };
  const G_FALLBACK: RegistryPlugins[number] = {
    id: "acme-g-fallback",
    origin: "global",
    channels: ["acme-g"],
    channelConfigs: { "acme-g": { schema: { type: "object" } } },
  };

  it("disables only the entry's own plugin, not its fallback-alias sibling", () => {
    const registry = makeRegistry([GOOGLE_CURRENT, GEMINI_CLI_CURRENT, G_FALLBACK]);
    const config: OpenClawConfig = {
      channels: { "acme-g": { token: "g" }, "acme-h": { token: "h" } },
      plugins: { entries: { "google-gemini-cli": { enabled: false } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // google's channel keeps its claimant: the sibling's disable must not fold onto it and
    // hand the channel to the fallback.
    expect(result.config.plugins?.entries?.google?.enabled).not.toBe(false);
    expect(result.config.plugins?.entries?.["acme-g-fallback"]?.enabled).not.toBe(true);
    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-g",
    );
    expect(owner?.schemaPluginId).toBe("google");
  });
});

// #120332 round 42 (P1): selection aliases cover EVERY runtime contribution alias, not just
// `legacyPluginIds` — the gateway's registry normalizer folds config keyed by a plugin's channel
// or provider ids onto the plugin (plugin-registry.test.ts pins that contract). A fold that
// recognizes only legacy ids treats a channel-keyed material entry as no selection, appends a
// current-id disable for the replacement, and runtime normalization merges that disable over the
// operator's aliased config — silently removing the configured capability.
describe("contribution aliases select the incumbent", () => {
  const CHAN_ALIAS_INC: RegistryPlugins[number] = {
    id: "acme-inc2",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const CHAN_ALIAS_REP: RegistryPlugins[number] = {
    id: "acme-rep2",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["Acme-Inc2"] } },
  };

  it("keeps an incumbent materially configured under its channel-id alias", () => {
    const registry = makeRegistry([CHAN_ALIAS_INC, CHAN_ALIAS_REP]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      // "acme-x" is the incumbent's channel id: the runtime normalizer folds this entry onto
      // the incumbent (first claimant in id order), so it is the operator's selection.
      plugins: { entries: { "acme-x": { config: { keep: true } } } },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // Selected through the alias, the superseded incumbent lands KEPT: no disable is appended
    // for runtime normalization to merge over the operator's aliased config.
    expect(result.config.plugins?.entries?.["acme-inc2"]?.enabled).not.toBe(false);
    expect(result.config.plugins?.entries?.["acme-x"]?.enabled).not.toBe(false);
  });
});

// #120332 round 41 (P1): fallback re-selection prefers operator-signaled ACTIVE claimants, and
// that preference must recognize a claimant selected and enabled under its documented legacy id.
// A current-id-only read passes over the alias-selected claimant and enables an
// earlier-discovered inactive fallback, which first-wins registration then hands the channel the
// operator pointed at their chosen plugin.
describe("fallback re-selection recognizes legacy-alias selections", () => {
  const KILLED_FIRST: RegistryPlugins[number] = {
    id: "acme-k-first",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const IDLE_FALLBACK: RegistryPlugins[number] = {
    id: "acme-f1-idle",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const ALIAS_SELECTED: RegistryPlugins[number] = {
    id: "acme-f2-chosen",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    legacyPluginIds: ["acme-f2-old"],
  };
  const CROSS_KILLER: RegistryPlugins[number] = {
    id: "acme-r-killer",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-k-first"] } },
  };

  it("prefers the claimant enabled under its legacy id over an idle earlier fallback", () => {
    const registry = makeRegistry([KILLED_FIRST, IDLE_FALLBACK, ALIAS_SELECTED, CROSS_KILLER]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
      plugins: { entries: { "acme-f2-old": { enabled: true } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // The cross-channel replacement kills the collected first claimant; re-selection must pick
    // the operator's alias-enabled claimant, not enable the idle earlier-discovered fallback.
    expect(result.config.plugins?.entries?.["acme-f1-idle"]?.enabled).not.toBe(true);
    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-f2-chosen");
  });
});

// #120332 round 40 (P1): a declared legacy alias that collides with ANOTHER installed plugin's
// current id denotes that plugin, not the declarer — the runtime fold gives current ids
// precedence. Selection and entry-key reads must apply the same exclusion, or the declarer's
// enablement is written into the other plugin's entry and its config is silently mutated.
describe("legacy aliases never capture another installed plugin's id", () => {
  const ALIAS_DECLARER: RegistryPlugins[number] = {
    id: "acme-alias-decl",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    // Collides with ACME_BEE's CURRENT id below: the alias must denote nothing.
    legacyPluginIds: ["acme-bee"],
  };
  const ACME_BEE: RegistryPlugins[number] = {
    id: "acme-bee",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" } } },
  };

  it("writes the declarer's enablement under its own id, not the collided entry", () => {
    const registry = makeRegistry([ALIAS_DECLARER, ACME_BEE]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-bee": { config: { beeSetting: true } } } },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // The declarer's enable lands under its own id; acme-bee's operator entry stays untouched.
    expect(result.config.plugins?.entries?.["acme-alias-decl"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["acme-bee"]).toEqual({
      config: { beeSetting: true },
    });
  });
});

// #120332 round 58 (P1): allowlist repair folds raw entry keys through the registry aliases.
// A material entry under a documented legacy id is the operator configuring the CURRENT
// plugin; treating the raw alias as unknown skips the repair and leaves the configured plugin
// excluded by the very allowlist the pass maintains.
describe("allowlist repair folds legacy entry keys", () => {
  const CURRENT_WITH_LEGACY: RegistryPlugins[number] = {
    id: "acme-current",
    origin: "global",
    channels: ["acme-lc"],
    channelConfigs: { "acme-lc": { schema: { type: "object" } } },
    legacyPluginIds: ["acme-old"],
  };

  it("adds the current plugin id for a legacy-keyed material entry", () => {
    const registry = makeRegistry([CURRENT_WITH_LEGACY]);
    const result = applyPluginAutoEnable({
      config: {
        plugins: {
          allow: ["existing"],
          entries: { "acme-old": { config: { token: "x" } } },
        },
      },
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    expect(result.config.plugins?.allow).toContain("acme-current");
  });
});
