import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./board-document.ts";

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

it("binds an acknowledged conversation only while the dashboard document is mounted", async () => {
  const request = vi.fn(async (method: string) =>
    method === "sessions.describe"
      ? { session: { key: "global", agentId: "work" } }
      : { sessionKey: "agent:work:global", revision: 1, tabs: [], widgets: [] },
  );
  const removeListener = vi.fn();
  const client = {
    request,
    addEventListener: vi.fn(() => removeListener),
  } as unknown as GatewayBrowserClient;
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.sessionKey = "agent:work:main";
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);
  element.remove();
  await element.updateComplete;
  expect(request).not.toHaveBeenCalled();

  document.body.append(element);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("board.get", {
      sessionKey: "global",
      agentId: "work",
    }),
  );
  await element.updateComplete;
  expect(element.querySelector("openclaw-board-view")).not.toBeNull();
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  await element.updateComplete;
  expect(request).toHaveBeenCalledTimes(2);
  element.remove();
  await element.updateComplete;
  expect(removeListener).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(2);

  document.body.append(element);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  expect(request).toHaveBeenLastCalledWith("board.get", { sessionKey: "global", agentId: "work" });
});

it("uses a prepared gallery session without describing it again", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.describe") {
      throw new Error("prepared sessions must not be described");
    }
    return { sessionKey: "dashboard", revision: 1, tabs: [], widgets: [] };
  });
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.preparedSession = { sessionKey: "dashboard", agentId: "main" };
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: { features: { methods: ["board.get"] } },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);

  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("board.get", {
      sessionKey: "dashboard",
      agentId: "main",
    }),
  );
  expect(request).toHaveBeenCalledOnce();
});

it("keeps passive documents live while exposing only capability-free HTML", async () => {
  const request = vi.fn(async () => ({
    sessionKey: "dashboard",
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0 }],
    widgets: [
      {
        name: "status",
        tabId: "main",
        contentKind: "html",
        sizeW: 12,
        sizeH: 6,
        position: 0,
        grantState: "granted",
        revision: 1,
        frameUrl: "data:text/html,status",
      },
      {
        name: "tools",
        tabId: "main",
        contentKind: "mcp-app",
        sizeW: 12,
        sizeH: 6,
        position: 1,
        grantState: "granted",
        revision: 1,
      },
    ],
  }));
  const client = {
    request,
    addEventListener: vi.fn(() => vi.fn()),
  } as unknown as GatewayBrowserClient;
  const element = document.createElement("openclaw-board-document");
  mounted.push(element);
  element.passive = true;
  element.preparedSession = { sessionKey: "dashboard", agentId: "main" };
  element.gatewaySnapshot = {
    client,
    phase: "connected",
    hello: {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["board.get", "board.widget.appView"] },
    },
  } as ApplicationGatewaySnapshot;
  document.body.append(element);

  const view = await vi.waitFor(() => {
    const current = element.querySelector("openclaw-board-view");
    expect(current).not.toBeNull();
    return current!;
  });
  expect(view.active).toBe(true);
  expect(view.bridgeEnabled).toBe(false);
  expect(view.canMutate).toBe(false);
  expect(view.canGrant).toBe(false);
  expect(view.snapshot?.widgets.map((widget) => widget.name)).toEqual(["status"]);
  expect(request).toHaveBeenCalledOnce();
});
