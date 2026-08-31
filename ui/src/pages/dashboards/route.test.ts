// @vitest-environment node

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

const loaderOptions: RouteLoaderOptions = {
  signal: new AbortController().signal,
  shouldRun: () => true,
  revalidating: false,
  location: { pathname: "/dashboards", search: "", hash: "" },
  deps: "",
  cause: "navigation",
};

async function loadDashboards(
  context: ApplicationContext,
  options: RouteLoaderOptions,
): Promise<Awaited<ReturnType<NonNullable<typeof page.loader>>>> {
  return await Promise.resolve(page.loader!(context, options));
}

describe("dashboards route", () => {
  it("seeds the exact managed dashboard query without calling the raw list API", async () => {
    const result = {
      ts: 1,
      path: "",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    };
    let snapshot = {
      result: null as typeof result | null,
      agentId: null,
      loading: false,
      error: null,
    };
    const list = vi.fn();
    const listSnapshot = vi.fn(() => snapshot);
    const refreshList = vi.fn(async () => {
      snapshot = { ...snapshot, result };
    });
    const context = {
      basePath: "",
      sessions: { list, listSnapshot, refreshList },
      agentSelection: { state: { selectedId: "main", scopeId: null } },
      agents: { state: { agentsList: null } },
      gateway: { snapshot: { hello: null } },
    } as unknown as ApplicationContext;
    if (!page.loader) {
      throw new Error("dashboards route has no loader");
    }

    await loadDashboards(context, loaderOptions);

    expect(refreshList).toHaveBeenCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      boardFace: "dashboard",
      archivedFilter: "all",
      force: true,
    });
    expect(listSnapshot).toHaveBeenLastCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      boardFace: "dashboard",
      archivedFilter: "all",
    });
    expect(list).not.toHaveBeenCalled();
  });
});
