// The class-killer invariant proofs for auto-enable's resolve phase: enumerated registry
// topologies swept across registry and channel orders. Split from
// plugin-auto-enable.resolve.test.ts (max-lines); the finding-shaped pins stay there.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { isPluginExplicitlySelected, normalizePluginsConfig } from "../plugins/config-state.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import {
  declaresPluginPreferenceOver,
  normalizePluginPolicyId,
} from "../plugins/plugin-policy-id.js";
import { collectPluginIdsForConfiguredChannel } from "./channel-claimant-plugins.js";
import { collectChannelSchemaMetadataWithOwnership } from "./channel-config-metadata.js";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import { planPluginAutoEnable } from "./plugin-auto-enable.shared.js";
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

/** True when any of the plugin's channel claims declares preference over the victim. */
const targets = (plugin: RegistryPlugins[number], victimId: string): boolean =>
  Object.values(plugin.channelConfigs ?? {}).some((channelConfig) =>
    declaresPluginPreferenceOver((channelConfig as { preferOver?: string[] }).preferOver, victimId),
  );

// The preferOver digraph over installed plugin ids, for the cycle amendment to I1: a replacement
// cycle has no self-consistent assignment (each member's killer can itself be killed around the
// loop), so seniority grounding activates one member and the rest of the cycle stands down with
// it — a victim inside a cycle is justified by any activated member of its cycle.
const buildPreferDigraph = (plugins: RegistryPlugins): Map<string, string[]> => {
  const byPolicyId = new Map(
    plugins.map((plugin) => [normalizePluginPolicyId(plugin.id), plugin.id]),
  );
  return new Map(
    plugins.map((plugin) => {
      const targetIds = new Set<string>();
      for (const channelConfig of Object.values(plugin.channelConfigs ?? {})) {
        for (const target of (channelConfig as { preferOver?: string[] }).preferOver ?? []) {
          const resolved = byPolicyId.get(normalizePluginPolicyId(target));
          if (resolved && resolved !== plugin.id) {
            targetIds.add(resolved);
          }
        }
      }
      return [plugin.id, [...targetIds]];
    }),
  );
};
const reaches = (edges: Map<string, string[]>, from: string, to: string): boolean => {
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return (edges.get(id) ?? []).some((next) => next === to || walk(next));
  };
  return walk(from);
};
const inSameReplacementCycle = (
  edges: Map<string, string[]>,
  left: string,
  right: string,
): boolean => left !== right && reaches(edges, left, right) && reaches(edges, right, left);
// #120332 rounds 35/36: a replacement cycle grounds its members only while intact. A member —
// the victim included — killed from OUTSIDE the cycle can release the victim to the orphan
// anchor; whether the break lands depends on mid-worklist liveness this static harness cannot
// reconstruct, so any cycle with an external in-edge is exempt here. Cycles with no external
// in-edges can never legitimately anchor and still fail. Projection coherence for anchored
// dual-actives is pinned by the dedicated describes over really-configured channels.
const cycleMayBreakExternally = (params: {
  plugins: RegistryPlugins;
  edges: Map<string, string[]>;
  victimId: string;
}): boolean => {
  const members = params.plugins
    .map((plugin) => plugin.id)
    .filter(
      (id) =>
        id === params.victimId ||
        (reaches(params.edges, params.victimId, id) && reaches(params.edges, id, params.victimId)),
    );
  const memberSet = new Set(members);
  return members.some((member) =>
    [...params.edges.entries()].some(
      ([from, edgeTargets]) => !memberSet.has(from) && edgeTargets.includes(member),
    ),
  );
};
// #120332 rounds 30/32: capability preservation and the orphan-guard anchor make dual-active
// pairs a sanctioned completed state — the runtime keeps the FIRST registrant and validation
// mirrors it (round 26). A dual-active pair on a non-cyclic edge is therefore acceptable exactly
// when the collector projects the first-discovered activated claimant as the channel's owner;
// any divergence between projection and runtime first-wins still fails.
const dualActiveMirrorsRuntime = (params: {
  registry: ReturnType<typeof makeRegistry>;
  channelId: string;
  supersederId: string;
  victimId: string;
  activatedIds: ReadonlySet<string>;
  edges: Map<string, string[]>;
  ownerOf: (channelId: string) => string | undefined;
}): boolean => {
  if (inSameReplacementCycle(params.edges, params.supersederId, params.victimId)) {
    return false;
  }
  const firstActivated = params.registry.plugins.find(
    (plugin) => plugin.channels.includes(params.channelId) && params.activatedIds.has(plugin.id),
  );
  return firstActivated !== undefined && params.ownerOf(params.channelId) === firstActivated.id;
};

