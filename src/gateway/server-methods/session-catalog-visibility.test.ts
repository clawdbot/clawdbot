import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};
type TestClient = {
  connect: { scopes: string[] };
  connId?: string;
  authenticatedUserProfile?: { profileId: string };
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  getUserProfileRole: vi.fn((): string | null => null),
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  listSessionEntriesReadOnly: vi.fn(
    (): Array<{
      sessionKey: string;
      entry: {
        createdActor?: { type: "human"; id: string };
        incognito?: true;
        updatedAt?: number;
        visibility?: "shared" | "draft";
      };
    }> => [],
  ),
  resolveSessionSharingRole: vi.fn(() => "viewer" as "viewer" | "member"),
  resolveSessionSharingTarget: vi.fn(() => null as Record<string, unknown> | null),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly,
}));
vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileRole: hoisted.getUserProfileRole,
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
}));
vi.mock("../session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-sharing.js")>()),
  resolveSessionSharingRole: hoisted.resolveSessionSharingRole,
  resolveSessionSharingTarget: hoisted.resolveSessionSharingTarget,
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");

function client(profileId: string, scopes = ["operator.read", "operator.write"]): TestClient {
  return { connect: { scopes }, authenticatedUserProfile: { profileId } };
}

function unprofiledClient(scopes = ["operator.read", "operator.write"]): TestClient {
  return { connect: { scopes } };
}

function session(threadId: string, sessionKey?: string) {
  return {
    threadId,
    status: "stored",
    archived: false,
    ...(sessionKey ? { sessionKey } : {}),
    canContinue: true,
    canArchive: true,
  };
}

