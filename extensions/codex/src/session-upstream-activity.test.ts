import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionUpstreamProbe } from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./app-server/client.js";
import type { CodexTurn } from "./app-server/protocol.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import type { CodexSessionCatalogControl } from "./session-catalog-types.js";
import { createChecker } from "./session-upstream-activity.js";

function probe(overrides: Partial<SessionUpstreamProbe> = {}): SessionUpstreamProbe {
  return {
    sessionKey: "agent:main:adopted:codex",
    agentId: "main",
    threadId: "thread-1",
    hostId: "gateway:local",
    upstreamKind: "codex-app-server",
    upstreamRef: { connectionFingerprint: "connection-1", threadId: "thread-1" },
    marker: { turnId: "turn-1", userMessageCount: 1 },
    ownRecentUserTexts: [],
    ...overrides,
  };
}

function turn(id: string, itemTypes: string[], startedAt: number): CodexTurn {
  return {
    id,
    startedAt,
    items: itemTypes.map((type, index) => ({
      id: `${id}-item-${index}`,
      type,
      text: type === "userMessage" ? `${id} prompt ${index}` : "",
    })) as CodexTurn["items"],
  };
}

function createControl(overrides: Partial<CodexSessionCatalogControl> = {}) {
  const withPinnedConnection = vi.fn(
    async (run: (value: CodexSessionCatalogControl) => Promise<unknown>) => await run(control),
  ) as unknown as CodexSessionCatalogControl["withPinnedConnection"];
  const control = {
    connectionFingerprint: "connection-1",
    withPinnedConnection,
    listPage: vi.fn(async () => ({ sessions: [] })),
    listDescendantPage: vi.fn(async () => ({ data: [] })),
    listTurnPage: vi.fn(async () => ({ data: [] })),
    readThread: vi.fn(async (threadId: string) => ({ id: threadId }) as never),
    archiveThread: vi.fn(async () => undefined),
    ...overrides,
  } as CodexSessionCatalogControl;
  return control;
}

function createActivityChecker(params: {
  control: CodexSessionCatalogControl;
  sessionId?: string;
  binding?: {
    threadId: string;
    connectionScope?: "supervision";
    supervisionSourceThreadId?: string;
  };
}) {
  const api = {
    runtime: {
      agent: {
        session: {
          getSessionEntry: () => (params.sessionId ? { sessionId: params.sessionId } : undefined),
        },
      },
    },
  } as unknown as OpenClawPluginApi;
  const bindingStore = {
    read: vi.fn(async () => params.binding),
  } as unknown as CodexAppServerBindingStore;
  return createChecker({
    api,
    bindingStore,
    control: params.control,
    getRuntimeConfig: () => undefined,
  });
}

async function checkTurns(params: { probe: SessionUpstreamProbe; turns: CodexTurn[] }) {
  const control = createControl({
    listTurnPage: vi.fn(async () => ({ data: params.turns })),
  });
  return await createActivityChecker({ control })([params.probe]);
}

