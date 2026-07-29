// Zalouser tests cover group policy plugin behavior.
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
} from "openclaw/plugin-sdk/channel-policy";
import { describe, expect, it } from "vitest";
import {
  buildZalouserGroupCandidates,
  findZalouserGroupEntry,
  isZalouserGroupEntryAllowed,
  resolveZalouserGroupScope,
} from "./group-policy.js";

describe("zalouser group policy helpers", () => {
  it("builds ordered candidates with optional aliases", () => {
    expect(
      buildZalouserGroupCandidates({
        groupId: "123",
        groupChannel: "chan-1",
        groupName: "Team Alpha",
        includeGroupIdAlias: true,
      }),
    ).toEqual(["123", "group:123", "chan-1", "Team Alpha", "team-alpha", "*"]);
  });

  it("gates name candidates behind dangerouslyAllowNameMatching", () => {
    expect(
      buildZalouserGroupCandidates({
        groupId: "123",
        groupChannel: "chan-1",
        groupName: "Team Alpha",
        includeGroupIdAlias: true,
        allowNameMatching: false,
      }),
    ).toEqual(["123", "group:123", "*"]);
  });

  it("finds the first matching group entry", () => {
    const groups = {
      "group:123": { enabled: true },
      "team-alpha": { requireMention: false },
      "*": { requireMention: true },
    };
    const entry = findZalouserGroupEntry(
      groups,
      buildZalouserGroupCandidates({
        groupId: "123",
        groupName: "Team Alpha",
        includeGroupIdAlias: true,
      }),
    );
    expect(entry).toEqual({ enabled: true });
  });

  it("evaluates allow/enable flags", () => {
    expect(isZalouserGroupEntryAllowed({ enabled: true })).toBe(true);
    expect(isZalouserGroupEntryAllowed({ allow: false } as never)).toBe(false);
    expect(isZalouserGroupEntryAllowed({ enabled: false })).toBe(false);
    expect(isZalouserGroupEntryAllowed(undefined)).toBe(false);
  });

  it("keeps wildcard fields hidden by a matched whole entry", () => {
    const scope = resolveZalouserGroupScope(
      {
        "123": {},
        "*": { requireMention: false, tools: { deny: ["exec"] } },
      },
      ["123"],
    );

    expect(resolveScopeRequireMention(scope)).toBe(true);
    expect(resolveScopeToolsPolicy(scope)).toBeUndefined();
  });

  it("selects name candidates only when dangerous name matching is enabled", () => {
    const groups = {
      "team-alpha": { requireMention: false },
      "*": { requireMention: true },
    };
    const buildScope = (allowNameMatching: boolean) =>
      resolveZalouserGroupScope(
        groups,
        buildZalouserGroupCandidates({
          groupId: "123",
          groupName: "Team Alpha",
          includeWildcard: false,
          allowNameMatching,
        }),
      );

    expect(resolveScopeRequireMention(buildScope(false))).toBe(true);
    expect(resolveScopeRequireMention(buildScope(true))).toBe(false);
  });
});