// #120332 round 14: the class-killer proof. Over every small registry topology and order, a
// configured channel may end without an activated claimant only when each of its activatable
// claimants was replaced by a plugin the completed config actually activates; and a plugin that
// stays activated while preferring over an implicitly selected co-claimant means that co-claimant
// must not be activated too. The findings' unowned-channel and dual-active corners are instances.
describe("auto-enable resolve invariants", () => {
  type InvariantCase = {
    name: string;
    plugins: RegistryPlugins;
    channels: Record<string, Record<string, unknown>>;
    pluginsConfig?: OpenClawConfig["plugins"];
  };

  const schema = { type: "object" } as const;
  const claim = (
    id: string,
    origin: "global" | "workspace" | "config",
    channels: Array<[channelId: string, preferOver?: string[]]>,
  ): RegistryPlugins[number] => ({
    id,
    origin,
    channels: channels.map(([channelId]) => channelId),
    channelConfigs: Object.fromEntries(
      channels.map(([channelId, preferOver]) => [
        channelId,
        { schema, ...(preferOver ? { preferOver } : {}) },
      ]),
    ),
  });

  const CASES: InvariantCase[] = [
    {
      name: "same-channel chain, head senior",
      plugins: [
        claim("acme-chain-head", "global", [["acme-chat", ["acme-chain-mid"]]]),
        claim("acme-chain-mid", "global", [["acme-chat", ["acme-chain-tail"]]]),
        claim("acme-chain-tail", "global", [["acme-chat"]]),
      ],
      channels: { "acme-chat": { token: "chat" } },
    },
    {
      name: "same-channel chain, tail senior",
      plugins: [
        claim("zz-chain-head", "global", [["acme-chat", ["mm-chain-mid"]]]),
        claim("mm-chain-mid", "global", [["acme-chat", ["aa-chain-tail"]]]),
        claim("aa-chain-tail", "global", [["acme-chat"]]),
      ],
      channels: { "acme-chat": { token: "chat" } },
    },
    {
      name: "cross-channel chain dooms the middle claimant",
      plugins: [
        claim("acme-chat-fallback", "global", [["acme-chat"]]),
        claim("Acme-Mid-Guard", "global", [["acme-chat", ["acme-chat-fallback"]]]),
        claim("acme-zap-next", "global", [["acme-zap", ["acme-mid-guard"]]]),
      ],
      channels: { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } },
    },
    {
      name: "kept claimant activated by the allowlist repair",
      plugins: [
        claim("acme-kept-a", "workspace", [["acme-chat", ["acme-b-serv"]]]),
        claim("acme-b-serv", "global", [["acme-chat"]]),
        claim("acme-zap-c", "global", [["acme-zap", ["acme-kept-a"]]]),
      ],
      channels: { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } },
      pluginsConfig: {
        allow: ["acme-zap-c"],
        entries: { "acme-kept-a": { config: { region: "eu" } } },
      },
    },
    {
      name: "kept-but-unloaded superseder does not orphan its channel",
      plugins: [
        claim("acme-kept-super", "workspace", [["acme-chat", ["acme-live-serv"]], ["acme-zap"]]),
        claim("acme-zap-modern", "global", [["acme-zap", ["acme-kept-super"]]]),
        claim("acme-live-serv", "global", [["acme-chat"]]),
      ],
      channels: { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } },
      pluginsConfig: { entries: { "acme-kept-super": { config: { region: "eu" } } } },
    },
    {
      name: "shared claimant loses both channels to survivors",
      plugins: [
        claim("acme-shared", "global", [["acme-chat", ["acme-x-guard"]], ["acme-zap"]]),
        claim("acme-x-guard", "global", [["acme-chat"]]),
        claim("acme-y-claimant", "global", [["acme-zap", ["acme-shared"]]]),
      ],
      channels: { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } },
    },
    {
      name: "cross-channel mutual preference",
      plugins: [
        claim("acme-chat-only", "global", [["acme-chat", ["acme-zap-only"]]]),
        claim("acme-zap-only", "global", [["acme-zap", ["acme-chat-only"]]]),
      ],
      channels: { "acme-chat": { token: "chat" }, "acme-zap": { token: "zap" } },
    },
    {
      name: "explicitly selected loser is kept beside the replacement",
      plugins: [
        claim("acme-modern", "global", [["acme-chat", ["acme-legacy"]]]),
        claim("acme-legacy", "global", [["acme-chat"]]),
      ],
      channels: { "acme-chat": { token: "chat" } },
      pluginsConfig: { entries: { "acme-legacy": { enabled: true } } },
    },
    {
      // Workspace claimants are default-off, so the channel is really unowned when its only
      // collected candidate dies to the cross-channel replacement.
      name: "fallback channel with an untargeted second claimant",
      plugins: [
        claim("Acme-X-Victim", "workspace", [["acme-x"]]),
        claim("acme-x-second", "workspace", [["acme-x"]]),
        claim("acme-y-killer", "global", [["acme-y", ["acme-x-victim"]]]),
      ],
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
    },
    {
      name: "two-channel replacement cycle",
      plugins: [
        claim("acme-cycle-aa", "global", [["acme-x", ["acme-cycle-bb"]]]),
        claim("acme-cycle-bb", "global", [["acme-x"], ["acme-y", ["acme-cycle-cc"]]]),
        claim("acme-cycle-cc", "global", [["acme-x", ["acme-cycle-aa"]]]),
      ],
      channels: { "acme-x": { token: "x" }, "acme-y": { token: "y" } },
    },
  ];

  for (const invariantCase of CASES) {
    const channelOrders = [
      Object.entries(invariantCase.channels),
      Object.entries(invariantCase.channels).toReversed(),
    ];
    for (const [registryOrder, plugins] of [
      ["forward", invariantCase.plugins],
      ["reverse", [...invariantCase.plugins].toReversed()],
    ] as const) {
      for (const channelEntries of channelOrders) {
        const channelOrder = channelEntries.map(([channelId]) => channelId).join(">");
        it(`${invariantCase.name} (${registryOrder}, ${channelOrder})`, () => {
          const registry = makeRegistry([...plugins]);
          const sourceConfig: OpenClawConfig = {
            channels: Object.fromEntries(channelEntries),
            ...(invariantCase.pluginsConfig ? { plugins: invariantCase.pluginsConfig } : {}),
          } as OpenClawConfig;
          const env = makeIsolatedEnv();
          let ownersByChannelId: Map<string, string | undefined> | undefined;
          const ownerOf = (ownerChannelId: string): string | undefined => {
            ownersByChannelId ??= new Map(
              collectChannelSchemaMetadataWithOwnership(registry, sourceConfig, env).map(
                (entry) => [entry.id, entry.schemaPluginId],
              ),
            );
            return ownersByChannelId.get(ownerChannelId);
          };
          const result = applyPluginAutoEnable({
            config: sourceConfig,
            env,
            manifestRegistry: registry,
          });
          const completedPlugins = normalizePluginsConfig(result.config.plugins);
          const activatedIds = new Set(
            registry.plugins
              .filter((plugin) =>
                isActivatedManifestOwner({
                  plugin,
                  normalizedConfig: completedPlugins,
                  rootConfig: result.config,
                }),
              )
              .map((plugin) => plugin.id),
          );

          for (const [channelId] of channelEntries) {
            const claimants = registry.plugins.filter((plugin) =>
              plugin.channels.includes(channelId),
            );
            const activatable = claimants; // no case forbids a claimant at the source config
            const activated = claimants.filter((plugin) => activatedIds.has(plugin.id));

            // I1: an unowned configured channel is legal only when every activatable claimant
            // was replaced by a plugin the completed config activates — never by a dead one. A
            // replacement cycle has no self-consistent assignment (each member's killer can
            // itself be killed around the loop), so seniority grounding activates one member and
            // the rest of the cycle stands down with it: a victim inside a cycle is justified by
            // any activated member of its cycle.
            if (activatable.length > 0 && activated.length === 0) {
              const edges = buildPreferDigraph([...plugins]);
              for (const victim of activatable) {
                const justified = registry.plugins.some(
                  (superseder) =>
                    superseder.id !== victim.id &&
                    activatedIds.has(superseder.id) &&
                    (targets(superseder, victim.id) ||
                      inSameReplacementCycle(edges, superseder.id, victim.id)),
                );
                expect
                  .soft(justified, `${channelId}: ${victim.id} disabled without a live superseder`)
                  .toBe(true);
              }
            }

            // I2: an activated claimant that prefers over an implicitly selected co-claimant
            // means that co-claimant must not be activated too (the dual-active corner) —
            // unless the victim anchors a sibling channel it alone serves (round 30).
            const i2Edges = buildPreferDigraph([...plugins]);
            for (const superseder of activated) {
              const preferOver = (
                superseder.channelConfigs?.[channelId] as { preferOver?: string[] } | undefined
              )?.preferOver;
              for (const victim of activated) {
                if (
                  victim.id !== superseder.id &&
                  declaresPluginPreferenceOver(preferOver, victim.id) &&
                  !isPluginExplicitlySelected(sourceConfig.plugins, victim.id) &&
                  !dualActiveMirrorsRuntime({
                    registry,
                    channelId,
                    supersederId: superseder.id,
                    victimId: victim.id,
                    activatedIds,
                    edges: i2Edges,
                    ownerOf,
                  })
                ) {
                  expect
                    .soft(
                      false,
                      `${channelId}: ${superseder.id} and its implicitly selected victim ${victim.id} are both activated`,
                    )
                    .toBe(true);
                }
              }
            }
          }
        });
      }
    }
  }
});

