/** Covers which plugin owns a channel's surfaced config schema when several claim the same id. */
import { describe, expect, it } from "vitest";
import { resolveManifestChannelPreferOverIds } from "../plugins/manifest-channel-preference.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadataWithOwnership,
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
    const ghost = claimant({
      id: "clickclack-ghost",
      channels: [],
      preferOver: ["clickclack-core"],
    });

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
