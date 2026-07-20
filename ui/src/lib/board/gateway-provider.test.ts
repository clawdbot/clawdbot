// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBoardProvider, type BoardProvider } from "./provider.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("gateway board provider lifecycle", () => {
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

  it("preserves minted view metadata across layout and grant mutation snapshots", async () => {
    const widget = {
      name: "alpha",
      tabId: "main",
      contentKind: "html" as const,
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending" as const,
      revision: 1,
      frameUrl: "/ticketed-frame",
      viewTicket: "view-ticket",
      viewTicketTtlMs: 60_000,
      viewGeneration: "a".repeat(32),
      sandboxUrl: "https://sandbox.example/host",
      sandboxPort: 18_790,
      sandboxOrigin: "https://sandbox.example:18790",
    };
    const initial = {
      sessionKey: "agent:main:mutation-view-contract",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [widget],
    };
    const layoutMutation = {
      ...initial,
      revision: 2,
      widgets: [{ ...widget, sizeW: 8, frameUrl: undefined, viewTicket: undefined }].map(
        ({
          frameUrl: _frameUrl,
          viewTicket: _viewTicket,
          viewTicketTtlMs: _viewTicketTtlMs,
          viewGeneration: _viewGeneration,
          sandboxUrl: _sandboxUrl,
          sandboxPort: _sandboxPort,
          sandboxOrigin: _sandboxOrigin,
          ...plainWidget
        }) => plainWidget,
      ),
    };
    const grantMutation = {
      ...layoutMutation,
      revision: 3,
      widgets: [{ ...layoutMutation.widgets[0]!, grantState: "granted" as const }],
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(layoutMutation)
      .mockResolvedValueOnce(grantMutation);
    const provider = new GatewayBoardProvider("agent:main:mutation-view-contract", {
      request: request as never,
      addEventListener: () => () => {},
    });
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(initial));

    await provider.applyOps([{ kind: "widget_resize", name: "alpha", sizeW: 8, sizeH: 4 }]);
    await provider.grant("alpha", "granted");

    expect(provider.snapshot$.value.widgets[0]).toEqual({
      ...widget,
      sizeW: 8,
      grantState: "granted",
    });
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
});
