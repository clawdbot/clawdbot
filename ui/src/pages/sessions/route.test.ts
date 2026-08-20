// @vitest-environment node

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListOptions, SessionListSnapshot } from "../../lib/sessions/index.ts";
import { page, type SessionsRouteData } from "./route.ts";

const result: SessionsListResult = {
  ts: 1,
  path: "",
  count: 0,
  defaults: { modelProvider: null, model: null, contextTokens: null },
  sessions: [],
};

async function loadSessionsRoute(options: {
  search: string;
  scopeId: string | null;
  expectedQuery: SessionListOptions;
}) {
  let snapshot: SessionListSnapshot = {
    result: null,
    agentId: null,
    loading: false,
    error: null,
  };
  const list = vi.fn();
  const listSnapshot = vi.fn(() => snapshot);
  const refreshList = vi.fn(async () => {
    snapshot = { result, agentId: options.scopeId, loading: false, error: null };
  });
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

  expect(refreshList).toHaveBeenCalledWith({ ...options.expectedQuery, force: true });
  expect(listSnapshot).toHaveBeenLastCalledWith(options.expectedQuery);
  expect(list).not.toHaveBeenCalled();
  expect(data).toMatchObject({ result, loading: false, error: null });
}

describe("sessions route", () => {
  it.each([
    {
      name: "default selected-agent roster",
      search: "",
      scopeId: "writer",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active" as const,
        agentId: "writer",
      },
    },
    {
      name: "archived all-agent roster",
      search: "?status=archived",
      scopeId: null,
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "archived" as const,
      },
    },
    {
      name: "all-status selected-agent roster",
      search: "?status=all",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        includeGlobal: true,
        includeUnknown: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "all" as const,
        agentId: "main",
      },
    },
    {
      name: "deep link owned by a different agent",
      search: "?session=agent%3Aresearch%3Alinked",
      scopeId: "main",
      expectedQuery: {
        limit: 50,
        search: "agent:research:linked",
        includeGlobal: true,
        includeUnknown: true,
        includeDerivedTitles: false,
        includeLastMessage: false,
        archivedFilter: "active" as const,
        agentId: "research",
      },
    },
  ])("loads the managed $name without a raw list", async (testCase) => {
    await loadSessionsRoute(testCase);
  });
});
