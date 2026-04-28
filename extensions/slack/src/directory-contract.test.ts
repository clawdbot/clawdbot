import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { expectDirectoryIds } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
} from "../directory-contract-api.js";
import type { SlackProbe } from "./probe.js";

describe("Slack directory contract", () => {
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
});
