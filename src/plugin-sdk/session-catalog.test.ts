import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "./plugin-runtime.js";
import {
  createSessionCatalogFamily,
  sessionCatalogPaging,
  sessionCatalogAdoptedSourceKey,
  type SessionCatalogFamilyOptions,
  type SessionCatalogSession,
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

  it("composes explicit local, node, adoption, capability, and continuation operations", async () => {
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
    const create = vi.fn().mockResolvedValue({ sessionKey: "agent:main:created" });
    const complete = vi.fn(async (continued: { sessionKey: string }) => continued);
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
        resolveAgentId: () => "main",
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

    const [first, second] = await Promise.all([
      provider.continueSession!({ hostId: "gateway", threadId: "local-thread" }),
      provider.continueSession!({ hostId: "gateway", threadId: "local-thread" }),
    ]);
    expect(first).toEqual({ sessionKey: "agent:main:created" });
    expect(second).toEqual(first);
    expect(create).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
