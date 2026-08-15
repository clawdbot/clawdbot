// Msteams tests cover policy plugin behavior.
import { describe, expect, it } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";
import {
  resolveMSTeamsGroupToolPolicy,
  resolveMSTeamsReplyPolicy,
  resolveMSTeamsRouteConfig,
} from "./policy.js";

function resolveNamedTeamRouteConfig(allowNameMatching = false) {
  const cfg: MSTeamsConfig = {
    teams: {
      "My Team": {
        requireMention: true,
        channels: {
          "General Chat": { requireMention: false },
        },
      },
    },
  };

  return resolveMSTeamsRouteConfig({
    cfg,
    teamName: "My Team",
    channelName: "General Chat",
    conversationId: "ignored",
    allowNameMatching,
  });
}

describe("msteams policy", () => {
  describe("resolveMSTeamsRouteConfig", () => {
    it("returns team and channel config when present", () => {
      const cfg: MSTeamsConfig = {
        teams: {
          team123: {
            requireMention: false,
            channels: {
              chan456: { requireMention: true },
            },
          },
        },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        teamId: "team123",
        conversationId: "chan456",
      });

      if (!res.teamConfig || !res.channelConfig) {
        throw new Error("expected matched team and channel config");
      }
      expect(res.teamConfig.requireMention).toBe(false);
      expect(res.channelConfig.requireMention).toBe(true);
      expect(res.allowlistConfigured).toBe(true);
      expect(res.allowed).toBe(true);
      expect(res.channelMatchKey).toBe("chan456");
      expect(res.channelMatchSource).toBe("direct");
    });

    it("returns undefined configs when teamId is missing", () => {
      const cfg: MSTeamsConfig = {
        teams: { team123: { requireMention: false } },
      };

      const res = resolveMSTeamsRouteConfig({
        cfg,
        teamId: undefined,
        conversationId: "chan",
      });
      expect(res.teamConfig).toBeUndefined();
      expect(res.channelConfig).toBeUndefined();
      expect(res.allowlistConfigured).toBe(true);
      expect(res.allowed).toBe(false);
    });

    it("blocks team and channel name matches by default", () => {
      const res = resolveNamedTeamRouteConfig();

      expect(res.teamConfig).toBeUndefined();
      expect(res.channelConfig).toBeUndefined();
      expect(res.allowed).toBe(false);
    });

    it("matches team and channel by name when dangerous name matching is enabled", () => {
      const res = resolveNamedTeamRouteConfig(true);

      if (!res.teamConfig || !res.channelConfig) {
        throw new Error("expected matched named team and channel config");
      }
      expect(res.teamConfig.requireMention).toBe(true);
      expect(res.channelConfig.requireMention).toBe(false);
      expect(res.allowed).toBe(true);
    });
  });

  describe("resolveMSTeamsReplyPolicy", () => {
    it("forces thread replies for direct messages", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: true,
        globalConfig: { replyStyle: "top-level", requireMention: false },
      });
      expect(policy).toEqual({ requireMention: false, replyStyle: "thread" });
    });

    it("defaults to requireMention=true and replyStyle=thread", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: {},
      });
      expect(policy).toEqual({ requireMention: true, replyStyle: "thread" });
    });

    it("defaults replyStyle to top-level when requireMention=false", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: false },
      });
      expect(policy).toEqual({
        requireMention: false,
        replyStyle: "top-level",
      });
    });

    it("prefers channel overrides over team and global defaults", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: true },
        teamConfig: { requireMention: true },
        channelConfig: { requireMention: false },
      });

      // requireMention from channel -> false, and replyStyle defaults from requireMention -> top-level
      expect(policy).toEqual({
        requireMention: false,
        replyStyle: "top-level",
      });
    });

    it("inherits team mention settings when channel config is missing", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: true },
        teamConfig: { requireMention: false },
      });
      expect(policy).toEqual({
        requireMention: false,
        replyStyle: "top-level",
      });
    });

    it("uses explicit replyStyle even when requireMention defaults would differ", () => {
      const policy = resolveMSTeamsReplyPolicy({
        isDirectMessage: false,
        globalConfig: { requireMention: false, replyStyle: "thread" },
      });
      expect(policy).toEqual({ requireMention: false, replyStyle: "thread" });
    });
  });

  describe("resolveMSTeamsGroupToolPolicy", () => {
    it("uses stable projected keys and never raw mutable names", () => {
      const cfg = {
        channels: {
          msteams: {
            dangerouslyAllowNameMatching: true,
            teams: {
              "Mutable Team": {
                channels: {
                  "Mutable Channel": { tools: { allow: ["exec"] } },
                },
              },
              "19:stable-team@thread.tacv2": {
                channels: {
                  "19:stable-channel@thread.tacv2": { tools: { allow: ["read"] } },
                },
              },
            },
          },
        },
      };

      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg,
          groupId: "19:unknown@thread.tacv2",
          groupChannel: "Mutable Channel",
          groupSpace: "Mutable Team",
        }),
      ).toBeUndefined();
      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg,
          groupId: "19:stable-channel@thread.tacv2",
          groupSpace: "19:stable-team@thread.tacv2",
        }),
      ).toEqual({ allow: ["read"] });
    });

    it("finds a channel across teams when no team matches", () => {
      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg: {
            channels: {
              msteams: {
                teams: {
                  first: { channels: { other: { tools: { deny: ["other"] } } } },
                  second: { channels: { target: { tools: { allow: ["cross-team"] } } } },
                },
              },
            },
          },
          groupSpace: "missing-team",
          groupId: "target",
        }),
      ).toEqual({ allow: ["cross-team"] });
    });

    it("falls through a policy-less matched team to the cross-team scan", () => {
      // A matched team without any applicable policy must not swallow another
      // team's channel deny rules (legacy resolver parity).
      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg: {
            channels: {
              msteams: {
                teams: {
                  "*": {},
                  actual: { channels: { target: { tools: { deny: ["shell"] } } } },
                },
              },
            },
          },
          groupSpace: "unknown-team",
          groupId: "target",
        }),
      ).toEqual({ deny: ["shell"] });
    });

    it("does not scan across teams once a channel matched inside the selected team", () => {
      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg: {
            channels: {
              msteams: {
                teams: {
                  mine: { channels: { target: {} } },
                  other: { channels: { target: { tools: { deny: ["shell"] } } } },
                },
              },
            },
          },
          groupSpace: "mine",
          groupId: "target",
        }),
      ).toBeUndefined();
    });

    it("falls from a fieldless channel entry to its team policy", () => {
      expect(
        resolveMSTeamsGroupToolPolicy({
          cfg: {
            channels: {
              msteams: {
                teams: {
                  team: {
                    tools: { deny: ["team"] },
                    channels: { channel: {} },
                  },
                },
              },
            },
          },
          groupSpace: "team",
          groupId: "channel",
        }),
      ).toEqual({ deny: ["team"] });
    });

    it("keeps slash-bearing flat scope keys collision-free", () => {
      const cfg = {
        channels: {
          msteams: {
            teams: {
              "a/channel:b": { tools: { allow: ["slash-team"] } },
              a: { channels: { b: { tools: { allow: ["nested-channel"] } } } },
            },
          },
        },
      };

      expect(resolveMSTeamsGroupToolPolicy({ cfg, groupSpace: "a/channel:b" })).toEqual({
        allow: ["slash-team"],
      });
      expect(resolveMSTeamsGroupToolPolicy({ cfg, groupSpace: "a", groupId: "b" })).toEqual({
        allow: ["nested-channel"],
      });
    });
  });
});
