// Round-23 coverage: the planner's reads and remedies must agree with the activation state the
// runtime actually loads — normalization's folded entries, already-active omitted claimants, and
// capabilities configured beside a replaced channel claim.
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

// #120332 round 23 (P2): disablement reads the folded entry, not any case variant. Normalization
// folds case-variant entry keys onto one policy key, merging fields in object order — a later
// variant's `enabled` wins the field — so a historical duplicate pair like `acme-chat: false`
// then `Acme-Chat: true` loads ENABLED at runtime, and the planner must not treat the plugin as
// forbidden off the earlier variant's false.
describe("disablement reads the folded entry like the runtime", () => {
  const MIXED_HIST: RegistryPlugins[number] = {
    id: "Acme-Hist",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const FALLBACK_HIST: RegistryPlugins[number] = {
    id: "acme-hist-fallback",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("treats a later enabled variant as enabled (duplicate persisted by the old apply path)", () => {
    const registry = makeRegistry([MIXED_HIST, FALLBACK_HIST]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      // Insertion order matters: normalization folds the later `true` over the earlier `false`.
      plugins: { entries: { "acme-hist": { enabled: false }, "Acme-Hist": { enabled: true } } },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // The runtime loads the claimant; the planner must not have re-selected the fallback.
    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-Hist");
    expect(result.config.plugins?.entries?.["acme-hist-fallback"]).toBeUndefined();
  });

  it("treats a later disabled variant as disabled", () => {
    const registry = makeRegistry([MIXED_HIST, FALLBACK_HIST]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "Acme-Hist": { enabled: true }, "acme-hist": { enabled: false } } },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // Folded state is disabled: the claimant stays out and the fallback serves the channel.
    expect(activatedClaimants(registry, "acme-x", result.config)).toEqual(["acme-hist-fallback"]);
  });

  // #120332 round 27 (P1): folding merges FIELDS across variants like the canonical normalizer.
  // A later config-only variant retains the exact entry's disablement — a last-variant-wins read
  // would drop it and auto-enable a plugin the operator explicitly disabled.
  it("retains an earlier variant's disablement beside a later config-only variant", () => {
    const registry = makeRegistry([MIXED_HIST, FALLBACK_HIST]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: {
        entries: { "Acme-Hist": { enabled: false }, "acme-hist": { config: { probe: true } } },
      },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // The runtime's merged entry stays disabled: the fallback serves the channel and the
    // operator's disablement survives the completed pass.
    expect(activatedClaimants(registry, "acme-x", result.config)).toEqual(["acme-hist-fallback"]);
    expect(normalizePluginsConfig(result.config.plugins).entries["acme-hist"]?.enabled).toBe(false);
  });
});

// #120332 round 28 (P2): group liveness reads the completed activation state. A claimant whose
// channel claims died cross-channel but whose configured capability keeps it loaded still serves
// every channel it claims — enablement is plugin-global and registration is first-wins — so
// fallback re-selection for those channels would double-register them beside a dead-weight
// fallback the runtime never picks.
describe("fallback re-selection counts capability-preserved claimants as live", () => {
  const MULTI_CHAN_CAP: RegistryPlugins[number] = {
    id: "acme-ab-cap",
    origin: "global",
    channels: ["acme-x", "acme-y"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" } },
      "acme-y": { schema: { type: "object" } },
    },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };
  const Y_KILLER: RegistryPlugins[number] = {
    id: "acme-y-killer",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-ab-cap"] } },
  };
  const X_FALLBACK: RegistryPlugins[number] = {
    id: "acme-x-fall",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("keeps the preserved claimant serving its channel instead of enabling a fallback", () => {
    const registry = makeRegistry([MULTI_CHAN_CAP, Y_KILLER, X_FALLBACK]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // The capability keeps the claimant loaded; it registers acme-x first-wins, so re-selection
    // writes no fallback entry while the replacement takes acme-y. (The fallback still shows
    // default-active here — global plugins activate without an entry — but the pass wrote
    // nothing to enable it for the channel.)
    expect(result.config.plugins?.entries?.["acme-x-fall"]).toBeUndefined();
    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("acme-ab-cap");
    expect(result.config.plugins?.entries?.["acme-y-killer"]?.enabled).toBe(true);
  });
});

// #120332 round 23 (P2): re-selection consults every claimant's completed activation. A channel
// whose collected claimant died cross-channel is not unowned when an omitted claimant is already
// active through its config entry — inserting an earlier-registry fallback would double-register
// the channel and validate keys for a plugin that does not serve it.
describe("re-selection skips channels served by an active omitted claimant", () => {
  const COLLECTED_A: RegistryPlugins[number] = {
    id: "acme-coll-aa",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const WRONG_B: RegistryPlugins[number] = {
    id: "acme-bb-early",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const ACTIVE_C: RegistryPlugins[number] = {
    id: "acme-cc-active",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const KILLER_D: RegistryPlugins[number] = {
    id: "acme-dd-killer",
    origin: "global",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-coll-aa"] } },
  };

  it("keeps the active omitted claimant instead of enabling an earlier fallback", () => {
    // A is discovery-first (collected); B sits earlier in the registry than C, so a blind
    // re-selection would pick B; C is already active through its explicit entry.
    const registry = makeRegistry([COLLECTED_A, WRONG_B, ACTIVE_C, KILLER_D]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
      plugins: { entries: { "acme-cc-active": { enabled: true } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // The cross-channel replacement killed A; C already serves X, so no fallback is enabled.
    expect(result.config.plugins?.entries?.["acme-bb-early"]).toBeUndefined();
    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("acme-cc-active");
    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    // Round 37: default-active B loads before C and registers X first-wins, so the projection
    // follows it (previously pinned to the explicitly entried C via the operator-intent tier).
    expect(owner?.schemaPluginId).toBe("acme-bb-early");
  });
});

// #120332 round 25 (P1): capability detection resolves the operator's entry through the policy
// key. A mixed-case plugin's configured tool lived under the normalized entry key, the exact-id
// read missed it, no capability candidate was created, and the case-folded channel replacement
// silently removed the configured tool — the round-23 preservation never engaged.
describe("capability detection reads the folded entry", () => {
  const MIXED_TOOL: RegistryPlugins[number] = {
    id: "Acme-Multi-Tool",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    contracts: { tools: ["thing"] },
    configSchema: {
      type: "object",
      properties: { thing: { type: "object" } },
      additionalProperties: false,
    },
  };
  const TOOL_REPLACEMENT: RegistryPlugins[number] = {
    id: "acme-tool-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-multi-tool"] } },
  };

  for (const [registryOrder, plugins] of [
    ["victim first", [MIXED_TOOL, TOOL_REPLACEMENT]],
    ["victim last", [TOOL_REPLACEMENT, MIXED_TOOL]],
  ] as const) {
    it(`the configured tool keeps its plugin loaded (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-x": { token: "x" } },
        plugins: { entries: { "acme-multi-tool": { config: { thing: { mode: "on" } } } } },
      };
      const env = makeIsolatedEnv();
      const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

      // The tool capability keeps the mixed-case victim activated beside the replacement.
      expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-Multi-Tool");
      expect(result.config.plugins?.entries?.["acme-tool-rep"]?.enabled).toBe(true);
    });
  }
});

// #120332 round 26 (P1) / round 37 (P1): capability preservation keeps a superseded incumbent
// LOADED beside its replacement, but the loader suppresses the incumbent's superseded channel
// registration, so the replacement serves the channel in any load order — validation projects
// the preferOver declarer, never the suppressed claim.
describe("equal-origin active claims project the replacement", () => {
  const EQ_INCUMBENT: RegistryPlugins[number] = {
    id: "acme-eq-incumbent",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };
  const EQ_REPLACEMENT: RegistryPlugins[number] = {
    id: "acme-eq-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-eq-incumbent"] } },
  };

  for (const [registryOrder, plugins] of [
    ["incumbent first", [EQ_INCUMBENT, EQ_REPLACEMENT]],
    ["incumbent last", [EQ_REPLACEMENT, EQ_INCUMBENT]],
  ] as const) {
    it(`the replacement owns the schema past a loaded suppressed claim (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-x": { token: "x" } },
        auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      };
      const env = makeIsolatedEnv();
      const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

      // Capability preservation keeps both loaded; the incumbent's suppressed claim never
      // registers, so the replacement owns regardless of registry order.
      expect(result.config.plugins?.entries?.["acme-eq-rep"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["acme-eq-incumbent"]?.enabled).toBe(true);
      const projected = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
        (entry) => entry.id === "acme-x",
      );
      expect(projected?.schemaPluginId).toBe("acme-eq-rep");
    });
  }
});

// #120332 round 37 (P1): anchor cycle detection spans only claims that became candidates. A
// registry claimant a configured channel's collection omitted (first-claimant selection picked
// another) was never decided, so its edges are synthetic and must not ground a cycle.
describe("anchor cycle detection ignores omitted claimants", () => {
  const B_SOLE3: RegistryPlugins[number] = {
    id: "Acme-B-Sole3",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-e-omit"] } },
  };
  const A_ON_Y2: RegistryPlugins[number] = {
    id: "acme-a-yy2",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-sole3"] } },
  };
  const C_FIRST_Z: RegistryPlugins[number] = {
    id: "acme-c-zz",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" } } },
  };
  const E_OMITTED: RegistryPlugins[number] = {
    id: "acme-e-omit",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" }, preferOver: ["acme-a-yy2"] } },
  };

  it("anchors the sole claimant when the cycle needs an omitted claimant's edge", () => {
    // Z's collection keeps only edge participants E→A... but C is discovery-first with no edge
    // touching Z's pair set — E's Z claim joins collection while C anchors Z's service; the
    // B→E→A→B loop closes only through E's edge, and E... participates on Z. The synthetic
    // part is B→E: E is collected for Z, not as B's co-claimant — B's kill by A must anchor B.
    const registry = makeRegistry([C_FIRST_Z, B_SOLE3, A_ON_Y2, E_OMITTED]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" }, "acme-z": { token: "z" } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-B-Sole3");
  });
});

// #120332 round 36 (P1): the external-break scan includes the anchor victim itself. A live
// out-of-cycle plugin killing the victim directly breaks the cycle exactly as an external kill
// of any relay does — excluding the victim treated the cycle as intact and orphaned its channel.
describe("anchor cycle break detection includes the victim", () => {
  const B_CYC: RegistryPlugins[number] = {
    id: "Acme-B-Cyc",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-a-cyc"] } },
  };
  const A_CYC: RegistryPlugins[number] = {
    id: "acme-a-cyc",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-cyc"] } },
  };
  const E_EXTERNAL: RegistryPlugins[number] = {
    id: "acme-e-ext",
    origin: "workspace",
    channels: ["acme-w"],
    channelConfigs: { "acme-w": { schema: { type: "object" }, preferOver: ["acme-b-cyc"] } },
  };

  it("anchors the sole claimant when a live external plugin kills it directly", () => {
    const registry = makeRegistry([B_CYC, A_CYC, E_EXTERNAL]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" }, "acme-w": { token: "w" } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-B-Cyc");
    expect(result.config.plugins?.entries?.["acme-e-ext"]?.enabled).toBe(true);
  });
});

// #120332 round 36 (P2): the SCC scan resolves kept-claim liveness through policy ids. A
// mixed-case kept member queried by its normalized id read as dead, misclassifying an intact
// cycle as externally broken and anchoring a victim beside its live superseder.
describe("anchor cycle scan resolves kept members through policy ids", () => {
  const B_LOOP: RegistryPlugins[number] = {
    id: "acme-b-loop",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-f-kept"] } },
  };
  const F_KEPT: RegistryPlugins[number] = {
    id: "Acme-F-Kept",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" }, preferOver: ["acme-a-loop"] } },
  };
  const A_LOOP: RegistryPlugins[number] = {
    id: "acme-a-loop",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-loop"] } },
  };
  const D_OUTSIDE: RegistryPlugins[number] = {
    id: "acme-d-out",
    origin: "workspace",
    channels: ["acme-w"],
    channelConfigs: { "acme-w": { schema: { type: "object" }, preferOver: ["acme-f-kept"] } },
  };

  it("keeps an intact cycle grounded when its kept member is mixed-case", () => {
    // F is materially configured under its normalized entry key: superseded it lands KEPT and
    // stays activated, so the B→F→A→B cycle is intact and B must stand down with it.
    const registry = makeRegistry([B_LOOP, F_KEPT, A_LOOP, D_OUTSIDE]);
    const config: OpenClawConfig = {
      channels: {
        "acme-x": { token: "x" },
        "acme-y": { token: "y" },
        "acme-z": { token: "z" },
        "acme-w": { token: "w" },
      },
      plugins: { entries: { "acme-f-kept": { config: { keep: true } } } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    expect(activatedClaimants(registry, "acme-z", result.config)).toContain("Acme-F-Kept");
    // Kept-live F kills A in-cycle (intact), so A grounds instead of being wrongly anchored;
    // B lives because dead A kills nothing.
    expect(activatedClaimants(registry, "acme-y", result.config)).not.toContain("acme-a-loop");
    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("acme-b-loop");
  });
});

// #120332 round 35 (P1): anchor cycle detection walks only claimants live in the completed
// pass. A relay the pass killed from outside the loop can never re-form the cycle — treating
// dead F as a live link in B→F→A→B suppressed the anchor and orphaned B's configured channel.
// Grounded cycles are unaffected: their victims' killers are live and directly adjacent.
describe("anchor cycle detection ignores pass-dead relays", () => {
  const B_MIXED: RegistryPlugins[number] = {
    id: "Acme-B-Mixed",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-f-mid"] } },
  };
  const A_ON_Y: RegistryPlugins[number] = {
    id: "acme-a-yy",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-mixed"] } },
  };
  const F_ON_Z: RegistryPlugins[number] = {
    id: "acme-f-mid",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" }, preferOver: ["acme-a-yy"] } },
  };
  const D_ON_W: RegistryPlugins[number] = {
    id: "acme-d-ww",
    origin: "workspace",
    channels: ["acme-w"],
    channelConfigs: { "acme-w": { schema: { type: "object" }, preferOver: ["acme-f-mid"] } },
  };

  it("anchors the sole claimant when the cycle's relay died to an external edge", () => {
    // All four channels are configured; the pass lands F dead (D kills it) and A live (F's
    // claim can no longer supersede A) — the B→F→A→B loop cannot re-form at runtime.
    const registry = makeRegistry([B_MIXED, A_ON_Y, F_ON_Z, D_ON_W]);
    const config: OpenClawConfig = {
      channels: {
        "acme-x": { token: "x" },
        "acme-y": { token: "y" },
        "acme-z": { token: "z" },
        "acme-w": { token: "w" },
      },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-B-Mixed");
    // Round 36: F's own external kill (D) anchors it too, so Z is served as well; A then dies
    // to anchored-live F in-cycle and Y grounds legal-unowned.
    expect(activatedClaimants(registry, "acme-z", result.config)).toContain("acme-f-mid");
  });
});

// #120332 round 34 (P1): anchor cycle detection sees only configured channel claims. Edges
// declared on unconfigured channels never produce candidates and never participate in
// resolution, so a relay chain through them is synthetic — it must not suppress the anchor.
describe("anchor cycle detection ignores unconfigured channel edges", () => {
  const B_SOLE2: RegistryPlugins[number] = {
    id: "Acme-B-Sole2",
    origin: "workspace",
    channels: ["acme-x", "acme-z"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" } },
      "acme-z": { schema: { type: "object" }, preferOver: ["acme-f-relay"] },
    },
  };
  const A_KILLER2: RegistryPlugins[number] = {
    id: "acme-a-killer2",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-sole2"] } },
  };
  const F_RELAY: RegistryPlugins[number] = {
    id: "acme-f-relay",
    origin: "workspace",
    channels: ["acme-w"],
    channelConfigs: { "acme-w": { schema: { type: "object" }, preferOver: ["acme-a-killer2"] } },
  };

  it("anchors the sole claimant despite a cycle routed through unconfigured channels", () => {
    // Only X and Y are configured: the B→F (via Z) and F→A (via W) edges are inert claims.
    const registry = makeRegistry([B_SOLE2, A_KILLER2, F_RELAY]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-B-Sole2");
    expect(result.config.plugins?.entries?.["acme-a-killer2"]?.enabled).toBe(true);
  });
});

// #120332 round 33 (P1): anchor cycle detection sees only activatable claimants. A denied
// plugin can never participate in resolution, so edges through it are synthetic — treating
// B→F(denied)→A→B as a cycle suppressed the anchor and orphaned B's configured channel.
describe("anchor cycle detection ignores forbidden plugins", () => {
  const B_SOLE: RegistryPlugins[number] = {
    id: "Acme-B-Sole",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-f-denied"] } },
  };
  const A_KILLER: RegistryPlugins[number] = {
    id: "acme-a-killer",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-sole"] } },
  };
  const F_DENIED: RegistryPlugins[number] = {
    id: "acme-f-denied",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" }, preferOver: ["acme-a-killer"] } },
  };

  it("anchors the sole claimant despite a synthetic cycle through a denied plugin", () => {
    const registry = makeRegistry([B_SOLE, A_KILLER, F_DENIED]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
      plugins: { deny: ["acme-f-denied"] },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // F is denied and cannot relay a cycle: B's kill is non-cyclic, so B anchors and serves X.
    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-B-Sole");
    expect(result.config.plugins?.entries?.["acme-a-killer"]?.enabled).toBe(true);
  });
});

// #120332 round 36 (P1): an exact plan stays exact under unrelated plugin entries. Only a
// configured entry for a plugin that DECLARES a setup surface can produce the probe-derived
// candidates a probe-skipping plan misses — an entry for a setup-less plugin changes nothing,
// and flipping exactness off it handed ownership back to the predictive tiers.
describe("exact plans survive unrelated plugin entries", () => {
  const PLAIN_C2: RegistryPlugins[number] = {
    id: "acme-cc-plain2",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const EDGE_A3: RegistryPlugins[number] = {
    id: "acme-aa-edge3",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-bb-edge3"] } },
  };
  const EDGE_B3: RegistryPlugins[number] = {
    id: "acme-bb-edge3",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const UNRELATED_U: RegistryPlugins[number] = {
    id: "acme-u-extra",
    origin: "global",
    channels: ["acme-q"],
    channelConfigs: { "acme-q": { schema: { type: "object" } } },
  };

  it("keeps the default-active first-discovered claimant as owner", () => {
    // U carries a material entry but declares no setup surface: no probe-derived candidate can
    // exist, so the plan is still exact and C stays load-order accounted.
    const registry = makeRegistry([PLAIN_C2, EDGE_A3, EDGE_B3, UNRELATED_U]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-u-extra": { config: { extra: true } } } },
    };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-cc-plain2");
  });

  // #120332 round 47 (P1): an explicitly DISABLED entry is categorically excluded from setup
  // candidacy before any probe resolves (the setup-candidate collector skips it), so a material
  // entry with `enabled: false` on a setup-capable plugin can no more produce a probe-derived
  // candidate than no entry at all — the plan stays exact.
  it("keeps the plan exact beside a disabled entry for a setup-capable plugin", () => {
    const SETUP_OFF_U: RegistryPlugins[number] = {
      id: "acme-u-setoff",
      origin: "global",
      channels: ["acme-q"],
      channelConfigs: { "acme-q": { schema: { type: "object" } } },
      setup: {},
    };
    const registry = makeRegistry([PLAIN_C2, EDGE_A3, EDGE_B3, SETUP_OFF_U]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-u-setoff": { config: { extra: true }, enabled: false } } },
    };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-cc-plain2");
  });

  // #120332 round 43 (P1): a runtime-disabled setup descriptor (`setup.requiresRuntime: false`)
  // is categorically skipped before any probe resolves, so a configured entry for such a plugin
  // can no more produce a probe-derived candidate than a setup-less one — the plan stays exact.
  it("keeps the plan exact beside an entry for a runtime-disabled setup plugin", () => {
    const RUNTIME_OFF_U: RegistryPlugins[number] = {
      id: "acme-u-rtoff",
      origin: "global",
      channels: ["acme-q"],
      channelConfigs: { "acme-q": { schema: { type: "object" } } },
      setup: { requiresRuntime: false },
    };
    const registry = makeRegistry([PLAIN_C2, EDGE_A3, EDGE_B3, RUNTIME_OFF_U]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-u-rtoff": { config: { extra: true } } } },
    };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-cc-plain2");
  });
});

// #120332 round 32 (P1): the orphan guard preserves an owner even when a channel has several
// claimants and every one of them dies to a distinct cross-channel edge — each pin vetoed by its
// own live killer. Restricting anchoring to a sole registry claimant left such a channel
// silently unowned; after all remedies exhaust, the first activatable non-cyclically-killed
// claimant anchors instead.
describe("orphan guard preserves an owner when every fallback is killed", () => {
  const B_X: RegistryPlugins[number] = {
    id: "Acme-B-X",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const D_X: RegistryPlugins[number] = {
    id: "Acme-D-X",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const Y_KILLS_B: RegistryPlugins[number] = {
    id: "acme-y-kb",
    origin: "workspace",
    channels: ["acme-y"],
    channelConfigs: { "acme-y": { schema: { type: "object" }, preferOver: ["acme-b-x"] } },
  };
  const Z_KILLS_D: RegistryPlugins[number] = {
    id: "acme-z-kd",
    origin: "workspace",
    channels: ["acme-z"],
    channelConfigs: { "acme-z": { schema: { type: "object" }, preferOver: ["acme-d-x"] } },
  };

  it("anchors the first activatable claimant after both kills", () => {
    const registry = makeRegistry([B_X, D_X, Y_KILLS_B, Z_KILLS_D]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" }, "acme-z": { token: "z" } },
    };
    const env = makeIsolatedEnv();
    const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    // X keeps a runtime owner: the first-discovered claimant anchors; the second stays dead and
    // both killers keep their own channels.
    expect(activatedClaimants(registry, "acme-x", result.config)).toContain("Acme-B-X");
    expect(result.config.plugins?.entries?.["acme-y-kb"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["acme-z-kd"]?.enabled).toBe(true);
  });
});

// #120332 round 31 (P1): an exact plan accounts for default-active omitted claimants. With no
// setup-relevant config, the probe-skipping plan IS the runtime's plan, so a default-active
// claimant outside the replacement edge set — decided nowhere — is still load-order eligible:
// it loads first and registration keeps it, and validation must apply its schema.
describe("load-order ranking includes default-active omitted claimants", () => {
  const PLAIN_C: RegistryPlugins[number] = {
    id: "acme-cc-plain",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };
  const EDGE_A2: RegistryPlugins[number] = {
    id: "acme-aa-edge2",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-bb-edge2"] } },
  };
  const EDGE_B2: RegistryPlugins[number] = {
    id: "acme-bb-edge2",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("projects the default-active first-discovered claimant as the schema owner", () => {
    // C sits outside the A→B edge set, so channel collection omits it; ordinary default
    // activation still loads it first, and it registers acme-x before the edge winner.
    const registry = makeRegistry([PLAIN_C, EDGE_A2, EDGE_B2]);
    const config: OpenClawConfig = { channels: { "acme-x": { token: "x" } } };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-cc-plain");
  });
});

// #120332 round 30 (P1): a configured channel's sole activatable claimant is never plugin-globally
// disabled by a replacement elsewhere. Enablement is plugin-global, so superseding such a claimant
// on one channel would orphan the sibling channel it alone serves — no fallback exists and a
// re-grounding pin is vetoed by the live preferring claim. The claimant stays live for its sole
// channel; since round 45 its REPLACED sibling claim still records supersede-disable, so loader
// suppression hands the contested channel to the replacement in either registration order.
describe("supersession preserves a sibling channel's sole claimant", () => {
  const MULTI_B: RegistryPlugins[number] = {
    id: "Acme-B-Multi",
    origin: "global",
    channels: ["acme-x", "acme-y"],
    channelConfigs: {
      "acme-x": { schema: { type: "object" } },
      "acme-y": { schema: { type: "object" } },
    },
  };
  const REP_A: RegistryPlugins[number] = {
    id: "acme-a-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-b-multi"] } },
  };

  for (const [registryOrder, plugins] of [
    ["victim first", [MULTI_B, REP_A]],
    ["victim last", [REP_A, MULTI_B]],
  ] as const) {
    it(`keeps the sole claimant serving its sibling channel (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
      };
      const env = makeIsolatedEnv();
      const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

      // The victim stays loaded for acme-y; its suppressed acme-x claim leaves the replacement
      // owning the contested channel regardless of registration order.
      expect(result.config.plugins?.entries?.["Acme-B-Multi"]?.enabled).not.toBe(false);
      expect(activatedClaimants(registry, "acme-y", result.config)).toContain("Acme-B-Multi");
      const metadata = collectChannelSchemaMetadataWithOwnership(registry, config, env);
      expect(metadata.find((entry) => entry.id === "acme-y")?.schemaPluginId).toBe("Acme-B-Multi");
      expect(metadata.find((entry) => entry.id === "acme-x")?.schemaPluginId).toBe("acme-a-rep");
    });
  }
});

// #120332 round 29 (P1): load-order eligibility includes claimants the pass decided globally.
// A provider-activated claimant outside the channel's preferOver edge set has no per-channel
// decision, but its capability candidate landed a live fate — the runtime loads it first and
// registration keeps it, so the projection must rank it by load order instead of handing the
// schema to the surviving edge claimant.
describe("load-order ranking includes capability-decided omitted claimants", () => {
  const EARLY_CAP: RegistryPlugins[number] = {
    id: "acme-cc-early",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };
  const EDGE_A: RegistryPlugins[number] = {
    id: "acme-aa-edge",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-bb-edge"] } },
  };
  const EDGE_B: RegistryPlugins[number] = {
    id: "acme-bb-edge",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("projects the provider-activated first-discovered claimant as the schema owner", () => {
    // C is discovery-first but outside the A→B edge set, so channel collection omits it; its
    // provider capability still activates it, and it registers acme-x before the edge winner.
    const registry = makeRegistry([EARLY_CAP, EDGE_A, EDGE_B]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
    };
    const env = makeIsolatedEnv();
    applyPluginAutoEnable({ config, env, manifestRegistry: registry });

    const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
      (entry) => entry.id === "acme-x",
    );
    expect(owner?.schemaPluginId).toBe("acme-cc-early");
  });
});

// #120332 round 29 (P2): allowlist membership and writes compare policy ids. A mixed-case
// manifest id enabled under its normalized entry key satisfied the folded enabled-read while
// the exact allow check reported it missing — the apply loop then appended the declared id
// beside the operator's normalized entry, and removing one variant left the plugin allowed.
describe("apply-loop allowlist compares policy ids", () => {
  const MIXED_ALLOWED: RegistryPlugins[number] = {
    id: "Acme-Chat",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
  };

  it("does not append a case-variant beside the operator's allow entry", () => {
    const registry = makeRegistry([MIXED_ALLOWED]);
    const config: OpenClawConfig = {
      channels: { "acme-x": { token: "x" } },
      plugins: { entries: { "acme-chat": { enabled: true } }, allow: ["acme-chat"] },
    };
    const result = applyPluginAutoEnable({
      config,
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // The normalized allow entry already covers the claimant; no variant may be appended.
    expect(result.config.plugins?.allow).toEqual(["acme-chat"]);
  });
});

// #120332 round 23 (P1): replacing a channel claim must not destroy the victim's other
// configured capabilities. A mixed-case victim that also owns a configured provider lost the
// provider when the channel-phase supersession landed a plugin-global disable before the
// provider candidate ran — the replacement replaces the channel, not the plugin's capabilities.
describe("channel replacement preserves the victim's configured capabilities", () => {
  const MULTI_CAP: RegistryPlugins[number] = {
    id: "Acme-AA-Multi",
    origin: "workspace",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" } } },
    autoEnableWhenConfiguredProviders: ["acme-prov"],
  };
  const CHAN_REPLACEMENT: RegistryPlugins[number] = {
    id: "acme-bb-rep",
    origin: "global",
    channels: ["acme-x"],
    channelConfigs: { "acme-x": { schema: { type: "object" }, preferOver: ["acme-aa-multi"] } },
  };

  for (const [registryOrder, plugins] of [
    ["victim first", [MULTI_CAP, CHAN_REPLACEMENT]],
    ["victim last", [CHAN_REPLACEMENT, MULTI_CAP]],
  ] as const) {
    it(`the provider survives and the replacement owns the channel (${registryOrder})`, () => {
      const registry = makeRegistry([...plugins]);
      const config: OpenClawConfig = {
        channels: { "acme-x": { token: "x" } },
        auth: { profiles: { "acme-prov:default": { provider: "acme-prov", mode: "api_key" } } },
      };
      const env = makeIsolatedEnv();
      const result = applyPluginAutoEnable({ config, env, manifestRegistry: registry });

      // Both stay enabled: the replacement by its claim, the victim by its provider capability.
      expect(result.config.plugins?.entries?.["acme-bb-rep"]?.enabled).toBe(true);
      expect(result.config.plugins?.entries?.["Acme-AA-Multi"]?.enabled).toBe(true);
      // Round 37: the loader suppresses the capability-preserved victim's superseded claim, so
      // the replacement serves the channel in any discovery order and validation projects it.
      const owner = collectChannelSchemaMetadataWithOwnership(registry, config, env).find(
        (entry) => entry.id === "acme-x",
      );
      expect(owner?.schemaPluginId).toBe("acme-bb-rep");
    });
  }
});
