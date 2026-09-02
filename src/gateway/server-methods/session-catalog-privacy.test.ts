import { describe, expect, it, vi } from "vitest";
import {
  ErrorCodes,
  type SessionCatalogHost,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  listAdoptedSessionCatalogSessions,
  type SessionCatalogEntrySnapshot,
  type SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { sessionCatalogHandlers } from "./session-catalog.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

async function withCatalog(
  run: (fixture: Awaited<ReturnType<typeof createCatalog>>) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const previousRegistry = getActivePluginRegistry() ?? createEmptyPluginRegistry();
    try {
      await run(await createCatalog());
    } finally {
      setActivePluginRegistry(previousRegistry);
    }
  });
}

async function createCatalog() {
  const caller = ensureProfileForEmail("catalog-caller@example.test");
  const other = ensureProfileForEmail("catalog-other@example.test");
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        default: "writer",
        definitions: {
          writer: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
        },
      },
    },
  };
  for (const [id, profileId, source, visibility] of [
    ["foreign", other.id, "profile", "shared"],
    ["owned", caller.id, "profile", "draft"],
    ["collision", caller.id, "channel", "draft"],
  ] as const) {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: `agent:main:${id}` },
      {
        sessionId: id,
        updatedAt: 1,
        visibility,
        pluginOwnerId: "fixture",
        createdVia: source === "profile" ? "operator" : "channel",
        createdActor: { type: "human", source, id: profileId },
      },
    );
  }
  const host: SessionCatalogHost = {
    hostId: "gateway:local",
    label: "Local",
    kind: "gateway",
    connected: true,
    sessions: ["foreign", "owned", "collision"].map((id) => ({
      threadId: id,
      sessionKey: `agent:main:${id}`,
      status: "stored",
      archived: false,
      canContinue: true,
      canArchive: true,
    })),
  };
  const runtime = createPluginRuntime();
  const enumerate = (sessionEntries?: SessionCatalogEntrySnapshot): SessionCatalogHost => {
    const adopted = listAdoptedSessionCatalogSessions({
      agentId: "main",
      config,
      pluginId: "fixture",
      runtime,
      sessionEntries,
      sourceFromEntry: (entry) => ({ hostId: host.hostId, threadId: entry.sessionId }),
    });
    return {
      ...host,
      sessions: host.sessions.map(({ sessionKey: _key, ...session }) => {
        const sessionKey = adopted.get(`${host.hostId}\0${session.threadId}`);
        return sessionKey ? { ...session, sessionKey } : session;
      }),
    };
  };
  const list = vi.fn<SessionCatalogProvider["list"]>(async ({ sessionEntries }) => [
    enumerate(sessionEntries),
  ]);
  const read = vi.fn<SessionCatalogProvider["read"]>(async ({ hostId, threadId }) => ({
    hostId,
    threadId,
    items: [],
  }));
  const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:owned" }));
  const archive = vi.fn(async () => ({ ok: true as const }));
  const registry = createEmptyPluginRegistry();
  registry.sessionCatalogs.push({
    pluginId: "fixture",
    source: import.meta.url,
    provider: { id: "fixture", label: "Fixture", list, read, continueSession, archive },
  });
  setActivePluginRegistry(registry);
  const client = (profileId: string) =>
    ({
      connId: profileId,
      connect: { scopes: ["operator.read", "operator.write"] },
      authenticatedUserProfile: { profileId },
    }) as GatewayClient;
  const owner = client(caller.id);
  const foreignOwner = client(other.id);
  const call = async (
    method: keyof typeof sessionCatalogHandlers = "sessions.catalog.list",
    params: Record<string, unknown> = {},
    requestClient = owner,
    broadcastToConnIds = vi.fn(),
  ) => {
    const respond = vi.fn();
    const context = { getRuntimeConfig: () => config, broadcastToConnIds } satisfies Pick<
      GatewayRequestContext,
      "getRuntimeConfig" | "broadcastToConnIds"
    >;
    await withPluginRuntimeGatewayRequestScope(
      { client: requestClient, pluginRegistry: registry, isWebchatConnect: () => false },
      () =>
        sessionCatalogHandlers[method]?.({
          params,
          client: requestClient,
          respond,
          context,
        } as never),
    );
    return respond;
  };
  const changeForeign = (patch: { visibility?: "draft" | "shared"; incognito?: true }) =>
    upsertSessionEntryCore({ agentId: "main", sessionKey: "agent:main:foreign" }, patch);
  const replaceForeign = async () => {
    const sessionKey = "agent:main:foreign";
    const removed = await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      archiveTranscript: false,
      expectedSessionId: "foreign",
    });
    expect(removed.deleted).toBe(true);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "replacement",
        updatedAt: 2,
        visibility: "draft",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: caller.id },
      },
    );
    expect(
      loadSessionEntryReadOnly({ agentId: "main", sessionKey })?.pluginOwnerId,
    ).toBeUndefined();
  };
  return {
    call,
    config,
    provider: registry.sessionCatalogs[0]!.provider,
    changeForeign,
    replaceForeign,
    enumerate,
    callerId: caller.id,
    foreignOwner,
    owner,
    host,
    list,
    read,
    continueSession,
    archive,
  };
}

