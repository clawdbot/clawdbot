import { afterEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionListEntryFilter } from "./session-sharing.js";

const getUserProfileDisplay = vi.hoisted(() =>
  vi.fn((profileId: string) => ({
    id: profileId,
    displayName: profileId === "profile-ada" ? "Ada" : "Bob",
    avatarRevision: profileId === "profile-ada" ? "ada-hash-png" : "42",
    hasAvatar: profileId === "profile-ada",
  })),
);

vi.mock("../state/user-profiles.js", () => ({ getUserProfileDisplay }));
vi.mock("./session-utils-row.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils-row.js")>();
  return {
    ...actual,
    projectSessionActor: (
      actor: Parameters<typeof actual.projectSessionActor>[0],
      identities: Parameters<typeof actual.projectSessionActor>[1],
      cfg: Parameters<typeof actual.projectSessionActor>[2],
    ) => {
      if (actor?.id === "shared-id") {
        return actor.type === "human"
          ? { type: actor.type, id: actor.id, label: "Alpha" }
          : { type: actor.type, id: actor.id, label: "Zulu", avatarUrl: "/avatar" };
      }
      if (actor?.id === "unicode-id") {
        return {
          type: actor.type,
          id: actor.id,
          label: actor.type === "human" ? "é" : "e\u0301",
        };
      }
      return actual.projectSessionActor(actor, identities, cfg);
    },
  };
});

import { listSessionsFromStore, listSessionsFromStoreAsync } from "./session-utils.js";

afterEach(() => {
  vi.restoreAllMocks();
  getUserProfileDisplay.mockClear();
});

it("keeps creator labels and avatars stable across actor order", () => {
  const actorOrders = [
    ["human", "agent"],
    ["agent", "human"],
  ] as const;
  for (const actorOrder of actorOrders) {
    const store = Object.fromEntries(
      actorOrder.map((type, index) => [
        `agent:main:${index}`,
        {
          createdActor: { type, id: "shared-id" },
          sessionId: `session-${index}`,
          updatedAt: 2 - index,
        } satisfies SessionEntry,
      ]),
    );
    const result = listSessionsFromStore({
      cfg: {} as OpenClawConfig,
      storePath: "/tmp/openclaw-session-creator-order",
      store,
      opts: { archived: "all" },
    });

    expect(result.creators).toEqual([{ id: "shared-id", label: "Alpha", avatarUrl: "/avatar" }]);
  }
});

it("breaks locale-equivalent creator label ties deterministically", () => {
  for (const actorOrder of [
    ["human", "agent"],
    ["agent", "human"],
  ] as const) {
    const store = Object.fromEntries(
      actorOrder.map((type, index) => [
        `agent:main:unicode-${index}`,
        {
          createdActor: { type, id: "unicode-id" },
          sessionId: `unicode-session-${index}`,
          updatedAt: 2 - index,
        } satisfies SessionEntry,
      ]),
    );
    const result = listSessionsFromStore({
      cfg: {} as OpenClawConfig,
      storePath: "/tmp/openclaw-session-creator-unicode-order",
      store,
      opts: { archived: "all" },
    });

    expect(result.creators).toEqual([{ id: "unicode-id", label: "e\u0301" }]);
  }
});

it("returns the complete deterministic creator facet independently of pagination", () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:ada": {
      archivedAt: 3,
      archivedBy: { type: "human", id: "profile-bob" },
      createdActor: { type: "human", id: "profile-ada" },
      sessionId: "session-ada",
      updatedAt: 2,
    },
    "agent:main:bob": {
      createdActor: { type: "human", id: "profile-bob" },
      sessionId: "session-bob",
      updatedAt: 1,
    },
  };

  const result = listSessionsFromStore({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-creators",
    store,
    opts: { archived: "all", limit: 1 },
  });

  expect(result.count).toBe(1);
  expect(result.totalCount).toBe(2);
  expect(result.creators).toEqual([
    {
      id: "profile-ada",
      label: "Ada",
      avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
    },
    { id: "profile-bob", label: "Bob" },
  ]);
  expect(result.sessions[0]?.createdActor).toEqual({
    type: "human",
    id: "profile-ada",
    label: "Ada",
    avatarUrl: "/api/users/profile-ada/avatar?v=ada-hash-png",
  });
  expect(result.sessions[0]?.archivedBy).toEqual({
    type: "human",
    id: "profile-bob",
    label: "Bob",
  });
  expect(getUserProfileDisplay).toHaveBeenCalledTimes(2);

  const filtered = listSessionsFromStore({
    cfg: {} as OpenClawConfig,
    storePath: "/tmp/openclaw-session-creators",
    store,
    opts: { archived: "all", creatorId: "profile-bob", limit: 1 },
  });
  expect(filtered.sessions.map((row) => row.key)).toEqual(["agent:main:bob"]);
  expect(filtered.creators).toEqual(result.creators);
});

