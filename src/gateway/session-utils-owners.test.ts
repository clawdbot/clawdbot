import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionListEntryFilter } from "./session-sharing.js";

const getUserProfileDisplay = vi.hoisted(() =>
  vi.fn((profileId: string) => {
    const displayNames: Record<string, string> = {
      "profile-ada": "Ada",
      "profile-bob": "Bob",
      "profile-carol": "Bob",
      "profile-dana": "Bob",
      "profile-erin": "Bob",
      "profile:channel:opaque": "Channel Keeper",
      "shared-id": "Shared",
    };
    const displayName = displayNames[profileId];
    if (!displayName) {
      throw new Error(`unknown profile: ${profileId}`);
    }
    return {
      id: profileId,
      displayName,
      avatarRevision: profileId === "profile-ada" ? "ada-hash-png" : "42",
      hasAvatar: profileId === "profile-ada",
    };
  }),
);

vi.mock("../state/user-profiles.js", () => ({ getUserProfileDisplay }));

import { listSessionsFromStoreAsync } from "./session-utils.js";

afterEach(() => {
  vi.restoreAllMocks();
  getUserProfileDisplay.mockClear();
});

it("lets configured agents win id-only owner facet collisions", async () => {
  const actorOrders = [
    ["human", "agent"],
    ["agent", "human"],
  ] as const;
  for (const actorOrder of actorOrders) {
    const store = Object.fromEntries(
      actorOrder.map((type, index) => [
        `agent:main:${index}`,
        {
          createdActor:
            type === "human"
              ? { type, source: "profile", id: "shared-id" }
              : { type, id: "shared-id" },
          createdVia: "operator",
          sessionId: `session-${index}`,
          updatedAt: 2 - index,
        } satisfies SessionEntry,
      ]),
    );
    const result = await listSessionsFromStoreAsync({
      cfg: {
        agents: { list: [{ id: "shared-id", identity: { name: "Shared agent" } }] },
      } as OpenClawConfig,
      storePath: "/tmp/openclaw-session-owner-order",
      store,
      opts: { archived: "all" },
    });

    expect(result.owners).toEqual([
      {
        type: "agent",
        id: "shared-id",
        identity: { type: "agent", id: "shared-id" },
        label: "Shared agent",
      },
    ]);
  }
});

it("returns the complete deterministic owner facet independently of pagination", async () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:ada": {
      archivedAt: 3,
      archivedBy: { type: "human", id: "profile-bob" },
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      sessionId: "session-ada",
      updatedAt: 2,
    },
    "agent:main:bob": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      sessionId: "session-bob",
      updatedAt: 1,
    },
  };

  const result = await listSessionsFromStoreAsync({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owners",
    store,
    opts: { archived: "all", limit: 1 },
  });

  expect(result.count).toBe(1);
  expect(result.totalCount).toBe(2);
  expect(result.owners).toEqual([
    {
      type: "human",
      id: "profile-ada",
      identity: { type: "profile", id: "profile-ada" },
      label: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
    },
    {
      type: "human",
      id: "profile-bob",
      identity: { type: "profile", id: "profile-bob" },
      label: "Bob",
    },
  ]);
  expect(result.sessions[0]?.createdActor).toEqual({
    type: "human",
    id: "profile-ada",
    identity: { type: "profile", id: "profile-ada" },
    label: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
  });
  expect(result.sessions[0]?.archivedBy).toEqual({
    type: "human",
    id: "profile-bob",
    identity: { type: "profile", id: "profile-bob" },
    label: "Bob",
  });
  expect(getUserProfileDisplay).toHaveBeenCalledTimes(2);

  const filtered = await listSessionsFromStoreAsync({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owners",
    store,
    opts: { archived: "all", ownerId: "profile-bob", limit: 1 },
  });
  expect(filtered.sessions.map((row) => row.key)).toEqual(["agent:main:bob"]);
  expect(filtered.owners).toEqual(result.owners);
});

