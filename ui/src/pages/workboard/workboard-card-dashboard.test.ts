/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  acquireBoardProviderForSession,
  type BoardProvider,
  type BoardProviderLease,
} from "../../lib/board/provider.ts";
import "./workboard-card-dashboard.ts";

type DashboardElement = HTMLElementTagNameMap["openclaw-workboard-card-dashboard"] & {
  updateComplete: Promise<boolean>;
};

const mounted: DashboardElement[] = [];

function createClient(
  widgets: unknown[] = [],
  tabs: unknown[] = widgets.length
    ? [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }]
    : [],
) {
  const removeListener = vi.fn();
  const request = vi.fn(async (_method: string, params?: { sessionKey?: string }) => ({
    sessionKey: params?.sessionKey ?? "agent:main:unknown",
    revision: 1,
    tabs,
    widgets,
  }));
  return {
    client: {
      request,
      addEventListener: vi.fn(() => removeListener),
    } as unknown as GatewayBrowserClient,
    request,
    removeListener,
  };
}

async function mountDashboard(
  sessionKey: string,
  client: GatewayBrowserClient,
  capabilities: { canMutate?: boolean; canGrant?: boolean } = {},
): Promise<DashboardElement> {
  const element = document.createElement("openclaw-workboard-card-dashboard");
  element.sessionKey = sessionKey;
  element.client = client;
  element.connected = true;
  element.canMutate = capabilities.canMutate ?? false;
  element.canGrant = capabilities.canGrant ?? false;
  document.body.append(element);
  mounted.push(element);
  // The provider is acquired in updated(), after the first DOM render.
  // Await the real lifecycle so a loaded runner cannot observe the toggle early.
  await element.updateComplete;
  expect(element.querySelector(".workboard-card-dashboard__toggle")).not.toBeNull();
  return element;
}

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("Workboard card dashboard", () => {
  it("waits for the initial gateway snapshot before choosing its expanded state", async () => {
    const sessionKey = "agent:main:workboard-delayed-snapshot";
    const snapshot = {
      sessionKey,
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
      widgets: [
        {
          name: "status",
          tabId: "main",
          title: "Status",
          contentKind: "html" as const,
          sizeW: 12,
          sizeH: 2,
          position: 0,
          grantState: "none" as const,
          revision: 1,
        },
      ],
    };
    let resolveSnapshot: ((value: typeof snapshot) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<typeof snapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const client = {
      request,
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    const element = await mountDashboard(sessionKey, client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(
      element.querySelector(".workboard-card-dashboard__toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(element.querySelector(".workboard-card-dashboard__collapsed-empty")).toBeNull();

    resolveSnapshot?.(snapshot);

    await vi.waitFor(() =>
      expect(
        element.querySelector(".workboard-card-dashboard__toggle")?.getAttribute("aria-expanded"),
      ).toBe("true"),
    );
    expect(element.querySelector("openclaw-board-view")).not.toBeNull();
  });

  it("updates mounted dashboard controls immediately when gateway permissions change", async () => {
    const { client, request } = createClient([
      {
        name: "pending-status",
        tabId: "main",
        title: "Pending status",
        contentKind: "html",
        sizeW: 12,
        sizeH: 2,
        position: 0,
        grantState: "pending",
        revision: 1,
      },
    ]);
    const element = await mountDashboard("agent:main:workboard-live-scopes", client, {
      canMutate: true,
      canGrant: true,
    });

    await vi.waitFor(() => expect(element.querySelector("openclaw-board-view")).not.toBeNull());
    const board = element.querySelector("openclaw-board-view")!;
    await board.updateComplete;
    await vi.waitFor(() =>
      expect(board.querySelector('[data-test-id="board-grant-allow"]')).not.toBeNull(),
    );
    const allow = board.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]')!;

    expect(board.canMutate).toBe(true);
    expect(board.canGrant).toBe(true);
    expect(allow.disabled).toBe(false);

    element.canMutate = false;
    element.canGrant = false;
    await element.updateComplete;
    await board.updateComplete;
    await board.querySelector("openclaw-board-widget-cell")?.updateComplete;

    expect(board.canMutate).toBe(false);
    expect(board.canGrant).toBe(false);
    expect(allow.disabled).toBe(true);

    element.canMutate = true;
    element.canGrant = true;
    await element.updateComplete;
    await board.updateComplete;
    await board.querySelector("openclaw-board-widget-cell")?.updateComplete;

    expect(board.canMutate).toBe(true);
    expect(board.canGrant).toBe(true);
    expect(allow.disabled).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["chat-first", "dashboard-first"] as const)(
    "shares gateway state without leaking dashboard capabilities in %s order",
    async (order) => {
      const sessionKey = `agent:main:workboard-shared-${order}`;
      const { client, request, removeListener } = createClient();
      let chat: BoardProviderLease | undefined;
      let dashboard: DashboardElement | undefined;

      try {
        if (order === "chat-first") {
          chat = acquireBoardProviderForSession(sessionKey, client, true, true, true, true, true);
          dashboard = await mountDashboard(sessionKey, client, {
            canMutate: true,
            canGrant: false,
          });
        } else {
          dashboard = await mountDashboard(sessionKey, client, {
            canMutate: true,
            canGrant: false,
          });
          chat = acquireBoardProviderForSession(sessionKey, client, true, true, true, true, true);
        }

        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        const dashboardProvider = Reflect.get(dashboard, "provider") as BoardProvider;

        expect(chat.provider).not.toBe(dashboardProvider);
        expect(chat.provider.snapshot$).toBe(dashboardProvider.snapshot$);
        expect(chat.provider).toMatchObject({
          canPinWidgets: true,
          canPinMcpApps: true,
          canMutate: true,
          canGrant: true,
        });
        expect(dashboardProvider).toMatchObject({
          canPinWidgets: false,
          canPinMcpApps: false,
          canMutate: true,
          canGrant: false,
        });

        dashboard.canMutate = false;
        await dashboard.updateComplete;

        expect(Reflect.get(dashboard, "provider")).toBe(dashboardProvider);
        expect(dashboardProvider.canMutate).toBe(false);
        expect(chat.provider.canMutate).toBe(true);
        expect(chat.provider.canPinWidgets).toBe(true);
        expect(chat.provider.canPinMcpApps).toBe(true);
        expect(chat.provider.canGrant).toBe(true);
        expect(request).toHaveBeenCalledOnce();

        dashboard.remove();
        expect(removeListener).not.toHaveBeenCalled();
        chat.release();
        expect(removeListener).toHaveBeenCalledOnce();
      } finally {
        dashboard?.remove();
        chat?.release();
      }
    },
  );

  it("expands a non-empty live dashboard by default", async () => {
    const { client, request } = createClient([
      {
        name: "status",
        tabId: "main",
        title: "Status",
        contentKind: "html",
        sizeW: 12,
        sizeH: 2,
        position: 0,
        grantState: "none",
        revision: 1,
      },
    ]);
    const element = await mountDashboard("agent:main:workboard-non-empty", client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", expect.anything()));
    await vi.waitFor(() =>
      expect(
        element.querySelector(".workboard-card-dashboard__toggle")?.getAttribute("aria-expanded"),
      ).toBe("true"),
    );
    expect(element.querySelector("openclaw-board-view")).not.toBeNull();
  });

  it("disables widget ticket refresh while the dashboard is collapsed", async () => {
    const { client } = createClient([
      {
        name: "status",
        tabId: "main",
        title: "Status",
        contentKind: "html",
        sizeW: 12,
        sizeH: 2,
        position: 0,
        grantState: "none",
        revision: 1,
        viewTicket: "ticket",
        viewTicketTtlMs: 1_200_000,
      },
    ]);
    const element = await mountDashboard("agent:main:workboard-collapse", client);
    await vi.waitFor(() => expect(element.querySelector("openclaw-board-view")).not.toBeNull());
    const board = element.querySelector("openclaw-board-view")!;
    expect(board.ticketRefreshEnabled).toBe(true);

    element.querySelector<HTMLButtonElement>(".workboard-card-dashboard__toggle")?.click();
    await element.updateComplete;
    await board.updateComplete;
    expect(board.ticketRefreshEnabled).toBe(false);

    element.querySelector<HTMLButtonElement>(".workboard-card-dashboard__toggle")?.click();
    await element.updateComplete;
    await board.updateComplete;
    expect(board.ticketRefreshEnabled).toBe(true);
  });

  it("keeps an empty dashboard compact until the operator expands its hint", async () => {
    const { client, request } = createClient();
    const element = await mountDashboard("agent:main:workboard-empty", client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", expect.anything()));
    await vi.waitFor(() => expect(element.textContent).toContain("No dashboard yet"));
    expect(
      element.querySelector(".workboard-card-dashboard__toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");

    element.querySelector<HTMLButtonElement>(".workboard-card-dashboard__toggle")?.click();
    await element.updateComplete;
    expect(element.querySelector(".workboard-card-dashboard__body")?.textContent).toContain(
      "the working agent can pin widgets",
    );
  });

  it("reacts when the embedded board selects another tab", async () => {
    const tabs = [
      { tabId: "main", title: "Main", position: 0, chatDock: "right" },
      { tabId: "research", title: "Research", position: 1, chatDock: "right" },
    ];
    const widgets = tabs.map((tab, position) => ({
      name: `${tab.tabId}-status`,
      tabId: tab.tabId,
      title: `${tab.title} status`,
      contentKind: "html",
      sizeW: 12,
      sizeH: 2,
      position,
      grantState: "none",
      revision: 1,
    }));
    const { client } = createClient(widgets, tabs);
    const element = await mountDashboard("agent:main:workboard-tabs", client);
    await vi.waitFor(() => expect(element.querySelector("wa-tab-group")).not.toBeNull());

    element
      .querySelector("wa-tab-group")
      ?.dispatchEvent(
        new CustomEvent("wa-tab-show", { bubbles: true, detail: { name: "research" } }),
      );

    await vi.waitFor(() =>
      expect(
        element.querySelector('[data-board-tab-id="research"]')?.getAttribute("active"),
      ).not.toBeNull(),
    );
    expect(element.querySelector('[data-board-tab-id="main"]')?.getAttribute("active")).toBeNull();
  });

  it("releases its shared provider lease when removed", async () => {
    const { client, request, removeListener } = createClient();
    const element = await mountDashboard("agent:main:workboard-disposal", client);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());

    element.remove();
    await Promise.resolve();

    expect(removeListener).toHaveBeenCalledOnce();
  });
});
