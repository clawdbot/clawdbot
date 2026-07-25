import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  listChannelsForTeamWithPageInfo: vi.fn(),
  resolveGraphToken: vi.fn(),
  resolveMSTeamsChannelAllowlist: vi.fn(),
  resolveMSTeamsTeamsConfig: vi.fn(),
  resolveMSTeamsUserAllowlist: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  listChannelsForTeamWithPageInfo: mocks.listChannelsForTeamWithPageInfo,
  resolveGraphToken: mocks.resolveGraphToken,
}));

vi.mock("./resolve-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./resolve-allowlist.js")>();
  return {
    ...actual,
    resolveMSTeamsChannelAllowlist: mocks.resolveMSTeamsChannelAllowlist,
    resolveMSTeamsTeamsConfig: mocks.resolveMSTeamsTeamsConfig,
    resolveMSTeamsUserAllowlist: mocks.resolveMSTeamsUserAllowlist,
  };
});

import {
  assertMSTeamsReadTargetAllowed,
  assertMSTeamsTeamEnumerationAllowed,
} from "./read-policy.js";

const ctx = {
  accountId: "default",
  requesterAccountId: "default",
  toolContext: {},
};

beforeEach(() => {
  mocks.listChannelsForTeamWithPageInfo.mockReset();
  mocks.resolveGraphToken.mockReset();
  mocks.resolveMSTeamsChannelAllowlist.mockReset();
  mocks.resolveMSTeamsTeamsConfig.mockReset();
  mocks.resolveMSTeamsUserAllowlist.mockReset();
  mocks.resolveGraphToken.mockResolvedValue("token");
});

