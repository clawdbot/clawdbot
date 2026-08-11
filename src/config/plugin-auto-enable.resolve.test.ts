// Covers the resolve phase of auto-enable's ordered pass: supersession liveness must be read
// against one coherent completed state, not the mid-pass evolving config.
import { beforeEach, describe, expect, it } from "vitest";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
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

function activatedClaimants(
  registry: PluginManifestRegistry,
  channelId: string,
  completed: OpenClawConfig,
): string[] {
  const completedPlugins = normalizePluginsConfig(completed.plugins);
  return registry.plugins
    .filter((plugin) => plugin.channels.includes(channelId))
    .filter((plugin) =>
      isActivatedManifestOwner({
        plugin,
        normalizedConfig: completedPlugins,
        rootConfig: completed,
      }),
    )
    .map((plugin) => plugin.id);
}

// #120332 round 14 (P1): a claimant that a surviving cross-channel replacement dooms must not
// disable its own channel's fallback first. The mid-pass "not disabled yet, so live" read let the
// doomed middle claimant kill the fallback before its own supersession landed, leaving the
// configured channel with no activated claimant — the silent-failure class.
describe("cross-channel supersession reads the superseder's completed fate", () => {
  // The fallback sorts before the mixed-case middle claimant in the channel candidate order, so
  // the pass decides the fallback while the middle claimant's own fate is still open.
  const CHAT_FALLBACK: RegistryPlugins[number] = {
    id: "acme-chat-fallback",
    origin: "global",
    channels: ["acme-chat"],
    channelConfigs: { "acme-chat": { schema: { type: "object" } } },
  };
  // Mixed-case manifest id: the cross-channel claimant below names it through the normalized
  // policy key, the reachability our id normalization added.
  const MIXED_CASE_MID: RegistryPlugins[number] = {
    id: "Acme-Mid-Guard",
    origin: "global",
    channels: ["acme-chat"],
    channelConfigs: {
      "acme-chat": { schema: { type: "object" }, preferOver: ["acme-chat-fallback"] },
    },
  };
  const ZAP_NEXT: RegistryPlugins[number] = {
    id: "acme-zap-next",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-mid-guard"] } },
  };

  const REGISTRY_ORDERS = [
    ["mid first", [MIXED_CASE_MID, CHAT_FALLBACK, ZAP_NEXT]],
    ["mid last", [ZAP_NEXT, CHAT_FALLBACK, MIXED_CASE_MID]],
  ] as const;
  const CHANNEL_ORDERS = [
    ["chat first", { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } }],
    ["zap first", { "acme-zap": { token: "zap" }, "acme-chat": { token: "chat" } }],
  ] as const;

  for (const [registryOrder, plugins] of REGISTRY_ORDERS) {
    for (const [channelOrder, channels] of CHANNEL_ORDERS) {
      it(`keeps the fallback when its superseder dies to a cross-channel replacement (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const result = applyPluginAutoEnable({
          config: { channels },
          env: makeIsolatedEnv(),
          manifestRegistry: registry,
        });

        // The cross-channel replacement wins its channel and dooms the middle claimant.
        expect(result.config.plugins?.entries?.["acme-zap-next"]?.enabled).toBe(true);
        expect(result.config.plugins?.entries?.["Acme-Mid-Guard"]?.enabled).toBe(false);
        // The doomed middle claimant must not have taken the fallback down with it.
        expect(result.config.plugins?.entries?.["acme-chat-fallback"]?.enabled).toBe(true);
        expect(activatedClaimants(registry, "acme-chat", result.config)).toStrictEqual([
          "acme-chat-fallback",
        ]);
      });
    }
  }
});

// #120332 round 14 (P1): supersession liveness for a kept claimant must read the activation state
// the completed pass produces — including the final material-entry allowlist repair. Reading the
// pre-repair allowlist judged the kept claimant inactive, enabled the plugin it prefers over, and
// the repaired config then activated BOTH sides of the replacement.
describe("kept-claimant liveness reads the post-repair activation state", () => {
  const KEPT_WORKSPACE: RegistryPlugins[number] = {
    id: "acme-kept-a",
    origin: "workspace",
    channels: ["acme-chat"],
    channelConfigs: { "acme-chat": { schema: { type: "object" }, preferOver: ["acme-b-serv"] } },
  };
  const B_SERV: RegistryPlugins[number] = {
    id: "acme-b-serv",
    origin: "global",
    channels: ["acme-chat"],
    channelConfigs: { "acme-chat": { schema: { type: "object" } } },
  };
  // The cross-channel replacement that supersedes the kept claimant, making its liveness flow
  // through the kept-activation read instead of the plain "will enable" branch.
  const ZAP_C: RegistryPlugins[number] = {
    id: "acme-zap-c",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-kept-a"] } },
  };

  const REGISTRY_ORDERS = [
    ["kept first", [KEPT_WORKSPACE, B_SERV, ZAP_C]],
    ["kept last", [ZAP_C, B_SERV, KEPT_WORKSPACE]],
  ] as const;
  const CHANNEL_ORDERS = [
    ["chat first", { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } }],
    ["zap first", { "acme-zap": { token: "zap" }, "acme-chat": { token: "chat" } }],
  ] as const;

  for (const [registryOrder, plugins] of REGISTRY_ORDERS) {
    for (const [channelOrder, channels] of CHANNEL_ORDERS) {
      it(`disables the preferred-over plugin when the repair activates its kept superseder (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const result = applyPluginAutoEnable({
          config: {
            channels,
            // Restrictive allowlist omits the kept claimant; its material entry makes the final
            // allowlist repair add it, so the completed config loads it.
            plugins: {
              allow: ["acme-zap-c"],
              entries: { "acme-kept-a": { config: { region: "eu" } } },
            },
          },
          env: makeIsolatedEnv(),
          manifestRegistry: registry,
        });

        // The repair ran: the kept claimant is allowlisted and its material entry is untouched.
        expect(result.config.plugins?.allow).toContain("acme-kept-a");
        expect(result.config.plugins?.entries?.["acme-kept-a"]).toStrictEqual({
          config: { region: "eu" },
        });
        // The kept claimant serves the channel alone: the plugin it prefers over stays disabled
        // exactly as it would if the operator had allowlisted the claimant directly.
        expect(result.config.plugins?.entries?.["acme-b-serv"]?.enabled).toBe(false);
        expect(activatedClaimants(registry, "acme-chat", result.config)).toStrictEqual([
          "acme-kept-a",
        ]);
      });
    }
  }
});

