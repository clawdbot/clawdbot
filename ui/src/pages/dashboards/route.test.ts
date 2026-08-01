// @vitest-environment node

import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
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

describe("dashboards route", () => {
  it("requests the dashboard face from the server before pagination", async () => {
    const list = vi.fn(async () => null);
    const context = {
      basePath: "",
      sessions: { list, canonicalListRevision: 4 },
      agentSelection: { state: { selectedId: "main", scopeId: null } },
      agents: { state: { agentsList: null } },
      gateway: { snapshot: { hello: null } },
    } as unknown as ApplicationContext;
    if (!page.loader) {
      throw new Error("dashboards route has no loader");
    }

    await page.loader(context, loaderOptions);

    expect(list).toHaveBeenCalledWith({
      limit: 50,
      boardFace: "dashboard",
      archivedFilter: "all",
    });
  });
});
