/** Covers which plugin owns a channel's surfaced config schema when several claim the same id. */
import { describe, expect, it } from "vitest";
import { resolveManifestChannelPreferOverIds } from "../plugins/manifest-channel-preference.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadataWithOwnership,
  collectRuntimeDisplacedChannelOwners,
  type ChannelOwnershipPolicy,
} from "./channel-config-metadata.js";

type ClaimantParams = {
  id: string;
  origin?: string;
  channels?: readonly string[];
  preferOver?: readonly string[];
  catalogPreferOver?: readonly string[];
};

function claimant({
  id,
  origin = "global",
  channels = ["clickclack"],
  preferOver,
  catalogPreferOver,
}: ClaimantParams) {
  return {
    id,
    origin,
    channels,
    ...(catalogPreferOver
      ? { channelCatalogMeta: { id: "clickclack", preferOver: catalogPreferOver } }
      : {}),
    channelConfigs: {
      clickclack: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { [`${id}Token`]: { type: "string" } },
        },
        ...(preferOver ? { preferOver } : {}),
      },
    },
  };
}

function policyFor(overrides: Partial<ChannelOwnershipPolicy>): ChannelOwnershipPolicy {
  return {
    isPluginActive: () => true,
    isPluginExplicitlySelected: () => false,
    isPluginPolicyDisabled: () => false,
    resolveChannelPreferOverIds: resolveManifestChannelPreferOverIds,
    ...overrides,
  };
}

function entryFor(
  plugins: ReturnType<typeof claimant>[],
  channelId = "clickclack",
  policy?: ChannelOwnershipPolicy,
) {
  const registry = { plugins, diagnostics: [] } as unknown as PluginManifestRegistry;
  return collectChannelSchemaMetadataWithOwnership(registry, policy).find(
    (entry) => entry.id === channelId,
  );
}

function ownerOf(
  plugins: ReturnType<typeof claimant>[],
  policy?: ChannelOwnershipPolicy,
): string | undefined {
  return entryFor(plugins, "clickclack", policy)?.schemaPluginId;
}

