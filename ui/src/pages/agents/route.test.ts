import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { AgentsRouteData } from "./agents-page.ts";
import { page } from "./route.ts";

describe("agents route", () => {
  it("keeps a requested agent when the roster loads on a cold deep link", async () => {
    const agentsList: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "research", name: "Research" },
      ],
    };
    const ensureList = vi.fn(async () => agentsList);
    const gateway = { snapshot: { client: null, connected: false } };
    const context = {
      gateway,
      agents: {
        state: { agentsList: null, agentsError: null },
        ensureList,
      },
    } as unknown as ApplicationContext;

    if (!page.loader) {
      throw new Error("agents route has no loader");
    }
    const result = (await page.loader(context, {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location: {
        pathname: "/settings/agents",
        search: "?agent=research",
        hash: "",
      },
      deps: "?agent=research",
      cause: "preload",
    } satisfies RouteLoaderOptions)) as AgentsRouteData;

    expect(ensureList).toHaveBeenCalledOnce();
    expect(result.agentsList).toBe(agentsList);
    expect(result.selectedAgentId).toBe("research");
  });
});
