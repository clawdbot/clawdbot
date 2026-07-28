import { expect, it, vi } from "vitest";
import { acquireBoardProviderForSession, mcpAppWidgetNameForViewId } from "./provider.ts";

export function registerBoardProviderLeaseCases(disableMockBoard: () => void): void {
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
        acquireBoardProviderForSession(sessionKey, client, true, true, true, true, true);
      const acquireDashboard = () =>
        acquireBoardProviderForSession(sessionKey, client, true, false, false, false, false);
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
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
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
      sessionKey,
      client,
      true,
      true,
      true,
      true,
      false,
    );
    const approver = acquireBoardProviderForSession(
      sessionKey,
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