describe("collectChannelSchemaMetadataWithOwnership", () => {
  // #92884: auto-enable skips a candidate that another configured plugin lists in `preferOver`,
  // but schema selection ranked only by origin. Two same-origin claimants therefore resolved by
  // iteration order, so `config validate` could reject the config keys of the very plugin the
  // runtime activates. Ownership has to follow the declaration in both orders.
  it.each([
    { order: "replacement last", plugins: ["clickclack-core", "clickclack-plus"] },
    { order: "replacement first", plugins: ["clickclack-plus", "clickclack-core"] },
  ])("gives a same-origin replacement the schema when it is listed $order", ({ plugins }) => {
    const byId = {
      "clickclack-core": claimant({ id: "clickclack-core" }),
      "clickclack-plus": claimant({
        id: "clickclack-plus",
        preferOver: ["clickclack-core"],
      }),
    };

    expect(ownerOf(plugins.map((id) => byId[id as keyof typeof byId]))).toBe("clickclack-plus");
  });

  it("reads a replacement declared through channelCatalogMeta", () => {
    const core = claimant({ id: "clickclack-core" });
    const replacement = claimant({
      id: "clickclack-plus",
      catalogPreferOver: ["clickclack-core"],
    });

    expect(ownerOf([replacement, core])).toBe("clickclack-plus");
  });

  // Codex review P2 on #123209: `shouldSkipPreferredPluginAutoEnable` applies a declaration with
  // no origin restriction, so ranking install origin above it would activate the replacement while
  // validating against the plugin it replaced. Order must not decide either.
  it.each([
    { order: "farther first", plugins: ["clickclack-plus", "clickclack-core"] },
    { order: "closer first", plugins: ["clickclack-core", "clickclack-plus"] },
  ])(
    "gives a farther-origin replacement the schema over a closer fallback ($order)",
    ({ plugins }) => {
      const byId = {
        "clickclack-core": claimant({ id: "clickclack-core", origin: "workspace" }),
        "clickclack-plus": claimant({
          id: "clickclack-plus",
          origin: "bundled",
          preferOver: ["clickclack-core"],
        }),
      };

      expect(ownerOf(plugins.map((id) => byId[id as keyof typeof byId]))).toBe("clickclack-plus");
    },
  );

  // Codex review P2 on #123209: auto-enable and the runtime channel facade build claimants from
  // `record.channels`, so a preference declared for a channel the record never claims must not
  // decide that channel's schema.
  it("ignores a preference from a record that does not claim the channel", () => {
    const core = claimant({ id: "clickclack-core" });
    const ghost = {
      ...claimant({
        id: "clickclack-ghost",
        channels: [],
        preferOver: ["clickclack-core"],
      }),
      manifestPath: "/tmp/clickclack-ghost/openclaw.plugin.json",
    };

    expect(ownerOf([ghost, core])).toBe("clickclack-core");
  });

  it("keeps the closer origin when neither claimant declares a replacement", () => {
    const workspace = claimant({ id: "clickclack-core", origin: "workspace" });
    const bundled = claimant({ id: "clickclack-plus", origin: "bundled" });

    // Origin still decides once operator policy and the declaration leave the claimants tied.
    expect(ownerOf([workspace, bundled])).toBe("clickclack-core");
    expect(ownerOf([bundled, workspace])).toBe("clickclack-core");
  });

  // Codex review P1 on #123209: auto-enable ignores a denied or explicitly disabled replacement
  // and activates the fallback, so ownership must too. Both orderings matter — falling through
  // would hand the channel to the disabled plugin as the last writer.
  it.each([
    { order: "replacement last", plugins: ["clickclack-core", "clickclack-plus"] },
    { order: "replacement first", plugins: ["clickclack-plus", "clickclack-core"] },
  ])(
    "leaves the channel with the fallback when the replacement is disabled ($order)",
    ({ plugins }) => {
      const byId = {
        "clickclack-core": claimant({ id: "clickclack-core" }),
        "clickclack-plus": claimant({ id: "clickclack-plus", preferOver: ["clickclack-core"] }),
      };
      const ordered = plugins.map((id) => byId[id as keyof typeof byId]);
      const policy = policyFor({ isPluginActive: (id) => id !== "clickclack-plus" });

      expect(ownerOf(ordered, policy)).toBe("clickclack-core");
    },
  );

  // Codex review P1 on #123209: eligibility was consulted only inside the equal-origin tie-break,
  // so a disabled replacement installed CLOSER than its fallback took the schema through plain
  // origin precedence. Auto-enable activates the fallback there, and validation then rejected the
  // fallback's own config. Operator policy has to outrank install origin in both orderings.
  it.each([
    { order: "fallback first", plugins: ["clickclack-core", "clickclack-plus"] },
    { order: "replacement first", plugins: ["clickclack-plus", "clickclack-core"] },
  ])(
    "leaves the channel with a farther active fallback when the closer replacement is disabled ($order)",
    ({ plugins }) => {
      const byId = {
        "clickclack-core": claimant({ id: "clickclack-core", origin: "bundled" }),
        "clickclack-plus": claimant({
          id: "clickclack-plus",
          origin: "global",
          preferOver: ["clickclack-core"],
        }),
      };
      const ordered = plugins.map((id) => byId[id as keyof typeof byId]);
      const policy = policyFor({ isPluginActive: (id) => id !== "clickclack-plus" });

      expect(ownerOf(ordered, policy)).toBe("clickclack-core");
    },
  );

  // Codex review P2 on #123209: comparing each record only against the current owner let a
  // replacement chain settle by registry order. `shouldSkipPreferredPluginAutoEnable` scans every
  // configured candidate, so it drops both B and C and leaves A active.
  it.each([
    { order: "A, C, B", plugins: ["chain-a", "chain-c", "chain-b"] },
    { order: "B, A, C", plugins: ["chain-b", "chain-a", "chain-c"] },
    { order: "C, B, A", plugins: ["chain-c", "chain-b", "chain-a"] },
  ])(
    "resolves an A-replaces-B-replaces-C chain the same way in any order ($order)",
    ({ plugins }) => {
      const byId = {
        "chain-a": claimant({ id: "chain-a", preferOver: ["chain-b"] }),
        "chain-b": claimant({ id: "chain-b", preferOver: ["chain-c"] }),
        "chain-c": claimant({ id: "chain-c" }),
      };

      expect(ownerOf(plugins.map((id) => byId[id as keyof typeof byId]))).toBe("chain-a");
    },
  );

  // Codex review P2 on #123209: the activity guard keeps the fallback's schema, but the
  // presentation pass ran first and only skipped SAME-origin non-owners, so a closer disabled
  // replacement still branded the channel. Config UI then showed the disabled plugin's name above
  // the active fallback's fields.
  it("keeps the active fallback's label when a closer replacement is disabled", () => {
    const core = {
      ...claimant({ id: "clickclack-core", origin: "bundled" }),
      channelCatalogMeta: { id: "clickclack", label: "ClickClack", blurb: "the active one" },
    };
    const replacement = {
      ...claimant({
        id: "clickclack-plus",
        origin: "global",
        preferOver: ["clickclack-core"],
      }),
      channelCatalogMeta: { id: "clickclack", label: "ClickClack Plus", blurb: "the disabled one" },
    };
    const policy = policyFor({ isPluginActive: (id) => id !== "clickclack-plus" });

    const entry = entryFor(
      [core, replacement] as unknown as ReturnType<typeof claimant>[],
      "clickclack",
      policy,
    );

    expect(entry?.schemaPluginId).toBe("clickclack-core");
    expect(entry?.label).toBe("ClickClack");
    expect(entry?.description).toBe("the active one");
  });

  // Codex review P2 on #123209: two claimants that each declare the other were both marked
  // displaced, so the tie fell through to the later claimant in registry order — while
  // auto-enable settles the same pair by candidate processing order. Distinct strict schemas then
  // let source validation select one plugin and startup serve the other. A mutual pair is set
  // aside like a suppressed declaration: neither is displaced, both claimants stay active, and
  // the schema stays with the first claimant, matching the runtime facade's first registrant.
  it("keeps the first claimant when two claimants declare each other", () => {
    const first = claimant({ id: "clickclack-plus", preferOver: ["clickclack-core"] });
    const second = claimant({ id: "clickclack-core", preferOver: ["clickclack-plus"] });

    expect(ownerOf([first, second])).toBe("clickclack-plus");
  });

  // Codex review on #123209: a ring longer than two — a names b, b names c, c names a — satisfies
  // the reciprocal test in neither direction, so every member was displaced and the tie fell to
  // the last claimant in registry order, while auto-enable settled the same ring by candidate
  // processing order. A cycle settles nothing whatever its length: every member stays active and
  // the schema follows the first claimant, matching the runtime facade's first registrant.
  it.each([
    { order: ["clickclack-a", "clickclack-b", "clickclack-c"], owner: "clickclack-a" },
    { order: ["clickclack-c", "clickclack-b", "clickclack-a"], owner: "clickclack-c" },
  ])("keeps the first claimant of a three-member ring ($order)", ({ order, owner }) => {
    const byId = {
      "clickclack-a": claimant({ id: "clickclack-a", preferOver: ["clickclack-b"] }),
      "clickclack-b": claimant({ id: "clickclack-b", preferOver: ["clickclack-c"] }),
      "clickclack-c": claimant({ id: "clickclack-c", preferOver: ["clickclack-a"] }),
    };

    expect(ownerOf(order.map((id) => byId[id as keyof typeof byId]))).toBe(owner);
  });

  // The four-member ring is where per-edge reasoning breaks down entirely: a and c sit on the
  // ring together yet share no declared edge. If only declared pairs were set aside, the (a, c)
  // comparison would fall through to last-writer and hand c the channel. Opposite corners must
  // tie-break exactly like the mutual pair, so the whole component is set aside pairwise.
  it("keeps the first claimant of a four-member ring", () => {
    const ring = [
      claimant({ id: "clickclack-a", preferOver: ["clickclack-b"] }),
      claimant({ id: "clickclack-b", preferOver: ["clickclack-c"] }),
      claimant({ id: "clickclack-c", preferOver: ["clickclack-d"] }),
      claimant({ id: "clickclack-d", preferOver: ["clickclack-a"] }),
    ];

    expect(ownerOf(ring)).toBe("clickclack-a");
  });

  // Codex review P2 on #123209: a manifest that names itself declares nothing. Candidate discovery
  // skips the self comparison, so a self-edge would strand ownership on another claimant while the
  // self-naming plugin stays active.
  it("ignores a claimant that declares itself in preferOver", () => {
    const core = claimant({ id: "clickclack-core" });
    const confused = claimant({ id: "clickclack-plus", preferOver: ["clickclack-plus"] });

    expect(ownerOf([confused, core])).toBe("clickclack-core");
    expect(ownerOf([core, confused])).toBe("clickclack-plus");
  });

  // Codex review P2 on #123209: auto-enable leaves an explicitly selected plugin enabled even when
  // another claimant declares it in `preferOver`, so both stay active and the runtime channel
  // facade falls back to registration order. Ownership must stop applying the declaration.
  // Registration order is first-wins: `registry-registrars-network.ts` rejects the later claimant
  // (`channel already registered`) and the first registrant keeps serving the channel, so the
  // schema follows the first claimant in both orders. Falling through to last-writer instead
  // validated against a schema belonging to a plugin the runtime never gave the channel to.
  it("keeps the first claimant when the declaration names an explicitly selected plugin", () => {
    const core = claimant({ id: "clickclack-core" });
    const replacement = claimant({ id: "clickclack-plus", preferOver: ["clickclack-core"] });
    const policy = policyFor({
      isPluginExplicitlySelected: (id) => id === "clickclack-core",
    });

    expect(ownerOf([core, replacement], policy)).toBe("clickclack-core");
    expect(ownerOf([replacement, core], policy)).toBe("clickclack-plus");
  });

  // A suppressed declaration can cross origins: the operator hand-picks a workspace fallback
  // while a farther bundled replacement declares it in `preferOver`. Both stay active, and the
  // runtime facade keeps the first registrant no matter whose origin sits closer, so the schema
  // follows the first claimant in both orders. Letting origin rank decide instead validated
  // against the closer plugin's schema in exactly the order where the runtime kept the farther one.
  it("keeps the first claimant when a suppressed declaration crosses origins", () => {
    const core = claimant({ id: "clickclack-core", origin: "workspace" });
    const replacement = claimant({
      id: "clickclack-plus",
      origin: "bundled",
      preferOver: ["clickclack-core"],
    });
    const policy = policyFor({
      isPluginExplicitlySelected: (id) => id === "clickclack-core",
    });

    expect(ownerOf([replacement, core], policy)).toBe("clickclack-plus");
    expect(ownerOf([core, replacement], policy)).toBe("clickclack-core");
  });

  // Codex review P2 on #123209: once the declaration crosses origins the presentation pass has to
  // follow it too, or a closer active fallback relabels a channel whose schema stays with the
  // farther replacement and the config UI shows fallback branding over replacement fields.
  it("keeps the cross-origin replacement's label when the fallback is visited later", () => {
    const replacement = {
      ...claimant({ id: "clickclack-plus", origin: "bundled", preferOver: ["clickclack-core"] }),
      channelCatalogMeta: { id: "clickclack", label: "ClickClack Plus", blurb: "the replacement" },
    };
    const core = {
      ...claimant({ id: "clickclack-core", origin: "workspace" }),
      channelCatalogMeta: { id: "clickclack", label: "ClickClack", blurb: "the fallback" },
    };

    const entry = entryFor(
      [replacement, core] as unknown as ReturnType<typeof claimant>[],
      "clickclack",
    );

    expect(entry?.schemaPluginId).toBe("clickclack-plus");
    expect(entry?.label).toBe("ClickClack Plus");
    expect(entry?.description).toBe("the replacement");
  });

  // Codex review P2 on #123209: with plugins switched off globally every claimant is inactive, so
  // dropping every declaration would leave registry order picking a winner. Nothing activates in
  // that state, so ownership answers what the operator would get once plugins come back.
  it.each([
    { order: "replacement last", plugins: ["clickclack-core", "clickclack-plus"] },
    { order: "replacement first", plugins: ["clickclack-plus", "clickclack-core"] },
  ])("still follows the declaration when no claimant is active ($order)", ({ plugins }) => {
    const byId = {
      "clickclack-core": claimant({ id: "clickclack-core" }),
      "clickclack-plus": claimant({ id: "clickclack-plus", preferOver: ["clickclack-core"] }),
    };
    const policy = policyFor({ isPluginActive: () => false });

    expect(
      ownerOf(
        plugins.map((id) => byId[id as keyof typeof byId]),
        policy,
      ),
    ).toBe("clickclack-plus");
  });

  // Codex review P2 on #123209: auto-enable falls back to the built-in channel registration and an
  // external plugin catalog when the manifest declares no preference. Ownership has to read the
  // same resolved facts or the two disagree for catalog-declared replacements.
  it("honors a replacement preference that comes from outside the manifest", () => {
    const core = claimant({ id: "clickclack-core" });
    const replacement = claimant({ id: "clickclack-plus" });
    const policy = policyFor({
      resolveChannelPreferOverIds: (record) =>
        record.id === "clickclack-plus" ? ["clickclack-core"] : [],
    });

    expect(ownerOf([replacement, core], policy)).toBe("clickclack-plus");
    expect(ownerOf([core, replacement], policy)).toBe("clickclack-plus");
  });

  // Codex review P2 on #123209: channelCatalogMeta describes exactly one channel, so its
  // preference must not let the plugin claim a different channel it also ships.
  it("does not apply a catalog preference to the plugin's other channels", () => {
    const core = {
      id: "multi-core",
      origin: "global",
      channels: ["otherchat"],
      channelConfigs: { otherchat: { schema: { type: "object", additionalProperties: true } } },
    };
    const wideClaimant = {
      id: "multi-plus",
      origin: "global",
      channels: ["clickclack", "otherchat"],
      // The preference is declared for clickclack only.
      channelCatalogMeta: { id: "clickclack", preferOver: ["multi-core"] },
      channelConfigs: { otherchat: { schema: { type: "object", additionalProperties: true } } },
    };

    const owner = entryFor(
      [wideClaimant, core] as unknown as ReturnType<typeof claimant>[],
      "otherchat",
    )?.schemaPluginId;

    expect(owner).toBe("multi-core");
  });

  // Codex review P2 on #123209: the losing record's `channels` pass ran before the schema was
  // settled, so it could relabel a channel whose schema stayed with the replacement.
  it("keeps the schema owner's label and description", () => {
    const core = {
      ...claimant({ id: "clickclack-core" }),
      channelCatalogMeta: { id: "clickclack", label: "Legacy ClickClack", blurb: "the old one" },
    };
    const replacement = {
      ...claimant({ id: "clickclack-plus", preferOver: ["clickclack-core"] }),
      channelCatalogMeta: { id: "clickclack", label: "ClickClack Plus", blurb: "the replacement" },
    };

    const entry = entryFor([replacement, core] as unknown as ReturnType<typeof claimant>[]);

    expect(entry?.schemaPluginId).toBe("clickclack-plus");
    expect(entry?.label).toBe("ClickClack Plus");
    expect(entry?.description).toBe("the replacement");
  });

  it("leaves undeclared same-origin claimants on the existing last-writer behavior", () => {
    const first = claimant({ id: "clickclack-core" });
    const second = claimant({ id: "clickclack-plus" });

    expect(ownerOf([first, second])).toBe("clickclack-plus");
    expect(ownerOf([second, first])).toBe("clickclack-core");
  });
});

