import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  parseSessionActivityFilters,
  projectSessionActivity,
  resolveActivityIdentity,
  resolveViewingNow,
  sessionActivitySearch,
} from "./session-activity.ts";

function session(
  key: string,
  title: string,
  updatedAt: number,
  owner: { id: string; label: string },
  participants: Array<{ id: string; label: string }> = [],
): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    displayName: title,
    updatedAt,
    createdActor: { type: "human", ...owner },
    owner: { actor: { type: "human", ...owner } },
    participants: participants.map((actor) => ({ type: "human" as const, ...actor })),
  };
}

describe("session activity projection", () => {
  const now = new Date(2026, 7, 17, 12).getTime();
  const rows = [
    session(
      "agent:main:release",
      "Release readiness",
      now - 60_000,
      { id: "alice", label: "Alice" },
      [{ id: "bob", label: "Bob" }],
    ),
    session(
      "agent:main:design",
      "Design review",
      now - 2 * 60 * 60_000,
      { id: "bob", label: "Bob" },
      [{ id: "alice", label: "Alice" }],
    ),
    session("agent:main:handoff", "Handoff notes", now - 26 * 60 * 60_000, {
      id: "carol",
      label: "Carol",
    }),
    session("agent:main:old", "Old planning", now - 10 * 24 * 60 * 60_000, {
      id: "dave",
      label: "Dave",
    }),
  ];

  it("counts people in the time window, filters titles and people, and groups days", () => {
    const all = projectSessionActivity(rows, { personId: null, query: "", time: "7d" }, now);
    expect(all.people.map(({ id, count }) => ({ id, count }))).toEqual([
      { id: "alice", count: 2 },
      { id: "bob", count: 2 },
      { id: "carol", count: 1 },
    ]);
    expect(all.days.map((day) => day.sessions.map((row) => row.key))).toEqual([
      ["agent:main:release", "agent:main:design"],
      ["agent:main:handoff"],
    ]);

    const filtered = projectSessionActivity(
      rows,
      { personId: "alice", query: "release", time: "7d" },
      now,
    );
    expect(filtered.sessions.map((row) => row.key)).toEqual(["agent:main:release"]);
    expect(filtered.matchedCount).toBe(1);
    expect(filtered.timeCount).toBe(3);
  });

  it("orders people by their latest activity instead of session count or online state", () => {
    const activity = projectSessionActivity(
      [
        session("agent:main:older-1", "Older one", now - 3_000, {
          id: "frequent",
          label: "Frequent",
        }),
        session("agent:main:older-2", "Older two", now - 2_000, {
          id: "frequent",
          label: "Frequent",
        }),
        session("agent:main:newest", "Newest", now - 1_000, {
          id: "recent",
          label: "Recent",
        }),
      ],
      { personId: null, query: "", time: "7d" },
      now,
    );

    expect(
      activity.people.map(({ id, count, lastActiveAt }) => ({ id, count, lastActiveAt })),
    ).toEqual([
      { id: "recent", count: 1, lastActiveAt: now - 1_000 },
      { id: "frequent", count: 2, lastActiveAt: now - 2_000 },
    ]);
  });

  it("round-trips linkable filters in a stable query order", () => {
    const search = sessionActivitySearch({
      personId: "profile/a",
      query: "release notes",
      time: "30d",
    });
    expect(search).toBe("?time=30d&person=profile%2Fa&q=release+notes");
    expect(parseSessionActivityFilters(search)).toEqual({
      personId: "profile/a",
      query: "release notes",
      time: "30d",
    });
  });
});

describe("per-person activity projection", () => {
  const rows = [
    session("agent:main:first", "First", 10, { id: "alice", label: "Alice" }),
    session("agent:main:second", "Second", 20, { id: "bob", label: "Bob" }, [
      { id: "alice", label: "Alice" },
    ]),
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
      rows,
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

  it("falls back to session actors for offline identities and rejects unknown ids", () => {
    expect(resolveActivityIdentity("alice", { presence: [] }, rows)).toMatchObject({
      id: "alice",
      name: "Alice",
      watchedSessions: [],
    });
    expect(resolveActivityIdentity("unknown", { presence: [] }, rows)).toBeNull();
  });
});
