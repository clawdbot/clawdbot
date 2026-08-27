/** Covers which plugins cede a contested channel, and to whom, before any runtime load. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectCededChannelIdsByPlugin } from "./channel-cede-planning.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { defaultSlotIdForKey } from "./slots.js";

const manifestRecord = {
  id: "example",
  channels: [],
  providers: [],
  cliBackends: [],
  skills: [],
  hooks: [],
  origin: "global",
  rootDir: "/plugins/example",
  source: "/plugins/example/index.js",
  manifestPath: "/plugins/example/openclaw.plugin.json",
} satisfies PluginManifestRecord;

describe("collectCededChannelIdsByPlugin", () => {
  function ringClaimant(id: string, preferOver?: string[]): PluginManifestRecord {
    return {
      ...manifestRecord,
      id,
      rootDir: `/plugins/${id}`,
      source: `/plugins/${id}/index.js`,
      manifestPath: `/plugins/${id}/openclaw.plugin.json`,
      channels: ["zzalpha"],
      channelConfigs: {
        zzalpha: {
          schema: { type: "object" },
          ...(preferOver ? { preferOver } : {}),
        },
      },
    };
  }

  function cededFor(plugins: PluginManifestRecord[], extraConfig?: Record<string, unknown>) {
    const config = {
      channels: { zzalpha: { token: "alpha" } },
      ...extraConfig,
    } as unknown as OpenClawConfig;
    return collectCededChannelIdsByPlugin({
      registry: { plugins, diagnostics: [] } as unknown as PluginManifestRegistry,
      config,
      sourceConfig: config,
      env: {},
      onlyPluginIdSet: null,
      dreamingSidecar: null,
    });
  }

  // Commit 6e5113c6742's invariant: members of a preferOver cycle settle nothing — no member
  // displaces another, all members register, and the first registrant keeps the channel. The cede
  // rule hands the channel to the winner and cedes every other active claimant, so a ring member
  // suppressed with the winner must be exempt: ceding it would displace a claimant the stand-off
  // says nobody displaces. The outside claimant's edge into the ring is what puts the channel in
  // the displaced set at all — a pure ring displaces nobody and the loop never reaches it.
  it("exempts a ring member suppressed with the winner from the cede", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-ring-a", ["zz-ring-b"]),
      ringClaimant("zz-ring-b", ["zz-ring-c"]),
      ringClaimant("zz-ring-c", ["zz-ring-a"]),
      ringClaimant("zz-outside", ["zz-ring-a"]),
    ]);

    // The outside edge displaces only zz-ring-a; the survivors settle on the first registrant.
    expect(cededChannelOwners.get("zzalpha")).toBe("zz-ring-b");
    expect(cededChannelIdsByPlugin.get("zz-ring-a")).toEqual(["zzalpha"]);
    // Not the winner, but suppressed with it: zz-ring-c keeps registering so the facade's
    // first-registrant rule — not a cede — settles the surviving ring.
    expect(cededChannelIdsByPlugin.has("zz-ring-c")).toBe(false);
    // An active claimant outside the suppressed component cedes to the winner.
    expect(cededChannelIdsByPlugin.get("zz-outside")).toEqual(["zzalpha"]);
  });

  function memoryClaimant(id: string, preferOver?: string[]): PluginManifestRecord {
    return { ...ringClaimant(id, preferOver), kind: ["memory"] } as PluginManifestRecord;
  }

  // Codex P2 3875710886 / 3875920566 / 3876244165 / 3876244172, all one defect. These four
  // reports circled a guard built on a false premise: that an UNSET `plugins.slots.memory` hands
  // the slot to whichever single-kind memory plugin the load reaches first. It does not.
  // `normalizePluginsConfigWithResolverCore` resolves the slot through `resolveSlotSelection`
  // before the loader ever asks, and an unset slot there means the DEFAULT memory plugin, not "no
  // constraint" -- so the outcome is decided by config, and the `selectedId` arm the guard was
  // written against is unreachable from every normalized call site. The guard is gone; what
  // replaces it is the ownership policy reading the slot the same way the loader does.
  it("declines the cede to a memory plugin the unset slot leaves disabled", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-plain-early"),
      memoryClaimant("zz-mem-solo", ["zz-plain-early"]),
    ]);

    // The unset slot belongs to the default memory plugin, so zz-mem-solo never registers.
    // Crowning it would cede zz-plain-early to a winner the load switches off, and leave the
    // configured channel with no runtime owner at all.
    expect(cededChannelOwners.has("zzalpha")).toBe(false);
    expect(cededChannelIdsByPlugin.has("zz-plain-early")).toBe(false);
  });

  // The other half of "unset means the default owner": the default memory plugin is SELECTED by
  // an unset slot, not held back by it. Reading unset as "slot off" would decline this cede too,
  // and would disable memory for every operator who never configured a slot.
  it("cedes to the default memory plugin when the slot is unset", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-plain-early"),
      memoryClaimant(defaultSlotIdForKey("memory"), ["zz-plain-early"]),
    ]);

    expect(cededChannelOwners.get("zzalpha")).toBe(defaultSlotIdForKey("memory"));
    expect(cededChannelIdsByPlugin.get("zz-plain-early")).toEqual(["zzalpha"]);
  });

  it("cedes to a memory plugin the configured slot selects", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor(
      [ringClaimant("zz-plain-early"), memoryClaimant("zz-mem-solo", ["zz-plain-early"])],
      { plugins: { slots: { memory: "zz-mem-solo" } } },
    );

    expect(cededChannelOwners.get("zzalpha")).toBe("zz-mem-solo");
    expect(cededChannelIdsByPlugin.get("zz-plain-early")).toEqual(["zzalpha"]);
  });

  // The loader compares the TRIMMED slot: `resolveSlotSelection` runs `normalizeOptionalString`
  // first. Comparing the authored spelling instead rejected a plugin the loader selects.
  it("selects the memory slot owner the way the loader does, whitespace and all", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor(
      [ringClaimant("zz-plain-early"), memoryClaimant("zz-mem-solo", ["zz-plain-early"])],
      { plugins: { slots: { memory: "  zz-mem-solo  " } } },
    );

    expect(cededChannelOwners.get("zzalpha")).toBe("zz-mem-solo");
    expect(cededChannelIdsByPlugin.get("zz-plain-early")).toEqual(["zzalpha"]);
  });

  // "none" is the only spelling that turns the slot off, and it disables every single-kind memory
  // plugin -- including one that would otherwise win a channel by declaration.
  it("declines the cede when the memory slot is turned off", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor(
      [ringClaimant("zz-plain-early"), memoryClaimant("zz-mem-solo", ["zz-plain-early"])],
      { plugins: { slots: { memory: "none" } } },
    );

    expect(cededChannelOwners.has("zzalpha")).toBe(false);
    expect(cededChannelIdsByPlugin.has("zz-plain-early")).toBe(false);
  });

  // Codex P2 3876090875, the mirror of the singleton namesake fix. A declaration only entitles its
  // claimants to the channel while the DECLARANT can actually load: a disabled one, or one outside
  // a scoped load, never registers, so enforcing its declaration turns an enabled namesake away
  // and leaves the channel with no owner at all.
  it("drops a declaration whose only declarant cannot participate in this load", () => {
    const { declaredChannelClaimants } = cededFor([ringClaimant("zz-decl-off", ["zzalpha"])], {
      plugins: { entries: { "zz-decl-off": { enabled: false } } },
    });

    expect(declaredChannelClaimants.has("zzalpha")).toBe(false);
  });

  // The guard must survive for a declarant that DOES load, or the singleton namesake fix is undone.
  it("keeps the declaration when its only declarant loads", () => {
    const { declaredChannelClaimants } = cededFor([ringClaimant("zz-decl-on", ["zzalpha"])]);

    expect(declaredChannelClaimants.get("zzalpha")).toEqual(["zz-decl-on"]);
  });

  // The P1 shape (comment 3840887960): two independent declarations leave two active,
  // undisplaced claimants, and ceding only the displaced ids let registration order pick between
  // them while schema ownership named its one winner. Every active non-winner cedes.
  it("cedes the second independent declarer, not only the displaced ids", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-pair-a", ["zz-pair-b"]),
      ringClaimant("zz-pair-b"),
      ringClaimant("zz-pair-c", ["zz-pair-d"]),
      ringClaimant("zz-pair-d"),
    ]);

    expect(cededChannelOwners.get("zzalpha")).toBe("zz-pair-a");
    expect(cededChannelIdsByPlugin.get("zz-pair-b")).toEqual(["zzalpha"]);
    expect(cededChannelIdsByPlugin.get("zz-pair-c")).toEqual(["zzalpha"]);
    expect(cededChannelIdsByPlugin.get("zz-pair-d")).toEqual(["zzalpha"]);
    expect(cededChannelIdsByPlugin.has("zz-pair-a")).toBe(false);
  });
});