// #120332 round 15 (P1): candidate-set completeness. A channel whose claimants declare no
// same-channel preferOver edge collects only its discovery-first claimant, so when a configured
// sibling channel's surviving claimant supersedes that lone candidate (named through the
// normalized policy key), the channel's untargeted second claimant was never a candidate and the
// configured channel ended silently unowned. The pass must re-select the next activatable
// claimant in discovery order — exactly the selection it would have made had the dead claimant
// not been collected first.
describe("first-claimant fallback re-selection after cross-channel supersession", () => {
  // Workspace origin: default-off until the pass selects them, so the channel really has no
  // owner when its only collected candidate dies (an installed global plugin without a
  // restrictive allowlist is activated by default and would mask the corner).
  const MIXED_CASE_VICTIM: RegistryPlugins[number] = {
    id: "Acme-X-Victim",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const X_SECOND: RegistryPlugins[number] = {
    id: "acme-x-second",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const Y_KILLER: RegistryPlugins[number] = {
    id: "acme-y-killer",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-x-victim"] } },
  };

  const CHANNEL_ORDERS = [
    ["x first", { "acme-x": { token: "x" }, "acme-y": { token: "y" } }],
    ["y first", { "acme-y": { token: "y" }, "acme-x": { token: "x" } }],
  ] as const;

  for (const [registryOrder, plugins] of [
    ["victim discovered first", [MIXED_CASE_VICTIM, X_SECOND, Y_KILLER]],
    ["killer discovered first", [Y_KILLER, MIXED_CASE_VICTIM, X_SECOND]],
  ] as const) {
    for (const [channelOrder, channels] of CHANNEL_ORDERS) {
      it(`re-selects the second claimant when the first dies cross-channel (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const result = applyPluginAutoEnable({
          config: { channels },
          env: makeIsolatedEnv(),
          manifestRegistry: registry,
        });

        expect(result.config.plugins?.entries?.["acme-y-killer"]?.enabled).toBe(true);
        expect(result.config.plugins?.entries?.["Acme-X-Victim"]?.enabled).toBe(false);
        // The re-selected fallback serves the channel the collected first claimant lost.
        expect(result.config.plugins?.entries?.["acme-x-second"]?.enabled).toBe(true);
        expect(activatedClaimants(registry, "acme-x", result.config)).toStrictEqual([
          "acme-x-second",
        ]);
      });
    }
  }

  // Control pin: when discovery lists the untargeted claimant first, it is the collected
  // candidate, survives, and the targeted claimant is never considered — unchanged behavior.
  it("keeps the untargeted discovery-first claimant without collecting the targeted one", () => {
    const registry = makeRegistry([X_SECOND, MIXED_CASE_VICTIM, Y_KILLER]);
    const result = applyPluginAutoEnable({
      config: { channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } } },
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    expect(result.config.plugins?.entries?.["acme-x-second"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["Acme-X-Victim"]).toBeUndefined();
    expect(activatedClaimants(registry, "acme-x", result.config)).toStrictEqual(["acme-x-second"]);
  });
});

// #120332 round 15 (P2): a replacement cycle spanning two channels must resolve to one coherent
// end state. The per-group seniority exclusion considered the cycle's cross-channel member live
// while deciding the senior claim, then landed that member dead, and the later cycle member was
// judged against the landed fate — the pass enabled two claimants of one channel with a
// preferOver edge between them, so registration served one plugin while validation applied the
// other's schema.
describe("cross-channel replacement cycles ground on discovery-order seniority", () => {
  // A(X) prefers over B; B claims X and Y and prefers over C on Y; C(X) prefers over A.
  const CYCLE_A: RegistryPlugins[number] = {
    id: "acme-cycle-aa",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-cycle-bb"] } },
  };
  const CYCLE_B: RegistryPlugins[number] = {
    id: "acme-cycle-bb",
    origin: "global",
    channels: ["acme-x", "acme-y"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" } },
      "acme-y": { schema: { type: "object" }, preferOver: ["acme-cycle-cc"] },
    },
  };
  const CYCLE_C: RegistryPlugins[number] = {
    id: "acme-cycle-cc",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-cycle-aa"] } },
  };

  for (const [registryOrder, plugins] of [
    ["forward", [CYCLE_A, CYCLE_B, CYCLE_C]],
    ["reverse", [CYCLE_C, CYCLE_B, CYCLE_A]],
  ] as const) {
    for (const [channelOrder, channels] of [
      ["x first", { "acme-x": { token: "x" }, "acme-y": { token: "y" } }],
      ["y first", { "acme-y": { token: "y" }, "acme-x": { token: "x" } }],
    ] as const) {
      it(`activates exactly one claimant and its schema owns the channel (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const config: OpenClawConfig = { channels };
        const env = makeIsolatedEnv();
        const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

        // Exactly one claimant serves the channel...
        const activated = activatedClaimants(registry, "acme-x", result.config);
        expect(activated).toHaveLength(1);
        // ...and validation's schema owner is that same claimant, so the schema that validates
        // the channel belongs to the plugin that registers it.
        const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
          (entry) => entry.id === "acme-x",
        );
        expect(owner?.schemaPluginId).toBe(activated[0]);
      });
    }
  }
});

// #120332 round 16 (P1): grounding a replacement cycle must not orphan a sibling channel of the
// victim. With reciprocal claims on X where the victim also solely claims configured Y,
// discovery-order grounding enabled the earliest X claimant and plugin-globally disabled the
// other, leaving Y silently unowned — the sequential pass this resolver replaced disabled the
// earliest claimant first and kept both channels served.
describe("cycle grounding keeps the victim's sibling channels owned", () => {
  const RECIP_B: RegistryPlugins[number] = {
    id: "acme-recip-bb",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-recip-cc"] } },
  };
  const RECIP_C: RegistryPlugins[number] = {
    id: "acme-recip-cc",
    origin: "global",
    channels: ["acme-x", "acme-y"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" }, preferOver: ["acme-recip-bb"] },
      "acme-y": { schema: { type: "object" } },
    },
  };

  for (const [registryOrder, plugins] of [
    ["victim discovered last", [RECIP_B, RECIP_C]],
    ["victim discovered first", [RECIP_C, RECIP_B]],
  ] as const) {
    for (const [channelOrder, channels] of [
      ["x first", { "acme-x": { token: "x" }, "acme-y": { token: "y" } }],
      ["y first", { "acme-y": { token: "y" }, "acme-x": { token: "x" } }],
    ] as const) {
      it(`serves both configured channels (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const config: OpenClawConfig = { channels };
        const env = makeIsolatedEnv();
        const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

        // X keeps exactly one activated claimant and validation's schema owner matches it.
        const activatedX = activatedClaimants(registry, "acme-x", result.config);
        expect(activatedX).toHaveLength(1);
        const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
          (entry) => entry.id === "acme-x",
        );
        expect(owner?.schemaPluginId).toBe(activatedX[0]);
        // Y's sole claimant sits inside X's replacement cycle; grounding must not disable it
        // plugin-globally while X has a survivor that serves X alone.
        expect(activatedClaimants(registry, "acme-y", result.config)).toEqual(["acme-recip-cc"]);
      });
    }
  }
});

// #120332 round 16 (P2): candidate collection must resolve replacement edges through the same
// chain the resolver honors (manifest channel config, plugin catalog meta, built-in meta,
// external catalog). A replacement whose edge lives only in catalog metadata was never collected,
// so validation planned the discovery-first incumbent while the runtime activates the replacement
// and its claim supersedes the incumbent — the schema/runtime ownership mismatch this PR exists
// to close.
describe("collection resolves catalog-declared replacement edges", () => {
  const CATALOG_INC: RegistryPlugins[number] = {
    id: "acme-inc-first",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const CATALOG_REP: RegistryPlugins[number] = {
    id: "acme-setup-rep",
    origin: "workspace",
    channels: ["acme-x"],
    // The replacement edge lives only in catalog metadata; the manifest channel config carries
    // none, so manifest-only edge detection never collects this claimant.
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    channelCatalogMeta: { id: "acme-x", preferOver: ["acme-inc-first"] },
  };

  for (const [registryOrder, plugins] of [
    ["incumbent first", [CATALOG_INC, CATALOG_REP]],
    ["replacement first", [CATALOG_REP, CATALOG_INC]],
  ] as const) {
    for (const [entryMode, pluginEntries] of [
      ["default-off replacement", undefined],
      ["material entry", { "acme-setup-rep": { config: { guardMode: "strict" } } }],
    ] as const) {
      it(`replacement supersedes the incumbent (${registryOrder}, ${entryMode})`, () => {
        const registry = makeRegistry([...plugins]);
        const config: OpenClawConfig = {
          channels: { "acme-x": { token: "x" } },
          ...(pluginEntries ? { plugins: { entries: pluginEntries } } : {}),
        };
        const env = makeIsolatedEnv();
        const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

        // The catalog-edged replacement is the channel's one activated claimant, and validation's
        // schema owner matches — the runtime honors the edge the moment the plugin is live, so a
        // collection that omits the claim leaves validation rejecting the keys the runtime serves.
        expect(activatedClaimants(registry, "acme-x", result.config)).toEqual(["acme-setup-rep"]);
        const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
          (entry) => entry.id === "acme-x",
        );
        expect(owner?.schemaPluginId).toBe("acme-setup-rep");
      });
    }
  }
});

// #120332 round 17 (P1): fallback re-selection must also fire when every collected candidate is
// operator-forbidden. Edge collection considers only replacement-edge participants, so with the
// edge pair disabled by the operator, the channel's allowed uncollected claimant was never
// re-selected and the configured channel silently started without an owner — disabling specific
// plugins is not disabling the channel.
describe("re-selection covers channels whose collected candidates are all forbidden", () => {
  const ALLOWED_C: RegistryPlugins[number] = {
    id: "acme-allowed-cc",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const EDGE_A: RegistryPlugins[number] = {
    id: "acme-edge-aa",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["legacy-b"] } },
  };
  const LEGACY_B: RegistryPlugins[number] = {
    id: "Legacy-B",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  for (const [registryOrder, plugins] of [
    ["allowed first", [ALLOWED_C, EDGE_A, LEGACY_B]],
    ["allowed last", [EDGE_A, LEGACY_B, ALLOWED_C]],
  ] as const) {
    it(`re-selects the allowed claimant (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-x": { token: "x" } },
        plugins: {
          entries: {
            "acme-edge-aa": { enabled: false },
            "legacy-b": { enabled: false },
          },
        },
      };
      const env = makeIsolatedEnv();
      const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

      // The operator forbade the edge pair, not the channel: the allowed claimant serves it.
      expect(activatedClaimants(registry, "acme-x", result.config)).toEqual(["acme-allowed-cc"]);
      const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
        (entry) => entry.id === "acme-x",
      );
      expect(owner?.schemaPluginId).toBe("acme-allowed-cc");
    });
  }
});