// The loader consumes this displacement graph to decide which claimants cede a channel, so the
// runtime plane must read a ring exactly as the schema plane does: no member displaces any other,
// every member registers, and the first registrant keeps the channel. Displacing all of them
// instead silently disabled every ring member but the auto-enable survivor.
describe("collectRuntimeDisplacedChannelOwners on preference rings", () => {
  function displacedFor(plugins: ReturnType<typeof claimant>[]) {
    const registry = { plugins, diagnostics: [] } as unknown as PluginManifestRegistry;
    return collectRuntimeDisplacedChannelOwners(registry, policyFor({}));
  }

  const ringOfThree = () => [
    claimant({ id: "clickclack-a", preferOver: ["clickclack-b"] }),
    claimant({ id: "clickclack-b", preferOver: ["clickclack-c"] }),
    claimant({ id: "clickclack-c", preferOver: ["clickclack-a"] }),
  ];

  it.each([
    { length: "three", plugins: ringOfThree() },
    {
      length: "four",
      plugins: [
        claimant({ id: "clickclack-a", preferOver: ["clickclack-b"] }),
        claimant({ id: "clickclack-b", preferOver: ["clickclack-c"] }),
        claimant({ id: "clickclack-c", preferOver: ["clickclack-d"] }),
        claimant({ id: "clickclack-d", preferOver: ["clickclack-a"] }),
      ],
    },
  ])("displaces nobody on a $length-member ring", ({ plugins }) => {
    expect(displacedFor(plugins).get("clickclack")).toBeUndefined();
  });

  // The stand-off is the ring's alone. A fourth claimant outside it still applies its declaration
  // against a ring member — and only that member is displaced, never the whole ring.
  it("still applies an outside claimant's edge into a ring", () => {
    const plugins = [
      ...ringOfThree(),
      claimant({ id: "clickclack-z", preferOver: ["clickclack-a"] }),
    ];

    expect([...(displacedFor(plugins).get("clickclack") ?? [])]).toEqual(["clickclack-a"]);
  });
});

