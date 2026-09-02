/* @vitest-environment jsdom */

import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiHost, ControlUiViewContext } from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  acquireBoardProviderForSession,
  type BoardProvider,
  type BoardProviderLease,
} from "../lib/board/provider.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import "./control-ui-dashboard.ts";

type DashboardElement = HTMLElementTagNameMap["openclaw-plugin-session-dashboard"] & {
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
  const request = vi.fn(async (_method: string, params?: BoardGetParams) => ({
    sessionKey:
      params?.sessionKey === "global"
        ? `agent:${params.agentId}:global`
        : (params?.sessionKey ?? "agent:main:unknown"),
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
  session: BoardGetParams,
  client: GatewayBrowserClient,
  capabilities: { canMutate?: boolean; canGrant?: boolean } = {},
  container: HTMLElement = document.body,
): Promise<DashboardElement> {
  const element = document.createElement("openclaw-plugin-session-dashboard");
  element.session = session;
  element.client = client;
  element.connected = true;
  element.canMutate = capabilities.canMutate ?? false;
  element.canGrant = capabilities.canGrant ?? false;
  container.append(element);
  mounted.push(element);
  // The provider is acquired in updated(), after the first DOM render.
  // Await the real lifecycle so a loaded runner cannot observe the toggle early.
  await element.updateComplete;
  expect(element.querySelector(".plugin-session-dashboard__toggle")).not.toBeNull();
  return element;
}

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("Plugin session dashboard", () => {
  it.each([
    { sessionKey: "global", hydrateOwner: false },
    { sessionKey: "agent:writer:workboard-owner-hydration", hydrateOwner: true },
  ])(
    "passes the queried owner of $sessionKey to native widgets outside the selected agent",
    async ({ sessionKey, hydrateOwner }) => {
      const lifetime = new AbortController();
      const widgetSignals: AbortSignal[] = [];
      const host = {
        signal: lifetime.signal,
        sessions: {},
        agents: {},
        navigation: {},
        ui: {},
        components: {},
      } as unknown as ControlUiHost;
      const entry = {
        key: "identity/context",
        pluginId: "identity",
        signal: lifetime.signal,
        host,
        value: {
          id: "context",
          label: "Conversation owner",
          mount(container: HTMLElement, view: ControlUiViewContext<BoardGetParams>) {
            widgetSignals.push(view.signal);
            container.dataset.nativeOwner = "widget";
            container.textContent = `${view.props.agentId}/${view.props.sessionKey}`;
          },
        },
      };
      const reportError = vi.fn();
      const context = {
        agentSelection: { state: { selectedId: "main" } },
        gateway: {
          snapshot: {
            phase: "connected",
            hello: {
              controlUiWidgetKinds: [
                { pluginId: "identity", kind: "identity:context", label: "Conversation owner" },
              ],
            },
          },
        },
        plugins: {
          registrations: (kind: string) => (kind === "widgets" ? [entry] : []),
          subscribe: () => () => undefined,
          reportError,
        },
      } as unknown as ApplicationContext;
      const provider = createApplicationContextProvider(context);
      onTestFinished(() => provider.remove());
      document.body.append(provider);
      const { client, request } = createClient([
        {
          name: "owner",
          tabId: "main",
          title: "Conversation owner",
          contentKind: "plugin",
          pluginKind: "identity:context",
          sizeW: 6,
          sizeH: 2,
          position: 0,
          grantState: "none",
          revision: 1,
        },
      ]);
      const session = { sessionKey, agentId: "writer" };
      const initial: BoardGetParams = hydrateOwner ? { sessionKey } : session;
      const element = await mountDashboard(initial, client, {}, provider);

      await customElements.whenDefined("openclaw-board-view");
      await vi.waitFor(() => {
        expect(reportError).not.toHaveBeenCalled();
        expect(
          element.querySelector('[data-native-owner="widget"]'),
          element.innerHTML,
        ).not.toBeNull();
      });
      expect(request).toHaveBeenCalledWith("board.get", initial);
      expect(element.querySelector('[data-native-owner="widget"]')?.textContent).toBe(
        `${initial.agentId}/${sessionKey}`,
      );
      if (hydrateOwner) {
        const previousSignal = widgetSignals.at(-1);
        expect(previousSignal?.aborted).toBe(false);

        element.session = session;
        await element.updateComplete;

        await vi.waitFor(() =>
          expect(element.querySelector('[data-native-owner="widget"]')?.textContent).toBe(
            `writer/${sessionKey}`,
          ),
        );
        expect(previousSignal?.aborted).toBe(true);
        expect(widgetSignals.at(-1)?.aborted).toBe(false);
      }
      expect(request).toHaveBeenCalledOnce();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

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
    const element = await mountDashboard({ sessionKey }, client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(
      element.querySelector(".plugin-session-dashboard__toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(element.querySelector(".plugin-session-dashboard__collapsed-empty")).toBeNull();

    resolveSnapshot?.(snapshot);

    await vi.waitFor(() =>
      expect(
        element.querySelector(".plugin-session-dashboard__toggle")?.getAttribute("aria-expanded"),
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
    const element = await mountDashboard(
      { sessionKey: "agent:main:workboard-live-scopes" },
      client,
      {
        canMutate: true,
        canGrant: true,
      },
    );

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

  it.each(
    (["chat-first", "dashboard-first"] as const).flatMap((order) => [
      { order, session: { sessionKey: `agent:main:workboard-shared-${order}` } },
      { order, session: { sessionKey: "global", agentId: "work" } },
    ]),
  )(
    "shares $session.sessionKey gateway state without leaking dashboard capabilities in $order order",
    async ({ order, session }) => {
      const { client, request, removeListener } = createClient();
      let chat: BoardProviderLease | undefined;
      let dashboard: DashboardElement | undefined;

      try {
        if (order === "chat-first") {
          chat = acquireBoardProviderForSession(session, client, true, true, true, true, true);
          dashboard = await mountDashboard(session, client, {
            canMutate: true,
            canGrant: false,
          });
        } else {
          dashboard = await mountDashboard(session, client, {
            canMutate: true,
            canGrant: false,
          });
          chat = acquireBoardProviderForSession(session, client, true, true, true, true, true);
        }

        await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
        expect(request).toHaveBeenCalledWith("board.get", session);
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

  it("pauses the board while the dashboard is collapsed", async () => {
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
    const element = await mountDashboard({ sessionKey: "agent:main:workboard-collapse" }, client);
    await vi.waitFor(() => expect(element.querySelector("openclaw-board-view")).not.toBeNull());
    const board = element.querySelector("openclaw-board-view")!;
    expect(board.active).toBe(true);

    element.querySelector<HTMLButtonElement>(".plugin-session-dashboard__toggle")?.click();
    await element.updateComplete;
    await board.updateComplete;
    expect(board.active).toBe(false);

    element.querySelector<HTMLButtonElement>(".plugin-session-dashboard__toggle")?.click();
    await element.updateComplete;
    await board.updateComplete;
    expect(board.active).toBe(true);
  });

  it("keeps an empty dashboard compact until the operator expands its hint", async () => {
    const { client, request } = createClient();
    const element = await mountDashboard({ sessionKey: "agent:main:workboard-empty" }, client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("board.get", expect.anything()));
    await vi.waitFor(() =>
      expect(element.textContent).toContain("This session has no dashboard widgets yet."),
    );
    expect(
      element.querySelector(".plugin-session-dashboard__toggle")?.getAttribute("aria-expanded"),
    ).toBe("false");

    element.querySelector<HTMLButtonElement>(".plugin-session-dashboard__toggle")?.click();
    await element.updateComplete;
    expect(element.querySelector(".plugin-session-dashboard__body")?.textContent).toContain(
      "This session has no dashboard widgets yet.",
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
    const element = await mountDashboard({ sessionKey: "agent:main:workboard-tabs" }, client);
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

  it("releases its provider through detached updates and reacquires only after reconnect", async () => {
    const { client, request, removeListener } = createClient();
    const element = await mountDashboard({ sessionKey: "agent:main:workboard-disposal" }, client);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());

    element.remove();
    await element.updateComplete;

    expect(removeListener).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();

    document.body.append(element);
    await element.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
    element.remove();
    await element.updateComplete;
    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