it("prepends an owner window without advancing shared-page pagination", async () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:foreign-newest": {
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      sessionId: "session-foreign-newest",
      updatedAt: 2,
    },
    "agent:main:owner-older": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      sessionId: "session-owner-older",
      updatedAt: 1,
    },
  };

  const result = await listSessionsFromStoreAsync({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owner-first",
    store,
    opts: { archived: "all", limit: 1 },
    ownerFirstActorId: "profile-bob",
  });

  expect(result.sessions.map((row) => row.key)).toEqual([
    "agent:main:owner-older",
    "agent:main:foreign-newest",
  ]);
  expect(result).toMatchObject({ count: 2, totalCount: 2, nextOffset: 1, hasMore: true });
});

it("projects only durable profiles and configured agents as effective owners", async () => {
  const cases = [
    {
      createdActor: { type: "human" as const, source: "profile" as const, id: "profile-ada" },
      ownerId: "profile-ada",
    },
    {
      createdActor: {
        type: "human" as const,
        source: "profile" as const,
        id: "profile:channel:opaque",
      },
      createdVia: "operator",
      ownerId: "profile:channel:opaque",
    },
    { createdActor: { type: "agent" as const, id: "research" }, ownerId: "research" },
    {
      createdActor: {
        type: "human" as const,
        source: "channel" as const,
        id: "discord:channel:123",
      },
    },
    { createdActor: { type: "agent" as const, id: "agent:roboclaw:discord:channel:456" } },
    { createdActor: { type: "system" as const, id: "system-import" } },
    {
      createdActor: { type: "human" as const, source: "profile" as const, id: "profile-ada" },
      createdVia: "operator",
      owner: { actor: { type: "human" as const, id: "slack:channel:789" } },
    },
  ];
  const store = Object.fromEntries(
    cases.map(({ createdActor, owner }, index) => [
      `agent:main:owner-${index}`,
      {
        createdActor,
        createdVia: "operator",
        owner,
        sessionId: `session-owner-${index}`,
        updatedAt: cases.length - index,
      } satisfies SessionEntry,
    ]),
  );
  const result = await listSessionsFromStoreAsync({
    cfg: {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "research", identity: { name: "Research" } },
        ],
      },
    } as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owner-candidates",
    store,
    opts: { archived: "all" },
  });

  expect(result.owners).toEqual([
    {
      type: "human",
      id: "profile-ada",
      identity: { type: "profile", id: "profile-ada" },
      label: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
    },
    {
      type: "human",
      id: "profile:channel:opaque",
      identity: { type: "profile", id: "profile:channel:opaque" },
      label: "Channel Keeper",
    },
    {
      type: "agent",
      id: "research",
      identity: { type: "agent", id: "research" },
      label: "Research",
    },
  ]);
  expect(
    result.sessions.map((row) => ({
      key: row.key,
      createdActor: row.createdActor && {
        type: row.createdActor.type,
        id: row.createdActor.id,
      },
      owner: row.owner && {
        type: row.owner.actor.type,
        id: row.owner.actor.id,
      },
    })),
  ).toEqual(
    cases.map(({ createdActor, ownerId }, index) => ({
      key: `agent:main:owner-${index}`,
      createdActor: { type: createdActor.type, id: createdActor.id },
      owner: ownerId ? { type: createdActor.type, id: ownerId } : undefined,
    })),
  );
});

