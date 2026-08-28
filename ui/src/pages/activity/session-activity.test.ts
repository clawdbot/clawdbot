import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import {
  parseSessionActivityFilters,
  projectSessionActivity,
  resolveActivityIdentity,
  resolveViewingNow,
  sessionActivitySearch,
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

  it("round-trips linkable filters in a stable query order", () => {
    const filters = { personId: "profile/a", query: "release notes", time: "30d" as const };
    const search = sessionActivitySearch(filters);
    expect(search).toBe("?time=30d&person=profile%2Fa&q=release+notes");
    expect(parseSessionActivityFilters(search)).toEqual(filters);
  });
});

describe("per-person activity projection", () => {
  const rows: GatewaySessionRow[] = [
    { key: "agent:main:first", kind: "direct", updatedAt: 10 },
    { key: "agent:main:second", kind: "direct", updatedAt: 20 },
  ];
  it("keeps presence details and resolves only known watched sessions", () => {
    const identity = resolveActivityIdentity(
      "alice",
      {
        presence: [
          {
            instanceId: "alice-laptop",
            host: "Alice's Mac",
            lastInputSeconds: 30,
            ts: 10,
            user: { id: "alice", name: "Alice", email: "alice@example.test" },
            watchedSessions: ["agent:main:first", "missing"],
          },
          {
            instanceId: "alice-phone",
            host: "Alice's phone",
            ts: 20,
            user: { id: "alice", name: "Alice" },
            watchedSessions: ["agent:main:second"],
          },
        ],
      },
      people,
    );
    expect(identity).toMatchObject({
      id: "alice",
      email: "alice@example.test",
      watchedSessions: ["agent:main:first", "agent:main:second", "missing"],
    });
    expect(identity?.entries?.map((entry) => entry.host)).toEqual(["Alice's Mac", "Alice's phone"]);
    expect(resolveViewingNow(identity!, rows).map((row) => row.key)).toEqual([
      "agent:main:second",
      "agent:main:first",
    ]);
  });
  it("uses the server profile facet for offline identities", () => {
    expect(resolveActivityIdentity("alice", { presence: [] }, people)).toMatchObject({
      id: "alice",
      name: "Alice",
      watchedSessions: [],
    });
    expect(resolveActivityIdentity("unknown", { presence: [] }, people)).toBeNull();
  });
});
