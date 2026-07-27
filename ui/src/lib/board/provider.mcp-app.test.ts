// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardMcpAppViewCache } from "./mcp-app-view-cache.ts";
import { GatewayBoardProvider } from "./provider.ts";

let mockLocation: { search: string };

beforeEach(() => {
  mockLocation = { search: "" };
  vi.stubGlobal("location", mockLocation);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("board provider MCP App views", () => {
  it("deduplicates leases until an explicit refresh", async () => {
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

  it("does not reuse a cached lease for a same-name replacement", async () => {
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

  it("contains re-mint failures as stale widget state and retries on demand", async () => {
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