// #120332 round 22 (P2): apply-phase writes land on the operator's canonical entry key. Config
// entries are keyed by the derived policy id while a manifest keeps its author's case; an
// exact-id enable write created a case-variant duplicate beside the operator's canonical entry,
// and entry normalization could later fold the appended `{ enabled: true }` over the operator's
// `enabled: false`.
describe("apply-phase writes land on the canonical entry key", () => {
  const MIXED_CASE_CLAIMANT: RegistryPlugins[number] = {
    id: "Acme-Chat",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("merges the enable into the operator's canonical entry instead of duplicating it", () => {
    const registry = makeRegistry([MIXED_CASE_CLAIMANT]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-chat": { config: { token: "op://chat" } } } },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    const entries = result.config.plugins?.entries ?? {};
    expect(entries["acme-chat"]).toStrictEqual({ config: { token: "op://chat" }, enabled: true });
    expect(entries["Acme-Chat"]).toBeUndefined();
  });
});

// #120332 round 21 (P2): a disabled channel's schema ownership must mirror the plan the channel
// gets the moment the operator re-enables it — not the completed activation unrelated candidates
// produced while it was off. A provider-activated incumbent must not take validation ownership
// of saved replacement-only keys that re-enabling would immediately validate.
describe("disabled-channel ownership is independent of unrelated activation", () => {
  const DIS_REPLACEMENT: RegistryPlugins[number] = {
    id: "acme-dis-rep2",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-prov-bb"] } },
  };
  const PROV_INCUMBENT: RegistryPlugins[number] = {
    id: "acme-prov-bb",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };

  for (const [registryOrder, plugins] of [
    ["replacement first", [DIS_REPLACEMENT, PROV_INCUMBENT]],
    ["incumbent first", [PROV_INCUMBENT, DIS_REPLACEMENT]],
  ] as const) {
    it(`the re-enabled plan's replacement owns the schema (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-x": { token: "x", enabled: false } },
        auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      };
      const env = makeIsolatedEnv();

      const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
        (entry) => entry.id === "acme-x",
      );
      expect(owner?.schemaPluginId).toBe("acme-dis-rep2");
    });
  }
});

// #120332 round 21 (P2): a hypothetical replay projects its own completed activation, not the
// original plan's. Replaying unconfigured X can revive a plugin the original pass killed (its
// killer dies to X's claimant); reading that plugin's activation from the original completed
// config advertises the wrong schema for X — configuring X would recompute exactly the replay's
// world and validate with the revived plugin's schema.
describe("hypothetical replays project their own activation", () => {
  const X_REPLACEMENT: RegistryPlugins[number] = {
    id: "acme-xa-rep",
    origin: "global",
    channels: ["acme-hx"],
    channelConfigs: { "acme-hx": { schema: { type: "object" }, preferOver: ["acme-yc-mid"] } },
  };
  const Y_MID: RegistryPlugins[number] = {
    id: "acme-yc-mid",
    origin: "global",
    channels: ["acme-hy"],
    channelConfigs: { "acme-hy": { schema: { type: "object" }, preferOver: ["acme-yp-store"] } },
  };
  const REVIVED_P: RegistryPlugins[number] = {
    id: "acme-yp-store",
    origin: "workspace",
    channels: ["acme-hy", "acme-hx"],
    channelConfigs: {
      "acme-hy": { schema: { type: "object" } },
      "acme-hx": { schema: { type: "object" } },
    },
  };

  for (const [registryOrder, plugins] of [
    ["revived last", [X_REPLACEMENT, Y_MID, REVIVED_P]],
    ["revived first", [REVIVED_P, Y_MID, X_REPLACEMENT]],
  ] as const) {
    it(`the revived claimant owns the unconfigured channel (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      // Only Y is configured: X's decisions come from the hypothetical replay, where X's
      // replacement kills Y's mid claimant and the revived store serves both channels.
      const config: OpenClawConfig = { channels: { "acme-hy": { token: "y" } } };
      const env = makeIsolatedEnv();

      const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
        (entry) => entry.id === "acme-hx",
      );
      expect(owner?.schemaPluginId).toBe("acme-yp-store");
    });
  }
});

// #120332 round 20 (P1): a disabled channel's claims must not enter the resolve pass at all.
// Skipping the channel only in repair scanning still let its replacement claim globally
// supersede a mixed-case victim that solely serves an ENABLED sibling channel — and the pin was
// rightly rejected (the killer stays live), so the enabled channel ended silently unowned on
// behalf of a channel the runtime never starts.
describe("disabled channels' claims never suppress sibling channels", () => {
  const DIS_REP: RegistryPlugins[number] = {
    id: "acme-dis-rep",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-bb-mixed"] } },
  };
  const MIXED_VICTIM: RegistryPlugins[number] = {
    id: "Acme-BB-Mixed",
    origin: "workspace",
    channels: ["acme-x", "acme-y"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" } },
      "acme-y": { schema: { type: "object" } },
    },
  };

  for (const [registryOrder, plugins] of [
    ["replacement first", [DIS_REP, MIXED_VICTIM]],
    ["victim first", [MIXED_VICTIM, DIS_REP]],
  ] as const) {
    for (const [channelOrder, channels] of [
      ["disabled first", { "acme-x": { token: "x", enabled: false }, "acme-y": { token: "y" } }],
      ["enabled first", { "acme-y": { token: "y" }, "acme-x": { token: "x", enabled: false } }],
    ] as const) {
      it(`keeps the enabled sibling served (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const config: OpenClawConfig = { channels };
        const env = makeIsolatedEnv();
        const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

        // The disabled channel contributes no claims: its replacement is not enabled on its
        // behalf, and the victim keeps serving the enabled channel it solely claims.
        expect(activatedClaimants(registry, "acme-y", result.config)).toEqual(["Acme-BB-Mixed"]);
        expect(result.config.plugins?.entries?.["acme-dis-rep"]).toBeUndefined();
      });
    }
  }
});

// #120332 round 20 (P2, verified already-correct — pinned): a setup-relevant plugin claiming
// only an unrelated channel, activated through its material entry, supersedes a configured
// channel's sole claimant through catalog replacement metadata at the SCHEMA-OWNER selection
// (the declared-replacement tier reads the activated plugin's catalog `preferOver` without
// executing plugin code), so validation surfaces the fallback's schema even though claimant
// collection for the channel never sees the setup plugin. This pin holds that path in both
// traversal orders.
describe("validation projects setup-derived cross-channel replacement", () => {
  const SETUP_FAR: RegistryPlugins[number] = {
    id: "acme-setup-far",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" } } },
    channelCatalogMeta: { id: "acme-z", preferOver: ["acme-inc-bb"] },
    // The scenario presumes a setup-capable plugin (its kill is probe-derived); round 36 keys
    // the projection's exact-plan accounting on this declared surface.
    setupSource: "./setup.js",
  };
  const INC_VICTIM: RegistryPlugins[number] = {
    id: "acme-inc-bb",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" } } },
  };
  const FALLBACK_C: RegistryPlugins[number] = {
    id: "acme-fall-cc",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" } } },
  };

  for (const [registryOrder, plugins] of [
    ["setup first", [SETUP_FAR, INC_VICTIM, FALLBACK_C]],
    ["setup last", [INC_VICTIM, FALLBACK_C, SETUP_FAR]],
  ] as const) {
    it(`the superseded incumbent's fallback owns the schema (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-y": { token: "y" } },
        plugins: { entries: { "acme-setup-far": { config: { probe: true } } } },
      };
      const env = makeIsolatedEnv();

      // The projection decides Y as the runtime would with the setup plugin active: the
      // incumbent superseded, the fallback re-selected, and Y validated by the fallback's schema.
      const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
        (entry) => entry.id === "acme-y",
      );
      expect(owner?.schemaPluginId).toBe("acme-fall-cc");
    });
  }
});