const rows = (respond: ReturnType<typeof vi.fn>) =>
  respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions.map(
    (row: { threadId: string }) => row.threadId,
  );

describe("catalog delivery uses current canonical privacy", () => {
  it.each([
    { publication: "published", others: undefined, profiled: true, visible: true },
    { publication: "published", others: undefined, profiled: false, visible: false },
    { publication: "published", others: "view", profiled: true, visible: true },
    { publication: "published", others: "suggest", profiled: true, visible: true },
    { publication: "published", others: "write", profiled: true, visible: true },
    { publication: "published", others: "none", profiled: true, visible: false },
    { publication: "published", others: "view", profiled: false, visible: false },
    { publication: undefined, others: "view", profiled: true, visible: false },
  ] as const)(
    "gates native $publication rows and reads for others=$others, profiled=$profiled",
    async ({ publication, others, profiled, visible }) =>
      withCatalog(async ({ call, config, provider, owner, host, list, read }) => {
        provider.visibility = publication;
        if (others === undefined) {
          delete config.gateway!.roles;
        } else {
          config.gateway!.roles!.definitions.writer!.sessions!.others = others;
        }
        const requestClient = profiled ? owner : { ...owner, authenticatedUserProfile: undefined };
        const publishedHost: SessionCatalogHost = {
          ...host,
          sessions: [
            {
              threadId: "published-native",
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
              createdActor: {
                type: "human",
                id: "remote-human",
                label: "Published Person",
                identity: {
                  type: "remote",
                  pluginId: "fixture",
                  domain: "source",
                  idKind: "profile",
                  id: "remote-human",
                },
              },
            },
          ],
        };
        list.mockImplementation(async ({ onHost }) => {
          onHost?.(publishedHost);
          return [publishedHost];
        });
        const broadcast = vi.fn();
        const listed = await call(
          "sessions.catalog.list",
          { progressId: "published" },
          requestClient,
          broadcast,
        );
        const expectedRows = visible ? publishedHost.sessions : [];
        expect
          .soft(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions)
          .toEqual(expectedRows);
        expect.soft(broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions).toEqual(expectedRows);
        const transcript = await call(
          "sessions.catalog.read",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: "published-native",
          },
          requestClient,
        );
        if (visible) {
          expect(transcript).toHaveBeenCalledWith(true, {
            hostId: host.hostId,
            threadId: "published-native",
            items: [],
          });
        } else {
          expect(transcript).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
          );
          expect(read).not.toHaveBeenCalled();
        }
      }),
  );

  it("keeps adopted catalogs owner-only on multi-identity gateways without roles", async () => {
    await withCatalog(async ({ call, config, host, read }) => {
      delete config.gateway!.roles;
      expect(rows(await call())).toEqual(["owned"]);
      const locator = { catalogId: "fixture", hostId: host.hostId };
      expect(
        await call("sessions.catalog.read", { ...locator, threadId: "foreign" }),
      ).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
      );
      expect(read).not.toHaveBeenCalled();
      const owned = await call("sessions.catalog.read", { ...locator, threadId: "owned" });
      expect(owned.mock.calls[0]?.[0]).toBe(true);
    });
  });

  it("rechecks published visibility on cached delivery after a role cap changes", async () => {
    await withCatalog(async ({ call, config, provider, host, list }) => {
      provider.visibility = "published";
      list.mockResolvedValue([
        {
          ...host,
          sessions: [
            {
              threadId: "published-native",
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        },
      ]);
      const role = config.gateway!.roles!.definitions.writer!;
      role.sessions!.others = "view";
      expect(rows(await call())).toEqual(["published-native"]);
      role.sessions!.others = "none";
      expect(rows(await call())).toEqual([]);
      role.sessions!.others = "view";
      expect(rows(await call())).toEqual(["published-native"]);
      expect(list).toHaveBeenCalledTimes(2);
      delete config.gateway!.roles;
      expect(rows(await call())).toEqual(["published-native"]);
      expect(list).toHaveBeenCalledTimes(3);
    });
  });

  it("rechecks published read visibility after a role cap changes during provider read", async () => {
    await withCatalog(async ({ call, config, provider, host, read }) => {
      provider.visibility = "published";
      const role = config.gateway!.roles!.definitions.writer!;
      role.sessions!.others = "view";
      const entered = createDeferredCore();
      const release = createDeferredCore();
      read.mockImplementation(async ({ hostId, threadId }) => {
        entered.resolve();
        await release.promise;
        return {
          hostId,
          threadId,
          items: [{ type: "userMessage", text: "published transcript" }],
        };
      });
      const pending = call("sessions.catalog.read", {
        catalogId: "fixture",
        hostId: host.hostId,
        threadId: "published-native",
      });
      await entered.promise;
      role.sessions!.others = "none";
      release.resolve();
      const denied = await pending;
      expect(denied).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({
          code: ErrorCodes.FORBIDDEN,
          message: "session catalog thread is not visible to this caller",
        }),
      );
    });
  });

  it("never adopts a published source key or grants mutation authority through it", async () => {
    await withCatalog(async ({ call, provider, host, list, continueSession, archive }) => {
      provider.visibility = "published";
      const createdActor = { type: "agent" as const, id: "publisher", label: "Source Agent" };
      list.mockResolvedValue([
        {
          ...host,
          sessions: [
            {
              threadId: "published-native",
              sessionKey: "agent:main:owned",
              createdActor,
              status: "stored",
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        },
      ]);
      const listed = await call();
      expect(listed.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.sessions).toEqual([
        {
          threadId: "published-native",
          createdActor,
          status: "stored",
          archived: false,
          canContinue: false,
          canArchive: false,
        },
      ]);
      for (const method of ["sessions.catalog.continue", "sessions.catalog.archive"] as const) {
        const result = await call(method, {
          catalogId: "fixture",
          hostId: host.hostId,
          threadId: "published-native",
          ...(method === "sessions.catalog.archive" ? { confirmNoOtherRunner: true } : {}),
        });
        expect(result).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
        );
      }
      expect(continueSession).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    });
  });

  it("keeps caller-bound provider enumeration separate while sharing the same caller's work", async () => {
    await withCatalog(async ({ call, owner, foreignOwner, host, list }) => {
      const release = createDeferredCore();
      list.mockImplementation(async () => {
        const scoped = getPluginRuntimeGatewayRequestScope()?.client;
        await release.promise;
        return [{ ...host, label: scoped?.connId ?? "missing-scope", sessions: [] }];
      });
      const otherConnection = { ...owner, connId: "other-connection" };
      const admin = {
        ...owner,
        connId: "admin-connection",
        connect: { ...owner.connect, scopes: ["operator.admin"] },
      };
      const callers = [owner, owner, otherConnection, foreignOwner, admin];
      const pending = callers.map((caller) => call("sessions.catalog.list", {}, caller));
      release.resolve();
      const responses = await Promise.all(pending);
      responses.forEach((respond, index) => {
        expect
          .soft(respond.mock.calls[0]?.[1]?.catalogs[0]?.hosts[0]?.label)
          .toBe(callers[index]?.connId);
      });
      expect.soft(list).toHaveBeenCalledTimes(4);
      await call();
      expect.soft(list).toHaveBeenCalledTimes(4);
      owner.connect.scopes = ["operator.read"];
      await call();
      expect(list).toHaveBeenCalledTimes(5);
    });
  });

  it.each([{ visibility: "draft" as const }, { incognito: true as const }])(
    "rechecks settled provider results after privacy changes to %j",
    async (patch) =>
      withCatalog(async ({ call, changeForeign, list, callerId }) => {
        expect(rows(await call())).toEqual(["foreign", "owned"]);
        await changeForeign(patch);
        expect.soft(rows(await call())).toEqual(["owned"]);
        expect(list).toHaveBeenCalledOnce();
        expect(rows(await call("sessions.catalog.list", { search: "cold" }))).toEqual(["owned"]);
        expect(list).toHaveBeenCalledTimes(2);
        linkEmail("catalog-other@example.test", callerId);
        expect(rows(await call())).toEqual(
          "visibility" in patch ? ["foreign", "owned"] : ["owned"],
        );
        expect(list).toHaveBeenCalledTimes(3);
      }),
  );

  it("does not transfer a cached native thread to a replacement session at the same key", async () => {
    await withCatalog(async ({ call, changeForeign, replaceForeign, list }) => {
      await changeForeign({ visibility: "draft" });
      expect(rows(await call())).toEqual(["owned"]);
      await replaceForeign();
      expect.soft(rows(await call())).toEqual(["owned"]);
      expect(list).toHaveBeenCalledOnce();
      expect(rows(await call("sessions.catalog.list", { search: "cold-replacement" }))).toEqual([
        "owned",
      ]);
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  it("rechecks recorded plugin ownership without discarding same-instance cache work", async () => {
    await withCatalog(async ({ call, list }) => {
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      const scope = { agentId: "main", sessionKey: "agent:main:owned" };
      await upsertSessionEntryCore(scope, { pluginOwnerId: "other-plugin" });
      expect(rows(await call())).toEqual(["foreign"]);
      await upsertSessionEntryCore(scope, { pluginOwnerId: "fixture" });
      expect(rows(await call())).toEqual(["foreign", "owned"]);
      expect(list).toHaveBeenCalledOnce();
    });
  });

  it.each([true, false])(
    "retains the original adoption across replacement before publication (prefetch=%s)",
    async (prefetch) =>
      withCatalog(async ({ call, changeForeign, replaceForeign, enumerate, list, owner }) => {
        await changeForeign({ visibility: "draft" });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        let observed: SessionCatalogHost | undefined;
        list.mockImplementation(async ({ sessionEntries, onHost }) => {
          if (prefetch) {
            observed = enumerate(sessionEntries);
          }
          entered.resolve();
          await release.promise;
          observed ??= enumerate(sessionEntries);
          onHost?.(observed);
          return [observed];
        });
        const broadcast = vi.fn();
        const pending = call(
          "sessions.catalog.list",
          { progressId: "replacement" },
          owner,
          broadcast,
        );
        await entered.promise;
        await replaceForeign();
        release.resolve();
        const result = await pending;
        // The provider's request snapshot keeps the original adoption even when first read
        // after its await; publication must reject that now-replaced instance independently.
        expect
          .soft(observed?.sessions.find((session) => session.threadId === "foreign")?.sessionKey)
          .toBe("agent:main:foreign");
        expect.soft(rows(result)).toEqual(["owned"]);
        expect(broadcast).toHaveBeenCalledOnce();
        expect
          .soft(
            broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions.map(
              (session: { threadId: string }) => session.threadId,
            ),
          )
          .toEqual(["owned"]);
      }),
  );

  it("rechecks each follower at progress and final delivery after provider awaits", async () => {
    await withCatalog(async ({ call, changeForeign, owner, foreignOwner, host, list }) => {
      const entered = createDeferredCore();
      const progress = createDeferredCore();
      const finish = createDeferredCore();
      list.mockImplementation(async ({ sessionEntries, onHost }) => {
        sessionEntries?.entriesForCatalog?.();
        entered.resolve();
        await progress.promise;
        onHost?.(host);
        await finish.promise;
        return [host];
      });
      const leaderBroadcast = vi.fn();
      const followerBroadcast = vi.fn();
      const sameCallerBroadcast = vi.fn();
      const leader = call(
        "sessions.catalog.list",
        { progressId: "leader" },
        owner,
        leaderBroadcast,
      );
      await entered.promise;
      const sameCaller = call(
        "sessions.catalog.list",
        { progressId: "same-caller" },
        owner,
        sameCallerBroadcast,
      );
      const follower = call(
        "sessions.catalog.list",
        { progressId: "follower" },
        foreignOwner,
        followerBroadcast,
      );
      await changeForeign({ visibility: "draft" });
      progress.resolve();
      await vi.waitFor(() => {
        expect(leaderBroadcast).toHaveBeenCalledOnce();
        expect(followerBroadcast).toHaveBeenCalledOnce();
        expect(sameCallerBroadcast).toHaveBeenCalledOnce();
      });
      const progressRows = (broadcast: typeof leaderBroadcast) =>
        broadcast.mock.calls[0]?.[1]?.catalog.hosts[0]?.sessions.map(
          (row: { threadId: string }) => row.threadId,
        );
      expect.soft(progressRows(leaderBroadcast)).toEqual(["owned"]);
      expect.soft(progressRows(followerBroadcast)).toEqual(["foreign"]);
      expect.soft(progressRows(sameCallerBroadcast)).toEqual(["owned"]);
      await changeForeign({ incognito: true });
      finish.resolve();
      const [leaderResult, followerResult, sameCallerResult] = await Promise.all([
        leader,
        follower,
        sameCaller,
      ]);
      expect.soft(rows(leaderResult)).toEqual(["owned"]);
      expect.soft(rows(followerResult)).toEqual([]);
      expect.soft(rows(sameCallerResult)).toEqual(["owned"]);
      expect(list).toHaveBeenCalledTimes(2);
    });
  });

  it.each(
    (
      ["sessions.catalog.read", "sessions.catalog.continue", "sessions.catalog.archive"] as const
    ).flatMap((method) => [
      { method, change: "privacy" as const },
      { method, change: "replacement" as const },
    ]),
  )("rechecks $change after enumeration before $method dispatch", async ({ method, change }) =>
    withCatalog(
      async ({
        call,
        changeForeign,
        replaceForeign,
        enumerate,
        host,
        list,
        read,
        continueSession,
        archive,
      }) => {
        const entered = createDeferredCore();
        const release = createDeferredCore();
        list.mockImplementation(async ({ sessionEntries }) => {
          const adopted = enumerate(sessionEntries);
          entered.resolve();
          await release.promise;
          return [adopted];
        });
        const locator = {
          catalogId: "fixture",
          hostId: host.hostId,
          threadId: "foreign",
          ...(method === "sessions.catalog.archive" ? { confirmNoOtherRunner: true } : {}),
        };
        const pending = call(method, locator);
        await entered.promise;
        await changeForeign({ visibility: "draft" });
        if (change === "replacement") {
          await replaceForeign();
        }
        release.resolve();
        const denied = await pending;
        expect
          .soft(denied)
          .toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: ErrorCodes.FORBIDDEN }),
          );
        const dispatch =
          method === "sessions.catalog.read"
            ? read
            : method === "sessions.catalog.continue"
              ? continueSession
              : archive;
        expect.soft(dispatch).not.toHaveBeenCalled();
        const allowed = await call(method, { ...locator, threadId: "owned" });
        expect(allowed.mock.calls[0]?.[0]).toBe(true);
      },
    ),
  );
});
