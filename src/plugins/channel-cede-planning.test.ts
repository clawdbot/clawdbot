/** Covers which plugins cede a contested channel, and to whom, before any runtime load. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectCededChannelIdsByPlugin } from "./channel-cede-planning.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";

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

  // Codex P2 3875710886. With `plugins.slots.memory` UNSET, the runtime slot goes to whichever
  // single-kind memory plugin the load reaches first, and every later one is disabled by the
  // `selectedId` arm of `resolveMemorySlotDecision` before it registers. Crowning a later declarer
  // therefore cedes the earlier claimant to a winner the load then switches off, and the
  // configured channel is left with no owner at all. No static policy can predict that order, so
  // the cede is declined rather than guessed.
  it("declines the cede when an unset memory slot decides the winner by load order", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      memoryClaimant("zz-mem-early"),
      memoryClaimant("zz-mem-late", ["zz-mem-early"]),
    ]);

    expect(cededChannelOwners.has("zzalpha")).toBe(false);
    expect(cededChannelIdsByPlugin.has("zz-mem-early")).toBe(false);
  });

  // The contest is only order-dependent while two single-kind memory plugins compete for the slot.
  // A lone memory claimant always wins it, so its declaration must still cede normally.
  it("still cedes when only one claimant competes for the memory slot", () => {
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor([
      ringClaimant("zz-plain-early"),
      memoryClaimant("zz-mem-solo", ["zz-plain-early"]),
    ]);

    expect(cededChannelOwners.get("zzalpha")).toBe("zz-mem-solo");
    expect(cededChannelIdsByPlugin.get("zz-plain-early")).toEqual(["zzalpha"]);
  });

  // Codex P2 3875920566, on the guard above. The contention set counted every single-kind memory
  // plugin in the REGISTRY, so an unrelated one the operator disabled -- which can never take the
  // slot -- made the contest look order-dependent and declined a cede that was in fact
  // deterministic, leaving the earlier claimant serving a channel schema ownership had moved.
  // Contention is only real among plugins that can actually participate in this load.
  it("ignores a policy-disabled memory plugin when judging slot contention", () => {
    const disabledElsewhere = {
      ...memoryClaimant("zz-mem-off"),
      channels: [] as string[],
      channelConfigs: {},
    } as PluginManifestRecord;
    const { cededChannelIdsByPlugin, cededChannelOwners } = cededFor(
      [
        ringClaimant("zz-plain-early"),
        memoryClaimant("zz-mem-solo", ["zz-plain-early"]),
        disabledElsewhere,
      ],
      { plugins: { entries: { "zz-mem-off": { enabled: false } } } },
    );

    expect(cededChannelOwners.get("zzalpha")).toBe("zz-mem-solo");
    expect(cededChannelIdsByPlugin.get("zz-plain-early")).toEqual(["zzalpha"]);
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
