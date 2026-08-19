// @vitest-environment node
import type { RouteLoaderOptions } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";
import type { UsageRouteData } from "./usage-page.ts";

describe("usage route", () => {
  it("redacts secrets in displayed loader failures", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.usage") {
        throw new Error("OPENAI_API_KEY=sk-1234567890abcdef");
      }
      return {};
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const gateway = { snapshot: { phase: "connected", client } };
    const context = {
      gateway,
      agentSelection: { state: { scopeId: "main" } },
    } as unknown as ApplicationContext;
    const options = {
      signal: new AbortController().signal,
      shouldRun: () => true,
      revalidating: false,
      location: { pathname: "/usage", search: "", hash: "" },
      deps: "",
      cause: "navigation",
    } satisfies RouteLoaderOptions;

    const result = (await page.loader?.(context, options)) as UsageRouteData;

    expect(result.error).toBe("OPENAI_API_KEY=sk-123...cdef");
  });
});
