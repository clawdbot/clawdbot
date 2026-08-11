// Verifies channel schema ownership projections of auto-enable's completed ordered pass.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import {
  createChannelPlugin,
  REPLACED_ACME,
  REPLACEMENT_ACME,
  selectAcmeOwner,
  validateAcmeChatKeys,
} from "./channel-config-metadata.test-helpers.js";
import { makeIsolatedEnv } from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

// A three-link preferOver chain over one configured channel. Auto-enable evaluates candidates in
// alphabetical order against the config it is mutating: the head enables, the middle is superseded
// and disabled, and the tail's superseder (the middle) is then already forbidden, so the completed
// pass leaves head AND tail active. The closer-origin tail registers first and serves the channel.
const CHAIN_HEAD_ACME = createChannelPlugin({
  id: "acme-chain-head",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "headOnly",
  preferOver: ["acme-chain-mid"],
});
const CHAIN_MID_ACME = createChannelPlugin({
  id: "acme-chain-mid",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "midOnly",
  preferOver: ["acme-chain-tail"],
});
const CHAIN_TAIL_ACME = createChannelPlugin({
  id: "acme-chain-tail",
  origin: "config",
  channelId: "acmechat",
  extraProperty: "tailOnly",
});

// The same chain with ids that reverse auto-enable's alphabetical candidate order: the tail is
// evaluated first while the middle is still live, so the completed pass disables tail and middle
// and only the head serves the channel.
const REVERSED_CHAIN_HEAD_ACME = createChannelPlugin({
  id: "zz-chain-head",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "headOnly",
  preferOver: ["mm-chain-mid"],
});
const REVERSED_CHAIN_MID_ACME = createChannelPlugin({
  id: "mm-chain-mid",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "midOnly",
  preferOver: ["aa-chain-tail"],
});
const REVERSED_CHAIN_TAIL_ACME = createChannelPlugin({
  id: "aa-chain-tail",
  origin: "config",
  channelId: "acmechat",
  extraProperty: "tailOnly",
});

// One plugin claiming two configured channels, superseded on the second: auto-enable disables it
// for the acmezap replacement before its acmechat claim is honored, so its own acmechat preferOver
// claim is dead and the acmechat co-claimant serves that channel.
const SHARED_XY_BASE = createChannelPlugin({
  id: "acme-shared",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "sharedXOnly",
  preferOver: ["acme-x-guard"],
});
const SHARED_XY_ACME: PluginManifestRecord = {
  ...SHARED_XY_BASE,
  channels: ["acmechat", "acmezap"],
  channelConfigs: {
    ...SHARED_XY_BASE.channelConfigs,
    ...createChannelPlugin({
      id: "acme-shared",
      origin: "global",
      channelId: "acmezap",
      extraProperty: "sharedYOnly",
    }).channelConfigs,
  },
};
const X_GUARD_ACME = createChannelPlugin({
  id: "acme-x-guard",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "guardXOnly",
});
const Y_CLAIMANT_ACME = createChannelPlugin({
  id: "acme-y-claimant",
  origin: "global",
  channelId: "acmezap",
  extraProperty: "zapOnly",
  preferOver: ["acme-shared"],
});