// Codex review P1 on #123209: ownership decides on `normalizeClaimedChannelId`, but the metadata
// and redaction maps were keyed by the spelling the manifest declared. A claimant spelling the
// channel differently landed in its own bucket, so a field only it marked sensitive carried no
// hint on the canonical path that redaction reads.
describe("channel id canonicalization", () => {
  it("collects a differently-spelled channel claim onto the canonical entry", () => {
    const plugins = [
      {
        id: "fallback",
        origin: "global",
        channels: ["clickclack"],
        channelConfigs: {
          Clickclack: {
            schema: { type: "object", additionalProperties: true },
            uiHints: { token: { sensitive: true } },
          },
        },
      },
    ];
    const registry = { plugins, diagnostics: [] } as unknown as PluginManifestRegistry;

    const entries = collectChannelSchemaMetadataWithOwnership(registry);

    expect(entries.map((entry) => entry.id)).toEqual(["clickclack"]);
    expect(entries[0]?.configUiHints?.token?.sensitive).toBe(true);
  });
});

// Codex review P1 on #123209: auto-enable disables the middle of an A-replaces-B-replaces-C chain,
// so ownership saw B active while validating the source config and inactive afterwards. Dropping
// B's edge to C in the second view left A and C to origin rank, and a closer C won there — the
// config was validated against A's strict schema while the runtime resolved to C.
describe("replacement chains across the materialization boundary", () => {
  function chainClaimant(id: string, origin: string, preferOver?: string[]) {
    return {
      id,
      origin,
      channels: ["clickclack"],
      channelConfigs: {
        clickclack: {
          schema: { type: "object", additionalProperties: true },
          ...(preferOver ? { preferOver } : {}),
        },
      },
    };
  }

  const byId: Record<string, ReturnType<typeof chainClaimant>> = {
    // C sits closer to the operator than A, so origin rank alone would prefer it.
    "chain-a": chainClaimant("chain-a", "global", ["chain-b"]),
    "chain-b": chainClaimant("chain-b", "global", ["chain-c"]),
    "chain-c": chainClaimant("chain-c", "config"),
  };

  it.each([
    { view: "source config, every claimant active", inactive: undefined },
    { view: "materialized config, chain-b disabled", inactive: "chain-b" },
  ])("resolves to chain-a under the $view", ({ inactive }) => {
    const registry = {
      plugins: ["chain-c", "chain-b", "chain-a"].map((id) => byId[id]),
      diagnostics: [],
    } as unknown as PluginManifestRegistry;

    const owner = collectChannelSchemaMetadataWithOwnership(
      registry,
      policyFor({ isPluginActive: (pluginId: string) => pluginId !== inactive }),
    ).find((entry) => entry.id === "clickclack")?.schemaPluginId;

    expect(owner).toBe("chain-a");
  });

  // Codex review P1 on #123209: a displaced claimant keeps declaring so both views close the chain
  // the same way, but that re-add must not resurrect a plugin the operator switched off.
  // `shouldSkipPreferredPluginAutoEnable` skips a disabled declarant, and the loader refuses to let
  // chain-c register if this graph says it was displaced — so chain-a would take a channel whose
  // only preference link was a plugin that is not running.
  it("does not apply the outgoing edge of an operator-disabled middle claimant", () => {
    const registry = {
      plugins: ["chain-c", "chain-b", "chain-a"].map((id) => byId[id]),
      diagnostics: [],
    } as unknown as PluginManifestRegistry;

    const owner = collectChannelSchemaMetadataWithOwnership(
      registry,
      policyFor({
        isPluginActive: (pluginId: string) => pluginId !== "chain-b",
        isPluginPolicyDisabled: (pluginId: string) => pluginId === "chain-b",
      }),
    ).find((entry) => entry.id === "clickclack")?.schemaPluginId;

    // chain-c is never displaced, and it sits closest to the operator.
    expect(owner).toBe("chain-c");
  });
});