it("filters immutable creator and effective owner separately while preserving projections", async () => {
  const store = {
    "agent:main:default-owner": {
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      sessionId: "session-default-owner",
      updatedAt: 2,
    },
    "agent:main:assigned-owner": {
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      owner: {
        actor: { type: "human", id: "profile-bob" },
        assignedBy: { type: "human", id: "profile-ada" },
        assignedAt: 10,
      },
      sessionId: "session-assigned-owner",
      updatedAt: 1,
    },
    "agent:main:other-creator": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      owner: { actor: { type: "human", id: "profile-ada" } },
      sessionId: "session-other-creator",
      updatedAt: 0,
    },
  } satisfies Record<string, SessionEntry>;
  const result = await listSessionsFromStoreAsync({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owners",
    store,
    opts: { archived: "all" },
  });

  expect(result.sessions.find((row) => row.key.endsWith(":default-owner"))).toMatchObject({
    createdActor: { id: "profile-ada", label: "Ada" },
    owner: { actor: { id: "profile-ada", label: "Ada" } },
  });
  expect(result.sessions.find((row) => row.key.endsWith(":assigned-owner"))).toMatchObject({
    createdActor: { id: "profile-ada", label: "Ada" },
    owner: {
      actor: { id: "profile-bob", label: "Bob" },
      assignedBy: { id: "profile-ada", label: "Ada" },
      assignedAt: 10,
    },
  });
  expect(result.owners).toEqual([
    {
      type: "human",
      id: "profile-ada",
      identity: { type: "profile", id: "profile-ada" },
      label: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
    },
    {
      type: "human",
      id: "profile-bob",
      identity: { type: "profile", id: "profile-bob" },
      label: "Bob",
    },
  ]);
  const creatorFiltered = await listSessionsFromStoreAsync({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owners",
    store,
    opts: { archived: "all", creatorId: "profile-ada" },
  });
  expect(creatorFiltered.sessions.map((row) => row.key)).toEqual([
    "agent:main:default-owner",
    "agent:main:assigned-owner",
  ]);
  expect(creatorFiltered.sessions.find((row) => row.key.endsWith(":assigned-owner"))).toMatchObject(
    {
      createdActor: { id: "profile-ada", label: "Ada" },
      owner: { actor: { id: "profile-bob", label: "Bob" } },
    },
  );
  const ownerFiltered = await listSessionsFromStoreAsync({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-owners",
    store,
    opts: { archived: "all", ownerId: "profile-bob" },
  });
  expect(ownerFiltered.sessions.map((row) => row.key)).toEqual(["agent:main:assigned-owner"]);
  expect(ownerFiltered.sessions[0]).toMatchObject({
    createdActor: { id: "profile-ada", label: "Ada" },
    owner: { actor: { id: "profile-bob", label: "Bob" } },
  });

  const viewer = {
    connect: { scopes: ["operator.read"] },
    authenticatedUserProfile: { profileId: "profile-ada" },
  } as GatewayClient;
  const entryFilter = createSessionListEntryFilter({ client: viewer });
  const actors = [
    { type: "human", source: "profile" },
    { type: "human", source: "channel" },
    { type: "human", source: "unknown" },
    { type: "agent" },
    { type: "system" },
  ] as const;
  for (const actor of actors) {
    const rows: Record<string, SessionEntry> = {
      "agent:main:shared": {
        sessionId: "shared",
        updatedAt: 2,
        createdVia: "cron",
        createdActor: { ...actor, id: "profile-ada" },
      },
      "agent:main:draft": {
        sessionId: "draft",
        updatedAt: 1,
        createdVia: "cron",
        createdActor: { ...actor, id: "profile-ada" },
        visibility: "draft",
      },
      "agent:main:other-creator": store["agent:main:other-creator"],
    };
    const query = {
      cfg: {},
      storePath: "/tmp/openclaw-session-owners",
      store: rows,
      opts: { creatorId: "profile-ada" },
    };
    expect
      .soft((await listSessionsFromStoreAsync(query)).sessions.map((row) => row.key))
      .toEqual(["agent:main:shared", "agent:main:draft"]);
    const authorized = await listSessionsFromStoreAsync({ ...query, entryFilter });
    expect
      .soft(authorized.sessions.map((row) => row.key))
      .toEqual(
        actor.type === "human" && actor.source === "profile"
          ? ["agent:main:shared", "agent:main:draft"]
          : ["agent:main:shared"],
      );
  }
});

