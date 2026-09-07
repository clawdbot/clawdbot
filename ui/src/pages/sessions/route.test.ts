// @vitest-environment jsdom

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListOptions } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadSessionsPagePreferences, saveSessionsPagePreferences } from "./page-state.ts";
import { page, sessionsPageListQuery, type SessionsRouteData } from "./route.ts";

async function loadSessionsRoute(options: {
  search: string;
  scopeId: string | null;
  expectedData: SessionsRouteData;
}) {
  const list = vi.fn();
  const listSnapshot = vi.fn();
  const refreshList = vi.fn();
  const context = {
    gateway: { snapshot: { phase: "connected", client: {} } },
    sessions: { list, listSnapshot, refreshList },
    runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
    agentSelection: { state: { selectedId: options.scopeId, scopeId: options.scopeId } },
  } as unknown as ApplicationContext;
  const loaderOptions: RouteLoaderOptions = {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location: { pathname: "/sessions", search: options.search, hash: "" },
    deps: "",
    cause: "navigation",
  };

  const data = (await page.loader?.(context, loaderOptions)) as SessionsRouteData;

  expect(refreshList).not.toHaveBeenCalled();
  expect(listSnapshot).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  expect(data).toEqual(options.expectedData);
}

describe("sessions route", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the persisted status for the initial roster", async () => {
    saveSessionsPagePreferences({
      ...loadSessionsPagePreferences(),
      statusFilter: "archived",
    });

    await loadSessionsRoute({
      search: "",
      scopeId: "writer",
      expectedData: { expandedSessionKey: null, statusFilter: "archived" },
    });
  });

  it("keeps explicit status URLs ahead of persisted status", async () => {
    saveSessionsPagePreferences({
      ...loadSessionsPagePreferences(),
      statusFilter: "archived",
    });

    await loadSessionsRoute({
      search: "?status=all",
      scopeId: null,
      expectedData: { expandedSessionKey: null, statusFilter: "all" },
    });
  });

  it("keeps direct-session links active and isolated from persisted status", async () => {
    saveSessionsPagePreferences({
      ...loadSessionsPagePreferences(),
      statusFilter: "archived",
    });

    await loadSessionsRoute({
      search: "?session=agent%3Aresearch%3Alinked",
      scopeId: "main",
      expectedData: {
        expandedSessionKey: "agent:research:linked",
        statusFilter: "active",
      },
    });
  });

  it("keeps direct-session list queries independent from roster filters", () => {
    const context = {
      agentSelection: { state: { scopeId: "main" } },
    } as unknown as ApplicationContext;
    const query = sessionsPageListQuery(context, {
      activeMinutes: 15,
      limit: 10,
      includeGlobal: false,
      includeUnknown: false,
      statusFilter: "archived",
      deepLinkSessionKey: "agent:research:linked",
    });

    expect(query).toEqual({
      limit: 50,
      search: "agent:research:linked",
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
      archivedFilter: "archived",
      agentId: "research",
    } satisfies SessionListOptions);
  });
});
