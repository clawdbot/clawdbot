import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import {
  createSessionCatalogFamily,
  sessionCatalogPaging,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogFamilyOptions,
  type SessionCatalogProvider,
  type SessionCatalogSession,
  type SessionCatalogTranscriptItem,
} from "./session-catalog.js";

const messages = {
  listNotObject: "list object required",
  unknownListParameter: (key: string) => `unknown list: ${key}`,
  invalidSearchTerm: "bad search",
  readNotObject: "read object required",
  unknownReadParameter: (key: string) => `unknown read: ${key}`,
  invalidThreadId: "bad thread",
};

const session = (threadId: string): SessionCatalogSession => ({
  threadId,
  status: "stored",
  archived: false,
  canContinue: true,
  canArchive: false,
});

describe("session catalog SDK", () => {
  it("exposes the closed share-route contract to external providers", () => {
    const shareRoute = {
      kind: "thread-id-prefix",
      routeSegment: "shared-sessions",
      hostId: "gateway",
      identifierAlphabet: "lowercase-hex",
      fullLength: 32,
      minPrefixLength: 12,
      lookup: "catalog-list-search-by-thread-id-prefix",
      ambiguity: "multiple-results-or-next-cursor",
    } as const satisfies NonNullable<SessionCatalogProvider["shareRoute"]>;
    const provider = {
      id: "external",
      label: "External",
      shareRoute,
      async list() {
        return [];
      },
      async read({ hostId, threadId }) {
        return { hostId, threadId, items: [] };
      },
    } satisfies SessionCatalogProvider;

    expect(provider.shareRoute).toEqual(shareRoute);
  });

  it("owns canonical list/read parameter and cursor parsing", () => {
    const cursor = sessionCatalogPaging.encodeCursor(2);
    expect(
      sessionCatalogPaging.parseListParams(
        { searchTerm: "  needle  ", limit: 4, cursor },
        { searchMaxLength: 20, messages },
      ),
    ).toEqual({ searchTerm: "needle", limit: 4, cursor });
    expect(
      sessionCatalogPaging.parseReadParams(
        { threadId: "thread-1", cursor },
        { threadIdMaxLength: 32, threadIdPattern: /^(?!-)[a-z0-9-]+$/u, messages },
      ),
    ).toEqual({ threadId: "thread-1", limit: 20, cursor });
    expect(sessionCatalogPaging.isExactCursor(cursor)).toBe(true);
    expect(sessionCatalogPaging.isExactCursor(`${cursor}=`)).toBe(false);
    expect(() =>
      sessionCatalogPaging.parseListParams({ extra: true }, { searchMaxLength: 20, messages }),
    ).toThrow("unknown list: extra");
    expect(() =>
      sessionCatalogPaging.parseReadParams(
        { threadId: "--help" },
        { threadIdMaxLength: 32, threadIdPattern: /^(?!-)[a-z0-9-]+$/u, messages },
      ),
    ).toThrow("bad thread");
  });

  it.each([
    { name: "missing", timestamps: [] },
    {
      name: "equal",
      timestamps: Array.from({ length: 5 }, () => "2026-08-30T12:00:00Z"),
    },
    {
      name: "non-monotonic",
      timestamps: [
        "2026-08-30T12:00:04Z",
        "2026-08-30T12:00:01Z",
        "2026-08-30T12:00:03Z",
        "2026-08-30T12:00:00Z",
        "2026-08-30T12:00:02Z",
      ],
    },
  ])("pages newest-first by source order with $name timestamps", ({ timestamps }) => {
    const items: SessionCatalogTranscriptItem[] = ["z", "2", "10", "a", "1"].map((id, index) => ({
      id,
      type: "agentMessage",
      text: id,
      timestamp: timestamps[index],
    }));
    const latest = sessionCatalogPaging.boundTranscriptPage(items, 2, 0);
    expect(latest.items.map((item) => item.id)).toEqual(["1", "a"]);
    const older = sessionCatalogPaging.boundTranscriptPage(
      items,
      2,
      sessionCatalogPaging.decodeCursor(latest.nextCursor),
    );
    expect(older.items.map((item) => item.id)).toEqual(["10", "2"]);
    const oldest = sessionCatalogPaging.boundTranscriptPage(
      items,
      2,
      sessionCatalogPaging.decodeCursor(older.nextCursor),
    );
    expect(oldest.items.map((item) => item.id)).toEqual(["z"]);
    expect(oldest.nextCursor).toBeUndefined();
    expect(items.map((item) => item.id)).toEqual(["z", "2", "10", "a", "1"]);
  });

  function createFamilyFixture() {
    const invoke = vi.fn().mockResolvedValue({
      payloadJSON: JSON.stringify({ sessions: [session("remote-thread")] }),
    });
    const runtime = {
      nodes: {
        list: vi.fn().mockResolvedValue({
          nodes: [
            {
              nodeId: "node-1",
              displayName: "Remote",
              connected: true,
              commands: ["family.list", "family.read", "family.terminal"],
            },
          ],
        }),
        invoke,
      },
    } as unknown as PluginRuntime;
    const create = vi.fn<SessionCatalogFamilyOptions["continuation"]["create"]>(
      async ({ agentId }) => ({ sessionKey: `agent:${agentId}:created` }),
    );
    const complete = vi.fn<SessionCatalogFamilyOptions["continuation"]["complete"]>(
      async (continued) => continued,
    );
    const options: SessionCatalogFamilyOptions = {
      runtime,
      local: {
        hostId: "gateway",
        label: "Local Family",
        available: () => true,
        list: async () => ({ sessions: [session("local-thread")] }),
        read: async (request) => ({
          hostId: request.hostId,
          threadId: request.threadId,
          items: [],
        }),
        assertAccess: vi.fn(),
      },
      node: {
        listCommand: "family.list",
        readCommand: "family.read",
        terminalCommand: "family.terminal",
        timeoutMs: 1_000,
        maxHosts: 10,
        maxPageLimit: 100,
        sessionIdPattern: /^[a-z0-9-]+$/u,
      },
      capabilities: {
        local: () => ({ canContinue: true, canOpenTerminal: false }),
        node: () => ({ canContinue: false, canOpenTerminal: true }),
        project: (value, capabilities) => ({ ...value, ...capabilities }),
      },
      messages: {
        invalidNodeCursor: "bad node cursor",
        invalidNodeSessionPage: "bad node sessions",
        invalidNodeTranscriptPage: "bad node transcript",
        invalidHostId: "bad host",
        localReadFailed: "local unavailable",
        nodeInvokeFailed: "node unavailable",
        nodeReadUnavailable: "node read unavailable",
        nodeTerminalUnavailable: "node terminal unavailable",
        sessionUnavailable: "session unavailable",
      },
      continuation: {
        resolveAgentId: (agentId = "main") => agentId,
        availability: () => ({ available: true }),
        listAdopted: (_agentId, entries) =>
          entries
            ? new Map([[sessionCatalogAdoptedSourceKey("gateway", "local-thread"), "adopted"]])
            : new Map(),
        loadSession: async (threadId) => session(threadId),
        validateSession: vi.fn(),
        create,
        complete,
        nodeReadOnlyMessage: "nodes are read-only",
      },
      terminal: {
        executable: "family",
        args: (threadId) => ["--session", threadId],
        title: (threadId) => `family ${threadId}`,
        requireLocalSession: async (threadId) => session(threadId),
        unavailableMessage: "family unavailable",
      },
      checkUpstreamActivity: async () => [],
    };
    const provider = createSessionCatalogFamily(options, sessionCatalogPaging.isExactCursor);
    return { provider, options, create, complete };
  }

  it("composes explicit local, node, adoption, capability, and continuation operations", async () => {
    const { provider } = createFamilyFixture();
    const onHost = vi.fn();

    const hosts = await provider.list({
      sessionEntries: { entriesForAgent: () => [] },
      onHost,
    });

    expect(hosts).toEqual([
      expect.objectContaining({
        hostId: "gateway",
        sessions: [
          expect.objectContaining({
            threadId: "local-thread",
            sessionKey: "adopted",
            canContinue: true,
            canOpenTerminal: false,
          }),
        ],
      }),
      expect.objectContaining({
        hostId: "node:node-1",
        sessions: [
          expect.objectContaining({
            threadId: "remote-thread",
            canContinue: false,
            canOpenTerminal: true,
          }),
        ],
      }),
    ]);
    expect(onHost).toHaveBeenCalledTimes(2);

    await expect(
      provider.continueSession({ hostId: "gateway", threadId: "local-thread" }),
    ).resolves.toEqual({ sessionKey: "agent:main:created" });
  });

  it.each([
    { joinDuring: "lookup", firstAgentId: "main", secondAgentId: "main" },
    { joinDuring: "lookup", firstAgentId: "main", secondAgentId: "other" },
    { joinDuring: "lookup", firstAgentId: undefined, secondAgentId: "main" },
    { joinDuring: "completion", firstAgentId: "main", secondAgentId: "main" },
    { joinDuring: "completion", firstAgentId: "main", secondAgentId: "other" },
    { joinDuring: "completion", firstAgentId: undefined, secondAgentId: "main" },
  ])(
    "coordinates $firstAgentId/$secondAgentId adoption during $joinDuring and reuses stored adoption",
    async ({ joinDuring, firstAgentId, secondAgentId }) => {
      const { provider, options, create, complete } = createFamilyFixture();
      const request = { hostId: "gateway", threadId: "local-thread" };
      const sourceKey = sessionCatalogAdoptedSourceKey(request.hostId, request.threadId);
      const adopted = new Map<string, Map<string, string>>();
      const entered = createDeferred();
      const release = createDeferred();
      const secondResolved = createDeferred();
      let resolutions = 0;
      options.continuation.resolveAgentId = (agentId = "main") => {
        if (++resolutions === 2) {
          secondResolved.resolve();
        }
        return agentId;
      };
      const listAdopted = vi.fn(async (agentId = "main") => {
        if (joinDuring === "lookup") {
          entered.resolve();
          await release.promise;
        }
        return adopted.get(agentId) ?? new Map<string, string>();
      });
      options.continuation.listAdopted = listAdopted;
      create.mockImplementation(async ({ agentId }) => {
        const sessionKey = `agent:${agentId}:created`;
        adopted.set(agentId, new Map([[sourceKey, sessionKey]]));
        return { sessionKey };
      });
      complete.mockImplementation(async (continued) => {
        if (joinDuring === "completion") {
          entered.resolve();
          await release.promise;
        }
        return continued;
      });

      const first = provider.continueSession({ ...request, agentId: firstAgentId });
      await entered.promise;
      const second = provider.continueSession({ ...request, agentId: secondAgentId });
      // Resolution is synchronous; the second request enters single-flight before this resumes.
      await secondResolved.promise;
      release.resolve();
      const results = await Promise.all([first, second]);

      expect
        .soft(results)
        .toEqual([
          { sessionKey: "agent:main:created" },
          { sessionKey: `agent:${secondAgentId}:created` },
        ]);
      const agentIds = [...new Set(["main", secondAgentId])];
      expect.soft(listAdopted.mock.calls).toEqual(agentIds.map((agentId) => [agentId]));
      expect.soft(create).toHaveBeenCalledTimes(agentIds.length);
      expect.soft(complete).toHaveBeenCalledTimes(agentIds.length);
      for (const agentId of agentIds) {
        const continued = { sessionKey: `agent:${agentId}:created` };
        expect.soft(create).toHaveBeenCalledWith({
          ...request,
          agentId,
          session: session(request.threadId),
        });
        expect.soft(complete).toHaveBeenCalledWith(continued, request.threadId);
        // Stored source identity stays host/thread-only after the in-flight operation ends.
        await expect(provider.continueSession({ ...request, agentId })).resolves.toEqual(continued);
      }
      expect(create).toHaveBeenCalledTimes(agentIds.length);
      expect(complete).toHaveBeenCalledTimes(agentIds.length * 2);
    },
  );
});