it("preserves legacy list output across visibility, scope, creator, and search filters", async () => {
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
      createdActor: { type: "human", id: "profile-bob" },
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
      createdActor: { type: "human", id: "profile-ada" },
      label: "focus",
      lastInteractionAt: now - 5,
      sessionId: "session-main-shared",
      subject: "needle main",
      updatedAt: now - 3,
      visibility: "shared",
    },
    "agent:main:draft": {
      createdActor: { type: "human", id: "profile-ada" },
      sessionId: "session-main-draft",
      subject: "needle hidden draft",
      updatedAt: now - 4,
      visibility: "draft",
    },
    "agent:work:shared": {
      createdActor: { type: "human", id: "profile-bob" },
      sessionId: "session-work-shared",
      subject: "needle work",
      updatedAt: now - 5,
      visibility: "shared",
    },
    "agent:main:archived": {
      archivedAt: now - 10,
      createdActor: { type: "human", id: "profile-bob" },
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

  const project = async (opts: Parameters<typeof listSessionsFromStore>[0]["opts"]) => {
    const result = await listSessionsFromStoreAsync({
      cfg,
      ...(entryFilter ? { entryFilter } : {}),
      opts,
      store,
      storePath: "/tmp/openclaw-session-filter-parity",
    });
    return {
      count: result.count,
      creators: result.creators,
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
      creators: [
        { id: "profile-ada", label: "Ada" },
        { id: "profile-bob", label: "Bob" },
        { id: "system-import" },
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
        creatorId: "profile-bob",
        includeGlobal: true,
        includeUnknown: true,
        search: "needle",
      }),
    ),
  ).toBe(
    JSON.stringify({
      count: 2,
      creators: [
        { id: "profile-ada", label: "Ada" },
        { id: "profile-bob", label: "Bob" },
      ],
      hasMore: false,
      keys: ["global", "agent:main:archived"],
      nextOffset: null,
      totalCount: 2,
    }),
  );
});

it("keeps the serialized list response deterministic for the current filter path", () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const result = listSessionsFromStore({
    cfg: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [{ id: "main", default: true, model: { primary: "openai/gpt-5.4" } }],
      },
    } as OpenClawConfig,
    opts: { archived: "all", includeGlobal: true, search: "needle" },
    store: {
      global: {
        contextTokens: 100,
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
    '{"ts":1000000,"path":"/tmp/openclaw-session-byte-parity","count":1,"totalCount":1,"limitApplied":100,"nextOffset":null,"hasMore":false,"creators":[{"id":"creator-b"}]',
    ',"defaults":{"modelProvider":"openai","model":"gpt-5.4","contextTokens":200000,"agentRuntime":{"id":"codex","cloudPlacementSupported":false,"source":"implicit"},"thinkingLevels":[{"id":"off","label":"off"},{"id":"minimal","label":"minimal"},{"id":"low","label":"low"},{"id":"medium","label":"medium"},{"id":"high","label":"high"},{"id":"xhigh","label":"xhigh"}],"thinkingOptions":["off","minimal","low","medium","high","xhigh"],"thinkingDefault":"off"}',
    ',"sessions":[{"key":"global","visibility":"shared","createdActor":{"type":"system","id":"creator-b"},"kind":"global","classification":"global","agentId":"main","isMain":false,"isBackground":false,"subject":"needle global","updatedAt":999999,"archived":false,"pinned":false,"unread":false,"sessionId":"session-global","thinkingLevels":[{"id":"off","label":"off"},{"id":"minimal","label":"minimal"},{"id":"low","label":"low"},{"id":"medium","label":"medium"},{"id":"high","label":"high"},{"id":"xhigh","label":"xhigh"}],"thinkingOptions":["off","minimal","low","medium","high","xhigh"],"thinkingDefault":"off","effectiveFastMode":false,"effectiveFastModeSource":"default","fastAutoOnSeconds":60,"totalTokens":1,"totalTokensFresh":true,"estimatedCostUsd":0,"effectiveResponseUsage":"off","effectiveQueueMode":"steer","modelProvider":"openai","model":"gpt-5.4","agentRuntime":{"id":"codex","source":"implicit"},"contextTokens":100}]}',
  ].join("");

  expect(JSON.stringify(result)).toBe(expectedSerializedResponse);
});