// #120332 round 11: ownership must project auto-enable's one completed ordered pass instead of
// re-deriving each channel in isolation against the unchanged source config.
describe("channel schema ownership follows the completed auto-enable pass", () => {
  const chainConfig = { channels: { acmechat: { tailOnly: {} } } } as OpenClawConfig;

  for (const [order, plugins] of [
    ["head first", [CHAIN_HEAD_ACME, CHAIN_MID_ACME, CHAIN_TAIL_ACME]],
    ["tail first", [CHAIN_TAIL_ACME, CHAIN_MID_ACME, CHAIN_HEAD_ACME]],
  ] as const) {
    it(`keeps the chain tail auto-enable leaves active beside the head (${order})`, () => {
      expect(selectAcmeOwner("acmechat", [...plugins], chainConfig)).toBe("acme-chain-tail");
    });
  }

  it("accepts the active chain tail's channel keys", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [CHAIN_HEAD_ACME, CHAIN_MID_ACME, CHAIN_TAIL_ACME],
        // tailOnly exists only in the tail's channel schema.
        channel: { tailOnly: {} },
        entries: {},
      }),
    ).toEqual([]);
  });

  // The reversed candidate order disables the tail before its superseder dies, exactly as the
  // runtime pass does, so the head keeps the channel in either registry traversal order.
  for (const [order, plugins] of [
    ["head first", [REVERSED_CHAIN_HEAD_ACME, REVERSED_CHAIN_MID_ACME, REVERSED_CHAIN_TAIL_ACME]],
    ["tail first", [REVERSED_CHAIN_TAIL_ACME, REVERSED_CHAIN_MID_ACME, REVERSED_CHAIN_HEAD_ACME]],
  ] as const) {
    it(`keeps the chain head when candidate order disables the tail (${order})`, () => {
      expect(selectAcmeOwner("acmechat", [...plugins], chainConfig)).toBe("zz-chain-head");
    });
  }

  const crossChannelConfig = {
    channels: { acmechat: { guardXOnly: {} }, acmezap: { zapOnly: {} } },
  } as OpenClawConfig;

  for (const [order, plugins] of [
    ["shared first", [SHARED_XY_ACME, X_GUARD_ACME, Y_CLAIMANT_ACME]],
    ["shared last", [Y_CLAIMANT_ACME, X_GUARD_ACME, SHARED_XY_ACME]],
  ] as const) {
    it(`hands both channels to the claimants that survive the cross-channel supersession (${order})`, () => {
      expect(selectAcmeOwner("acmechat", [...plugins], crossChannelConfig)).toBe("acme-x-guard");
      expect(selectAcmeOwner("acmezap", [...plugins], crossChannelConfig)).toBe("acme-y-claimant");
    });
  }

  it("accepts both surviving claimants' channel keys after the cross-channel supersession", () => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "openclaw" }] },
        channels: { acmechat: { guardXOnly: {} }, acmezap: { zapOnly: {} } },
        plugins: { entries: {} },
      },
      {
        env: makeIsolatedEnv(),
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [SHARED_XY_ACME, X_GUARD_ACME, Y_CLAIMANT_ACME],
          },
        },
      },
    );
    expect(result.ok ? [] : result.issues).toEqual([]);
  });
});

// #120332 round 12: claimant activation and hypothetical channels must both read the completed
// pass, not the pre-plan config or a channel-local candidate slice.

// A workspace claimant outside the channel's preferOver candidate pair: the completed pass enables
// it through its provider trigger, not through a channel decision, so only the completed config
// knows the runtime loads it.
const PROVIDER_ENABLED_WORKSPACE_ACME: PluginManifestRecord = {
  ...createChannelPlugin({
    id: "acme-prov-chat",
    origin: "workspace",
    channelId: "acmechat",
    extraProperty: "provOnly",
  }),
  autoEnableWhenConfiguredProviders: ["acmeprov"],
};
const PROVIDER_ENABLED_CONFIG = {
  channels: { acmechat: { provOnly: {} } },
  models: {
    providers: {
      acmeprov: {
        baseUrl: "http://localhost:1",
        models: [
          {
            id: "m1",
            name: "M1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
          },
        ],
      },
    },
  },
} as OpenClawConfig;

// A workspace claimant kept only through a material entries.config record: auto-enable refuses to
// disable it for the replacement, but the completed config still leaves a workspace plugin without
// enabled:true unloaded, so the replacement serves the channel.
const MATERIAL_KEPT_WORKSPACE_ACME = createChannelPlugin({
  id: "acme-kept-chat",
  origin: "workspace",
  channelId: "acmechat",
  extraProperty: "keptOnly",
});
const KEPT_REPLACEMENT_ACME = createChannelPlugin({
  id: "acme-kept-guard",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "guardOnly",
  preferOver: ["acme-kept-chat"],
});