// A catalog-preferred replacement can claim a channel while shipping no `channelConfigs`
// descriptor of its own. Counting schema descriptors left such a channel out of displacement —
// one descriptor is no contest — and the descriptor walk then installed the displaced fallback's
// strict schema because no owner existed yet. Validation and the Control UI enforced the
// fallback's `additionalProperties: false` schema against a channel the loader cedes to the
// replacement, rejecting every key the replacement accepts. The contest counts claimants like the
// runtime plane, and a displaced claimant may not seed the schema while the active winner serves
// the channel: with no descriptor from the winner the channel stays permissive.
describe("replacements that ship no descriptor", () => {
  const fallback = () => ({
    id: "zz-fallback",
    origin: "global",
    channels: ["zzalpha"],
    channelConfigs: {
      zzalpha: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { fallbackToken: { type: "string" } },
        },
      },
    },
  });
  const replacement = () => ({
    id: "zz-replacement",
    origin: "global",
    channels: ["zzalpha"],
    channelCatalogMeta: { id: "zzalpha", preferOver: ["zz-fallback"] },
  });

  it.each([
    { order: "fallback first", plugins: () => [fallback(), replacement()] },
    { order: "replacement first", plugins: () => [replacement(), fallback()] },
  ])("drops the displaced fallback's schema on the ceded channel ($order)", ({ plugins }) => {
    const registry = {
      plugins: plugins(),
      diagnostics: [],
    } as unknown as PluginManifestRegistry;

    const entry = collectChannelSchemaMetadataWithOwnership(registry).find(
      (candidate) => candidate.id === "zzalpha",
    );

    expect(entry).toBeDefined();
    expect(entry?.schemaPluginId).toBeUndefined();
    expect(entry?.configSchema).toBeUndefined();
  });

  // The gate must not fire without an active, non-displaced winner. Only the all-inactive state
  // reaches its guard: a replacement that is merely disabled never declares, so the fallback is
  // not displaced and the gate's first condition already fails. With every claimant inactive the
  // declarations are read from the whole claimant set — the fallback IS displaced — but nothing
  // outranks its descriptor at runtime, so the schema must stay with the fallback.
  it("keeps the displaced fallback's schema when no claimant is active", () => {
    const registry = {
      plugins: [fallback(), replacement()],
      diagnostics: [],
    } as unknown as PluginManifestRegistry;
    const policy = policyFor({ isPluginActive: () => false });

    const entry = collectChannelSchemaMetadataWithOwnership(registry, policy).find(
      (candidate) => candidate.id === "zzalpha",
    );

    expect(entry?.schemaPluginId).toBe("zz-fallback");
  });
});