function host(sessions: ReturnType<typeof session>[], nextCursor?: string) {
  return {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway" as const,
    connected: true,
    sessions,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function provider(overrides: Partial<SessionCatalogProvider> = {}): SessionCatalogProvider {
  return {
    id: "codex",
    label: "Codex",
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: Record<string, unknown>,
  requestClient: TestClient,
  config: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await sessionCatalogHandlers[method]?.({
    params,
    respond,
    client: requestClient,
    context: { getRuntimeConfig: () => config, ...contextOverrides },
  } as never);
  return respond;
}

function setActors(entries: Array<[sessionKey: string, profileId: string]>) {
  hoisted.listSessionEntriesReadOnly.mockReturnValue(
    entries.map(([sessionKey, profileId], index) => ({
      sessionKey,
      entry: { createdActor: { type: "human", id: profileId }, updatedAt: entries.length - index },
    })),
  );
}

function roleConfig(others: "none" | "view" | "suggest" | "write", agents: "*" | string[] = "*") {
  return {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others },
            agents,
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
}

describe("session catalog caller visibility", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    hoisted.getUserProfileRole.mockReset().mockReturnValue(null);
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
    hoisted.resolveSessionSharingRole.mockReset().mockReturnValue("viewer");
    hoisted.resolveSessionSharingTarget.mockReset().mockReturnValue(null);
  });

  it("filters streamed and final rows to the caller's adopted sessions", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([
      ["agent:main:owned", "profile-owner"],
      ["agent:main:other", "profile-other"],
    ]);
    const listedHost = host([
      session("owned-thread", "agent:main:owned"),
      session("other-thread", "agent:main:other"),
      session("unadopted-thread"),
    ]);
    const broadcastToConnIds = vi.fn();
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async ({ onHost }) => {
            onHost?.(listedHost);
            return [listedHost];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "profile-progress" },
      { ...client("profile-owner"), connId: "owner-conn" },
      {},
      { broadcastToConnIds },
    );
    const visible = [expect.objectContaining({ threadId: "owned-thread" })];

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      expect.objectContaining({
        catalog: expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: visible })],
        }),
      }),
      new Set(["owner-conn"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: visible })],
        }),
      ],
    });
  });

  it("rejects hidden targets before read, continue, or archive dispatch", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([["agent:main:other", "profile-other"]]);
    const list = vi.fn(async () => [host([session("other-thread", "agent:main:other")])]);
    const read = vi.fn(async () => ({
      hostId: "gateway:local",
      threadId: "other-thread",
      items: [],
    }));
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:other" }));
    const archive = vi.fn(async () => ({ ok: true as const }));
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list, read, continueSession, archive }) },
    ];

    for (const [method, params] of [
      ["sessions.catalog.read", {}],
      ["sessions.catalog.continue", {}],
      ["sessions.catalog.archive", { confirmNoOtherRunner: true }],
    ] as const) {
      const respond = await call(
        method,
        { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread", ...params },
        client("profile-owner"),
      );
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          message: "session catalog thread is not visible to this caller",
        }),
      );
    }
    expect(read).not.toHaveBeenCalled();
    expect(continueSession).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("hides every row from an unprofiled multi-identity caller", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const listedHost = host([session("unadopted-thread")]);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list: vi.fn(async () => [listedHost]) }) },
    ];

    const listed = await call("sessions.catalog.list", {}, unprofiledClient());

    expect(listed).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: [] })],
        }),
      ],
    });
  });

  it("rejects reads for an unprofiled multi-identity caller", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const read = vi.fn(async () => ({
      hostId: "gateway:local",
      threadId: "unadopted-thread",
      items: [{ type: "userMessage" as const, text: "private host history" }],
    }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [host([session("unadopted-thread")])]),
          read,
        }),
      },
    ];

    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "unadopted-thread" },
      unprofiledClient(),
    );

    expect(transcript).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        message: "session catalog thread is not visible to this caller",
      }),
    );
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { label: "admin", multiple: true, scopes: ["operator.admin"] },
    { label: "solo Gateway", multiple: false, scopes: ["operator.read"] },
  ])("keeps $label list and read responses unfiltered", async ({ multiple, scopes }) => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(multiple);
    const listedHost = host([session("unadopted-thread")]);
    const readResult = {
      hostId: "gateway:local",
      threadId: "unadopted-thread",
      items: [{ type: "userMessage" as const, text: "host history" }],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [listedHost]),
          read: vi.fn(async () => readResult),
        }),
      },
    ];
    const requestClient = client("profile-owner", scopes);

    const listed = await call("sessions.catalog.list", {}, requestClient);
    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "unadopted-thread" },
      requestClient,
    );

    expect(listed).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ hosts: [listedHost] })],
    });
    expect(transcript).toHaveBeenCalledWith(true, readResult);
  });

  it("lets an identified owner list and read their adopted row", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([["agent:main:owned", "profile-owner"]]);
    const listedHost = host([session("owned-thread", "agent:main:owned")]);
    const readResult = { hostId: "gateway:local", threadId: "owned-thread", items: [] };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [listedHost]),
          read: vi.fn(async () => readResult),
        }),
      },
    ];
    const owner = client("profile-owner");

    const listed = await call("sessions.catalog.list", {}, owner);
    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "owned-thread" },
      owner,
    );

    expect(listed).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        catalogs: [
          expect.objectContaining({
            hosts: [
              expect.objectContaining({
                sessions: [
                  expect.objectContaining({
                    threadId: "owned-thread",
                    createdActor: { type: "human", id: "profile-owner" },
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    expect(transcript).toHaveBeenCalledWith(true, readResult);
  });

  it("pages before authorizing an older owner thread", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([
      ["agent:main:other", "profile-other"],
      ["agent:main:owned", "profile-owner"],
    ]);
    const list = vi.fn(async ({ cursors }: { cursors?: Record<string, string> }) => [
      cursors
        ? host([session("owned-thread", "agent:main:owned")])
        : host([session("other-thread", "agent:main:other")], "page-2"),
    ]);
    const readResult = { hostId: "gateway:local", threadId: "owned-thread", items: [] };
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list: list as never, read: vi.fn(async () => readResult) }) },
    ];

    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "owned-thread" },
      client("profile-owner"),
    );

    expect(transcript).toHaveBeenCalledWith(true, readResult);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursors: { "gateway:local": "page-2" } }),
    );
  });

  it("isolates settled list cache entries between identities", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    setActors([
      ["agent:main:alpha", "profile-alpha"],
      ["agent:main:beta", "profile-beta"],
    ]);
    const list = vi.fn(async () => [
      host([
        session("alpha-thread", "agent:main:alpha"),
        session("beta-thread", "agent:main:beta"),
        session("unadopted-thread"),
      ]),
    ]);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider({ list }) }];
    const config = {};

    const alpha = await call("sessions.catalog.list", {}, client("profile-alpha"), config);
    const unprofiled = await call("sessions.catalog.list", {}, unprofiledClient(), config);
    const beta = await call("sessions.catalog.list", {}, client("profile-beta"), config);
    const rows = (respond: ReturnType<typeof vi.fn>) =>
      respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions.map(
        (item: { threadId: string }) => item.threadId,
      );

    expect(rows(alpha)).toEqual(["alpha-thread"]);
    expect(rows(unprofiled)).toEqual([]);
    expect(rows(beta)).toEqual(["beta-thread"]);
    expect(list).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "keeps a none role owner-only with multiple identities = %s",
    async (multiple) => {
      hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(multiple);
      setActors([
        ["agent:main:owned", "profile-owner"],
        ["agent:main:other", "profile-other"],
      ]);
      const list = vi.fn(async () => [
        host([
          session("owned-thread", "agent:main:owned"),
          session("other-thread", "agent:main:other"),
        ]),
      ]);
      const read = vi.fn(async () => ({
        hostId: "gateway:local",
        threadId: "other-thread",
        items: [],
      }));
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider({ list, read }) }];
      const config = roleConfig("none");

      const listed = await call("sessions.catalog.list", {}, client("profile-owner"), config);
      const foreign = await call(
        "sessions.catalog.read",
        { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread" },
        client("profile-owner"),
        config,
      );

      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining({ threadId: "owned-thread" }),
      ]);
      expect(foreign).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["view", "suggest", "write"] as const)(
    "shows foreign adopted sessions but never foreign drafts or incognito for %s roles",
    async (others) => {
      hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
      hoisted.listSessionEntriesReadOnly.mockReturnValue([
        {
          sessionKey: "agent:main:other",
          entry: { createdActor: { type: "human", id: "profile-other" }, visibility: "shared" },
        },
        {
          sessionKey: "agent:main:draft",
          entry: { createdActor: { type: "human", id: "profile-other" }, visibility: "draft" },
        },
        {
          sessionKey: "agent:main:private",
          entry: { createdActor: { type: "human", id: "profile-other" }, incognito: true },
        },
      ]);
      const read = vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }));
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider({
            list: vi.fn(async () => [
              host([
                session("other-thread", "agent:main:other"),
                session("draft-thread", "agent:main:draft"),
                session("incognito-thread", "agent:main:private"),
                session("unadopted-thread"),
              ]),
            ]),
            read,
          }),
        },
      ];
      const config = roleConfig(others);
      const owner = client("profile-owner");

      const listed = await call("sessions.catalog.list", {}, owner, config);
      const visible = await call(
        "sessions.catalog.read",
        { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread" },
        owner,
        config,
      );
      const draft = await call(
        "sessions.catalog.read",
        { catalogId: "codex", hostId: "gateway:local", threadId: "draft-thread" },
        owner,
        config,
      );

      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        expect.objectContaining({ threadId: "other-thread" }),
      ]);
      expect(visible).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ threadId: "other-thread" }),
      );
      expect(draft).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it.each(["view", "suggest"] as const)(
    "blocks foreign catalog continue and archive for %s roles without explicit membership",
    async (others) => {
      setActors([["agent:main:other", "profile-other"]]);
      const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:other" }));
      const archive = vi.fn(async () => ({ ok: true as const }));
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider({
            list: vi.fn(async () => [host([session("other-thread", "agent:main:other")])]),
            continueSession,
            archive,
          }),
        },
      ];
      const config = roleConfig(others);

      for (const [method, extra] of [
        ["sessions.catalog.continue", {}],
        ["sessions.catalog.archive", { confirmNoOtherRunner: true }],
      ] as const) {
        const respond = await call(
          method,
          { catalogId: "codex", hostId: "gateway:local", threadId: "other-thread", ...extra },
          client("profile-owner"),
          config,
        );
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
        );
      }
      expect(continueSession).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    },
  );

  it("permits a view-capped person to archive a foreign session after explicit membership", async () => {
    setActors([["agent:main:other", "profile-other"]]);
    hoisted.resolveSessionSharingTarget.mockReturnValue({ canonicalKey: "agent:main:other" });
    hoisted.resolveSessionSharingRole.mockReturnValue("member");
    const archive = vi.fn(async () => ({ ok: true as const }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [host([session("other-thread", "agent:main:other")])]),
          archive,
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.archive",
      {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "other-thread",
        confirmNoOtherRunner: true,
      },
      client("profile-owner"),
      roleConfig("view"),
    );

    expect(archive).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("rejects catalog adoption before the provider creates a disallowed agent session", async () => {
    setActors([["agent:main:owned", "profile-owner"]]);
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:owned" }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          list: vi.fn(async () => [host([session("owned-thread", "agent:main:owned")])]),
          continueSession,
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.continue",
      { catalogId: "codex", hostId: "gateway:local", threadId: "owned-thread" },
      client("profile-owner"),
      roleConfig("write", ["research"]),
    );

    expect(continueSession).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        message: expect.stringContaining('cannot create sessions for agent "main"'),
      }),
    );
  });

  it("partitions a settled catalog cache when one profile's effective role changes", async () => {
    setActors([
      ["agent:main:owned", "profile-owner"],
      ["agent:main:other", "profile-other"],
    ]);
    const list = vi.fn(async () => [
      host([
        session("owned-thread", "agent:main:owned"),
        session("other-thread", "agent:main:other"),
      ]),
    ]);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider({ list }) }];
    const config = roleConfig("none");
    const owner = client("profile-owner");

    const restricted = await call("sessions.catalog.list", {}, owner, config);
    config.gateway.roles.definitions.guest.sessions.others = "view";
    const shared = await call("sessions.catalog.list", {}, owner, config);

    expect(restricted.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toHaveLength(1);
    expect(shared.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("keeps operator.admin unrestricted despite a configured none role", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const listedHost = host([session("unadopted-thread")]);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ list: vi.fn(async () => [listedHost]) }) },
    ];

    const listed = await call(
      "sessions.catalog.list",
      {},
      client("profile-owner", ["operator.admin"]),
      roleConfig("none"),
    );

    expect(listed).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ hosts: [listedHost] })],
    });
  });
});
