import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { describe, expect, it } from "vitest";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";

describe("irc policy", () => {
  it("matches direct and wildcard group entries", () => {
    const direct = resolveIrcGroupMatch({
      groups: {
        "#ops": { requireMention: false },
      },
      target: "#ops",
    });
    expect(direct.allowed).toBe(true);
    expect(resolveIrcRequireMention({ groupConfig: direct.groupConfig })).toBe(false);

    const wildcard = resolveIrcGroupMatch({
      groups: {
        "*": { requireMention: true },
      },
      target: "#random",
    });
    expect(wildcard.allowed).toBe(true);
    expect(resolveIrcRequireMention({ wildcardConfig: wildcard.wildcardConfig })).toBe(true);
  });

  it("keeps case-insensitive group matching aligned with shared channel policy resolution", () => {
    const groups = {
      "#Ops": { requireMention: false },
      "#Hidden": { enabled: false },
      "*": { requireMention: true },
    };

    const inboundDirect = resolveIrcGroupMatch({ groups, target: "#ops" });
    const sharedDirect = resolveChannelGroupPolicy({
      cfg: { channels: { irc: { groups } } },
      channel: "irc",
      groupId: "#ops",
      groupIdCaseInsensitive: true,
    });
    expect(sharedDirect.allowed).toBe(inboundDirect.allowed);
    expect(sharedDirect.groupConfig?.requireMention).toBe(
      inboundDirect.groupConfig?.requireMention,
    );

    const inboundDisabled = resolveIrcGroupMatch({ groups, target: "#hidden" });
    const sharedDisabled = resolveChannelGroupPolicy({
      cfg: { channels: { irc: { groups } } },
      channel: "irc",
      groupId: "#hidden",
      groupIdCaseInsensitive: true,
    });
    expect(sharedDisabled.allowed).toBe(inboundDisabled.allowed);
    expect(inboundDisabled.groupConfig?.enabled).toBe(false);
  });
});