it("deduplicates participants in order, excludes the owner, and filters sessions involving the viewer", async () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:owned": {
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      participants: [{ identity: { type: "profile", id: "profile-bob" } }],
      participantCount: 1,
      sessionId: "session-owned",
      updatedAt: 3,
    },
    "agent:main:participating": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      participants: [
        { identity: { type: "profile", id: "profile-bob" } },
        { identity: { type: "agent", id: "research" } },
        { identity: { type: "profile", id: "profile-carol" } },
        { identity: { type: "profile", id: "profile-dana" } },
        { identity: { type: "profile", id: "profile-erin" } },
        { identity: { type: "profile", id: "profile-ada" } },
        { identity: { type: "agent", id: "research" } },
      ],
      participantCount: 7,
      sessionId: "session-participating",
      updatedAt: 2,
    },
    "agent:main:channel-collision": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      participants: [
        {
          identity: {
            type: "observation",
            id: "profile-ada",
            pluginId: "discord",
            accountId: null,
            senderKind: "unknown",
          },
        },
      ],
      participantCount: 1,
      sessionId: "session-channel-collision",
      updatedAt: 1,
    },
    "agent:main:legacy-collision": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      participants: [
        { identity: { type: "legacy", id: "profile-ada", actorType: "human", source: null } },
      ],
      participantCount: 1,
      sessionId: "session-legacy-collision",
      updatedAt: 1,
    },
    "agent:main:unrelated": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      sessionId: "session-unrelated",
      updatedAt: 1,
    },
  };
  const cfg: OpenClawConfig = {
    agents: { list: [{ id: "research", identity: { name: "Research" } }] },
  };
  const result = await listSessionsFromStoreAsync({
    cfg,
    storePath: "/tmp/openclaw-session-participants",
    store,
    opts: { archived: "all" },
    involvingActorId: "profile-ada",
  });

  expect(result.sessions.map((row) => row.key)).toEqual([
    "agent:main:owned",
    "agent:main:participating",
  ]);
  expect(result.sessions[1]).toMatchObject({
    participants: [
      { identity: { type: "agent", id: "research" }, label: "Research" },
      { identity: { type: "profile", id: "profile-carol" }, label: "Bob" },
      { identity: { type: "profile", id: "profile-dana" }, label: "Bob" },
      { identity: { type: "profile", id: "profile-erin" }, label: "Bob" },
    ],
    participantCount: 5,
  });

  const unfiltered = await listSessionsFromStoreAsync({
    cfg,
    storePath: "/tmp/openclaw-session-participants",
    store,
    opts: { archived: "all" },
  });
  expect(unfiltered.sessions.find((row) => row.key.endsWith(":channel-collision"))).toMatchObject({
    participants: [{ identity: { type: "observation", id: "profile-ada" } }],
  });
  expect(unfiltered.sessions.find((row) => row.key.endsWith(":legacy-collision"))).toMatchObject({
    participants: [{ identity: { type: "legacy", id: "profile-ada" } }],
  });
  for (const suffix of [":legacy-collision", ":channel-collision"]) {
    const participant = unfiltered.sessions.find((row) => row.key.endsWith(suffix))
      ?.participants?.[0];
    expect(participant).not.toHaveProperty("label");
    expect(participant).not.toHaveProperty("avatarUrl");
  }
  const selected = await listSessionsFromStoreAsync({
    cfg,
    storePath: "/tmp/openclaw-session-participants",
    store,
    opts: { archived: "all", includePeople: true, involvingProfileId: "profile-ada", limit: 1 },
  });
  expect(selected.totalCount).toBe(2);
  expect(
    selected.people?.find((person) => person.identity.id === "profile-ada")?.sessionCount,
  ).toBe(2);
  expect(selected.people?.some((person) => person.identity.id === "research")).toBe(false);
});

