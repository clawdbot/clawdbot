import {
  buildChannelGroupsScopeTree,
  resolveScopeKeyCaseInsensitive,
} from "openclaw/plugin-sdk/channel-policy";
// Qqbot tests cover shared group tool policy behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { qqbotPlugin } from "./channel.js";
import { resolveQQBotGroupToolPolicy } from "./group-policy.js";

describe("qqbot group tool policy", () => {
  it("prefers an exact group key over a case-insensitive match", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            g1: { tools: { allow: ["case-insensitive"] } },
            G1: { tools: { deny: ["exact"] } },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveQQBotGroupToolPolicy({ cfg, groupId: "G1" })).toStrictEqual({
      deny: ["exact"],
    });
  });

  it("resolves toolsBySender before group tools", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            G1: {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:alice": { deny: ["*"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveQQBotGroupToolPolicy({
        cfg,
        groupId: "G1",
        senderId: "alice",
      }),
    ).toStrictEqual({ deny: ["*"] });
  });

  it("uses a case-insensitive group key when no exact key exists", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            Group_OPENID: {
              tools: { allow: ["read"] },
              toolsBySender: {
                "id:alice": { deny: ["*"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveQQBotGroupToolPolicy({
        cfg,
        groupId: "group_openid",
        senderId: "alice",
      }),
    ).toStrictEqual({ deny: ["*"] });
  });

  it("keeps wildcard defaults out of case-insensitive scope matching", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            "*": { tools: { deny: ["default"] } },
          },
        },
      },
    } as OpenClawConfig;
    const tree = buildChannelGroupsScopeTree(cfg, "qqbot");

    expect(resolveScopeKeyCaseInsensitive(tree, "*")).toBeUndefined();
    expect(resolveQQBotGroupToolPolicy({ cfg, groupId: "*" })).toStrictEqual({
      deny: ["default"],
    });
  });

  it("registers the resolver on the channel plugin", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            G1: { tools: { deny: ["*"] } },
          },
        },
      },
    } as OpenClawConfig;

    expect(qqbotPlugin.groups?.resolveToolPolicy?.({ cfg, groupId: "G1" })).toStrictEqual({
      deny: ["*"],
    });
  });
});
