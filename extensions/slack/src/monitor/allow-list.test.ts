import { describe, expect, it } from "vitest";
import {
  normalizeAllowList,
  normalizeAllowListLower,
  normalizeSlackSlug,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "./allow-list.js";

describe("slack/allow-list", () => {
  it("normalizes lists and slugs", () => {
    expect(normalizeAllowList(["  Alice  ", 7, "", "  "])).toEqual(["Alice", "7"]);
    expect(normalizeAllowListLower(["  Alice  ", 7])).toEqual(["alice", "7"]);
    expect(normalizeSlackSlug(" Team Space  ")).toBe("team-space");
    expect(normalizeSlackSlug(" #Ops.Room ")).toBe("#ops.room");
  });

  it("matches wildcard and id candidates by default", () => {
    expect(resolveSlackAllowListMatch({ allowList: ["*"], id: "u1", name: "alice" })).toEqual({
      allowed: true,
      matchKey: "*",
      matchSource: "wildcard",
    });

    expect(
      resolveSlackAllowListMatch({
        allowList: ["u1"],
        id: "u1",
        name: "alice",
      }),
    ).toEqual({
      allowed: true,
      matchKey: "u1",
      matchSource: "id",
    });

    expect(
      resolveSlackAllowListMatch({
        allowList: ["slack:alice"],
        id: "u2",
        name: "alice",
      }),
    ).toEqual({ allowed: false });

    expect(
      resolveSlackAllowListMatch({
        allowList: ["slack:alice"],
        id: "u2",
        name: "alice",
        allowNameMatching: true,
      }),
    ).toEqual({
      allowed: true,
      matchKey: "slack:alice",
      matchSource: "prefixed-name",
    });
  });

  it("allows all users when allowList is empty and denies unknown entries", () => {
    expect(resolveSlackUserAllowed({ allowList: [], userId: "u1", userName: "alice" })).toBe(true);
    expect(resolveSlackUserAllowed({ allowList: ["u2"], userId: "u1", userName: "alice" })).toBe(
      false,
    );
  });
});