it.each(["spawn", "talk", "cron"] as const)(
  "associates a required %s creator without inventing profile contributions or promoting unqualified creators",
  async (via) => {
    getUserProfileDisplay.mockImplementation((id) => ({
      id: id === "former" ? "current" : id,
      displayName: "Current",
      hasAvatar: false,
      avatarRevision: "1",
    }));
    const childKey = "agent:main:delegated";
    const child: SessionEntry = {
      ...buildSessionCreationStamp({
        via,
        ...inheritSessionCreationPolicy(
          { createdActor: { type: "human", source: "profile", id: "former" }, sandbox: "required" },
          { type: "agent", id: "research" },
        ),
        now: 1,
      }),
      sessionId: "delegated",
      updatedAt: 0,
      participants: [{ identity: { type: "agent", id: "research" } }],
      participantCount: 1,
    };
    const store: Record<string, SessionEntry> = {
      "agent:main:historical": {
        sessionId: "historical",
        updatedAt: 1,
        participants: [
          { identity: { type: "profile", id: "former" } },
          { identity: { type: "profile", id: "current" } },
        ],
      },
      [childKey]: child,
    };
    const unqualified = [
      ["channel", undefined],
      ["channel", "required"],
      ["spawn", undefined],
      ["talk", undefined],
      ["cron", undefined],
      ["plugin", "required"],
      ["internal", "required"],
      [undefined, "required"],
    ] as const;
    for (const [index, [createdVia, sandbox]] of unqualified.entries()) {
      store[`agent:main:unqualified-${index}`] = {
        sessionId: `unqualified-${index}`,
        updatedAt: 2,
        createdVia,
        sandbox,
        createdActor: { type: "human", source: "unknown", id: "current" },
      };
    }
    const query = {
      cfg: { agents: { list: [{ id: "main" }, { id: "research" }] } },
      storePath: "/tmp/openclaw-session-profile-alias",
      store,
      opts: { archived: "all" as const, includePeople: true },
    };
    const all = await listSessionsFromStoreAsync(query);
    const creator = {
      type: "human",
      id: "former",
      identity: { type: "profile", id: "current" },
      label: "Current",
    };
    expect(all.sessions.find((row) => row.key === childKey)).toMatchObject({
      createdActor: creator,
      owner: { actor: creator },
      participants: [{ identity: { type: "agent", id: "research" } }],
      participantCount: 1,
    });
    expect(all.owners).toEqual([creator]);
    for (const row of all.sessions.filter((candidate) => candidate.key.includes(":unqualified-"))) {
      expect(row.createdActor).toEqual({
        type: "human",
        id: "current",
        identity: { type: "legacy", actorType: "human", source: null, id: "current" },
      });
      expect(row.owner).toBeUndefined();
    }
    const involving = await listSessionsFromStoreAsync({ ...query, involvingActorId: "current" });
    expect(involving.sessions.map((row) => row.key)).toEqual(["agent:main:historical", childKey]);
    expect(involving.sessions[0]?.participants).toEqual([
      { identity: { type: "profile", id: "current" }, label: "Current" },
    ]);
    expect(involving.people).toEqual([
      { identity: { type: "profile", id: "current" }, label: "Current", sessionCount: 2 },
    ]);
    const ownerFirst = await listSessionsFromStoreAsync({
      ...query,
      opts: { archived: "all", limit: 1 },
      ownerFirstActorId: "current",
    });
    expect(ownerFirst.sessions[0]?.key).toBe(childKey);

    // Reassignment must not erase the creator's Activity association or fabricate their input.
    child.owner = { actor: { type: "agent", id: "main" } };
    const associated = await listSessionsFromStoreAsync({
      ...query,
      opts: { ...query.opts, involvingProfileId: "former" },
    });
    expect(associated.sessions.map((row) => row.key)).toEqual(["agent:main:historical", childKey]);
    expect(associated.involvingProfileId).toBe("current");
    expect(associated.sessions[1]?.participants).toEqual([
      { identity: { type: "agent", id: "research" } },
    ]);
    expect(child.createdActor).toEqual({ type: "human", source: "profile", id: "former" });
    expect(child.participants).toEqual([{ identity: { type: "agent", id: "research" } }]);
  },
);

it("returns a canonical selected person and orders merged owners without borrowing remote identities", async () => {
  getUserProfileDisplay.mockImplementation((id) => ({
    id: id === "former" ? "current" : id,
    displayName: id,
    hasAvatar: false,
    avatarRevision: "1",
  }));
  const store: Record<string, SessionEntry> = Object.fromEntries(
    Array.from({ length: 65 }, (_, i) => [
      `agent:main:other-${i}`,
      {
        sessionId: `other-${i}`,
        updatedAt: 100 + i,
        participants: [{ identity: { type: "profile", id: `person-${i}` } }],
      },
    ]),
  );
  store["agent:main:owned"] = {
    sessionId: "owned",
    updatedAt: 1,
    owner: { actor: { type: "human", id: "former" } },
  };
  const query = {
    cfg: {},
    storePath: "/tmp/openclaw-session-selected-person",
    store,
    opts: { archived: "all" as const, includePeople: true, involvingProfileId: "former", limit: 1 },
  };
  const result = await listSessionsFromStoreAsync(query);
  expect(result).toMatchObject({
    involvingProfileId: "current",
    totalCount: 1,
    peopleIncomplete: true,
  });
  expect(result.people?.some((person) => person.identity.id === "current")).toBe(true);
  const ordered = await listSessionsFromStoreAsync({
    ...query,
    opts: { archived: "all", limit: 1 },
    ownerFirstActorId: "current",
  });
  expect(ordered.sessions[0]?.key).toBe("agent:main:owned");
  const involved = await listSessionsFromStoreAsync({
    ...query,
    opts: { archived: "all" },
    involvingActorId: "current",
  });
  expect(involved.sessions.map((row) => row.key)).toEqual(["agent:main:owned"]);
});

