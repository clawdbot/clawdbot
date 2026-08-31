// Slack tests cover group policy plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy } from "./group-policy.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channels: {
        alerts: {
          requireMention: false,
          tools: { allow: ["message.send"] },
          toolsBySender: {
            "id:user:alice": { allow: ["sessions.list"] },
          },
        },
        "*": {
          requireMention: true,
          tools: { deny: ["exec"] },
        },
      },
    },
  },
} as OpenClawConfig;

describe("slack group policy", () => {
  it("uses matched channel requireMention and wildcard fallback", () => {
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#alerts" })).toBe(false);
    expect(resolveSlackGroupRequireMention({ cfg, groupChannel: "#missing" })).toBe(true);
  });

  it("resolves sender override, then channel tools, then wildcard tools", () => {
    const senderOverride = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#alerts",
      senderId: "user:alice",
    });
    expect(senderOverride).toEqual({ allow: ["sessions.list"] });

    const channelTools = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#alerts",
      senderId: "user:bob",
    });
    expect(channelTools).toEqual({ allow: ["message.send"] });

    const wildcardTools = resolveSlackGroupToolPolicy({
      cfg,
      groupChannel: "#missing",
      senderId: "user:bob",
    });
    expect(wildcardTools).toEqual({ deny: ["exec"] });
  });

  it.each([
    { configuredChannelId: "C01234567", groupId: "c01234567" },
    { configuredChannelId: "c01234567", groupId: "C01234567" },
    { configuredChannelId: "channel:C01234567", groupId: "c01234567" },
    { configuredChannelId: "channel:c01234567", groupId: "C01234567" },
  ])(
    "applies $configuredChannelId channel and sender policies to session $groupId",
    ({ configuredChannelId, groupId }) => {
      const channelPolicyCfg = {
        channels: {
          slack: {
            channels: {
              [configuredChannelId]: {
                requireMention: false,
                tools: { allow: ["message.send"] },
                toolsBySender: {
                  "id:user:alice": { allow: ["sessions.list"] },
                },
              },
              "*": {
                requireMention: true,
                tools: { deny: ["exec"] },
              },
            },
          },
        },
      } as OpenClawConfig;

      expect(resolveSlackGroupRequireMention({ cfg: channelPolicyCfg, groupId })).toBe(false);
      expect(
        resolveSlackGroupToolPolicy({
          cfg: channelPolicyCfg,
          groupId,
          senderId: "user:bob",
        }),
      ).toEqual({ allow: ["message.send"] });
      expect(
        resolveSlackGroupToolPolicy({
          cfg: channelPolicyCfg,
          groupId,
          senderId: "user:alice",
        }),
      ).toEqual({ allow: ["sessions.list"] });
    },
  );

  it("scopes Enterprise mention and tool policies to the event workspace", () => {
    const installationState = registerSlackInstallationState("default", "enterprise");
    const enterpriseCfg = {
      channels: {
        slack: {
          channels: {
            "team:T11111111:channel:C01234567": {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
            "team:T22222222:channel:C01234567": {
              requireMention: true,
              tools: { deny: ["exec"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveSlackGroupRequireMention({
          cfg: enterpriseCfg,
          groupId: "C01234567",
          groupSpace: "T11111111",
        }),
      ).toBe(false);
      expect(
        resolveSlackGroupToolPolicy({
          cfg: enterpriseCfg,
          groupId: "C01234567",
          groupSpace: "T11111111",
        }),
      ).toEqual({ allow: ["message.send"] });
      expect(
        resolveSlackGroupRequireMention({
          cfg: enterpriseCfg,
          groupId: "C01234567",
          groupSpace: "T22222222",
        }),
      ).toBe(true);
      expect(
        resolveSlackGroupToolPolicy({
          cfg: enterpriseCfg,
          groupId: "C01234567",
          groupSpace: "T22222222",
        }),
      ).toEqual({ deny: ["exec"] });
    } finally {
      installationState.release();
    }
  });

  it("retains bare channel policy matching for workspace installs", () => {
    const installationState = registerSlackInstallationState("default", "workspace");
    const workspaceCfg = {
      channels: {
        slack: {
          channels: {
            C01234567: {
              requireMention: false,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    try {
      expect(
        resolveSlackGroupRequireMention({
          cfg: workspaceCfg,
          groupId: "C01234567",
          groupSpace: "T11111111",
        }),
      ).toBe(false);
      expect(
        resolveSlackGroupToolPolicy({
          cfg: workspaceCfg,
          groupId: "C01234567",
          groupSpace: "T11111111",
        }),
      ).toEqual({ allow: ["message.send"] });
    } finally {
      installationState.release();
    }
  });

  it("prefers the exact channel ID when case variants have different policies", () => {
    const caseSensitiveCfg = {
      channels: {
        slack: {
          channels: {
            c01234567: { tools: { allow: ["message.send"] } },
            C01234567: { tools: { deny: ["exec"] } },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSlackGroupToolPolicy({ cfg: caseSensitiveCfg, groupId: "c01234567" })).toEqual({
      allow: ["message.send"],
    });
    expect(resolveSlackGroupToolPolicy({ cfg: caseSensitiveCfg, groupId: "C01234567" })).toEqual({
      deny: ["exec"],
    });
  });

  it("keeps wildcard fields hidden by a matched whole entry", () => {
    const partialCfg = {
      channels: {
        slack: {
          channels: {
            partial: {},
            "*": { requireMention: false, tools: { deny: ["exec"] } },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveSlackGroupRequireMention({ cfg: partialCfg, groupId: "partial" })).toBe(true);
    expect(resolveSlackGroupToolPolicy({ cfg: partialCfg, groupId: "partial" })).toBeUndefined();
  });

  it("does not match channel-prefixed toolsBySender without a message provider", () => {
    const channelSenderCfg = {
      channels: {
        slack: {
          channels: {
            alerts: {
              tools: { deny: ["exec"] },
              toolsBySender: {
                "channel:slack:user:alice": { allow: ["exec"] },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveSlackGroupToolPolicy({
        cfg: channelSenderCfg,
        groupId: "alerts",
        senderId: "user:alice",
      }),
    ).toEqual({ deny: ["exec"] });
  });
});