// An unconfigured channel's claim pair beside a configured channel's claimant that supersedes the
// pair's head: the moment the channel becomes configured, that claimant disables the head globally
// and the tail serves the channel.
const HYPO_ALPHA_ACME = createChannelPlugin({
  id: "acme-hypo-alpha",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "alphaOnly",
  preferOver: ["acme-hypo-beta"],
});
const HYPO_BETA_ACME = createChannelPlugin({
  id: "acme-hypo-beta",
  origin: "global",
  channelId: "acmechat",
  extraProperty: "betaOnly",
});
const ZAP_GUARD_ACME = createChannelPlugin({
  id: "acme-zap-guard",
  origin: "global",
  channelId: "acmezap",
  extraProperty: "zapGuardOnly",
  preferOver: ["acme-hypo-alpha"],
});

describe("channel schema ownership reads activation from the completed pass", () => {
  for (const [order, plugins] of [
    [
      "workspace claimant first",
      [PROVIDER_ENABLED_WORKSPACE_ACME, REPLACEMENT_ACME, REPLACED_ACME],
    ],
    ["workspace claimant last", [REPLACEMENT_ACME, REPLACED_ACME, PROVIDER_ENABLED_WORKSPACE_ACME]],
  ] as const) {
    it(`keeps a claimant omitted from the channel candidates that the pass enables elsewhere (${order})`, () => {
      expect(selectAcmeOwner("acmechat", [...plugins], PROVIDER_ENABLED_CONFIG)).toBe(
        "acme-prov-chat",
      );
    });
  }

  it("accepts the provider-enabled omitted claimant's channel keys", () => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "openclaw" }] },
        ...PROVIDER_ENABLED_CONFIG,
      },
      {
        env: makeIsolatedEnv(),
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [PROVIDER_ENABLED_WORKSPACE_ACME, REPLACEMENT_ACME, REPLACED_ACME],
          },
        },
      },
    );
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  for (const [order, plugins] of [
    ["kept claimant first", [MATERIAL_KEPT_WORKSPACE_ACME, KEPT_REPLACEMENT_ACME]],
    ["kept claimant last", [KEPT_REPLACEMENT_ACME, MATERIAL_KEPT_WORKSPACE_ACME]],
  ] as const) {
    it(`keeps a material-only workspace claimant inactive under supersede-keep (${order})`, () => {
      const materialOnly = {
        channels: { acmechat: { guardOnly: {} } },
        plugins: { entries: { "acme-kept-chat": { config: { workspace: "T123" } } } },
      } as OpenClawConfig;
      expect(selectAcmeOwner("acmechat", [...plugins], materialOnly)).toBe("acme-kept-guard");

      // Rounds 37/40: enabled:true is the boundary — an explicit selection is never
      // suppressed, so the loaded kept claimant registers first-wins and keeps its schema.
      const explicitlyEnabled = {
        channels: { acmechat: { keptOnly: {} } },
        plugins: { entries: { "acme-kept-chat": { enabled: true } } },
      } as OpenClawConfig;
      expect(selectAcmeOwner("acmechat", [...plugins], explicitlyEnabled)).toBe("acme-kept-chat");
    });
  }

  it("accepts the serving replacement's channel keys over a material-only kept workspace claimant", () => {
    expect(
      validateAcmeChatKeys({
        plugins: [MATERIAL_KEPT_WORKSPACE_ACME, KEPT_REPLACEMENT_ACME],
        // guardOnly exists only in the replacement's channel schema.
        channel: { guardOnly: {} },
        entries: { "acme-kept-chat": { config: { workspace: "T123" } } },
      }),
    ).toEqual([]);
  });

  // #120332 round 13: the kept-but-unloaded claimant as a superseder. Its keep never activates it,
  // so its own preferOver claim must not displace the plugin that actually serves the channel.
  const KEPT_SUPERSEDER_BASE = createChannelPlugin({
    id: "acme-kept-super",
    origin: "workspace",
    channelId: "acmechat",
    extraProperty: "keptSuperOnly",
    preferOver: ["acme-live-serv"],
  });
  const KEPT_SUPERSEDER_ACME: PluginManifestRecord = {
    ...KEPT_SUPERSEDER_BASE,
    channels: ["acmechat", "acmezap"],
    channelConfigs: {
      ...KEPT_SUPERSEDER_BASE.channelConfigs,
      ...createChannelPlugin({
        id: "acme-kept-super",
        origin: "workspace",
        channelId: "acmezap",
        extraProperty: "keptSuperZapOnly",
      }).channelConfigs,
    },
  };
  const ZAP_MODERN_ACME = createChannelPlugin({
    id: "acme-zap-modern",
    origin: "global",
    channelId: "acmezap",
    extraProperty: "zapModernOnly",
    preferOver: ["acme-kept-super"],
  });
  const LIVE_SERV_ACME = createChannelPlugin({
    id: "acme-live-serv",
    origin: "global",
    channelId: "acmechat",
    extraProperty: "servOnly",
  });
  const keptSuperConfig = {
    channels: { acmechat: { servOnly: {} }, acmezap: { zapModernOnly: {} } },
    plugins: { entries: { "acme-kept-super": { config: { workspace: "T123" } } } },
  } as OpenClawConfig;

  for (const [order, plugins] of [
    ["kept superseder first", [KEPT_SUPERSEDER_ACME, ZAP_MODERN_ACME, LIVE_SERV_ACME]],
    ["kept superseder last", [LIVE_SERV_ACME, ZAP_MODERN_ACME, KEPT_SUPERSEDER_ACME]],
  ] as const) {
    it(`keeps the channel with its active claimant against a kept-but-unloaded superseder (${order})`, () => {
      expect(selectAcmeOwner("acmechat", [...plugins], keptSuperConfig)).toBe("acme-live-serv");
      expect(selectAcmeOwner("acmezap", [...plugins], keptSuperConfig)).toBe("acme-zap-modern");
    });
  }

  it("accepts the active claimant's channel keys against a kept-but-unloaded superseder", () => {
    const result = validateConfigObjectWithPlugins(
      {
        agents: { list: [{ id: "openclaw" }] },
        // servOnly exists only in the live claimant's channel schema.
        ...keptSuperConfig,
      },
      {
        env: makeIsolatedEnv(),
        pluginMetadataSnapshot: {
          manifestRegistry: {
            diagnostics: [],
            plugins: [KEPT_SUPERSEDER_ACME, ZAP_MODERN_ACME, LIVE_SERV_ACME],
          },
        },
      },
    );
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  const hypotheticalConfig = {
    channels: { acmezap: { zapGuardOnly: {} } },
  } as OpenClawConfig;
  const configuredTruthConfig = {
    channels: { acmechat: { betaOnly: {} }, acmezap: { zapGuardOnly: {} } },
  } as OpenClawConfig;

  for (const [order, plugins] of [
    ["zap guard first", [ZAP_GUARD_ACME, HYPO_ALPHA_ACME, HYPO_BETA_ACME]],
    ["zap guard last", [HYPO_ALPHA_ACME, HYPO_BETA_ACME, ZAP_GUARD_ACME]],
  ] as const) {
    it(`replays an unconfigured channel against the completed plan's candidates (${order})`, () => {
      // The configured truth this projection must match once the channel is saved.
      expect(selectAcmeOwner("acmechat", [...plugins], configuredTruthConfig)).toBe(
        "acme-hypo-beta",
      );
      expect(selectAcmeOwner("acmechat", [...plugins], hypotheticalConfig)).toBe("acme-hypo-beta");
    });
  }

  // #120332 round 13: hypothetical claims must join the replay at the channel-candidate phase,
  // where a really configured channel's claims run. Appended after a provider-triggered candidate
  // they replay a different pass order, and on a replacement cycle the advertised owner then
  // diverges from the post-save truth.
  const CYCLE_ALPHA_ACME = createChannelPlugin({
    id: "acme-cyc-alpha",
    origin: "global",
    channelId: "acmecyc",
    extraProperty: "alphaOnly",
    preferOver: ["acme-cyc-beta"],
  });
  const CYCLE_BETA_ACME = createChannelPlugin({
    id: "acme-cyc-beta",
    origin: "global",
    channelId: "acmecyc",
    extraProperty: "betaOnly",
    preferOver: ["acme-cyc-gamma"],
  });
  const CYCLE_GAMMA_ACME: PluginManifestRecord = {
    ...createChannelPlugin({
      id: "acme-cyc-gamma",
      origin: "global",
      channelId: "acmecyc",
      extraProperty: "gammaOnly",
      preferOver: ["acme-cyc-alpha"],
    }),
    autoEnableWhenConfiguredProviders: ["acmeprov"],
  };
  const cycleProviderConfig = { models: PROVIDER_ENABLED_CONFIG.models } as OpenClawConfig;
  const cycleTruthConfig = {
    ...cycleProviderConfig,
    channels: { acmecyc: { betaOnly: {} } },
  } as OpenClawConfig;

  // Gamma's provider capability keeps it loaded past its supersession, but the loader
  // suppresses its superseded claim (round 37), so beta serves the channel in any discovery
  // order and the projection advertises beta beforehand.
  for (const [order, plugins] of [
    ["gamma first", [CYCLE_GAMMA_ACME, CYCLE_ALPHA_ACME, CYCLE_BETA_ACME]],
    ["gamma last", [CYCLE_ALPHA_ACME, CYCLE_BETA_ACME, CYCLE_GAMMA_ACME]],
  ] as const) {
    it(`replays a replacement cycle in the channel phase beside a provider trigger (${order})`, () => {
      // The configured truth: the channel-phase pass disables alpha (gamma still live), enables
      // beta, then skips gamma's disable for its provider capability.
      expect(selectAcmeOwner("acmecyc", [...plugins], cycleTruthConfig)).toBe("acme-cyc-beta");
      expect(selectAcmeOwner("acmecyc", [...plugins], cycleProviderConfig)).toBe("acme-cyc-beta");
    });
  }
});

