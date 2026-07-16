import { describe, expect, it } from "vitest";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";

describe("shouldPromoteRecentInviteRoom", () => {
  it("fails closed when room metadata could not be resolved", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          altAliases: [],
          nameResolved: false,
          aliasesResolved: true,
        },
      }),
    ).toBe(false);
  });

  it("rejects named or aliased rooms", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!named:example.org",
        roomInfo: {
          name: "Ops Room",
          altAliases: [],
          nameResolved: true,
          aliasesResolved: true,
        },
      }),
    ).toBe(false);

    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!aliased:example.org",
        roomInfo: {
          canonicalAlias: "#ops:example.org",
          altAliases: [],
          nameResolved: true,
          aliasesResolved: true,
        },
      }),
    ).toBe(false);
  });

  it("rejects rooms explicitly configured by direct match", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          altAliases: [],
          nameResolved: true,
          aliasesResolved: true,
        },
        rooms: {
          "!room:example.org": {
            enabled: true,
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects rooms matched only by wildcard config", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          altAliases: [],
          nameResolved: true,
          aliasesResolved: true,
        },
        rooms: {
          "*": {
            enabled: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("allows strict unnamed invite rooms without direct room config", () => {
    expect(
      shouldPromoteRecentInviteRoom({
        roomId: "!room:example.org",
        roomInfo: {
          altAliases: [],
          nameResolved: true,
          aliasesResolved: true,
        },
      }),
    ).toBe(true);
  });
});
