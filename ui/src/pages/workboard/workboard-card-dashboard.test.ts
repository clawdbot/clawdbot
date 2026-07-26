/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
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
): Promise<DashboardElement> {
  const element = document.createElement("openclaw-workboard-card-dashboard");
  element.sessionKey = sessionKey;
  element.client = client;
  element.connected = true;
  document.body.append(element);
  mounted.push(element);
  await vi.waitFor(() =>
    expect(element.querySelector(".workboard-card-dashboard__toggle")).not.toBeNull(),
  );
  return element;
}

afterEach(() => {
  for (const element of mounted.splice(0)) {
    element.remove();
  }
});

describe("Workboard card dashboard", () => {
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