it("reports the authoritative admission bound even when the visible participant list is smaller", async () => {
  const result = await listSessionsFromStoreAsync({
    cfg: {},
    storePath: "/tmp/openclaw-session-bound",
    store: {
      "agent:main:capped": {
        sessionId: "capped",
        updatedAt: 1,
        participantCount: 32,
        participants: Array.from({ length: 31 }, (_, i) => ({
          identity: {
            type: "remote",
            pluginId: "test",
            domain: "workspace",
            idKind: "user",
            id: String(i),
          },
        })),
      },
    },
    opts: { includePeople: true },
  });
  expect(result.people).toEqual([]);
  expect(result.peopleIncomplete).toBe(true);
});

it("preserves list output across visibility, scope, owner, and search filters", async () => {
  const now = 1_000_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  getUserProfileDisplay.mockImplementation((profileId: string) => ({
    id: profileId,
    displayName:
      profileId === "profile-ada" ? "Ada" : profileId === "profile-bob" ? "Bob" : "Carol",
    avatarRevision: String(now),
    hasAvatar: false,
  }));
  const cfg = {
    agents: {
      list: [{ id: "main", default: true }, { id: "work" }],
    },
  } as OpenClawConfig;
  const store: Record<string, SessionEntry> = {
    global: {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      sessionId: "session-global",
      subject: "needle global",
      updatedAt: now - 1,
    },
    unknown: {
      createdActor: { type: "system", id: "system-import" },
      sessionId: "session-unknown",
      subject: "needle unknown",
      updatedAt: now - 2,
    },
    "agent:main:shared": {
      boardFace: "chat",
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      label: "focus",
      lastInteractionAt: now - 5,
      sessionId: "session-main-shared",
      subject: "needle main",
      updatedAt: now - 3,
      visibility: "shared",
    },
    "agent:main:draft": {
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      createdVia: "operator",
      sessionId: "session-main-draft",
      subject: "needle hidden draft",
      updatedAt: now - 4,
      visibility: "draft",
    },
    "agent:work:shared": {
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      sessionId: "session-work-shared",
      subject: "needle work",
      updatedAt: now - 5,
      visibility: "shared",
    },
    "agent:main:archived": {
      archivedAt: now - 10,
      createdActor: { type: "human", source: "profile", id: "profile-bob" },
      createdVia: "operator",
      sessionId: "session-main-archived",
      subject: "needle archived",
      updatedAt: now - 7,
      visibility: "shared",
    },
    "agent:main:sessions": {} as SessionEntry,
  };
  const viewer = {
    authenticatedUserId: "profile-viewer",
    authenticatedUserProfile: {
      displayName: "Viewer",
      hasAvatar: false,
      profileId: "profile-viewer",
      updatedAt: now,
    },
    connect: {
      client: {
        id: "openclaw-control-ui",
        mode: "webchat",
        platform: "test",
        version: "test",
      },
      maxProtocol: 1,
      minProtocol: 1,
      role: "operator",
      scopes: ["operator.read"],
    },
  } as GatewayClient;
  const entryFilter = createSessionListEntryFilter({ client: viewer });

  const project = async (opts: Parameters<typeof listSessionsFromStoreAsync>[0]["opts"]) => {
    const result = await listSessionsFromStoreAsync({
      cfg,
      ...(entryFilter ? { entryFilter } : {}),
      opts,
      store,
      storePath: "/tmp/openclaw-session-filter-parity",
    });
    return {
      count: result.count,
      owners: result.owners,
      hasMore: result.hasMore,
      keys: result.sessions.map((row) => row.key),
      nextOffset: result.nextOffset,
      totalCount: result.totalCount,
    };
  };

  // These exact projections were captured from the pre-refactor chained-filter implementation.
  expect(
    JSON.stringify(
      await project({
        archived: "all",
        includeGlobal: true,
        includeUnknown: true,
        search: "needle",
      }),
    ),
  ).toBe(
    JSON.stringify({
      count: 5,
      owners: [
        {
          type: "human",
          id: "profile-ada",
          identity: { type: "profile", id: "profile-ada" },
          label: "Ada",
        },
        {
          type: "human",
          id: "profile-bob",
          identity: { type: "profile", id: "profile-bob" },
          label: "Bob",
        },
      ],
      hasMore: false,
      keys: ["global", "unknown", "agent:main:shared", "agent:work:shared", "agent:main:archived"],
      nextOffset: null,
      totalCount: 5,
    }),
  );
  expect(
    JSON.stringify(
      await project({
        agentId: "main",
        archived: "all",
        ownerId: "profile-bob",
        includeGlobal: true,
        includeUnknown: true,
        search: "needle",
      }),
    ),
  ).toBe(
    JSON.stringify({
      count: 2,
      owners: [
        {
          type: "human",
          id: "profile-ada",
          identity: { type: "profile", id: "profile-ada" },
          label: "Ada",
        },
        {
          type: "human",
          id: "profile-bob",
          identity: { type: "profile", id: "profile-bob" },
          label: "Bob",
        },
      ],
      hasMore: false,
      keys: ["global", "agent:main:archived"],
      nextOffset: null,
      totalCount: 2,
    }),
  );
});