describe("Codex upstream activity", () => {
  it("counts userMessage turns and uses the latest human timestamp", async () => {
    await expect(
      checkTurns({
        probe: probe(),
        turns: [
          turn("turn-4", ["agentMessage"], 400),
          turn("turn-3", ["userMessage", "agentMessage"], 300),
          turn("turn-2", ["agentMessage"], 200),
          turn("turn-1", ["userMessage"], 100),
        ],
      }),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "agent:main:adopted:codex",
        occurredAt: 300_000,
        humanTurns: 1,
        nextMarker: { turnId: "turn-4", userMessageCount: 0 },
        dedupeId: "turn-4:0",
      },
    ]);
  });

  it("keeps an existing thread linked when its turn page is empty", async () => {
    await expect(checkTurns({ probe: probe(), turns: [] })).resolves.toEqual([]);
  });

  it("accepts an empty page for a thread with no materialized turn", async () => {
    await expect(
      checkTurns({
        probe: probe({ marker: { turnId: null, userMessageCount: 0 } }),
        turns: [],
      }),
    ).resolves.toEqual([]);
  });

  it("uses the pinned connection and a bounded descending summary page", async () => {
    const listTurnPage = vi.fn(async () => ({
      data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)],
    }));
    const readThread = vi.fn(async () => ({}) as never);
    const control = createControl({
      listTurnPage,
      readThread,
    });
    const checkUpstreamActivity = createActivityChecker({
      control,
      sessionId: "session-1",
      binding: {
        threadId: "thread-canonical",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-1",
      },
    });

    await expect(checkUpstreamActivity([probe()])).resolves.toEqual([
      expect.objectContaining({ dedupeId: "turn-2:1", humanTurns: 1 }),
    ]);
    expect(listTurnPage).toHaveBeenCalledWith({
      threadId: "thread-canonical",
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    });
    expect(readThread).not.toHaveBeenCalled();
  });

  it("keeps a rolled-back thread linked when thread/read succeeds", async () => {
    const readThread = vi.fn(async () => ({}) as never);
    const control = createControl({
      listTurnPage: async () => ({ data: [] }),
      readThread,
    });
    const checkUpstreamActivity = createActivityChecker({
      control,
      sessionId: "session-1",
      binding: {
        threadId: "thread-canonical",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-1",
      },
    });

    await expect(checkUpstreamActivity([probe()])).resolves.toEqual([]);
    expect(readThread).toHaveBeenCalledWith("thread-canonical", false);
  });

  it("reports missing when thread/read rejects with the definitive not-found code", async () => {
    const readThread = vi.fn(async () => {
      throw new CodexAppServerRpcError(
        { code: -32600, message: "thread not loaded: thread-1" },
        "thread/read",
      );
    });
    const control = createControl({
      listTurnPage: async () => ({ data: [] }),
      readThread,
    });

    await expect(createActivityChecker({ control })([probe()])).resolves.toEqual([
      { kind: "missing", sessionKey: "agent:main:adopted:codex" },
    ]);
    expect(readThread).toHaveBeenCalledWith("thread-1", false);
  });

  it("treats non-definitive thread/read failures as inconclusive", async () => {
    const readThread = vi.fn(async () => {
      throw new CodexAppServerRpcError({ code: -32603, message: "store hiccup" }, "thread/read");
    });
    const control = createControl({
      listTurnPage: async () => ({ data: [] }),
      readThread,
    });

    await expect(createActivityChecker({ control })([probe()])).resolves.toEqual([]);
  });

  it("treats other invalid-request thread/read failures as inconclusive", async () => {
    const readThread = vi.fn(async () => {
      throw new CodexAppServerRpcError(
        { code: -32600, message: "some other validation failure" },
        "thread/read",
      );
    });
    const control = createControl({
      listTurnPage: async () => ({ data: [] }),
      readThread,
    });

    await expect(createActivityChecker({ control })([probe()])).resolves.toEqual([]);
  });

  it("detects deletion of a thread baselined with no materialized turn", async () => {
    const readThread = vi.fn(async () => {
      throw new CodexAppServerRpcError(
        { code: -32600, message: "thread not loaded: thread-1" },
        "thread/read",
      );
    });
    const control = createControl({
      listTurnPage: async () => ({ data: [] }),
      readThread,
    });

    await expect(
      createActivityChecker({ control })([
        probe({ marker: { turnId: null, userMessageCount: 0 } }),
      ]),
    ).resolves.toEqual([{ kind: "missing", sessionKey: "agent:main:adopted:codex" }]);
  });

  it("isolates a stale thread from healthy probes", async () => {
    const listTurnPage = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === "thread-stale") {
        throw new Error("thread missing");
      }
      return { data: [turn("turn-2", ["userMessage"], 200), turn("turn-1", [], 100)] };
    });
    const control = createControl({
      listTurnPage,
      readThread: async () => ({}) as never,
    });

    await expect(
      createActivityChecker({ control })([
        probe({ threadId: "thread-stale" }),
        probe({ sessionKey: "healthy" }),
      ]),
    ).resolves.toEqual([expect.objectContaining({ sessionKey: "healthy" })]);
  });

  it("detects a steer-appended user message on the marker turn", async () => {
    await expect(
      checkTurns({
        probe: probe({ marker: { turnId: "turn-1", userMessageCount: 1 } }),
        turns: [turn("turn-1", ["userMessage", "agentMessage", "userMessage"], 100)],
      }),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "agent:main:adopted:codex",
        occurredAt: 100_000,
        humanTurns: 1,
        nextMarker: { turnId: "turn-1", userMessageCount: 2 },
        dedupeId: "turn-1:2",
      },
    ]);
  });

  it("upgrades a legacy turn marker without reporting existing steers", async () => {
    await expect(
      checkTurns({
        probe: probe({ marker: { turnId: "turn-1" } }),
        turns: [turn("turn-1", ["userMessage", "agentMessage", "userMessage"], 100)],
      }),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "agent:main:adopted:codex",
        humanTurns: 0,
        nextMarker: { turnId: "turn-1", userMessageCount: 2 },
      },
    ]);
  });

  it("filters OpenClaw-authored user items by normalized transcript text", async () => {
    await expect(
      checkTurns({
        probe: probe({
          marker: { turnId: "turn-1", userMessageCount: 0 },
          ownRecentUserTexts: ["same prompt"],
        }),
        turns: [
          {
            ...turn("turn-1", [], 100),
            items: [
              {
                id: "user-1",
                type: "userMessage",
                text: "",
                content: [{ type: "text", text: " same   prompt ", text_elements: [] }],
              } as unknown as CodexTurn["items"][number],
            ],
          },
        ],
      }),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "agent:main:adopted:codex",
        humanTurns: 0,
        nextMarker: { turnId: "turn-1", userMessageCount: 1 },
      },
    ]);
  });

  it("filters a batched OpenClaw steer by its component transcript texts", async () => {
    await expect(
      checkTurns({
        probe: probe({
          marker: { turnId: "turn-1", userMessageCount: 0 },
          ownRecentUserTexts: ["first steer", "second steer"],
        }),
        turns: [
          {
            ...turn("turn-1", [], 100),
            items: [
              {
                id: "user-1",
                type: "userMessage",
                text: "",
                content: [
                  { type: "text", text: " first   steer ", text_elements: [] },
                  { type: "text", text: "second steer", text_elements: [] },
                ],
              } as unknown as CodexTurn["items"][number],
            ],
          },
        ],
      }),
    ).resolves.toEqual([
      {
        kind: "activity",
        sessionKey: "agent:main:adopted:codex",
        humanTurns: 0,
        nextMarker: { turnId: "turn-1", userMessageCount: 1 },
      },
    ]);
  });
});
