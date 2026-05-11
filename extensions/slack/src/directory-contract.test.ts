import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
import { getSlackDirectorySelfLive } from "./directory-live.js";
import type { SlackProbe } from "./probe.js";

const slackClientMocks = vi.hoisted(() => ({
  authTest: vi.fn(),
  usersInfo: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackWebClient: () => ({
    auth: { test: slackClientMocks.authTest },
    users: { info: slackClientMocks.usersInfo },
  }),
}));

describe("Slack directory contract", () => {
  beforeEach(() => {
    slackClientMocks.authTest.mockReset();
    slackClientMocks.usersInfo.mockReset();
  });

  it("keeps public probe aligned with base contract", () => {
    expectTypeOf<SlackProbe>().toMatchTypeOf<BaseProbeResult>();
  });

  it("lists peers/groups from config", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U123", "user:U999"] },
          dms: { U234: {} },
          channels: { C111: { users: ["U777"] } },
        },
      },
    } as unknown as OpenClawConfig;

    await expectDirectoryIds(
      listSlackDirectoryPeersFromConfig,
      cfg,
      ["user:u123", "user:u234", "user:u777", "user:u999"],
      { sorted: true },
    );
    await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
  });

  it("keeps directories readable when tokens are unresolved SecretRefs", async () => {
    const envSecret = {
      source: "env",
      provider: "default",
      id: "MISSING_TEST_SECRET",
    } as const;
    const cfg = {
      channels: {
        slack: {
          botToken: envSecret,
          appToken: envSecret,
          dm: { allowFrom: ["U123"] },
          channels: { C111: {} },
        },
      },
    } as unknown as OpenClawConfig;

    await expectDirectoryIds(listSlackDirectoryPeersFromConfig, cfg, ["user:u123"]);
    await expectDirectoryIds(listSlackDirectoryGroupsFromConfig, cfg, ["channel:c111"]);
  });

  it("applies query and limit filtering for config-backed directories", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U100", "U200"] },
          dms: { U300: {} },
        },
      },
    } as unknown as OpenClawConfig;

    const peers = await listSlackDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "user:u",
      limit: 2,
    });
    expect(peers).toHaveLength(2);
    expect(peers.every((entry) => entry.id.startsWith("user:u"))).toBe(true);
  });

  it("resolves current Slack account identity from live auth", async () => {
    slackClientMocks.authTest.mockResolvedValue({
      ok: true,
      user_id: "USELF",
      user: "ada",
      team_id: "T1",
      team: "Test Team",
    });
    slackClientMocks.usersInfo.mockResolvedValue({
      user: {
        id: "USELF",
        name: "ada",
        profile: {
          display_name: "Ada",
          real_name: "Ada Lovelace",
        },
      },
    });
    const cfg = {
      channels: {
        slack: {
          userToken: "xoxp-test",
        },
      },
    } as unknown as OpenClawConfig;

    await expect(getSlackDirectorySelfLive({ cfg, accountId: "default" })).resolves.toEqual(
      expect.objectContaining({
        kind: "user",
        id: "user:USELF",
        name: "Ada",
        handle: "@ada",
      }),
    );
    expect(slackClientMocks.authTest).toHaveBeenCalled();
    expect(slackClientMocks.usersInfo).toHaveBeenCalledWith({ user: "USELF" });
  });

  it("falls back to auth identity when live user profile lookup fails", async () => {
    slackClientMocks.authTest.mockResolvedValue({
      ok: true,
      user_id: "USELF",
      user: "ada",
    });
    slackClientMocks.usersInfo.mockRejectedValue(new Error("missing_scope"));
    const cfg = {
      channels: {
        slack: {
          userToken: "xoxp-test",
        },
      },
    } as unknown as OpenClawConfig;

    await expect(getSlackDirectorySelfLive({ cfg, accountId: "default" })).resolves.toEqual(
      expect.objectContaining({
        kind: "user",
        id: "user:USELF",
        name: "ada",
        handle: "@ada",
      }),
    );
  });
});
