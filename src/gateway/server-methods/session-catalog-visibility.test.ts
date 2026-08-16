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
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  listSessionEntriesReadOnly: vi.fn(
    (): Array<{
      sessionKey: string;
      entry: { createdActor?: { type: "human"; id: string }; updatedAt?: number };
    }> => [],
  ),
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
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
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

describe("session catalog caller visibility", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
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
});
