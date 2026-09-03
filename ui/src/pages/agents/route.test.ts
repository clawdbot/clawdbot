import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page, type AgentsRouteData } from "./route.ts";

const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Main" },
    { id: "ordinary-looking-id", kind: "system", name: "System" },
    { id: "research", name: "Research" },
  ],
};

async function loadRoute(url: string): Promise<AgentsRouteData> {
  const parsed = new URL(url, "https://control.test");
  const ensureList = vi.fn(async () => agentsList);
  const gateway = { snapshot: { client: null, phase: "stopped" } };
  const context = {
    basePath: "",
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
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
    deps: `${parsed.pathname}\u0000${parsed.search}\u0000${parsed.hash}`,
    cause: "preload",
  } satisfies RouteLoaderOptions)) as AgentsRouteData;
  expect(ensureList).toHaveBeenCalledOnce();
  return result;
}

describe("agents route", () => {
  it("keeps a requested agent and panel when the roster loads on a cold deep link", async () => {
    const result = await loadRoute("/settings/agents/research/tools");

    expect(result.agentsList?.agents.map((agent) => agent.id)).toEqual(["main", "research"]);
    expect(result.requestedAgentId).toBe("research");
    expect(result.panel).toBe("tools");
    expect(result.canonicalLocation).toBeUndefined();
  });

  it("keeps the bare route and default panel", async () => {
    const result = await loadRoute("/settings/agents");

    expect(result.requestedAgentId).toBeNull();
    expect(result.panel).toBe("files");
    expect(result.canonicalLocation).toBeUndefined();
  });

  it("preserves an unknown explicit id for page-owned roster reconciliation", async () => {
    const result = await loadRoute("/settings/agents/missing/memory");

    expect(result.requestedAgentId).toBe("missing");
    expect(result.panel).toBe("memory");
    expect(result.canonicalLocation).toBeUndefined();
  });

  it("returns the canonical replacement for a legacy agent query", async () => {
    const result = await loadRoute("/settings/agents?agent=research&probe=1#files");

    expect(result.panel).toBe("files");
    expect(result.canonicalLocation).toEqual({
      pathname: "/settings/agents/research",
      search: "?probe=1",
      hash: "#files",
    });
  });
});