// The descriptor walk read `channelConfigs` regardless of `record.channels`, even though the
// manifest contract says `channels` declares ownership. While a channel is unconfigured no
// candidate set exists, every claimant counts as active, and a closer-origin non-claimant won
// the schema. The Control UI then offered its fields; saving one made the channel configured,
// candidates narrowed to records that actually claim it, ownership flipped to the real claimant,
// and its strict schema rejected the exact field the UI had just offered.
describe("descriptors from records that do not claim the channel", () => {
  function schemaPropertyKeys(entry: { configSchema?: Record<string, unknown> } | undefined) {
    const properties = entry?.configSchema?.properties;
    return Object.keys((properties as Record<string, unknown> | undefined) ?? {});
  }

  const claimantRecord = () => ({
    id: "zz-claimant",
    origin: "bundled",
    channels: ["zzalpha"],
    channelConfigs: {
      zzalpha: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { realKey: { type: "string" } },
        },
      },
    },
  });
  const ghostRecord = () => ({
    id: "zz-ghost",
    origin: "config",
    channels: ["zzother"],
    manifestPath: "/tmp/zz-ghost/openclaw.plugin.json",
    channelConfigs: {
      zzalpha: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ghostKey: { type: "string" } },
        },
      },
      zzother: {
        schema: { type: "object", additionalProperties: true },
      },
    },
  });

  it("drops the non-claimant's descriptor and reports it once", () => {
    const registry = {
      plugins: [claimantRecord(), ghostRecord()],
      diagnostics: [],
    } as unknown as PluginManifestRegistry;

    // The collector runs repeatedly against one registry; the drop must not accumulate.
    collectChannelSchemaMetadataWithOwnership(registry);
    const entry = collectChannelSchemaMetadataWithOwnership(registry).find(
      (candidate) => candidate.id === "zzalpha",
    );

    expect(entry?.schemaPluginId).toBe("zz-claimant");
    expect(schemaPropertyKeys(entry)).toContain("realKey");
    const dropped = registry.diagnostics.filter((diagnostic) => diagnostic.pluginId === "zz-ghost");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe("warn");
    expect(dropped[0]?.message).toContain("zzalpha");
    // The claimed channel's own descriptor still lands.
    const other = collectChannelSchemaMetadataWithOwnership(registry).find(
      (candidate) => candidate.id === "zzother",
    );
    expect(other?.schemaPluginId).toBe("zz-ghost");
  });

  it("offers no field the post-save owner rejects across the configure flip", () => {
    const registry = () =>
      ({
        plugins: [claimantRecord(), ghostRecord()],
        diagnostics: [],
      }) as unknown as PluginManifestRegistry;
    // Unconfigured channel: no candidate set exists yet, so every claimant counts as active.
    const offered = collectChannelSchemaMetadataWithOwnership(
      registry(),
      policyFor({ isPluginActive: () => true }),
    ).find((candidate) => candidate.id === "zzalpha");
    // The operator saves a field the surfaced schema offered; zzalpha becomes configured and
    // candidates narrow to records that claim it, so the non-claimant goes inactive there.
    const saved = collectChannelSchemaMetadataWithOwnership(
      registry(),
      policyFor({
        isPluginActive: (pluginId, channelId) =>
          channelId !== "zzalpha" || pluginId === "zz-claimant",
      }),
    ).find((candidate) => candidate.id === "zzalpha");

    // Ownership must not flip on save: whatever fields the UI offered before the save must still
    // be accepted by the owner enforced after it.
    expect(offered?.schemaPluginId).toBe("zz-claimant");
    expect(saved?.schemaPluginId).toBe("zz-claimant");
    const offeredKeys = schemaPropertyKeys(offered);
    const savedKeys = schemaPropertyKeys(saved);
    expect(offeredKeys).toContain("realKey");
    expect(offeredKeys).not.toContain("ghostKey");
    expect(savedKeys).toEqual(expect.arrayContaining(offeredKeys));
  });
});