// #120332 round 18 (P2): the remedies must not repair a channel the operator explicitly
// disabled. Re-selection for a channel whose collected claimant is plugin-disabled would
// auto-enable another claimant and project it as the live schema owner, while gateway startup
// excludes the disabled channel entirely — existing disabled-channel config would begin failing
// validation against a plugin that cannot start.
describe("remedies skip explicitly disabled channels", () => {
  const DIS_FIRST: RegistryPlugins[number] = {
    id: "acme-dis-aa",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const DIS_OTHER: RegistryPlugins[number] = {
    id: "acme-dis-bb",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("neither re-selects nor enables a claimant for a disabled channel", () => {
    const registry = makeRegistry([DIS_FIRST, DIS_OTHER]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x", enabled: false } },
      plugins: { entries: { "acme-dis-aa": { enabled: false } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // The operator turned the channel off; no claimant may be enabled on its behalf.
    expect(activatedClaimants(registry, "acme-x", result.config)).toEqual([]);
    expect(result.config.plugins?.entries?.["acme-dis-bb"]).toBeUndefined();
  });
});

// #120332 round 17 (P1): a landed enable is authoritative, so the re-grounding pin survives a
// same-channel seniority kill and the victim's sibling channel stays owned. The normalized edge
// made a mid claimant's preferOver bind to a mixed-case victim it never matched before, expanding
// the same-channel residual to an id form that worked at the merge base; the pin now revives the
// victim, accepted because its killer itself ends dead — the runtime's next pass agrees.
describe("re-grounding pins survive same-channel seniority kills", () => {
  const MULTI_MIXED: RegistryPlugins[number] = {
    id: "Acme-AA-Multi",
    origin: "global",
    channels: ["acme-chat", "acme-zap"],
    channelConfigs: {
      "acme-chat": { schema: { type: "object" } },
      "acme-zap": { schema: { type: "object" } },
    },
  };
  const MID_KILLER: RegistryPlugins[number] = {
    id: "acme-mm-mid",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-aa-multi"] } },
  };
  const HEAD_KILLER: RegistryPlugins[number] = {
    id: "acme-zz-head",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-mm-mid"] } },
  };

  for (const [registryOrder, plugins] of [
    ["forward", [MULTI_MIXED, MID_KILLER, HEAD_KILLER]],
    ["reverse", [HEAD_KILLER, MID_KILLER, MULTI_MIXED]],
  ] as const) {
    for (const [channelOrder, channels] of [
      ["chat first", { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } }],
      ["zap first", { "acme-zap": { token: "zap" }, "acme-chat": { token: "chat" } }],
    ] as const) {
      it(`keeps the mixed-case victim's sibling channel owned (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const config: OpenClawConfig = { channels };
        const env = makeIsolatedEnv();
        const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

        // The victim serves its sibling channel; its zap killer ends dead, so reviving the victim
        // creates no claim the completed pass would kill again.
        expect(activatedClaimants(registry, "acme-chat", result.config)).toEqual(["Acme-AA-Multi"]);
        expect(activatedClaimants(registry, "acme-zap", result.config)).toContain("acme-zz-head");
        expect(activatedClaimants(registry, "acme-zap", result.config)).not.toContain(
          "acme-mm-mid",
        );
      });
    }
  }
});

// #120332 round 15 (P1): the material-entry allowlist repair must resolve installed ids through
// the derived policy key. The operator's entry lives under the normalized key while a manifest
// keeps its author's case; the exact-id known-plugin read rejected the entry as unknown, both
// repair passes skipped it, the kept incumbent never went live, and the plugin it preferred over
// was disabled anyway — the configured channel ended unowned.
describe("allowlist repair resolves mixed-case installed ids through the policy key", () => {
  const KEPT_MIXED: RegistryPlugins[number] = {
    id: "Acme-Kept-Mixed",
    origin: "workspace",
    channels: ["acme-chat"],
    channelConfigs: {
      "acme-chat": { schema: { type: "object" }, preferOver: ["acme-b-serv"] },
    },
  };
  const B_SERV: RegistryPlugins[number] = {
    id: "acme-b-serv",
    origin: "global",
    channels: ["acme-chat"],
    channelConfigs: { "acme-chat": { schema: { type: "object" } } },
  };
  const ZAP_C: RegistryPlugins[number] = {
    id: "acme-zap-c",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-kept-mixed"] } },
  };

  for (const [registryOrder, plugins] of [
    ["kept first", [KEPT_MIXED, B_SERV, ZAP_C]],
    ["kept last", [ZAP_C, B_SERV, KEPT_MIXED]],
  ] as const) {
    for (const [channelOrder, channels] of [
      ["chat first", { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } }],
      ["zap first", { "acme-zap": { token: "zap" }, "acme-chat": { token: "chat" } }],
    ] as const) {
      it(`repairs the normalized entry key of a mixed-case install (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const result = applyPluginAutoEnable({
          config: {
            channels,
            // Restrictive allowlist omits the kept incumbent; its material entry sits under the
            // normalized policy key config normalization derives from the mixed-case id.
            plugins: {
              allow: ["acme-zap-c"],
              entries: { "acme-kept-mixed": { config: { region: "eu" } } },
            },
          },
          env: makeIsolatedEnv(),
          manifestRegistry: registry,
        });

        // The repair recognized the installed plugin behind the normalized key.
        expect(result.config.plugins?.allow).toContain("acme-kept-mixed");
        expect(result.config.plugins?.entries?.["acme-kept-mixed"]).toStrictEqual({
          config: { region: "eu" },
        });
        // The kept incumbent is live post-repair, so it serves the channel alone.
        expect(result.config.plugins?.entries?.["acme-b-serv"]?.enabled).toBe(false);
        expect(activatedClaimants(registry, "acme-chat", result.config)).toStrictEqual([
          "Acme-Kept-Mixed",
        ]);
      });
    }
  }
});

describe("closed residual: same-channel seniority kill of a multi-channel victim", () => {
  const MULTI_VICTIM: RegistryPlugins[number] = {
    id: "acme-aa-multi",
    origin: "global",
    channels: ["acme-chat", "acme-zap"],
    channelConfigs: {
      "acme-chat": { schema: { type: "object" } },
      "acme-zap": { schema: { type: "object" } },
    },
  };
  const MID_KILLER: RegistryPlugins[number] = {
    id: "acme-mm-mid",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-aa-multi"] } },
  };
  const HEAD_KILLER: RegistryPlugins[number] = {
    id: "acme-zz-head",
    origin: "global",
    channels: ["acme-zap"],
    channelConfigs: { "acme-zap": { schema: { type: "object" }, preferOver: ["acme-mm-mid"] } },
  };

  for (const [registryOrder, plugins] of [
    ["forward", [MULTI_VICTIM, MID_KILLER, HEAD_KILLER]],
    ["reverse", [HEAD_KILLER, MID_KILLER, MULTI_VICTIM]],
  ] as const) {
    for (const [channelOrder, channels] of [
      ["chat first", { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } }],
      ["zap first", { "acme-zap": { token: "zap" }, "acme-chat": { token: "chat" } }],
    ] as const) {
      it(`stays deterministic and serves both channels (${registryOrder}, ${channelOrder})`, () => {
        const registry = makeRegistry([...plugins]);
        const result = applyPluginAutoEnable({
          config: { channels },
          env: makeIsolatedEnv(),
          manifestRegistry: registry,
        });

        expect(result.config.plugins?.entries).toStrictEqual({
          "acme-aa-multi": { enabled: true },
          "acme-mm-mid": { enabled: false },
          "acme-zz-head": { enabled: true },
        });
        // The revived victim coexists with head on zap edge-free (head's edge targets dead mid),
        // matching what the runtime's next pass would decide from this completed config.
        expect(activatedClaimants(registry, "acme-zap", result.config).toSorted()).toStrictEqual([
          "acme-aa-multi",
          "acme-zz-head",
        ]);
        expect(activatedClaimants(registry, "acme-chat", result.config)).toStrictEqual([
          "acme-aa-multi",
        ]);
      });
    }
  }
});
