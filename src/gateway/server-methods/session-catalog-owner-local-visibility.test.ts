import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
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
        createdActor?: { type: "human"; source: "profile" | "channel" | "unknown"; id: string };
        incognito?: true;
        initializationPending?: true;
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
vi.mock("../../state/user-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/user-profiles.js")>()),
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

const ownerLocalAudience = {
  kind: "gateway-owner-local",
  prepareVisibility: ({ sessionEntries }) => {
    const adopted = new Set(
      sessionEntries.entriesForCatalog?.().map(({ sessionKey }) => sessionKey),
    );
    return (row) => !adopted.has(`agent:main:${row.threadId}`);
  },
} satisfies Exclude<NonNullable<SessionCatalogProvider["audience"]>, string>;

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

describe("session catalog caller visibility", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    hoisted.getUserProfileRole.mockReset().mockReturnValue(null);
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
    hoisted.resolveSessionSharingRole.mockReset().mockReturnValue("viewer");
    hoisted.resolveSessionSharingTarget.mockReset().mockReturnValue(null);
  });

  it("lets only the Gateway owner list, search, and read owner-local native rows", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const native = { ...session("native-thread"), name: "Native exact title", source: "cli" };
    const visibleNative = {
      ...native,
      canContinue: false,
      canArchive: false,
      canOpenTerminal: false,
    };
    const local = host([native], "page-2");
    const paired = {
      ...host([native], "node-page-2"),
      hostId: "node:paired",
      kind: "node" as const,
      nodeId: "paired",
    };
    const list = vi.fn(async () => [local, paired]);
    const read = vi.fn(async ({ hostId, threadId }: { hostId: string; threadId: string }) => ({
      hostId,
      threadId,
      items: [],
    }));
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:native" }));
    const archive = vi.fn(async () => ({ ok: true as const }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          audience: ownerLocalAudience,
          list,
          read,
          continueSession,
          archive,
        }),
      },
    ];
    const config = {};
    const owner = client(GATEWAY_OWNER_PROFILE_ID);
    // Same config/query: owner identity must not reuse the generic operator cache partition.
    const requestClient = unprofiledClient();
    for (const profileId of [
      undefined,
      GATEWAY_OWNER_PROFILE_ID,
      undefined,
      "profile-other",
      GATEWAY_OWNER_PROFILE_ID,
    ]) {
      requestClient.authenticatedUserProfile = profileId ? { profileId } : undefined;
      const listed = await call("sessions.catalog.list", {}, requestClient, config);
      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts).toEqual([
        expect.objectContaining({
          sessions: profileId === GATEWAY_OWNER_PROFILE_ID ? [visibleNative] : [],
          nextCursor: "page-2",
        }),
        expect.objectContaining({ sessions: [], nextCursor: "node-page-2" }),
      ]);
    }
    expect(list).toHaveBeenCalledTimes(3);
    const searched = await call("sessions.catalog.list", { search: native.name }, owner, config);
    expect(searched.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([visibleNative]);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: native.name }));
    for (const hiddenClient of [unprofiledClient(), client("profile-other")]) {
      const hiddenSearch = await call(
        "sessions.catalog.list",
        { search: native.name },
        hiddenClient,
        config,
      );
      expect(
        hiddenSearch.mock.calls[0]?.[1]?.catalogs[0]?.hosts.every(
          (listedHost: { sessions: unknown[] }) => listedHost.sessions.length === 0,
        ),
      ).toBe(true);
    }
    const transcript = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: local.hostId, threadId: native.threadId },
      owner,
      config,
    );
    expect(transcript).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ threadId: native.threadId }),
    );
    for (const [deniedClient, hostId, method] of [
      [unprofiledClient(), local.hostId, "sessions.catalog.read"],
      [client("profile-other"), local.hostId, "sessions.catalog.read"],
      [owner, paired.hostId, "sessions.catalog.read"],
      [owner, local.hostId, "sessions.catalog.continue"],
      [owner, local.hostId, "sessions.catalog.archive"],
    ] as const) {
      const denied = await call(
        method,
        {
          catalogId: "codex",
          hostId,
          threadId: native.threadId,
          ...(method === "sessions.catalog.archive" ? { confirmNoOtherRunner: true } : {}),
        },
        deniedClient,
        config,
      );
      expect(denied).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
    }
    expect(read).toHaveBeenCalledOnce();
    expect(continueSession).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it.each([
    { visibility: "draft" as const },
    { incognito: true as const },
    { initializationPending: true as const },
  ])(
    "rechecks owner-local adoption on cached, streamed, and read delivery (%j)",
    async (privacy) => {
      hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
      const listedHost = host([session("native-thread")]);
      const list = vi.fn<SessionCatalogProvider["list"]>(async () => [listedHost]);
      const read = vi.fn(async () => ({
        hostId: listedHost.hostId,
        threadId: "native-thread",
        items: [],
      }));
      hoisted.activeRegistry.sessionCatalogs = [
        { provider: provider({ audience: ownerLocalAudience, list, read }) },
      ];
      const owner = { ...client(GATEWAY_OWNER_PROFILE_ID), connId: "owner-conn" };
      const config = {};
      const adopt = () =>
        hoisted.listSessionEntriesReadOnly.mockReturnValue([
          {
            sessionKey: "agent:main:native-thread",
            entry: {
              createdActor: { type: "human", source: "profile", id: "profile-other" },
              ...privacy,
            },
          },
        ]);
      const initial = await call("sessions.catalog.list", {}, owner, config);
      expect(initial.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toHaveLength(1);
      adopt();
      const cached = await call("sessions.catalog.list", {}, owner, config);
      expect(cached.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
      expect(list).toHaveBeenCalledOnce();

      hoisted.listSessionEntriesReadOnly.mockReturnValue([]);
      list.mockImplementation(async ({ onHost }) => {
        await Promise.resolve();
        adopt();
        onHost?.(listedHost);
        return [listedHost];
      });
      const broadcastToConnIds = vi.fn();
      const streamed = await call(
        "sessions.catalog.list",
        { search: "native", progressId: "adoption-race" },
        owner,
        config,
        { broadcastToConnIds },
      );
      expect(streamed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.catalog.host",
        expect.objectContaining({
          catalog: expect.objectContaining({ hosts: [expect.objectContaining({ sessions: [] })] }),
        }),
        new Set(["owner-conn"]),
        { dropIfSlow: true },
      );

      hoisted.listSessionEntriesReadOnly.mockReturnValue([]);
      const transcript = await call(
        "sessions.catalog.read",
        { catalogId: "codex", hostId: listedHost.hostId, threadId: "native-thread" },
        owner,
        config,
      );
      expect(transcript).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("does not treat adopted private or missing entries as owner-local native rows", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    hoisted.listSessionEntriesReadOnly.mockReturnValue([
      {
        sessionKey: "agent:main:draft",
        entry: {
          createdActor: { type: "human", source: "profile", id: "profile-other" },
          visibility: "draft",
        },
      },
      {
        sessionKey: "agent:main:incognito",
        entry: {
          createdActor: { type: "human", source: "profile", id: "profile-other" },
          incognito: true,
        },
      },
    ]);
    const rows = [
      session("draft", "agent:main:draft"),
      session("incognito", "agent:main:incognito"),
      session("missing", "agent:main:missing"),
    ];
    const read = vi.fn(async ({ hostId, threadId }: { hostId: string; threadId: string }) => ({
      hostId,
      threadId,
      items: [],
    }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          audience: ownerLocalAudience,
          list: vi.fn(async () => [host(rows)]),
          read,
        }),
      },
    ];
    const owner = client(GATEWAY_OWNER_PROFILE_ID);
    const listed = await call("sessions.catalog.list", {}, owner);
    expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([]);
    for (const row of rows) {
      const denied = await call(
        "sessions.catalog.read",
        { catalogId: "codex", hostId: "gateway:local", threadId: row.threadId },
        owner,
      );
      expect(denied).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("pages through hidden adopted rows before reading an owner-local native thread", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const list = vi.fn(async ({ cursors }: { cursors?: Record<string, string> }) => [
      cursors
        ? host([session("native-thread")])
        : host([session("private-thread", "agent:main:private")], "page-2"),
    ]);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider({ audience: ownerLocalAudience, list }) },
    ];
    const result = await call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: "gateway:local", threadId: "native-thread" },
      client(GATEWAY_OWNER_PROFILE_ID),
    );
    expect(result).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ threadId: "native-thread" }),
    );
    expect(list).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursors: { "gateway:local": "page-2" } }),
    );
  });

  it("revokes an owner-local read adopted while transcript retrieval is pending", async () => {
    hoisted.hasMultipleSessionSharingIdentities.mockReturnValue(true);
    const listedHost = host([session("native-thread")]);
    const transcript = Promise.withResolvers<{
      hostId: string;
      threadId: string;
      items: [];
    }>();
    const read = vi.fn(() => transcript.promise);
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider({
          audience: ownerLocalAudience,
          list: vi.fn(async () => [listedHost]),
          read,
        }),
      },
    ];
    const pending = call(
      "sessions.catalog.read",
      { catalogId: "codex", hostId: listedHost.hostId, threadId: "native-thread" },
      client(GATEWAY_OWNER_PROFILE_ID),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    hoisted.listSessionEntriesReadOnly.mockReturnValue([
      {
        sessionKey: "agent:main:native-thread",
        entry: {
          createdActor: { type: "human", source: "profile", id: "profile-other" },
          visibility: "draft",
        },
      },
    ]);
    transcript.resolve({ hostId: listedHost.hostId, threadId: "native-thread", items: [] });

    const result = await pending;
    expect(result).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
    );
    expect(result).not.toHaveBeenCalledWith(true, expect.anything());
  });
});
