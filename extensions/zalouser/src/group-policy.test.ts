import { describe, expect, it } from "vitest";
import {
  buildZalouserGroupCandidates,
  findZalouserGroupEntry,
  isZalouserGroupEntryAllowed,
  normalizeZalouserGroupSlug,
} from "./group-policy.js";

describe("zalouser group policy helpers", () => {
  it("normalizes group slug names", () => {
    expect(normalizeZalouserGroupSlug(" Team Alpha ")).toBe("team-alpha");
    expect(normalizeZalouserGroupSlug("#Roadmap Updates")).toBe("roadmap-updates");
  });

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

  it("builds id-only candidates when name matching is disabled", () => {
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
});
