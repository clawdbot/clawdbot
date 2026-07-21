import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
import "../../components/app-sidebar.ts";

function createDataTransferStub() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    effectAllowed: "none",
    dropEffect: "none",
  };
}

function dispatchDragEvent(
  target: Element,
  type: "dragstart" | "dragover" | "drop",
  dataTransfer: ReturnType<typeof createDataTransferStub>,
  clientY = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientY: { value: clientY },
  });
  target.dispatchEvent(event);
}

function zoneEntry(sidebar: SidebarLifecycleState, entry: string): HTMLElement {
  const element = sidebar.querySelector<HTMLElement>(`[data-sidebar-entry="${entry}"]`);
  if (!element) {
    throw new Error(`expected sidebar zone entry ${entry}`);
  }
  return element;
}

async function mountZone() {
  const gateway = createGateway({} as GatewayBrowserClient);
  const sessions = createSessionsHarness("main", [
    "agent:main:main",
    "agent:main:alpha",
    "agent:main:beta",
  ]);
  const { sidebar } = await mountSidebar(gateway, sessions.sessions);
  sidebar.connected = true;
  return { sidebar, sessions };
}

describe("AppSidebar interleaved zone", () => {
  it("keeps pinned sessions outside the optional page budget", async () => {
    const keys = [
      "agent:main:session-0",
      ...Array.from({ length: 40 }, (_, index) => `agent:main:session-${index + 1}`),
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions.slice(0, 31)) {
      row.pinned = true;
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(41);
    expect(sidebar.querySelector(".sidebar-session-pagination")).toBeNull();
  });

  it("keeps a pinned session visible outside the first-page budget", async () => {
    const pinnedKey = "agent:main:pinned";
    const keys = [
      ...Array.from({ length: 10 }, (_, index) => `agent:main:session-${index + 1}`),
      pinnedKey,
      "agent:main:extra",
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    const pinned = result.sessions.find((row) => row.key === pinnedKey);
    expect(pinned).toBeDefined();
    if (!pinned) {
      return;
    }
    pinned.pinned = true;
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(11);
    expect(sidebar.querySelector(`[data-session-key="${pinnedKey}"]`)).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:session-10"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:extra"]')).toBeNull();
  });

  it("renders pinned emoji and named icons with unknown-name fallback", async () => {
    const keys = ["agent:main:main", "agent:main:emoji", "agent:main:named", "agent:main:unknown"];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    const iconsByKey = new Map([
      ["agent:main:emoji", "🦞"],
      ["agent:main:named", "name:spark"],
      ["agent:main:unknown", "name:constructor"],
    ]);
    for (const row of result.sessions) {
      const icon = iconsByKey.get(row.key);
      if (icon) {
        Object.assign(row, { pinned: true, icon });
      }
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    const iconFor = (key: string) =>
      sidebar.querySelector(`[data-session-key="${key}"] .sidebar-pinned-session__icon`);
    expect(iconFor("agent:main:emoji")?.textContent).toContain("🦞");
    expect(iconFor("agent:main:named")?.querySelector('path[d^="M9.937"]')).not.toBeNull();
    expect(iconFor("agent:main:unknown")?.querySelector('path[d^="M21 15"]')).not.toBeNull();
  });

  it("keeps many pinned sessions always visible", async () => {
    const keys = [
      "agent:main:pinned-0",
      ...Array.from({ length: 30 }, (_, index) => `agent:main:pinned-${index + 1}`),
    ];
    const sessions = createSessionsHarness("main", keys);
    const result = sessions.sessions.state.result;
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    for (const row of result.sessions) {
      row.pinned = true;
    }
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);

    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(31);
    expect(sidebar.querySelector(".sidebar-session-pagination")).toBeNull();
  });

  it("renders routes and pinned sessions in entry order while Home stays fixed", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    sessions.publish({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:alpha"
            ? Object.assign({}, row, { label: "Alpha", pinned: true })
            : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["route:usage", "session:agent:main:alpha", "route:plugins"];
    await sidebar.updateComplete;

    const labels = [...sidebar.querySelectorAll<HTMLElement>(".sidebar-zone-entry")].map((entry) =>
      entry.textContent?.trim(),
    );
    expect(labels).toEqual(["Usage", "Alpha", "Plugins"]);
    expect(sidebar.querySelector('[data-session-section="pinned"]')).toBeNull();
    expect(sidebar.querySelector(".nav-item--home")?.hasAttribute("draggable")).toBe(false);
  });

  it("renders plugin tabs as sidebar entries", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway.gateway, sessions.sessions);

    gateway.publish({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.read"] },
        controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
      },
    });
    await sidebar.updateComplete;

    const entry = sidebar.querySelector<HTMLAnchorElement>(
      '[data-sidebar-entry="plugin:logbook/logbook"] > .nav-item',
    );
    expect(entry?.textContent).toContain("Logbook");
    expect(entry?.getAttribute("href")).toBe("/plugin?plugin=logbook&id=logbook");

    gateway.publish({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.read"] },
        controlUiTabs: [],
      },
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector('[data-sidebar-entry="plugin:logbook/logbook"]')).toBeNull();
  });

  it("writes reordered entries after a route drop", async () => {
    const { sidebar } = await mountZone();
    sidebar.sidebarEntries = ["route:usage", "route:plugins", "route:tasks"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = zoneEntry(sidebar, "route:tasks");
    const target = zoneEntry(sidebar, "route:usage");
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 10,
      height: 20,
    } as DOMRect);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer, 11);
    dispatchDragEvent(target, "drop", dataTransfer, 11);

    expect(onUpdate).toHaveBeenCalledWith(["route:tasks", "route:usage", "route:plugins"]);
  });

  it("pins and inserts a session dropped from Threads", async () => {
    const { sidebar, sessions } = await mountZone();
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = sidebar.querySelector('[data-session-key="agent:main:alpha"]');
    const target = zoneEntry(sidebar, "route:plugins");
    if (!source) {
      throw new Error("expected Alpha session row");
    }
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 10,
      height: 20,
    } as DOMRect);
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer, 11);
    dispatchDragEvent(target, "drop", dataTransfer, 11);

    expect(sessions.patch).toHaveBeenCalledWith(
      "agent:main:alpha",
      { pinned: true },
      { agentId: "main" },
    );
    // The slot write waits for the pin patch to land.
    await waitForFast(() =>
      expect(onUpdate).toHaveBeenCalledWith([
        "route:usage",
        "session:agent:main:alpha",
        "route:plugins",
      ]),
    );
  });

  it("hides a route dropped into the session-list region", async () => {
    const { sidebar } = await mountZone();
    sidebar.sidebarEntries = ["route:usage", "route:plugins"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;
    const source = zoneEntry(sidebar, "route:usage");
    const target = sidebar.querySelector('[data-session-section="ungrouped"]');
    if (!target) {
      throw new Error("expected session-list region");
    }
    const dataTransfer = createDataTransferStub();

    dispatchDragEvent(source, "dragstart", dataTransfer);
    dispatchDragEvent(target, "dragover", dataTransfer);
    dispatchDragEvent(target, "drop", dataTransfer);

    expect(onUpdate).toHaveBeenCalledWith(["route:plugins"]);
  });

  it("prunes only the unpinned session's entry and preserves unknown-agent slots", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    sessions.publish({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:alpha" ? Object.assign({}, row, { pinned: true }) : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["session:agent:b:remote", "session:agent:main:alpha", "route:usage"];
    const onUpdate = vi.fn();
    sidebar.onUpdateSidebarEntries = onUpdate;
    await sidebar.updateComplete;

    // agent-b's session is not loaded here: it renders nothing but keeps its slot.
    expect(sidebar.querySelector('[data-sidebar-entry="session:agent:b:remote"]')).toBeNull();

    sidebar
      .querySelector<HTMLButtonElement>(
        '[data-session-key="agent:main:alpha"] [data-sidebar-session-pin="true"]',
      )
      ?.click();
    await waitForFast(() =>
      expect(onUpdate).toHaveBeenCalledWith(["session:agent:b:remote", "route:usage"]),
    );
  });

  it("keeps pinned rows first in shift-range selection order", async () => {
    const { sidebar, sessions } = await mountZone();
    const result = sessions.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    sessions.publish({
      result: {
        ...result,
        sessions: result.sessions.map((row) =>
          row.key === "agent:main:alpha" ? Object.assign({}, row, { pinned: true }) : row,
        ),
      },
    });
    sidebar.sidebarEntries = ["session:agent:main:alpha", "route:usage"];
    await sidebar.updateComplete;
    const alpha = sidebar.querySelector(
      '[data-session-key="agent:main:alpha"] .sidebar-recent-session__link',
    );
    const beta = sidebar.querySelector(
      '[data-session-key="agent:main:beta"] .sidebar-recent-session__link',
    );
    if (!alpha || !beta) {
      throw new Error("expected session links");
    }

    alpha.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    beta.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
    );
    await sidebar.updateComplete;

    expect(
      [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session--selected")].map(
        (row) => row.dataset.sessionKey,
      ),
    ).toEqual(["agent:main:alpha", "agent:main:beta"]);
  });
});