// #120332 round 15: generated topology sweep — the enumerated matrix behind the hand cases
// above. Every 3-plugin topology over two configured channels (single preferOver edge per
// plugin, workspace origin so claimants are default-off) runs exhaustively, plus a deterministic
// sample of the 4-plugin space, in both channel orders, through the same resolve+apply core
// (candidates built exactly as detection builds them). Explicit-selection shapes (keeps) stay in
// the hand cases; this sweep covers the implicit space where the silent-unowned and dual-active
// classes live.
describe("auto-enable resolve invariants: generated topology sweep", () => {
  const CHANNEL_X = "acme-gen-x";
  const CHANNEL_Y = "acme-gen-y";
  const CLAIM_SETS = [[CHANNEL_X], [CHANNEL_Y], [CHANNEL_X, CHANNEL_Y]] as const;

  type GeneratedPlugin = {
    claims: readonly string[];
    edge: { channelId: string; targetOffset: number } | null;
  };

  // All (claim set, edge) combos one plugin can take: none, or one preferOver edge on one of its
  // claimed channels toward one of the other plugins (encoded as an offset skipping itself).
  const pluginComboList = (pluginCount: number): GeneratedPlugin[] => {
    const combos: GeneratedPlugin[] = [];
    for (const claims of CLAIM_SETS) {
      combos.push({ claims, edge: null });
      for (const channelId of claims) {
        for (let targetOffset = 0; targetOffset < pluginCount - 1; targetOffset++) {
          combos.push({ claims, edge: { channelId, targetOffset } });
        }
      }
    }
    return combos;
  };

  const buildRegistryPlugins = (
    combos: readonly GeneratedPlugin[],
    pick: readonly number[],
  ): RegistryPlugins =>
    pick.map((comboIndex, pluginIndex) => {
      const combo = expectDefined(combos[comboIndex], "generated plugin combo");
      const channelConfigs = Object.fromEntries(
        combo.claims.map((channelId) => {
          const targeted =
            combo.edge && combo.edge.channelId === channelId
              ? combo.edge.targetOffset + (combo.edge.targetOffset >= pluginIndex ? 1 : 0)
              : null;
          return [
            channelId,
            {
              schema: { type: "object" },
              ...(targeted === null ? {} : { preferOver: [`acme-gen-p${targeted}`] }),
            },
          ];
        }),
      );
      return {
        id: `acme-gen-p${pluginIndex}`,
        origin: "workspace" as const,
        channels: [...combo.claims],
        channelConfigs,
      };
    });

  const checkInvariants = (params: {
    plugins: RegistryPlugins;
    channelOrder: readonly string[];
    env: NodeJS.ProcessEnv;
    label: string;
  }): void => {
    const registry = makeRegistry([...params.plugins]);
    const candidates = params.channelOrder.flatMap((channelId) =>
      collectPluginIdsForConfiguredChannel(channelId, registry, params.env).map((pluginId) => ({
        pluginId,
        kind: "channel-configured" as const,
        channelId,
      })),
    );
    const plan = planPluginAutoEnable({
      config: {
        channels: Object.fromEntries(params.channelOrder.map((channelId) => [channelId, {}])),
      },
      candidates,
      env: params.env,
      manifestRegistry: registry,
    });
    const completedPlugins = normalizePluginsConfig(plan.config.plugins);
    const activatedIds = new Set(
      registry.plugins
        .filter((plugin) =>
          isActivatedManifestOwner({
            plugin,
            normalizedConfig: completedPlugins,
            rootConfig: plan.config,
          }),
        )
        .map((plugin) => plugin.id),
    );
    const edges = buildPreferDigraph([...params.plugins]);

    for (const channelId of params.channelOrder) {
      const claimants = registry.plugins.filter((plugin) => plugin.channels.includes(channelId));
      const activated = claimants.filter((plugin) => activatedIds.has(plugin.id));

      // I1 (sweep form): an unowned configured channel is legal only when every claimant's
      // disable is accounted for — a live superseder, the cycle grounding, or the pinned
      // same-group order residual: the victim's killer was itself doomed by a claim decided
      // under a group's own discovery order (a doomer sharing a channel with the killer or with
      // the victim), the round-14 residual class the residual describe below pins as
      // maintainer-gated. A killer doomed purely from unrelated channels never justifies the
      // victim — that is the class rounds 14/15 fixed.
      if (claimants.length > 0 && activated.length === 0) {
        for (const victim of claimants) {
          const justified = registry.plugins.some(
            (superseder) =>
              superseder.id !== victim.id &&
              targets(superseder, victim.id) &&
              (activatedIds.has(superseder.id) ||
                inSameReplacementCycle(edges, superseder.id, victim.id) ||
                registry.plugins.some(
                  (doomer) =>
                    doomer.id !== superseder.id &&
                    targets(doomer, superseder.id) &&
                    doomer.channels.some(
                      (id) => superseder.channels.includes(id) || victim.channels.includes(id),
                    ),
                )),
          );
          expect
            .soft(
              justified,
              `${params.label}: ${channelId}: ${victim.id} disabled without a live superseder`,
            )
            .toBe(true);
        }
      }

      // I2 (sweep form): an activated claimant that prefers over a co-claimant means that
      // (implicitly selected) co-claimant must not be activated too. One documented residual:
      // when the superseder was itself targeted by a same-group claim that ended dead, its
      // liveness rode the pinned in-group discovery order and the pair can split — the
      // sequential pass judges early candidates before that in-group fate lands. The named
      // finding shapes stay hard-pinned by the dedicated describes and the hand cases above.
      for (const superseder of activated) {
        const preferOver = (
          superseder.channelConfigs?.[channelId] as { preferOver?: string[] } | undefined
        )?.preferOver;
        const ridesInGroupOrder = registry.plugins.some(
          (doomer) =>
            doomer.id !== superseder.id &&
            targets(doomer, superseder.id) &&
            !activatedIds.has(doomer.id) &&
            doomer.channels.some((id) => superseder.channels.includes(id)),
        );
        for (const victim of activated) {
          if (
            victim.id !== superseder.id &&
            declaresPluginPreferenceOver(preferOver, victim.id) &&
            !ridesInGroupOrder &&
            // Rounds 30/32/35: the orphan guard deliberately preserves claimants killed from
            // sibling channels, so a NON-CYCLIC dual-active pair is a sanctioned completed
            // state in this minimal harness (runtime keeps the first registrant; projection
            // coherence is pinned by the dedicated describes over really-configured channels).
            // Cyclic pairs must still ground to one survivor — unless the cycle is externally
            // broken, where the anchor legitimately revives the victim.
            inSameReplacementCycle(edges, superseder.id, victim.id) &&
            !cycleMayBreakExternally({
              plugins: [...params.plugins],
              edges,
              victimId: victim.id,
            })
          ) {
            expect
              .soft(
                false,
                `${params.label}: ${channelId}: ${superseder.id} and its victim ${victim.id} are both activated`,
              )
              .toBe(true);
          }
        }
      }
    }
  };

  for (const [orderName, channelOrder] of [
    ["x first", [CHANNEL_X, CHANNEL_Y]],
    ["y first", [CHANNEL_Y, CHANNEL_X]],
  ] as const) {
    it(`holds over every 3-plugin topology (${orderName})`, () => {
      const env = makeIsolatedEnv();
      const combos = pluginComboList(3);
      for (let first = 0; first < combos.length; first++) {
        for (let second = 0; second < combos.length; second++) {
          for (let third = 0; third < combos.length; third++) {
            const pick = [first, second, third];
            checkInvariants({
              plugins: buildRegistryPlugins(combos, pick),
              channelOrder,
              env,
              label: `combo ${pick.join("/")}`,
            });
          }
        }
      }
    });

    it(`holds over a deterministic 4-plugin sample (${orderName})`, () => {
      const env = makeIsolatedEnv();
      const combos = pluginComboList(4);
      // Deterministic LCG so failures reproduce; samples the 15^4 combo space.
      let seed = 0x12345678;
      const nextComboIndex = (): number => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed % combos.length;
      };
      for (let sample = 0; sample < 3000; sample++) {
        const pick = [nextComboIndex(), nextComboIndex(), nextComboIndex(), nextComboIndex()];
        checkInvariants({
          plugins: buildRegistryPlugins(combos, pick),
          channelOrder,
          env,
          label: `sample ${sample} (combo ${pick.join("/")})`,
        });
      }
    });
  }
});

