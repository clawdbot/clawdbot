import { expect, it } from "vitest";
import {
  hasSessionPresenceViewers,
  presenceUserLabel,
  projectOnlinePresenceViewers,
  projectPresencePayload,
  projectPresenceViewers,
} from "./presence-users.ts";

it.each([
  [{ id: "gateway-owner" }, { name: "Shared owner", isSharedOwner: true }],
  [
    { id: "gateway-owner", name: "Saved owner name" },
    { name: "Shared owner", isSharedOwner: true },
  ],
  [
    { id: "person", name: "Example person", email: "person@example.test" },
    { name: "Example person", isSharedOwner: false },
  ],
  [
    { id: "person", email: "person@example.test" },
    { name: "person@example.test", isSharedOwner: false },
  ],
  [{ id: "person" }, { name: "person", isSharedOwner: false }],
])("labels presence without presenting the shared identity as a person: %j", (user, expected) => {
  expect(presenceUserLabel(user)).toEqual(expected);
});

it("isolates namespaces while merging renamed tabs and excluding disconnected facts", () => {
  const id = "synthetic-shared-id";
  const profile = { id, identity: { type: "profile" as const, id }, name: "Profile person" };
  const raw = { id, name: "Unqualified sender" };
  const presence = [
    { instanceId: "profile-tab", user: profile, watchedSessions: ["profile-session"] },
    { instanceId: "raw-tab", user: raw, watchedSessions: ["raw-session"] },
    {
      instanceId: "profile-tab-2",
      user: { ...profile, name: "Renamed profile" },
      watchedSessions: ["profile-extra"],
    },
    {
      instanceId: "raw-tab-2",
      user: { ...raw, name: "Updated raw" },
      watchedSessions: ["raw-extra"],
    },
    { instanceId: "closed", user: raw, reason: "disconnect", watchedSessions: ["closed-session"] },
  ];
  const forward = projectPresencePayload({ presence });
  expect(forward.users).toHaveLength(2);
  expect(
    forward.users.map(({ id: userId, identity, name, watchedSessions, entries }) => ({
      id: userId,
      identity,
      name,
      watchedSessions,
      tabs: entries?.length,
    })),
  ).toEqual([
    {
      id,
      identity: profile.identity,
      name: profile.name,
      watchedSessions: ["profile-extra", "profile-session"],
      tabs: 2,
    },
    {
      id,
      identity: undefined,
      name: raw.name,
      watchedSessions: ["raw-extra", "raw-session"],
      tabs: 2,
    },
  ]);
  expect(projectPresencePayload({ presence: presence.toReversed() })).toEqual(forward);
});

it.each([true, false])(
  "excludes only self's current namespace for an unchanged payload (profile: %s)",
  (qualified) => {
    const id = "synthetic-shared-id";
    const profile = { id, identity: { type: "profile" as const, id }, name: "Same label" };
    const raw = { id, identity: undefined, name: "Same label" };
    const payload = {
      presence: [
        { instanceId: "profile-tab", user: profile, watchedSessions: ["profile-session"] },
        { instanceId: "raw-tab", user: raw, watchedSessions: ["raw-session"] },
      ],
    };
    const self = qualified ? profile : raw;
    const other = qualified ? raw : profile;
    const instance = qualified ? "profile-tab" : "raw-tab";
    const otherSession = qualified ? "raw-session" : "profile-session";
    // An unchanged payload must still exclude the current self qualification.
    projectOnlinePresenceViewers(payload, other);
    for (const [explicitSelf, fallbackInstance] of [
      [self, undefined],
      [undefined, instance],
      [self, qualified ? "raw-tab" : "profile-tab"],
    ] as const) {
      const viewers = projectOnlinePresenceViewers(payload, explicitSelf, fallbackInstance);
      expect(viewers).toHaveLength(1);
      expect(viewers[0]?.identity).toEqual(other.identity);
      expect(hasSessionPresenceViewers(payload, explicitSelf, fallbackInstance, otherSession)).toBe(
        true,
      );
      expect(
        hasSessionPresenceViewers(
          payload,
          explicitSelf,
          fallbackInstance,
          qualified ? "profile-session" : "raw-session",
        ),
      ).toBe(false);
    }
    expect(projectOnlinePresenceViewers(payload).map((user) => user.identity)).toEqual([
      profile.identity,
      undefined,
    ]);
  },
);

it.each([
  { type: "profile" as const, id: "same" },
  { type: "agent" as const, id: "same" },
  { type: "legacy" as const, actorType: "human", source: "channel", id: "same" },
  undefined,
])("deduplicates only a rendered profile owner: %j", (identity) => {
  const payload = {
    presence: [
      {
        user: { id: "same", identity: { type: "profile" as const, id: "same" } },
        watchedSessions: ["session"],
      },
      { user: { id: "same" }, watchedSessions: ["session"] },
    ],
  };
  const viewers = projectPresenceViewers(
    payload,
    undefined,
    undefined,
    "session",
    identity ? [identity] : [],
  );
  expect(viewers.map((user) => user.identity)).toEqual(
    identity?.type === "profile" ? [undefined] : [payload.presence[0]!.user.identity, undefined],
  );
});