it("keeps the serialized list response deterministic for the current filter path", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const result = await listSessionsFromStoreAsync({
    modelCatalog: [
      {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "openai",
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ],
    cfg: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [{ id: "main", default: true, model: { primary: "openai/gpt-5.4" } }],
      },
    } as OpenClawConfig,
    opts: { archived: "all", includeGlobal: true, search: "needle" },
    store: {
      global: {
        agentHarnessId: "codex",
        contextTokens: 100,
        contextTokensSource: "runtime",
        createdActor: { type: "system", id: "creator-b" },
        estimatedCostUsd: 0,
        model: "gpt-5.4",
        modelProvider: "openai",
        sessionId: "session-global",
        subject: "needle global",
        totalTokens: 1,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        updatedAt: 999_999,
      },
    },
    storePath: "/tmp/openclaw-session-byte-parity",
  });
  const expectedSerializedResponse = [
    '{"ts":1000000,"path":"/tmp/openclaw-session-byte-parity","count":1,"totalCount":1,"limitApplied":100,"nextOffset":null,"hasMore":false,"owners":[]',
    ',"defaults":{"modelProvider":"openai","model":"gpt-5.4","contextTokens":200000,"agentRuntime":{"id":"codex","cloudPlacementSupported":false,"devicePlacementSupported":false,"source":"implicit"},"thinkingLevels":[{"id":"off","label":"off"},{"id":"minimal","label":"minimal"},{"id":"low","label":"low"},{"id":"medium","label":"medium"},{"id":"high","label":"high"},{"id":"xhigh","label":"xhigh"}],"thinkingOptions":["off","minimal","low","medium","high","xhigh"],"thinkingDefault":"off"}',
    ',"sessions":[{"key":"global","visibility":"shared","createdActor":{"type":"system","id":"creator-b","identity":{"type":"legacy","actorType":"system","source":null,"id":"creator-b"}},"kind":"global","classification":"global","agentId":"main","isMain":false,"isBackground":false,"subject":"needle global","updatedAt":999999,"archived":false,"pinned":false,"unread":false,"sessionId":"session-global","thinkingLevels":[{"id":"off","label":"off"},{"id":"minimal","label":"minimal"},{"id":"low","label":"low"},{"id":"medium","label":"medium"},{"id":"high","label":"high"},{"id":"xhigh","label":"xhigh"}],"thinkingOptions":["off","minimal","low","medium","high","xhigh"],"thinkingDefault":"off","effectiveFastMode":false,"effectiveFastModeSource":"default","fastAutoOnSeconds":60,"totalTokens":1,"totalTokensFresh":true,"estimatedCostUsd":0,"effectiveResponseUsage":"off","effectiveQueueMode":"steer","modelProvider":"openai","model":"gpt-5.4","modelOverrideSource":null,"agentRuntime":{"id":"codex","cloudPlacementSupported":false,"devicePlacementSupported":false,"source":"implicit"},"contextTokens":100}]}',
  ].join("");

  expect(JSON.stringify(result)).toBe(expectedSerializedResponse);
});
