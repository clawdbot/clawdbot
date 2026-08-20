// Slack tests cover allow list plugin behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeAllowList,
  normalizeAllowListLower,
  normalizeSlackSlug,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowListForTeam,
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

  it("matches a workspace-qualified user only in that workspace", () => {
    const allowList = ["team:t11111111:user:u01234567"];

    expect(
      resolveSlackAllowListMatch({
        allowList,
        teamId: "T11111111",
        id: "U01234567",
      }),
    ).toEqual({
      allowed: true,
      matchKey: "team:t11111111:user:u01234567",
      matchSource: "workspace-id",
    });
    expect(
      resolveSlackAllowListMatch({
        allowList,
        teamId: "T22222222",
        id: "U01234567",
      }),
    ).toEqual({ allowed: false });
    expect(
      resolveSlackAllowListMatch({
        allowList: ["u01234567"],
        teamId: "T22222222",
        id: "U01234567",
      }),
    ).toEqual({ allowed: true, matchKey: "u01234567", matchSource: "id" });
  });

  it("matches a workspace-qualified bot only in that workspace", () => {
    const allowList = ["team:t11111111:user:b01234567"];

    expect(
      resolveSlackAllowListMatch({
        allowList,
        teamId: "T11111111",
        id: "B01234567",
      }),
    ).toEqual({
      allowed: true,
      matchKey: "team:t11111111:user:b01234567",
      matchSource: "workspace-id",
    });
    expect(
      resolveSlackAllowListMatch({
        allowList,
        teamId: "T22222222",
        id: "B01234567",
      }),
    ).toEqual({ allowed: false });
  });

  it("preserves org-wide IDs and workspace-qualified user identities", () => {
    expect(
      resolveSlackUserAllowListForTeam({
        allowList: ["W01234567", "team:T11111111:user:U01234567", "team:T22222222:user:U01234567"],
        teamId: "T11111111",
      }),
    ).toEqual(["w01234567", "team:t11111111:user:u01234567"]);
  });
});
