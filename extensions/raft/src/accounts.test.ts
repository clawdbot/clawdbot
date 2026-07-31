import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { listRaftAccountIds, resolveRaftAccount } from "./accounts.js";
import { raftChannelConfigSchema } from "./config-schema.js";
import { raftSetupPlugin } from "./setup.js";

type RaftSetupInput = ChannelSetupInput & { profile?: string };

const originalProfile = process.env.RAFT_PROFILE;
const runtimeConfigSchema = raftChannelConfigSchema.runtime;
if (!runtimeConfigSchema) {
  throw new Error("expected Raft runtime config schema");
}

afterEach(() => {
  if (originalProfile === undefined) {
    delete process.env.RAFT_PROFILE;
  } else {
    process.env.RAFT_PROFILE = originalProfile;
  }
});

describe("Raft account resolution", () => {
  it("uses RAFT_PROFILE only for the default account", () => {
    process.env.RAFT_PROFILE = "environment-profile";
    const cfg = {
      channels: {
        raft: {
          accounts: {
            support: {
              profile: "support-profile",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listRaftAccountIds(cfg)).toEqual(["default", "support"]);
    expect(resolveRaftAccount({ cfg })).toMatchObject({
      accountId: "default",
      configured: true,
      profile: "environment-profile",
    });
    expect(resolveRaftAccount({ cfg, accountId: "support" })).toMatchObject({
      configured: true,
      profile: "support-profile",
    });
  });

  it("prefers an explicit profile over RAFT_PROFILE", () => {
    process.env.RAFT_PROFILE = "environment-profile";
    const cfg = {
      channels: {
        raft: {
          profile: "configured-profile",
        },
      },
    } as OpenClawConfig;

    expect(resolveRaftAccount({ cfg }).profile).toBe("configured-profile");
  });

  it("keeps named account setup scoped to that account", () => {
    const next = raftSetupPlugin.setup!.applyAccountConfig({
      cfg: {} as OpenClawConfig,
      accountId: "support",
      input: {
        profile: "support-profile",
      } as RaftSetupInput,
    });

    expect(next.channels?.raft).toEqual({
      enabled: true,
      accounts: {
        support: {
          enabled: true,
          profile: "support-profile",
        },
      },
    });
  });

  it("accepts the supported single and multi-account fields only", () => {
    expect(runtimeConfigSchema.safeParse({ profile: "default" }).success).toBe(true);
    expect(
      runtimeConfigSchema.safeParse({
        accounts: {
          support: {
            profile: "support",
          },
        },
      }).success,
    ).toBe(true);
    expect(runtimeConfigSchema.safeParse({ bridgePort: 3000 }).success).toBe(false);
  });
});
