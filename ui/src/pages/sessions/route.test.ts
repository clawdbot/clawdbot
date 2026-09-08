// @vitest-environment node

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionListOptions } from "../../lib/sessions/index.ts";
import { page, sessionsPageListQuery, type SessionsRouteData } from "./route.ts";

async function loadSessionsRoute(options: {
  search: string;
  scopeId: string | null;
  expectedQuery: SessionListOptions;
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
  expect(data).toEqual({
    expandedSessionKey: options.expectedQuery.search ?? null,
    statusFilter: options.expectedQuery.archivedFilter,
  });
  expect(
    sessionsPageListQuery(context, {
      statusFilter: data.statusFilter,
      deepLinkSessionKey: data.expandedSessionKey,
      includeGlobal: true,
      includeUnknown: false,
      limit: 50,
    }),
  ).toEqual(options.expectedQuery);
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
  ])("prepares the $name without issuing outside the page owner", async (testCase) => {
    await loadSessionsRoute(testCase);
  });
});