// #120332 round 13: `openclaw config validate` and config-mutation preflights read this collector,
// so its projection must never load plugin setup modules or run their probes — plugin code must
// not execute, and a throwing probe must never abort validation.
describe("channel schema ownership stays manifest-only", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("never executes a plugin setup module whose probe would abort validation", () => {
    const pluginRoot = makeTrackedTempDir("openclaw-throwing-setup", tempDirs);
    const markerPath = path.join(pluginRoot, "setup-loaded.marker");
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "probe-fixture",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.js"),
      'export default { id: "probe-fixture", register() {} };\n',
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "setup-api.js"),
      [
        'import fs from "node:fs";',
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded");`,
        "export default {",
        '  id: "probe-fixture",',
        "  register(api) {",
        "    api.registerAutoEnableProbe(() => {",
        '      throw new Error("probe exploded");',
        "    });",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf-8",
    );

    const env = makeIsolatedEnv();
    // A material plugin entry makes the config setup-relevant, so full auto-enable detection
    // would load the fixture's setup module and invoke its throwing probe.
    const config = {
      channels: { acmechat: { legacyOption: {} } },
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { "probe-fixture": { config: { marker: true } } },
      },
    } as OpenClawConfig;
    const registry: PluginManifestRegistry = { diagnostics: [], plugins: [REPLACED_ACME] };

    expect(() => collectChannelSchemaMetadataWithOwnership(registry, config, env)).not.toThrow();

    const result = validateConfigObjectWithPlugins(
      { agents: { list: [{ id: "openclaw" }] }, ...config },
      { env, pluginMetadataSnapshot: { manifestRegistry: registry } },
    );
    expect(result.ok ? [] : result.issues).toEqual([]);

    // The setup module itself must never have been loaded, not merely tolerated when throwing.
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