// Closed residual (round 17): within one channel group, discovery-order seniority still lets a
// superseder disable a victim before the group's later claims kill that superseder (the pinned
// same-channel candidate-order contract), and a supersede-disable is plugin-global — but the
// re-grounding pin now revives the victim for its orphaned sibling channel, accepted because the
// victim's killer itself ends dead, so the completed pass records no claim it would kill again.
// This diverges from the merge base deliberately: base leaves the configured sibling channel
// silently unowned; serving it is the product-doctrine choice (silent failure is the worst
// class), disclosed in the PR body for maintainer review.

// #120332 round 22 (P2): claimant liveness evaluation must not be exponential. In a complete
// cross-channel replacement DAG whose sole survivor sits last in scan order, every liveness read
// re-evaluated the full killer subtree before reaching the one live claimant — 2^N evaluations,
// stalling gateway startup and config validation for a few dozen installed replacement plugins.
// Memoized per decision the same plan completes in milliseconds; the timeout is the regression
// guard, generous enough for any loaded runner.
describe("resolve completes on dense replacement DAGs", () => {
  it("plans a 28-claimant complete replacement DAG without exponential rescans", () => {
    const pad = (index: number): string => String(index).padStart(2, "0");
    const plugins: RegistryPlugins = Array.from({ length: 28 }, (_seed, index) => ({
      id: `acme-dag-${pad(index)}`,
      origin: "global" as const,
      channels: [`acme-dag-ch-${pad(index)}`],
      channelConfigs: {
        [`acme-dag-ch-${pad(index)}`]: {
          schema: { type: "object" },
          // Every claimant supersedes all earlier ones; the final claimant survives and every
          // scan discovers that only after exhausting the dead subtree before it.
          preferOver: Array.from({ length: index }, (_edge, target) => `acme-dag-${pad(target)}`),
        },
      },
    }));
    const channels = Object.fromEntries(
      plugins.map((_plugin, index) => [`acme-dag-ch-${pad(index)}`, { token: "x" }]),
    );
    const registry = makeRegistry([...plugins]);
    const result = applyPluginAutoEnable({
      config: { channels },
      env: makeIsolatedEnv(),
      manifestRegistry: registry,
    });

    // The scan-last survivor is enabled; the point of this case is completing at all.
    expect(result.config.plugins?.entries?.["acme-dag-27"]?.enabled).toBe(true);
  }, 15_000);
});
