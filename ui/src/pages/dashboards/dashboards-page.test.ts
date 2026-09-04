/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import type { SessionListOptions, SessionListSnapshot } from "../../lib/sessions/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { DashboardsRouteData } from "./view.ts";
import "./dashboards-page.ts";

type DashboardsPageElement = HTMLElement & {
  routeData?: DashboardsRouteData;
  updateComplete: Promise<boolean>;
};

function result(sessionRow: GatewaySessionRow): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [sessionRow],
  };
}

function results(sessionRows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessionRows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: sessionRows,
  };
}

function row(key: string, displayName: string): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    boardFace: "dashboard",
    displayName,
    updatedAt: 1,
  };
}

function routeData(sessionRow: GatewaySessionRow): DashboardsRouteData {
  return {
    result: result(sessionRow),
    error: null,
    basePath: "",
    fallbackAgentId: "main",
    mainKey: "main",
  };
}

describe("DashboardsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("subscribes to the exact query and preserves rows while a new agent scope loads", async () => {
    const selectionListeners = new Set<() => void>();
    const listListeners = new Map<string, (snapshot: SessionListSnapshot) => void>();
    const snapshots = new Map<string, SessionListSnapshot>();
    const queryKey = (options: SessionListOptions) => options.agentId ?? "all";
    const allResult = result(row("agent:main:before", "Before"));
    snapshots.set("all", { result: allResult, agentId: null, loading: false, error: null });
    snapshots.set("writer", { result: null, agentId: null, loading: false, error: null });
    const refreshList = vi.fn(async () => undefined);
    const subscribeList = vi.fn(
      (query: SessionListOptions, listener: (snapshot: SessionListSnapshot) => void) => {
        const key = queryKey(query);
        listListeners.set(key, listener);
        return () => listListeners.delete(key);
      },
    );
    const selectionState = { selectedId: "main", scopeId: null as string | null };
    const context = {
      basePath: "",
      gateway: { snapshot: { client: {}, phase: "connected", hello: null } },
      sessions: {
        listSnapshot(query: SessionListOptions) {
          return snapshots.get(queryKey(query))!;
        },
        subscribeList,
        refreshList,
      },
      agentSelection: {
        state: selectionState,
        subscribe(listener: () => void) {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = routeData(row("agent:main:before", "Before"));
    const provider = createApplicationContextProvider(context);
    provider.append(element);
    document.body.append(provider);
    await element.updateComplete;

    expect(subscribeList).toHaveBeenCalledWith(
      { limit: SIDEBAR_SESSION_ROSTER_LIMIT, hasBoard: true, archivedFilter: "all" },
      expect.any(Function),
    );
    expect(refreshList).not.toHaveBeenCalled();
    const retiredListener = listListeners.get("all")!;

    selectionState.scopeId = "writer";
    selectionListeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledTimes(1));
    expect(refreshList).toHaveBeenCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      hasBoard: true,
      archivedFilter: "all",
      agentId: "writer",
      force: true,
    });
    expect(element.textContent).toContain("Before");

    listListeners.get("writer")?.({
      result: result(row("agent:writer:current", "Writer dashboard")),
      agentId: "writer",
      loading: false,
      error: null,
    });
    await vi.waitFor(() => expect(element.textContent).toContain("Writer dashboard"));
    retiredListener({
      result: result(row("agent:main:retired", "Retired")),
      agentId: null,
      loading: false,
      error: "Retired scope refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Retired");

    const writerListener = listListeners.get("writer")!;
    writerListener({
      result: result(row("agent:writer:current", "Writer dashboard")),
      agentId: "writer",
      loading: false,
      error: "Writer refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).toContain("Writer dashboard");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("Writer refresh failed");
    refreshList.mockClear();
    element.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    expect(refreshList).toHaveBeenCalledOnce();
    expect(refreshList).toHaveBeenLastCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      hasBoard: true,
      archivedFilter: "all",
      agentId: "writer",
      force: true,
    });

    element.remove();
    writerListener({
      result: null,
      agentId: "writer",
      loading: false,
      error: "Detached refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Detached refresh failed");
  });

  it("loads every dashboard page so older dashboards remain searchable", async () => {
    const first = {
      ...results([row("agent:main:new", "New dashboard")]),
      totalCount: 2,
      hasMore: true,
      nextOffset: 1,
      offset: 0,
    };
    const second = {
      ...results([row("agent:main:old", "Old dashboard")]),
      totalCount: 2,
      hasMore: false,
      nextOffset: null,
      offset: 1,
    };
    const snapshot = { result: first, agentId: null, loading: false, error: null };
    const list = vi.fn(async () => second);
    const context = {
      basePath: "",
      gateway: { snapshot: { client: {}, phase: "connected", hello: null } },
      sessions: {
        list,
        listSnapshot: () => snapshot,
        subscribeList: () => () => undefined,
        refreshList: vi.fn(async () => undefined),
      },
      agentSelection: {
        state: { selectedId: "main", scopeId: null },
        subscribe: () => () => undefined,
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = {
      result: first,
      error: null,
      basePath: "",
      fallbackAgentId: "main",
      mainKey: "main",
    };
    const provider = createApplicationContextProvider(context);
    provider.append(element);
    document.body.append(provider);

    await vi.waitFor(() =>
      expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(2),
    );
    expect(list).toHaveBeenCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      hasBoard: true,
      archivedFilter: "all",
      offset: 1,
    });

    const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "old";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("Old dashboard");
  });

  it("filters by search and author and sorts visible cards by title", async () => {
    const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = {
      result: results([
        {
          ...row("agent:main:dashboard:zulu", "Zulu monitor"),
          updatedAt: 30,
          createdActor: { type: "human", id: "peter", label: "Peter" },
        },
        {
          ...row("agent:main:dashboard:alpha", "Alpha signals"),
          updatedAt: 10,
          createdActor: { type: "human", id: "mira", label: "Mira" },
        },
        {
          ...row("agent:main:dashboard:bravo", "Bravo health"),
          updatedAt: 20,
          createdActor: { type: "human", id: "peter", label: "Peter" },
        },
      ]),
      error: null,
      basePath: "",
      fallbackAgentId: "main",
      mainKey: "main",
    };
    document.body.append(element);
    await element.updateComplete;

    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(3);

    const search = element.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    if (!search) {
      return;
    }
    search.value = "signals";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("Alpha signals");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    const selects = element.querySelectorAll<HTMLSelectElement>("select");
    const authorSelect = selects.item(0);
    const sortSelect = selects.item(1);
    authorSelect.value = "mira";
    authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("By Mira");

    authorSelect.value = "";
    authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
    sortSelect.value = "title";
    sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(
      Array.from(element.querySelectorAll(".dashboard-card__heading h2"), (heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Alpha signals", "Bravo health", "Zulu monitor"]);
  });
});
