import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  resolveIrcGroupAccessGate,
  resolveIrcGroupMatch,
  resolveIrcGroupSenderAllowed,
  resolveIrcMentionGate,
  resolveIrcRequireMention,
} from "./policy.js";

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

  it("enforces allowlist by default in groups", () => {
    const message = {
      messageId: "m1",
      target: "#ops",
      senderNick: "alice",
      senderUser: "ident",
      senderHost: "example.org",
      text: "hi",
      timestamp: Date.now(),
      isGroup: true,
    };

    expect(
      resolveIrcGroupSenderAllowed({
        groupPolicy: "allowlist",
        message,
        outerAllowFrom: [],
        innerAllowFrom: [],
      }),
    ).toBe(false);

    expect(
      resolveIrcGroupSenderAllowed({
        groupPolicy: "allowlist",
        message,
        outerAllowFrom: ["alice!ident@example.org"],
        innerAllowFrom: [],
      }),
    ).toBe(true);
    expect(
      resolveIrcGroupSenderAllowed({
        groupPolicy: "allowlist",
        message,
        outerAllowFrom: ["alice"],
        innerAllowFrom: [],
      }),
    ).toBe(false);
    expect(
      resolveIrcGroupSenderAllowed({
        groupPolicy: "allowlist",
        message,
        outerAllowFrom: ["alice"],
        innerAllowFrom: [],
        allowNameMatching: true,
      }),
    ).toBe(true);
  });

  it('allows unconfigured channels when groupPolicy is "open"', () => {
    const groupMatch = resolveIrcGroupMatch({
      groups: undefined,
      target: "#random",
    });
    const gate = resolveIrcGroupAccessGate({
      groupPolicy: "open",
      groupMatch,
    });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toBe("open");
  });

  it("honors explicit group disable even in open mode", () => {
    const groupMatch = resolveIrcGroupMatch({
      groups: {
        "#ops": { enabled: false },
      },
      target: "#ops",
    });
    const gate = resolveIrcGroupAccessGate({
      groupPolicy: "open",
      groupMatch,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("disabled");
  });

  it("allows authorized control commands without mention", () => {
    const gate = resolveIrcMentionGate({
      isGroup: true,
      requireMention: true,
      wasMentioned: false,
      hasControlCommand: true,
      allowTextCommands: true,
      commandAuthorized: true,
    });
    expect(gate.shouldSkip).toBe(false);
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
