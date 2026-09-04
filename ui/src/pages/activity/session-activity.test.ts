import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { activityPersonFromPath } from "../../app-route-paths.ts";
import {
  parseSessionActivityFilters,
  canonicalSessionActivityLocation,
  projectSessionActivity,
  sessionActivityLocation,
} from "./session-activity.ts";

const people: NonNullable<SessionsListResult["people"]> = [
  { identity: { type: "profile", id: "alice" }, label: "Alice", sessionCount: 12 },
  { identity: { type: "profile", id: "bob" }, label: "Bob", sessionCount: 3 },
];
function result(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    totalCount: 12,
    peopleSessionCount: 15,
    people,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions,
  };
}

describe("session activity projection", () => {
  it("refreshes decorative names while retaining exact references, longer prefixes, filters and anchors", () => {
    const personId = "12345678-abcd-4123-8123-123456789abc";
    const legacy = {
      pathname: "/ui/activity",
      search: `?person=${personId}&time=30d&q=release`,
      hash: "#sessions",
    };
    expect(canonicalSessionActivityLocation(legacy, personId, "Ada Lovelace", "/ui")).toEqual({
      pathname: "/ui/activity/ada-lovelace-12345678abcd41238123123456789abc",
      search: "?time=30d&q=release",
      hash: "#sessions",
    });
    for (const reference of [
      "12345678",
      "12345678abcd4123",
      personId,
      personId.replaceAll("-", ""),
    ]) {
      const location = { ...legacy, pathname: `/ui/activity/${reference}`, search: "?q=none" };
      expect(canonicalSessionActivityLocation(location, personId, "Ada", "/ui")?.pathname).toBe(
        `/ui/activity/ada-${reference.replaceAll("-", "")}`,
      );
    }
    const empty = { pathname: "/ui/activity/ada-12345678abcd", search: "?q=none", hash: "" };
    expect(canonicalSessionActivityLocation(empty, "12345678abcd", undefined, "/ui")).toBeNull();
    expect(
      canonicalSessionActivityLocation(legacy, "abcdef12-1234-4123-8123-123456789abc", "Ada", "/ui")
        ?.pathname,
    ).toBe("/ui/activity/ada-abcdef12123441238123123456789abc");
  });

  it("groups the server page without treating its preview or session clock as personal history", () => {
    const now = new Date(2026, 7, 17, 12).getTime();
    const rows: GatewaySessionRow[] = [
      {
        key: "agent:main:first",
        kind: "direct",
        updatedAt: now,
        participants: [{ identity: { type: "agent", id: "bob" } }],
      },
      { key: "agent:main:second", kind: "direct", updatedAt: now - 60_000 },
      { key: "agent:main:older", kind: "direct", updatedAt: now - 26 * 60 * 60_000 },
    ];
    const activity = projectSessionActivity(result(rows));
    expect(activity.people.map(({ id, count }) => ({ id, count }))).toEqual([
      { id: "alice", count: 12 },
      { id: "bob", count: 3 },
    ]);
    expect(activity.people.every((person) => !("lastActiveAt" in person))).toBe(true);
    expect(activity.days.map((day) => day.sessions.map((row) => row.key))).toEqual([
      ["agent:main:first", "agent:main:second"],
      ["agent:main:older"],
    ]);
    expect(activity.matchedCount).toBe(12);
    expect(activity.timeCount).toBe(15);
  });

  it("does not infer people from unqualified owner or participant IDs", () => {
    const page = result([
      {
        key: "agent:main:channel",
        kind: "direct",
        createdActor: { type: "human", id: "alice" },
        participants: [
          { identity: { type: "legacy", actorType: "human", source: "channel", id: "bob" } },
        ],
      },
    ]);
    page.people = [];
    expect(projectSessionActivity(page).people).toEqual([]);
    expect(projectSessionActivity(undefined).sessions).toEqual([]);
  });

  it("round-trips person paths and query filters under a mounted base path", () => {
    const filters = { personId: "profile/a", query: "release notes", time: "30d" as const };
    const { pathname, search } = sessionActivityLocation(filters, "/ui");
    expect(pathname).toBe("/ui/activity/profile%2Fa");
    expect(search).toBe("?time=30d&q=release+notes");
    expect(parseSessionActivityFilters(search, activityPersonFromPath(pathname, "/ui"))).toEqual(
      filters,
    );
    expect(sessionActivityLocation({ ...filters, personId: null }, "/ui").pathname).toBe(
      "/ui/activity",
    );
  });
});
