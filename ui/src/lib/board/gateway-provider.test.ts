// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBoardProvider } from "./gateway-provider.ts";
import type { BoardProvider } from "./provider.ts";

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
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:replacement" },
      oldClient,
      false,
    );
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
    const provider = new GatewayBoardProvider({ sessionKey: "agent:main:gateway-swap" }, oldClient);
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

  it.each([
    { failure: "transport", error: new Error("temporarily unavailable") },
    {
      failure: "retryable unavailable",
      error: new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: "Starting",
        retryable: true,
      }),
    },
  ])("retries a transient activation failure ($failure)", async ({ error }) => {
    vi.useFakeTimers();
    const snapshot = {
      sessionKey: "agent:main:retry",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [],
    };
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(snapshot);
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:retry" },
      {
        request: request as never,
        addEventListener: () => () => {},
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
  });

  it.each(["manual refresh", "reconnect", "board change"] as const)(
    "stops definitive unavailable polling until %s without discarding its snapshot",
    async (resume) => {
      vi.useFakeTimers();
      const initial = {
        sessionKey: "agent:main:unavailable",
        revision: 1,
        tabs: [],
        widgets: [],
      };
      const recovered = { ...initial, revision: 2 };
      const unavailable = new GatewayProtocolRequestError({
        code: "UNAVAILABLE",
        message: "Session dashboard unavailable",
        retryable: false,
      });
      const request = vi.fn().mockResolvedValueOnce(initial).mockRejectedValue(unavailable);
      let emit: ((event: EventFrame) => void) | undefined;
      const client = {
        request: request as never,
        addEventListener: (listener: (event: EventFrame) => void) => {
          emit = listener;
          return () => {};
        },
      };
      const provider = new GatewayBoardProvider({ sessionKey: initial.sessionKey }, client);
      const changed = () =>
        emit?.({
          type: "event",
          event: "board.changed",
          payload: { sessionKey: initial.sessionKey, revision: recovered.revision },
        });
      try {
        await vi.advanceTimersByTimeAsync(0);
        changed();
        await vi.advanceTimersByTimeAsync(61_000);
        expect(request).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
        expect(provider.snapshot$.value).toEqual(initial);
        expect(provider.loadError$.value).toBe(unavailable.message);

        request.mockResolvedValue(recovered);
        if (resume === "manual refresh") {
          await provider.refreshWidgetFrame("status");
        } else if (resume === "reconnect") {
          provider.attachClient(client, false);
          provider.attachClient(client, true);
        } else {
          changed();
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(3);
        expect(provider.snapshot$.value).toEqual(recovered);
        expect(provider.loadError$.value).toBeNull();
      } finally {
        provider.dispose();
      }
    },
  );

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
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:reconnect" },
      client,
      false,
    );

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
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:reconnect-backoff" },
      client,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    provider.attachClient(client, false);
    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
  });

  it("pauses board retries during an outage and refreshes once after reconnect", async () => {
    vi.useFakeTimers();
    let connected = true;
    const snapshot = {
      sessionKey: "agent:main:paused-reconnect",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockImplementation(async () => {
        if (!connected) {
          throw new Error("gateway not connected");
        }
        return snapshot;
      });
    const client = {
      request: request as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider({ sessionKey: snapshot.sessionKey }, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    connected = false;
    provider.attachClient(client, false);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    connected = true;
    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
    provider.dispose();
  });

  it("pauses a failed user-requested widget refresh until reconnect", async () => {
    vi.useFakeTimers();
    const snapshot = {
      sessionKey: "agent:main:offline-widget-refresh",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValue(snapshot);
    const client = {
      request: request as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider({ sessionKey: snapshot.sessionKey }, client, false);

    const refresh = provider.refreshWidgetFrame("status");
    await vi.advanceTimersByTimeAsync(0);
    await refresh;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(snapshot);
    provider.dispose();
  });

  it("preserves a manual offline refresh that joins an existing retry loop", async () => {
    vi.useFakeTimers();
    const snapshot = {
      sessionKey: "agent:main:coalesced-offline-widget-refresh",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValue(snapshot);
    const client = {
      request: request as never,
      addEventListener: () => () => {},
    };
    const provider = new GatewayBoardProvider({ sessionKey: snapshot.sessionKey }, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();

    provider.attachClient(client, false);
    const refresh = provider.refreshWidgetFrame("status");
    await vi.advanceTimersByTimeAsync(0);
    await refresh;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    provider.attachClient(client, true);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(3);
    expect(provider.snapshot$.value).toEqual(snapshot);
    provider.dispose();
  });

  it("does not reread a queued manual refresh after its gateway disconnects", async () => {
    vi.useFakeTimers();
    const initial = {
      sessionKey: "agent:main:offline-queued-refresh",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    const changed = { ...initial, revision: 2 };
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const resolvers: Array<(value: typeof initial) => void> = [];
    const request = vi.fn(
      () =>
        new Promise<typeof initial>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const client = {
      request: request as never,
      addEventListener: (next: (event: EventFrame) => void) => {
        listener = next as typeof listener;
        return () => {};
      },
    };
    const provider = new GatewayBoardProvider({ sessionKey: initial.sessionKey }, client, true);
    const refresh = provider.refreshWidgetFrame("status");

    listener?.({
      event: "board.changed",
      payload: { sessionKey: initial.sessionKey, revision: changed.revision },
    });
    provider.attachClient(client, false);
    resolvers[0]?.(initial);
    await refresh;
    await vi.advanceTimersByTimeAsync(31_000);

    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    provider.attachClient(client, true);
    resolvers[1]?.(changed);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledTimes(2);
    expect(provider.snapshot$.value).toEqual(changed);
    provider.dispose();
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
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:event-retry" },
      {
        request: request as never,
        addEventListener: (next) => {
          listener = next as typeof listener;
          return () => {};
        },
      },
    );
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

  it("coalesces same-tick widget refreshes into one in-flight board.get", async () => {
    const snapshot = {
      sessionKey: "agent:main:coalesced",
      revision: 1,
      tabs: [],
      widgets: [],
    };
    let resolveRequest: ((value: typeof snapshot) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const provider = new GatewayBoardProvider(
      { sessionKey: snapshot.sessionKey },
      { request: request as never, addEventListener: () => () => {} },
      false,
    );

    const refreshes = [
      provider.refreshWidgetFrame("first"),
      provider.refreshWidgetFrame("second"),
      provider.refreshWidgetFrame("third"),
    ];
    expect(request).toHaveBeenCalledOnce();
    resolveRequest?.(snapshot);
    await Promise.all(refreshes);
    await Promise.resolve();

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("board.get", { sessionKey: snapshot.sessionKey });
  });

  it.each([
    {
      session: { sessionKey: "agent:main:changed-during-refresh" },
      acknowledgedKey: "agent:main:changed-during-refresh",
    },
    { session: { sessionKey: "global", agentId: "work" }, acknowledgedKey: "agent:work:global" },
  ])(
    "rereads $session when board.changed precedes its first acknowledgment",
    async ({ session, acknowledgedKey }) => {
      const initial = {
        sessionKey: acknowledgedKey,
        revision: 1,
        tabs: [],
        widgets: [],
      };
      const changed = { ...initial, revision: 2 };
      let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
      const resolvers: Array<(value: typeof initial) => void> = [];
      const request = vi.fn(
        () =>
          new Promise<typeof initial>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const client = {
        request: request as never,
        addEventListener: (next: (event: EventFrame) => void) => {
          listener = next as typeof listener;
          return () => {};
        },
      };
      const provider = new GatewayBoardProvider(session, client, false);
      provider.attachClient(client, true);

      const refresh = provider.refreshWidgetFrame("status");
      listener?.({
        event: "board.changed",
        payload: { sessionKey: initial.sessionKey, revision: changed.revision },
      });
      resolvers[0]?.(initial);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      resolvers[1]?.(changed);
      await refresh;

      expect(provider.snapshot$.value.revision).toBe(changed.revision);
    },
  );

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
    const provider = new GatewayBoardProvider(
      { sessionKey: "agent:main:mutation-view-contract" },
      {
        request: request as never,
        addEventListener: () => () => {},
      },
    );
    await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(initial));

    await provider.applyOps([{ kind: "widget_resize", name: "alpha", sizeW: 8, sizeH: 4 }]);
    await provider.grant("alpha", "granted");

    expect(provider.snapshot$.value.widgets[0]).toEqual({
      ...widget,
      sizeW: 8,
      grantState: "granted",
    });
  });

  it.each([
    { session: { sessionKey: "agent:main:live" }, acknowledgedKey: "agent:main:live" },
    { session: { sessionKey: "global", agentId: "work" }, acknowledgedKey: "agent:work:global" },
  ])(
    "preserves $session through mutations and acknowledged board events",
    async ({ session, acknowledgedKey }) => {
      let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
      const empty = { sessionKey: acknowledgedKey, revision: 0, tabs: [], widgets: [] };
      const pinned = {
        sessionKey: acknowledgedKey,
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
      const provider = new GatewayBoardProvider(session, {
        request: request as never,
        addEventListener: (next) => {
          listener = next as typeof listener;
          return () => {};
        },
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", session));
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
        event: "board.changed",
        payload: { sessionKey: "agent:other:global", revision: 99 },
      });
      listener?.({
        event: "board.command",
        payload: {
          sessionKey: "agent:other:global",
          command: { kind: "focus_tab", tabId: "main" },
        },
      });
      expect(command).not.toHaveBeenCalled();
      listener?.({
        event: "board.command",
        payload: {
          sessionKey: acknowledgedKey,
          command: { kind: "focus_tab", tabId: "main" },
        },
      });

      expect(request).toHaveBeenCalledWith("board.update", {
        ...session,
        ops: [{ kind: "tab_update", tabId: "main", chatDock: "left" }],
      });
      expect(request).toHaveBeenCalledWith("board.widget.grant", {
        ...session,
        name: "canvas-cv-1",
        decision: "granted",
        revision: 1,
        instanceId: "canvas-instance",
      });
      expect(request).toHaveBeenCalledWith("board.widget.put", {
        ...session,
        name: "canvas-cv-1",
        title: Array.from(longTitle).slice(0, 80).join(""),
        content: { kind: "canvas-doc", docId: "cv-1" },
      });
      expect(request).toHaveBeenCalledWith("board.widget.put", {
        ...session,
        name: "mcp-app-opaque",
        title: "App status",
        content: { kind: "mcp-app", viewId: "mcp-app-source" },
        placement: { tabId: "main", size: "md", after: "canvas-cv-1" },
      });
      expect(request.mock.calls.filter(([method]) => method === "board.get")).toHaveLength(1);
      expect(provider.snapshot$.value).toEqual(pinned);
      listener?.({ event: "board.changed", payload: { sessionKey: acknowledgedKey, revision: 2 } });
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([method]) => method === "board.get")).toHaveLength(2),
      );
      listener?.({
        event: "board.command",
        payload: { ...session, command: { kind: "focus_tab", tabId: "main" } },
      });
      expect(command).toHaveBeenCalledTimes(2);
      expect(command).toHaveBeenCalledWith({
        sessionKey: acknowledgedKey,
        command: { kind: "focus_tab", tabId: "main" },
      });
      provider.dispose();
    },
  );
});
