import { expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { acquireBoardProviderForSession, mcpAppWidgetNameForViewId } from "./provider.ts";

export function registerBoardProviderLeaseCases(disableMockBoard: () => void): void {
  it("keeps retired gateway clients from rolling back shared board leases", async () => {
    disableMockBoard();
    const sessionKey = "agent:main:monotonic-board-lease";
    const capabilities = {
      canPinWidgets: true,
      canPinMcpApps: true,
      canMutate: true,
      canGrant: true,
    };
    const createClient = (revision: number) => {
      const snapshot = { sessionKey, revision, tabs: [], widgets: [] };
      const requests = vi.fn(async () => snapshot);
      const listeners = new Set<(event: GatewayEventFrame) => void>();
      const addEventListener = vi.fn((listener: (event: GatewayEventFrame) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      });
      return {
        snapshot,
        requests,
        listeners,
        addEventListener,
        request: requests as never,
      };
    };
    const previous = createClient(1);
    const current = createClient(2);
    const future = createClient(3);
    const writer = acquireBoardProviderForSession({ sessionKey }, previous);
    const stale = acquireBoardProviderForSession({ sessionKey }, previous);

    try {
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(previous.snapshot));
      const retiredListener = [...previous.listeners][0];
      expect(retiredListener).toBeDefined();

      writer.update(current, true, capabilities);
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(current.snapshot));
      expect(stale.provider.snapshot$.value).toEqual(current.snapshot);
      expect(previous.listeners.size).toBe(0);
      expect(current.listeners.size).toBe(1);

      stale.update(previous, false, capabilities);
      expect(writer.provider.snapshot$.value).toEqual(current.snapshot);
      expect(stale.provider.snapshot$.value).toEqual(current.snapshot);
      expect(previous.addEventListener).toHaveBeenCalledOnce();
      expect(previous.requests).toHaveBeenCalledOnce();
      expect(current.listeners.size).toBe(1);

      retiredListener?.({
        type: "event",
        event: "board.changed",
        payload: { sessionKey, revision: 4 },
      });
      await Promise.resolve();
      expect(current.requests).toHaveBeenCalledOnce();

      await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
      expect(current.requests).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(previous.requests).toHaveBeenCalledOnce();

      writer.update(current, false, capabilities);
      writer.update(current, true, capabilities);
      await vi.waitFor(() => expect(current.requests).toHaveBeenCalledTimes(3));
      expect(writer.provider.snapshot$.value).toEqual(current.snapshot);

      stale.update(future, true, capabilities);
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(future.snapshot));
      expect(stale.provider.snapshot$.value).toEqual(future.snapshot);
      expect(current.listeners.size).toBe(0);
      expect(future.listeners.size).toBe(1);

      await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
      expect(future.requests).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(previous.requests).toHaveBeenCalledOnce();
    } finally {
      writer.release();
      stale.release();
    }
  });

  it.each(["chat-first", "dashboard-first"] as const)(
    "isolates concurrent board lease capabilities in %s order",
    async (order) => {
      disableMockBoard();
      const sessionKey = `agent:main:lease-capabilities-${order}`;
      const snapshot = { sessionKey, revision: 1, tabs: [], widgets: [] };
      const removeListener = vi.fn();
      const client = {
        request: vi.fn(async () => snapshot) as never,
        addEventListener: vi.fn(() => removeListener),
      };
      const acquireChat = () =>
        acquireBoardProviderForSession({ sessionKey }, client, true, true, true, true, true);
      const acquireDashboard = () =>
        acquireBoardProviderForSession({ sessionKey }, client, true, false, false, false, false);
      const first = order === "chat-first" ? acquireChat() : acquireDashboard();
      const second = order === "chat-first" ? acquireDashboard() : acquireChat();
      const chat = order === "chat-first" ? first : second;
      const dashboard = order === "chat-first" ? second : first;

      try {
        await vi.waitFor(() => expect(chat.provider.snapshot$.value).toEqual(snapshot));

        expect(chat.provider).not.toBe(dashboard.provider);
        expect(chat.provider.snapshot$).toBe(dashboard.provider.snapshot$);
        expect(chat.provider.events).toBe(dashboard.provider.events);
        expect(chat.provider).toMatchObject({
          canPinWidgets: true,
          canPinMcpApps: true,
          canMutate: true,
          canGrant: true,
        });
        expect(dashboard.provider).toMatchObject({
          canPinWidgets: false,
          canPinMcpApps: false,
          canMutate: false,
          canGrant: false,
        });
        expect(client.request).toHaveBeenCalledOnce();
        expect(client.addEventListener).toHaveBeenCalledOnce();

        await expect(chat.provider.applyOps([])).resolves.toBeUndefined();
        await expect(chat.provider.pinWidget({ docId: "cv-allowed" })).resolves.toBeUndefined();
        await expect(chat.provider.pinMcpApp({ viewId: "app-allowed" })).resolves.toBeUndefined();
        await expect(dashboard.provider.pinWidget({ docId: "cv-denied" })).rejects.toThrow();
        await expect(dashboard.provider.pinMcpApp({ viewId: "app-denied" })).rejects.toThrow();

        expect(client.request).toHaveBeenCalledTimes(4);
        expect(client.request).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
        expect(client.request).toHaveBeenCalledWith("board.widget.put", {
          sessionKey,
          name: "canvas-cv-allowed",
          content: { kind: "canvas-doc", docId: "cv-allowed" },
        });
        expect(client.request).toHaveBeenCalledWith("board.widget.put", {
          sessionKey,
          name: mcpAppWidgetNameForViewId("app-allowed"),
          content: { kind: "mcp-app", viewId: "app-allowed" },
        });

        first.release();
        first.release();
        expect(removeListener).not.toHaveBeenCalled();
        expect(second.provider.snapshot$.value).toEqual(snapshot);
        await expect(first.provider.applyOps([])).rejects.toThrow();
        expect(client.request).toHaveBeenCalledTimes(4);
        second.release();
        expect(removeListener).toHaveBeenCalledOnce();
      } finally {
        first.release();
        second.release();
      }
    },
  );

  it("enforces write and approval scopes separately for concurrent board leases", async () => {
    disableMockBoard();
    const sessionKey = "agent:main:independent-board-scopes";
    const snapshot = {
      sessionKey,
      revision: 1,
      tabs: [
        {
          tabId: "main",
          title: t("chat.board.defaultTab"),
          position: 0,
          chatDock: "right" as const,
        },
      ],
      widgets: [
        {
          name: "pending-widget",
          tabId: "main",
          contentKind: "html" as const,
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "pending" as const,
          revision: 1,
        },
      ],
    };
    const client = {
      request: vi.fn(async () => snapshot) as never,
      addEventListener: vi.fn(() => () => {}),
    };
    const writer = acquireBoardProviderForSession(
      { sessionKey },
      client,
      true,
      true,
      true,
      true,
      false,
    );
    const approver = acquireBoardProviderForSession(
      { sessionKey },
      client,
      true,
      false,
      false,
      false,
      true,
    );

    try {
      await vi.waitFor(() => expect(writer.provider.snapshot$.value).toEqual(snapshot));

      await expect(writer.provider.applyOps([])).resolves.toBeUndefined();
      await expect(writer.provider.grant("pending-widget", "granted")).rejects.toThrow();
      await expect(approver.provider.applyOps([])).rejects.toThrow();
      await expect(approver.provider.pinWidget({ docId: "cv-restricted" })).rejects.toThrow();
      await expect(approver.provider.pinMcpApp({ viewId: "app-restricted" })).rejects.toThrow();
      await expect(approver.provider.grant("pending-widget", "granted")).resolves.toBeUndefined();

      expect(client.request).toHaveBeenCalledTimes(3);
      expect(client.request).toHaveBeenCalledWith("board.update", { sessionKey, ops: [] });
      expect(client.request).toHaveBeenCalledWith("board.widget.grant", {
        sessionKey,
        name: "pending-widget",
        decision: "granted",
        revision: 1,
      });
      expect(client.addEventListener).toHaveBeenCalledOnce();
    } finally {
      writer.release();
      approver.release();
    }
  });
}
