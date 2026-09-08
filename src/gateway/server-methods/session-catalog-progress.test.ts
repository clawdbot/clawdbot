import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  call,
  hoisted,
  markPluginRegistryActive,
  provider,
  resetSessionCatalogTestState,
  startCall,
  type PluginRegistry,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

describe("session catalog progress ownership", () => {
  beforeEach(resetSessionCatalogTestState);

  it("streams completed hosts to only the requesting connection", async () => {
    const broadcastToConnIds = vi.fn();
    const host = {
      hostId: "node:fast",
      label: "Fast node",
      kind: "node" as const,
      connected: true,
      nodeId: "fast",
      sessions: [],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return [host];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "progress-1" },
      {},
      { connId: "requester", connect: {} },
      { broadcastToConnIds },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      {
        progressId: "progress-1",
        agentId: "main",
        catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
      },
      new Set(["requester"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
    });
  });

  it("single-flights identical concurrent lists for one caller and fans progress to active followers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const late = createDeferredCore();
    const publications: Promise<void>[] = [];
    const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
      const publication = late.promise.then(() => onHost?.(host));
      publications.push(publication);
      waitUntil?.(publication);
      await gate;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = { agents: { list: [{ id: "main" }, { id: "research" }] } };
    const leaderBroadcast = vi.fn();
    const followerBroadcast = vi.fn();
    const sharedClient = { connId: "requester" };
    const leader = startCall(
      "sessions.catalog.list",
      { progressId: "leader-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: leaderBroadcast },
    );
    const follower = startCall(
      "sessions.catalog.list",
      { progressId: "follower-progress", agentId: "main" },
      config,
      sharedClient,
      { broadcastToConnIds: followerBroadcast },
    );
    const otherAgent = startCall("sessions.catalog.list", { agentId: "research" }, config);
    const otherParams = startCall(
      "sessions.catalog.list",
      { search: "other", agentId: "main" },
      config,
    );

    try {
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
      release();
      await Promise.all([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
      ]);

      expect(leaderBroadcast).toHaveBeenCalledOnce();
      expect(followerBroadcast).toHaveBeenCalledOnce();
      for (const pending of [leader, follower, otherAgent, otherParams]) {
        expect(pending.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
        });
      }
      const settledBroadcast = vi.fn();
      await call(
        "sessions.catalog.list",
        { progressId: "settled-progress", agentId: "main" },
        config,
        sharedClient,
        { broadcastToConnIds: settledBroadcast },
      );
      late.resolve();
      await Promise.all(publications);
      expect(leaderBroadcast).toHaveBeenCalledTimes(2);
      expect(followerBroadcast).toHaveBeenCalledTimes(2);
      expect(settledBroadcast).not.toHaveBeenCalled();
      expect(list).toHaveBeenCalledTimes(3);
    } finally {
      release();
      late.resolve();
      await Promise.allSettled([
        leader.completion,
        follower.completion,
        otherAgent.completion,
        otherParams.completion,
        ...publications,
      ]);
    }
  });

  it.each(["settled", "in-flight"] as const)(
    "refreshes %s lists immediately after archiving a session",
    async (listingState) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const gate = createDeferredCore();
      const started = createDeferredCore();
      const late = createDeferredCore();
      const publications: Promise<void>[] = [];
      const broadcastToConnIds = vi.fn();
      const session = {
        threadId: "deleted-thread",
        status: "stored",
        archived: false,
        canContinue: false,
        canArchive: true,
      };
      const host = {
        hostId: "gateway:local",
        label: "Local",
        kind: "gateway" as const,
        connected: true,
        sessions: [session],
      };
      let archived = false;
      const list = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost, waitUntil }) => {
        const resultHost = { ...host, sessions: archived ? [] : [session] };
        const publication = late.promise.then(() => onHost?.(resultHost));
        publications.push(publication);
        waitUntil?.(publication);
        started.resolve();
        await gate.promise;
        return [resultHost];
      });
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("fixture", {
            list,
            archive: async () => {
              archived = true;
              return { ok: true };
            },
          }),
        },
      ];
      const config = {};
      const client = { connId: "requester" };
      const original = startCall(
        "sessions.catalog.list",
        { progressId: "before-delete" },
        config,
        client,
        { broadcastToConnIds },
      );
      try {
        await started.promise;
        if (listingState === "settled") {
          gate.resolve();
          await original.completion;
        }
        const deletion = await call(
          "sessions.catalog.archive",
          {
            catalogId: "fixture",
            hostId: host.hostId,
            threadId: session.threadId,
            confirmNoOtherRunner: true,
          },
          config,
          client,
        );
        expect(deletion).toHaveBeenCalledWith(true, { ok: true });
        late.resolve();
        await publications[0];
        gate.resolve();
        await original.completion;
        expect(original.respond).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [host] })],
        });

        const refreshed = await call(
          "sessions.catalog.list",
          { progressId: "after-delete" },
          config,
          client,
          { broadcastToConnIds: vi.fn() },
        );
        expect(refreshed).toHaveBeenCalledWith(true, {
          catalogs: [expect.objectContaining({ hosts: [{ ...host, sessions: [] }] })],
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(broadcastToConnIds).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        late.resolve();
        await original.completion;
        await Promise.allSettled(publications);
        now.mockRestore();
      }
    },
  );

  it("retires pending progress when aggregate projection fails", async () => {
    const late = createDeferredCore();
    const broadcastToConnIds = vi.fn();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("fixture", {
          list: async (params) => {
            signal = params.signal;
            publication = late.promise.then(() =>
              params.onHost?.({
                hostId: "late",
                label: "Late",
                kind: "node",
                connected: true,
                sessions: [],
              }),
            );
            params.waitUntil?.(publication);
            return [];
          },
        }),
      },
    ];
    const getRuntimeConfig = vi
      .fn()
      .mockReturnValueOnce({})
      .mockImplementation(() => {
        throw new Error("current config unavailable");
      });
    try {
      await expect(
        call(
          "sessions.catalog.list",
          { progressId: "failed" },
          {},
          { connId: "requester" },
          {
            getRuntimeConfig,
            broadcastToConnIds,
          },
        ),
      ).rejects.toThrow("current config unavailable");
      expect(signal?.aborted).toBe(true);
      late.resolve();
      await publication;
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      late.resolve();
      await publication;
    }
  });

  it.each(["registry-reactivation", "gateway-close", "disconnect"] as const)(
    "fences old publications after %s while a replacement request can publish",
    async (retirement) => {
      const releases = [createDeferredCore(), createDeferredCore()];
      const publications: Promise<void>[] = [];
      const connection = new AbortController();
      const gateway = new AbortController();
      const broadcastToConnIds = vi.fn();
      const replacementBroadcast = vi.fn();
      let producerSignal: AbortSignal | undefined;
      const list = vi.fn<SessionCatalogProvider["list"]>(async (params) => {
        producerSignal = params.signal;
        const publication = releases[publications.length]!.promise.then(() =>
          params.onHost?.({
            hostId: "node:late",
            label: "Late",
            kind: "node",
            connected: true,
            sessions: [],
          }),
        );
        publications.push(publication);
        params.waitUntil?.(publication);
        return [];
      });
      hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("fixture", { list }) }];
      const config = {};
      try {
        await call(
          "sessions.catalog.list",
          { progressId: "original" },
          config,
          { connId: "old", connectionSignal: connection.signal },
          { broadcastToConnIds, requestEntryLifetime: { signal: gateway.signal } },
        );
        if (retirement === "registry-reactivation") {
          markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
        } else if (retirement === "gateway-close") {
          gateway.abort();
        } else {
          connection.abort();
        }
        expect(producerSignal?.aborted).toBe(retirement !== "disconnect");
        await call(
          "sessions.catalog.list",
          { progressId: "replacement" },
          config,
          { connId: "new" },
          { broadcastToConnIds: replacementBroadcast },
        );
        releases[0]!.resolve();
        await publications[0];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledTimes(2);
        releases[1]!.resolve();
        await publications[1];
        expect(broadcastToConnIds).not.toHaveBeenCalled();
        expect(replacementBroadcast).toHaveBeenCalledOnce();
        expect(replacementBroadcast.mock.calls[0]?.[1]?.progressId).toBe("replacement");
      } finally {
        for (const release of releases) {
          release.resolve();
        }
        await Promise.allSettled(publications);
      }
    },
  );
});
