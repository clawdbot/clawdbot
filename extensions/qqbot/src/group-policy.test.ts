// Qqbot tests cover shared group tool policy behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { qqbotPlugin } from "./channel.js";
import { resolveQQBotGroupToolPolicy } from "./group-policy.js";

describe("qqbot group tool policy", () => {
  it("resolves canonical per-group tools config", () => {
    const cfg = {
      channels: {
        qqbot: {
          groups: {
            G1: { tools: { deny: ["*"] } },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveQQBotGroupToolPolicy({ cfg, groupId: "G1" })).toStrictEqual({
      deny: ["*"],
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

  it("matches mixed-case group ids after session-key normalization", () => {
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
