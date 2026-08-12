// Verifies canonical configured open-inbound policy discovery for all audit consumers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listConfiguredOpenInboundPolicyPaths,
  resolveConfiguredChannelDmAllowFromModes,
} from "./audit-open-inbound.js";

const listChannelCatalogEntriesMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/channel-catalog-registry.js", () => ({
  listChannelCatalogEntries: listChannelCatalogEntriesMock,
}));

describe("configured open inbound policy paths", () => {
  beforeEach(() => {
    listChannelCatalogEntriesMock.mockReset();
  });

  it("uses closest-origin metadata and lets equal origins replace stale entries", () => {
    listChannelCatalogEntriesMock.mockReturnValue([
      {
        origin: "bundled",
        channel: { id: "matrix", doctorCapabilities: { dmAllowFromMode: "topOnly" } },
      },
      {
        origin: "config",
        channel: {
          id: "matrix",
          aliases: ["matrix-alt"],
          doctorCapabilities: { dmAllowFromMode: "topOnly" },
        },
      },
      {
        origin: "config",
        channel: {
          id: "matrix",
          aliases: ["matrix-alt"],
          doctorCapabilities: { dmAllowFromMode: "nestedOnly" },
        },
      },
    ]);

    expect(resolveConfiguredChannelDmAllowFromModes({})).toEqual(
      new Map([
        ["matrix", "nestedOnly"],
        ["matrix-alt", "nestedOnly"],
      ]),
    );
  });

  it("surfaces channel metadata discovery failures", () => {
    listChannelCatalogEntriesMock.mockImplementation(() => {
      throw new Error("catalog unavailable");
    });

    expect(() => resolveConfiguredChannelDmAllowFromModes({})).toThrow("catalog unavailable");
  });

  it("resolves account, legacy DM, precedence, and nested channel scopes", () => {
    const cfg = {
      channels: {
        discord: {
          dmPolicy: "allowlist",
          dm: { policy: "open" },
          accounts: {
            work: { groupPolicy: "open", dm: { policy: "open" } },
            dm: { policy: "custom", groupPolicy: "open" },
          },
        },
        matrix: {
          accounts: {
            work: { dmPolicy: "allowlist", dm: { policy: "open" } },
          },
        },
        modelByChannel: {
          discord: { groupPolicy: "open" },
        },
        telegram: {
          groupPolicy: "allowlist",
          groups: { "-10042": { groupPolicy: "open" } },
          direct: { alice: { dmPolicy: "open" } },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      listConfiguredOpenInboundPolicyPaths(cfg, {
        dmAllowFromModes: new Map([
          ["discord", "topOnly"],
          ["matrix", "nestedOnly"],
          ["telegram", "topOnly"],
        ]),
      }),
    ).toEqual([
      "channels.discord.accounts.dm.groupPolicy",
      "channels.discord.accounts.work.dm.policy",
      "channels.discord.accounts.work.groupPolicy",
      "channels.matrix.accounts.work.dm.policy",
      "channels.telegram.direct.alice.dmPolicy",
      "channels.telegram.groups.-10042.groupPolicy",
    ]);
  });
});
