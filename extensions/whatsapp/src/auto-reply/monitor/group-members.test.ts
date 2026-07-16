import { describe, expect, it } from "vitest";
import { formatGroupMembers, noteGroupMember } from "./group-members.js";

describe("noteGroupMember", () => {
  it("normalizes member phone numbers before storing", () => {
    const groupMemberNames = new Map<string, Map<string, string>>();

    noteGroupMember(groupMemberNames, "g1", "+1 (555) 123-4567", "Alice");

    expect(groupMemberNames.get("g1")?.get("+15551234567")).toBe("Alice");
  });

  it("ignores incomplete member values", () => {
    const groupMemberNames = new Map<string, Map<string, string>>();

    noteGroupMember(groupMemberNames, "g1", undefined, "Alice");
    noteGroupMember(groupMemberNames, "g1", "+15551234567", undefined);

    expect(groupMemberNames.get("g1")).toBeUndefined();
  });
});

describe("formatGroupMembers", () => {
  it("deduplicates participants and appends named roster members", () => {
    const roster = new Map<string, string>([
      ["+16660000000", "Bob"],
      ["+17770000000", "Carol"],
    ]);

    const formatted = formatGroupMembers({
      participants: ["+1 (555) 000-0000", "+15550000000", "+16660000000"],
      roster,
    });

    expect(formatted).toBe("+15550000000, Bob (+16660000000), Carol (+17770000000)");
  });

  it("falls back to sender when no participants or roster are available", () => {
    const formatted = formatGroupMembers({
      participants: [],
      roster: undefined,
      fallbackE164: "+1 (555) 222-3333",
    });

    expect(formatted).toBe("+15552223333");
  });

  it("returns undefined when no members can be resolved", () => {
    expect(
      formatGroupMembers({
        participants: [],
        roster: undefined,
      }),
    ).toBeUndefined();
  });
});
