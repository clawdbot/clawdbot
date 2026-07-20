// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardMcpAppViewCache } from "./mcp-app-view-cache.ts";
import {
  boardExists,
  boardProviderForSession,
  canvasWidgetNameForDocument,
  GatewayBoardProvider,
  mcpAppWidgetNameForViewId,
  type BoardCommandEvent,
  type BoardProvider,
} from "./provider.ts";

type MockProvider = BoardProvider & { emitCommand(command: BoardCommandEvent["command"]): void };

let mockLocation: { search: string };

function mockBoardProvider(sessionKey: string): MockProvider {
  return boardProviderForSession(sessionKey) as MockProvider;
}

beforeEach(() => {
  mockLocation = { search: "?mockBoard=1" };
  vi.stubGlobal("location", mockLocation);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("board providers", () => {
  it("keeps generated canvas widget names distinct after normalization and truncation", () => {
    const longPrefix = "x".repeat(80);
    const names = [
      canvasWidgetNameForDocument("Foo"),
      canvasWidgetNameForDocument("foo"),
      canvasWidgetNameForDocument(`${longPrefix}-one`),
      canvasWidgetNameForDocument(`${longPrefix}-two`),
    ];

    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names.every((name) => /^[a-z0-9][a-z0-9._-]*$/u.test(name))).toBe(true);
  });

  it("generates opaque stable names for MCP App views", () => {
    const first = mcpAppWidgetNameForViewId("view-session-bound");
    const second = mcpAppWidgetNameForViewId("view-session-bound");

    expect(first).toBe(second);
    expect(first).toMatch(/^mcp-app-[a-f0-9]{16}$/u);
    expect(first).not.toContain("view-session-bound");
  });

  it("keeps the null provider chat-only", () => {
    mockLocation.search = "";
    const provider = boardProviderForSession("agent:main:plain");

    expect(boardExists(provider.snapshot$.value)).toBe(false);
    expect(provider.snapshot$.value).toEqual({
      sessionKey: "agent:main:plain",
      revision: 0,
      tabs: [],
      widgets: [],
    });
  });

  it("keeps older gateways without board methods on the null provider", () => {
    mockLocation.search = "";
    const provider = boardProviderForSession("agent:main:legacy", {} as never, false);

    expect(provider.canPinWidgets).toBe(false);
    expect(boardExists(provider.snapshot$.value)).toBe(false);
  });

  it("updates pin capability independently from board availability", () => {
    mockLocation.search = "";
    const client = {
      request: vi.fn(),
      addEventListener: vi.fn(() => () => {}),
    };
    const provider = boardProviderForSession(
      "agent:main:pin-capability",
      client as never,
      true,
      false,
      false,
    );

    expect(provider.canPinWidgets).toBe(false);
    expect(provider.canPinMcpApps).toBe(false);
    expect(
      boardProviderForSession(
        "agent:main:pin-capability",
        client as never,
        true,
        false,
        true,
        false,
      ),
    ).toBe(provider);
    expect(provider.canPinWidgets).toBe(true);
    expect(provider.canPinMcpApps).toBe(false);
    boardProviderForSession("agent:main:pin-capability", client as never, true, false, true, true);
    expect(provider.canPinMcpApps).toBe(true);
  });

  it("provides two mock tabs with mixed widget sizes", () => {
    const snapshot = mockBoardProvider("agent:main:main").snapshot$.value;

    expect(snapshot.tabs).toHaveLength(2);
    expect(snapshot.tabs.map((tab) => tab.chatDock)).toEqual(["right", "bottom"]);
    expect(new Set(snapshot.widgets.map((widget) => `${widget.sizeW}x${widget.sizeH}`)).size).toBe(
      3,
    );
  });

  it("applies dock operations and publishes snapshots", async () => {
    const provider = mockBoardProvider("agent:main:main");
    const changed = vi.fn();
    provider.snapshot$.subscribe(changed);

    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);

    expect(provider.snapshot$.value.tabs[0]?.chatDock).toBe("left");
    expect(provider.snapshot$.value.revision).toBe(2);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("preserves tabs when a reorder is not a complete permutation", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([{ kind: "tabs_reorder", tabIds: ["research"] }]);

    expect(provider.snapshot$.value.tabs.map((tab) => tab.tabId)).toEqual(["main", "research"]);
  });

  it("does not create or reorder duplicate tab ids", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "tab_create", tabId: "main", title: "Duplicate" },
      { kind: "tabs_reorder", tabIds: ["main", "research", "main"] },
    ]);

    expect(provider.snapshot$.value.tabs.map((tab) => tab.tabId)).toEqual(["main", "research"]);
  });

  it("reorders widgets after a named anchor", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "widget_move", name: "session-status", after: "recent-findings" },
    ]);

    expect(
      provider.snapshot$.value.widgets
        .filter((widget) => widget.tabId === "main")
        .toSorted((left, right) => left.position - right.position)
        .map((widget) => widget.name),
    ).toEqual(["recent-findings", "session-status"]);
  });

  it("moves widgets across tabs and normalizes both tab orders", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "widget_move", name: "source-map", tabId: "main", after: "session-status" },
    ]);

    expect(
      provider.snapshot$.value.widgets
        .filter((widget) => widget.tabId === "main")
        .map((widget) => `${widget.position}:${widget.name}`),
    ).toEqual(["0:session-status", "1:source-map", "2:recent-findings"]);
    expect(
      provider.snapshot$.value.widgets.filter((widget) => widget.tabId === "research"),
    ).toEqual([]);
  });

  it("clamps widget sizes to the board grid", async () => {
    const provider = mockBoardProvider("agent:main:main");

    await provider.applyOps([
      { kind: "widget_resize", name: "session-status", sizeW: 99, sizeH: -5 },
    ]);

    expect(provider.snapshot$.value.widgets[0]).toMatchObject({ sizeW: 12, sizeH: 1 });
  });

  it("surfaces agent board commands", () => {
    const provider = mockBoardProvider("agent:main:main");
    const listener = vi.fn();
    provider.events.subscribe(listener);

    provider.emitCommand({ kind: "set_chat_dock", dock: "hidden" });
    provider.emitCommand({ kind: "focus_tab", tabId: "research" });

    expect(listener).toHaveBeenNthCalledWith(1, {
      sessionKey: "agent:main:main",
      command: { kind: "set_chat_dock", dock: "hidden" },
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      sessionKey: "agent:main:main",
      command: { kind: "focus_tab", tabId: "research" },
    });
  });

  it("shares one provider across equivalent main session keys", () => {
    vi.stubGlobal("location", { search: "?mockBoard=1" });

    expect(boardProviderForSession("main")).toBe(boardProviderForSession("agent:main:main"));
  });

  it("provides mock boards for canonical configured-main session keys", () => {
    vi.stubGlobal("location", { search: "?mockBoard=1" });

    expect(boardExists(boardProviderForSession("agent:work:primary").snapshot$.value)).toBe(true);
  });

  it("refetches changed boards while reloading only the named widget frame", async () => {
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const snapshots = [
      {
        sessionKey: "agent:main:live",
        revision: 1,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
        widgets: [
          {
            name: "alpha",
            tabId: "main",
            contentKind: "html" as const,
            sizeW: 6,
            sizeH: 4,
            position: 0,
            grantState: "none" as const,
            revision: 1,
            frameUrl: "/alpha-old",
          },
          {
            name: "beta",
            tabId: "main",
            contentKind: "html" as const,
            sizeW: 6,
            sizeH: 4,
            position: 1,
            grantState: "none" as const,
            revision: 1,
            frameUrl: "/beta-old",
          },
        ],
      },
      {
        sessionKey: "agent:main:live",
        revision: 2,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
        widgets: [
          {
            name: "alpha",
            tabId: "main",
            contentKind: "html" as const,
            sizeW: 6,
            sizeH: 4,
            position: 0,
            grantState: "none" as const,
            revision: 2,
            frameUrl: "/alpha-new",
          },
          {
            name: "beta",
            tabId: "main",
            contentKind: "html" as const,
            sizeW: 6,
            sizeH: 4,
            position: 1,
            grantState: "none" as const,
            revision: 1,
            frameUrl: "/beta-reminted-but-preserved",
          },
        ],
      },
      {
        sessionKey: "agent:main:live",
        revision: 2,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
        widgets: [
          {
            name: "alpha",
            tabId: "main",
            contentKind: "html" as const,
            sizeW: 6,
            sizeH: 4,
            position: 0,
            grantState: "none" as const,
            revision: 2,
            frameUrl: "/alpha-reminted",
          },
          {
            name: "beta",
            tabId: "main",
            contentKind: "html" as const,
            sizeW: 6,
            sizeH: 4,
            position: 1,
            grantState: "none" as const,
            revision: 1,
            frameUrl: "/beta-reminted-again",
          },
        ],
      },
    ];
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("board.get");
      return snapshots.shift();
    });
    const provider = new GatewayBoardProvider("agent:main:live", {
      request: request as never,
      addEventListener: (next) => {
        listener = next as typeof listener;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));

    listener?.({
      event: "board.changed",
      payload: { sessionKey: "agent:main:live", revision: 2, widget: "alpha" },
    });
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(2));

    expect(provider.widgetFrameUrl("alpha", 2)).toBe("/alpha-new");
    expect(provider.widgetFrameUrl("beta", 1)).toBe("/beta-old");

    await provider.refreshWidgetFrame("alpha");
    expect(provider.widgetFrameUrl("alpha", 2)).toBe("/alpha-reminted");
    expect(provider.widgetFrameUrl("beta", 1)).toBe("/beta-old");
  });

  it("does not publish an activation snapshot older than a completed mutation", async () => {
    let resolveActivation: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const stale = {
      sessionKey: "agent:main:stale",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const current = {
      sessionKey: "agent:main:stale",
      revision: 2,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const request = vi.fn((method: string) => {
      if (method === "board.get") {
        return new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
          resolveActivation = resolve;
        });
      }
      return Promise.resolve(current);
    });
    const provider = new GatewayBoardProvider("agent:main:stale", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", expect.anything()));

    await provider.pinWidget({ docId: "cv-current" });
    expect(provider.snapshot$.value.revision).toBe(2);
    resolveActivation?.(stale);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    expect(provider.snapshot$.value).toEqual(current);
  });

  it("preserves a newer deletion reset while an older refresh is in flight", async () => {
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let resolveIntermediate: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const populated = {
      sessionKey: "agent:main:deleted-board",
      revision: 5,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const intermediate = { ...populated, revision: 6 };
    const deleted = {
      sessionKey: "agent:main:deleted-board",
      revision: 0,
      tabs: [],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(populated)
      .mockImplementationOnce(
        () =>
          new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveIntermediate = resolve;
          }),
      )
      .mockResolvedValueOnce(deleted);
    const provider = new GatewayBoardProvider("agent:main:deleted-board", {
      request: request as never,
      addEventListener: (next) => {
        listener = next as typeof listener;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(populated));

    listener?.({
      event: "board.changed",
      payload: { sessionKey: "agent:main:deleted-board", revision: 6 },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    listener?.({
      event: "board.changed",
      payload: { sessionKey: "agent:main:deleted-board", revision: 7 },
    });
    resolveIntermediate?.(intermediate);

    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(deleted));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("accepts a recreated board after a higher-revision deletion event", async () => {
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let resolveStale: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const populated = {
      sessionKey: "agent:main:recreated-board",
      revision: 5,
      tabs: [{ tabId: "old", title: "Old", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const deleted = {
      sessionKey: "agent:main:recreated-board",
      revision: 0,
      tabs: [],
      widgets: [],
    };
    const recreated = {
      sessionKey: "agent:main:recreated-board",
      revision: 1,
      tabs: [{ tabId: "new", title: "New", position: 0, chatDock: "left" as const }],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(populated)
      .mockImplementationOnce(
        () =>
          new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce(recreated);
    const provider = new GatewayBoardProvider("agent:main:recreated-board", {
      request: request as never,
      addEventListener: (next) => {
        listener = next as typeof listener;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(populated));

    listener?.({
      event: "board.changed",
      payload: { sessionKey: "agent:main:recreated-board", revision: 6 },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    listener?.({
      event: "board.changed",
      payload: { sessionKey: "agent:main:recreated-board", revision: 1 },
    });
    resolveStale?.(deleted);

    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(recreated));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("ignores a stale empty response from an overlapping mutation", async () => {
    let resolveOlder: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    let resolveNewer: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const populated = {
      sessionKey: "agent:main:mutation-race",
      revision: 5,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const newer = { ...populated, revision: 6 };
    const deleted = {
      sessionKey: "agent:main:mutation-race",
      revision: 0,
      tabs: [],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(populated)
      .mockImplementationOnce(
        () =>
          new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveNewer = resolve;
          }),
      );
    const provider = new GatewayBoardProvider("agent:main:mutation-race", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(populated));

    const olderMutation = provider.applyOps([{ kind: "tab_delete", tabId: "main" }]);
    const newerMutation = provider.applyOps([
      { kind: "tab_update", tabId: "main", chatDock: "left" },
    ]);
    resolveNewer?.(newer);
    await newerMutation;
    resolveOlder?.(deleted);
    await olderMutation;

    expect(provider.snapshot$.value).toEqual(newer);
  });

  it("does not resurrect a board from a refresh started before deletion", async () => {
    let resolveRefresh: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    let resolveDelete: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const populated = {
      sessionKey: "agent:main:refresh-reset-race",
      revision: 5,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const staleRefresh = { ...populated, revision: 6 };
    const deleted = {
      sessionKey: "agent:main:refresh-reset-race",
      revision: 0,
      tabs: [],
      widgets: [],
    };
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "board.get") {
        getCount += 1;
        if (getCount === 1) {
          return Promise.resolve(populated);
        }
        if (getCount === 2) {
          return new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return Promise.resolve(deleted);
      }
      return new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
        resolveDelete = resolve;
      });
    });
    const provider = new GatewayBoardProvider("agent:main:refresh-reset-race", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(populated));

    const refresh = provider.activate();
    await vi.waitFor(() => expect(getCount).toBe(2));
    const deleteMutation = provider.applyOps([{ kind: "tab_delete", tabId: "main" }]);
    resolveDelete?.(deleted);
    await deleteMutation;
    resolveRefresh?.(staleRefresh);
    await refresh;

    expect(provider.snapshot$.value).toEqual(deleted);
    expect(getCount).toBe(3);
  });

  it("preserves a widget ticket refresh across a superseding mutation", async () => {
    let resolveRefresh: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const initial = {
      sessionKey: "agent:main:ticket-race",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [
        {
          name: "alpha",
          tabId: "main",
          contentKind: "html" as const,
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none" as const,
          revision: 1,
          frameUrl: "/old-ticket",
        },
      ],
    };
    const mutation = {
      ...initial,
      revision: 2,
      widgets: [{ ...initial.widgets[0]!, frameUrl: "/mutation-ticket" }],
    };
    const reminted = {
      ...mutation,
      widgets: [{ ...initial.widgets[0]!, frameUrl: "/reminted-ticket" }],
    };
    let getCount = 0;
    const request = vi.fn((method: string) => {
      if (method !== "board.get") {
        return Promise.resolve(mutation);
      }
      getCount += 1;
      if (getCount === 1) {
        return Promise.resolve(initial);
      }
      if (getCount === 2) {
        return new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return Promise.resolve(reminted);
    });
    const provider = new GatewayBoardProvider("agent:main:ticket-race", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(initial));

    const refresh = provider.refreshWidgetFrame("alpha");
    await vi.waitFor(() => expect(getCount).toBe(2));
    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);
    resolveRefresh?.({
      ...mutation,
      widgets: [{ ...initial.widgets[0]!, frameUrl: "/superseded-ticket" }],
    });
    await refresh;

    expect(getCount).toBe(3);
    expect(provider.widgetFrameUrl("alpha", 1)).toBe("/reminted-ticket");
  });

  it("discards mutation responses from a replaced gateway client", async () => {
    let resolveMutation: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const oldClient = {
      request: vi.fn(
        () =>
          new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveMutation = resolve;
          }),
      ) as never,
      addEventListener: () => () => {},
    };
    const current = {
      sessionKey: "agent:main:replacement",
      revision: 3,
      tabs: [],
      widgets: [],
    };
    const newClient = {
      request: vi.fn(async () => current) as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider("agent:main:replacement", oldClient, false);
    const mutation = provider.applyOps([]);

    provider.attachClient(newClient, true);
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(current));
    resolveMutation?.({ ...current, revision: 4 });
    await mutation;

    expect(provider.snapshot$.value).toEqual(current);
  });

  it("clears an old gateway snapshot before accepting a lower revision", async () => {
    const oldSnapshot = {
      sessionKey: "agent:main:gateway-swap",
      revision: 5,
      tabs: [{ tabId: "main", title: "Old", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const newSnapshot = {
      sessionKey: "agent:main:gateway-swap",
      revision: 1,
      tabs: [{ tabId: "main", title: "New", position: 0, chatDock: "left" as const }],
      widgets: [],
    };
    const oldClient = {
      request: vi.fn(async () => oldSnapshot) as never,
      addEventListener: () => () => {},
    };
    let resolveNewSnapshot: ((snapshot: BoardProvider["snapshot$"]["value"]) => void) | undefined;
    const newClient = {
      request: vi.fn(
        () =>
          new Promise<BoardProvider["snapshot$"]["value"]>((resolve) => {
            resolveNewSnapshot = resolve;
          }),
      ) as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider("agent:main:gateway-swap", oldClient);
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(oldSnapshot));

    provider.attachClient(newClient, true);
    expect(provider.snapshot$.value).toEqual({
      sessionKey: "agent:main:gateway-swap",
      revision: 0,
      tabs: [],
      widgets: [],
    });
    resolveNewSnapshot?.(newSnapshot);
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(newSnapshot));
  });

  it("retries a transient activation failure", async () => {
    vi.useFakeTimers();
    const snapshot = {
      sessionKey: "agent:main:retry",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(snapshot);
    const provider = new GatewayBoardProvider("agent:main:retry", {
      request: request as never,
      addEventListener: () => () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
  });

  it("reactivates the same gateway client after reconnect", async () => {
    const snapshot = {
      sessionKey: "agent:main:reconnect",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const request = vi.fn(async () => snapshot);
    const client = {
      request: request as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider("agent:main:reconnect", client, false);

    expect(request).not.toHaveBeenCalled();
    provider.attachClient(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(provider.snapshot$.value).toEqual(snapshot);
  });

  it("wakes a pending refresh backoff when the gateway reconnects", async () => {
    vi.useFakeTimers();
    const snapshot = {
      sessionKey: "agent:main:reconnect-backoff",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(snapshot);
    const client = {
      request: request as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider("agent:main:reconnect-backoff", client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    provider.attachClient(client, false);
    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
  });

  it("retries a transient board.changed refresh failure", async () => {
    vi.useFakeTimers();
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const initial = {
      sessionKey: "agent:main:event-retry",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const changed = { ...initial, revision: 2 };
    const request = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(changed);
    const provider = new GatewayBoardProvider("agent:main:event-retry", {
      request: request as never,
      addEventListener: (next) => {
        listener = next as typeof listener;
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    listener?.({
      event: "board.changed",
      payload: { sessionKey: "agent:main:event-retry", revision: 2 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.snapshot$.value.revision).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(3);
    expect(provider.snapshot$.value.revision).toBe(2);
  });

  it("passes mutations through and surfaces board commands", async () => {
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const empty = { sessionKey: "agent:main:live", revision: 0, tabs: [], widgets: [] };
    const pinned = {
      sessionKey: "agent:main:live",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [
        {
          name: "canvas-cv-1",
          tabId: "main",
          contentKind: "html" as const,
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none" as const,
          revision: 1,
          instanceId: "canvas-instance",
          frameUrl: "/frame",
        },
      ],
    };
    let getCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "board.get") {
        getCount += 1;
        return getCount === 1 ? empty : pinned;
      }
      return pinned;
    });
    const provider = new GatewayBoardProvider("agent:main:live", {
      request: request as never,
      addEventListener: (next) => {
        listener = next as typeof listener;
        return () => {};
      },
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", expect.anything()));
    const command = vi.fn();
    provider.events.subscribe(command);

    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);
    await provider.grant("canvas-cv-1", "granted");
    const longTitle = "Pinned ".repeat(20).trim();
    await provider.pinWidget({ docId: "cv-1", title: longTitle });
    await provider.pinMcpApp({
      viewId: "mcp-app-source",
      name: "mcp-app-opaque",
      title: "App status",
      tabId: "main",
      size: "md",
      after: "canvas-cv-1",
    });
    listener?.({
      event: "board.command",
      payload: {
        sessionKey: "agent:main:live",
        command: { kind: "focus_tab", tabId: "main" },
      },
    });

    expect(request).toHaveBeenCalledWith("board.update", {
      sessionKey: "agent:main:live",
      ops: [{ kind: "tab_update", tabId: "main", chatDock: "left" }],
    });
    expect(request).toHaveBeenCalledWith("board.widget.grant", {
      sessionKey: "agent:main:live",
      name: "canvas-cv-1",
      decision: "granted",
      revision: 1,
      instanceId: "canvas-instance",
    });
    expect(request).toHaveBeenCalledWith("board.widget.put", {
      sessionKey: "agent:main:live",
      name: "canvas-cv-1",
      title: Array.from(longTitle).slice(0, 80).join(""),
      content: { kind: "canvas-doc", docId: "cv-1" },
    });
    expect(request).toHaveBeenCalledWith("board.widget.put", {
      sessionKey: "agent:main:live",
      name: "mcp-app-opaque",
      title: "App status",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
      placement: { tabId: "main", size: "md", after: "canvas-cv-1" },
    });
    expect(request.mock.calls.filter(([method]) => method === "board.get")).toHaveLength(1);
    expect(provider.snapshot$.value).toEqual(pinned);
    expect(command).toHaveBeenCalledWith({
      sessionKey: "agent:main:live",
      command: { kind: "focus_tab", tabId: "main" },
    });
  });

  it("deduplicates MCP App leases until an explicit refresh", async () => {
    mockLocation.search = "";
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const snapshot = {
      sessionKey: "agent:main:app",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [
        {
          name: "server-app",
          tabId: "main",
          contentKind: "mcp-app" as const,
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none" as const,
          revision: 1,
          instanceId: "app-instance",
        },
      ],
    };
    let lease = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "board.get") {
        return snapshot;
      }
      if (method === "board.widget.appView") {
        lease += 1;
        return { viewId: `mcp-app-${lease}`, expiresAtMs: lease === 1 ? 10_000 : 20_000 };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const provider = new GatewayBoardProvider("agent:main:app", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));

    await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
      status: "ready",
      viewId: "mcp-app-1",
    });
    expect(request).toHaveBeenCalledWith("board.widget.appView", {
      sessionKey: "agent:main:app",
      name: "server-app",
      revision: 1,
      instanceId: "app-instance",
    });
    await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
      viewId: "mcp-app-1",
    });
    now = 6_000;
    await expect(provider.widgetAppView("server-app", 1)).resolves.toMatchObject({
      status: "ready",
      viewId: "mcp-app-1",
    });
    await expect(provider.refreshWidgetAppView("server-app", 1)).resolves.toMatchObject({
      status: "ready",
      viewId: "mcp-app-2",
    });
    expect(request.mock.calls.filter(([method]) => method === "board.widget.appView")).toHaveLength(
      2,
    );
  });

  it("does not reuse a cached MCP App lease for a same-name replacement", async () => {
    const cache = new BoardMcpAppViewCache();
    const widget = {
      name: "server-app",
      tabId: "main",
      contentKind: "mcp-app" as const,
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none" as const,
      revision: 1,
      instanceId: "instance-a",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ viewId: "view-a", expiresAtMs: Date.now() + 60_000 })
      .mockResolvedValueOnce({ viewId: "view-b", expiresAtMs: Date.now() + 60_000 });

    await expect(cache.resolve(widget, request, false)).resolves.toMatchObject({
      viewId: "view-a",
    });
    await expect(
      cache.resolve({ ...widget, instanceId: "instance-b" }, request, false),
    ).resolves.toMatchObject({ viewId: "view-b" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("contains MCP App re-mint failures as stale widget state and retries on demand", async () => {
    mockLocation.search = "";
    const snapshot = {
      sessionKey: "agent:main:stale-app",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [
        {
          name: "server-app",
          tabId: "main",
          contentKind: "mcp-app" as const,
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none" as const,
          revision: 1,
          instanceId: "stale-app-instance",
        },
      ],
    };
    let attempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "board.get") {
        return snapshot;
      }
      attempts += 1;
      if (attempts === 1) {
        throw new Error("origin transcript pruned");
      }
      return { viewId: "mcp-app-restored", expiresAtMs: Date.now() + 60_000 };
    });
    const provider = new GatewayBoardProvider("agent:main:stale-app", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));

    await expect(provider.widgetAppView("server-app", 1)).resolves.toEqual({
      status: "stale",
      error: "origin transcript pruned",
    });
    await expect(provider.refreshWidgetAppView("server-app", 1)).resolves.toMatchObject({
      status: "ready",
      viewId: "mcp-app-restored",
    });
  });
});