describe("Microsoft Teams read policy", () => {
  it("uses startup-equivalent resolved channel policy for stable action targets", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          teams: {
            Product: {
              channels: {
                Roadmap: { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.resolveMSTeamsTeamsConfig.mockResolvedValue({
      teams: {
        Product: {
          channels: {
            Roadmap: { requireMention: true },
          },
        },
        "11111111-1111-1111-1111-111111111111": {
          channels: {
            "19:roadmap@thread.tacv2": { requireMention: true },
          },
        },
      },
      mapping: [],
      unresolved: [],
    });

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2");
    expect(mocks.resolveMSTeamsTeamsConfig).toHaveBeenCalledWith({
      cfg,
      teamIdMode: "graph",
      teams: cfg.channels?.msteams?.teams,
    });
  });

  it("maps stable Bot Framework team keys to Graph channel targets", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          teams: {
            "19:general@thread.tacv2": {
              channels: {
                "19:roadmap@thread.tacv2": { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.listChannelsForTeamWithPageInfo.mockResolvedValue({
      items: [
        { id: "19:general@thread.tacv2", displayName: "Allgemein" },
        { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
      ],
      truncated: false,
    });

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2");
    expect(mocks.listChannelsForTeamWithPageInfo).toHaveBeenCalledWith(
      "token",
      "11111111-1111-1111-1111-111111111111",
    );
  });

  it("rejects an ambiguous Bot Framework team mapping", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          teams: {
            "19:general@thread.tacv2": {
              channels: {
                "19:roadmap@thread.tacv2": {},
              },
            },
            "19:other@thread.tacv2": {
              channels: {
                "19:roadmap@thread.tacv2": {},
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.listChannelsForTeamWithPageInfo.mockResolvedValue({
      items: [
        { id: "19:general@thread.tacv2", displayName: "General" },
        { id: "19:other@thread.tacv2", displayName: "Other" },
        { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
      ],
      truncated: false,
    });

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
  });

  it("rejects an incomplete Bot Framework team mapping", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          teams: {
            "19:general@thread.tacv2": {
              channels: {
                "19:roadmap@thread.tacv2": {},
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.listChannelsForTeamWithPageInfo.mockResolvedValue({
      items: [{ id: "19:general@thread.tacv2", displayName: "General" }],
      truncated: true,
    });

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
  });

  it("resolves mutable DM identities only when explicitly enabled", async () => {
    const cfg = {
      channels: {
        msteams: {
          dmPolicy: "allowlist",
          allowFrom: ["Alice"],
          dangerouslyAllowNameMatching: true,
        },
      },
    } as OpenClawConfig;
    mocks.resolveMSTeamsUserAllowlist.mockResolvedValue([
      {
        input: "alice@example.com",
        resolved: true,
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      },
      { input: "alice", resolved: true, id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    ]);

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "user:alice@example.com",
      }),
    ).resolves.toBe("user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it.each([
    "19:abc@thread.tacv2",
    "19:abc@thread.skype",
    "19:user_app@unq.gbl.spaces",
    "a:1abc123",
    "8:orgid:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  ])(
    "allows a supported bare conversation target when both scopes are open (%s)",
    async (target) => {
      const cfg = {
        channels: {
          msteams: {
            groupPolicy: "open",
            dmPolicy: "open",
          },
        },
      } as OpenClawConfig;

      await expect(assertMSTeamsReadTargetAllowed({ cfg, ctx, target })).resolves.toBe(target);
    },
  );

  it("does not classify a bare Bot Framework user id as a conversation", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "open",
          dmPolicy: "open",
        },
      },
    } as OpenClawConfig;

    await expect(
      assertMSTeamsReadTargetAllowed({ cfg, ctx, target: "29:user-id" }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
  });

  it("rejects mutable DM identities when name matching is disabled", async () => {
    const cfg = {
      channels: {
        msteams: {
          dmPolicy: "allowlist",
          allowFrom: ["alice@example.com"],
        },
      },
    } as OpenClawConfig;

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "user:alice@example.com",
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    expect(mocks.resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
  });

  it("resolves mutable channel targets only when explicitly enabled", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          dangerouslyAllowNameMatching: true,
          teams: {
            Product: {
              channels: {
                Roadmap: { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.resolveMSTeamsChannelAllowlist.mockResolvedValue([
      {
        input: "Product/Roadmap",
        resolved: true,
        teamId: "19:general@thread.tacv2",
        graphTeamId: "11111111-1111-1111-1111-111111111111",
        channelId: "19:roadmap@thread.tacv2",
      },
    ]);
    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx,
        target: "Product/Roadmap",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2");
  });

  it("requires team-wide access before channel enumeration", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          teams: {
            Product: {
              channels: {
                "*": { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.resolveMSTeamsTeamsConfig.mockResolvedValue({
      teams: {
        "11111111-1111-1111-1111-111111111111": {
          channels: {
            "*": { requireMention: true },
          },
        },
      },
      mapping: [],
      unresolved: [],
    });

    await expect(
      assertMSTeamsTeamEnumerationAllowed({
        cfg,
        teamId: "11111111-1111-1111-1111-111111111111",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111");
    expect(mocks.resolveMSTeamsTeamsConfig).toHaveBeenCalledWith({
      cfg,
      teamIdMode: "graph",
      teams: cfg.channels?.msteams?.teams,
    });
  });

  it("maps stable Bot Framework team keys before channel enumeration", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          teams: {
            "19:general@thread.tacv2": {
              channels: {
                "*": { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    mocks.listChannelsForTeamWithPageInfo.mockResolvedValue({
      items: [
        { id: "19:general@thread.tacv2", displayName: "General" },
        { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
      ],
      truncated: false,
    });

    await expect(
      assertMSTeamsTeamEnumerationAllowed({
        cfg,
        teamId: "11111111-1111-1111-1111-111111111111",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111");
  });

  it("lets a direct operator read stable unconfigured channel and DM targets", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          dmPolicy: "pairing",
        },
      },
    } as OpenClawConfig;
    const directCtx = {
      ...ctx,
      conversationReadOrigin: "direct-operator" as const,
    };

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx: directCtx,
        target: "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2");
    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg,
        ctx: directCtx,
        target: "user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).resolves.toBe("user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  });

  it("keeps disabled Teams scopes blocked for direct operators", async () => {
    const directCtx = {
      ...ctx,
      conversationReadOrigin: "direct-operator" as const,
    };

    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg: {
          channels: {
            msteams: {
              groupPolicy: "disabled",
              dmPolicy: "open",
            },
          },
        } as OpenClawConfig,
        ctx: directCtx,
        target: "11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
    await expect(
      assertMSTeamsReadTargetAllowed({
        cfg: {
          channels: {
            msteams: {
              groupPolicy: "open",
              dmPolicy: "disabled",
            },
          },
        } as OpenClawConfig,
        ctx: directCtx,
        target: "user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      }),
    ).rejects.toThrow("Microsoft Teams read target is not allowed.");
  });

  it("lets a direct operator enumerate an unconfigured stable team", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "allowlist",
        },
      },
    } as OpenClawConfig;

    await expect(
      assertMSTeamsTeamEnumerationAllowed({
        cfg,
        ctx: {
          ...ctx,
          conversationReadOrigin: "direct-operator",
        },
        teamId: "11111111-1111-1111-1111-111111111111",
      }),
    ).resolves.toBe("11111111-1111-1111-1111-111111111111");
  });
});
