import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { page } from "./route.ts";

const location: RouteLocation = {
  pathname: "/settings/model-setup",
  search: "",
  hash: "",
};

function loaderOptions(): RouteLoaderOptions {
  return {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location,
    deps: "",
    cause: "navigation",
  };
}

describe("model setup route", () => {
  it("keys loader data by the first-run query", () => {
    const context = {
      agentSelection: { state: { selectedId: "main" } },
    } as ApplicationContext;

    expect(page.loaderDeps?.(context, location)).toBe("");
    expect(page.loaderDeps?.(context, { ...location, search: "?firstRun=1" })).toBe("?firstRun=1");
  });

  it("retries a stale route detection against the same client's reconnected generation", async () => {
    const stale: SystemAgentSetupDetectResult = {
      candidates: [],
      manualProviders: [],
      workspace: "/tmp/stale-workspace",
      setupComplete: false,
    };
    const current: SystemAgentSetupDetectResult = {
      ...stale,
      workspace: "/tmp/current-workspace",
    };
    let resolveStale!: (result: SystemAgentSetupDetectResult) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<SystemAgentSetupDetectResult>((resolve) => {
            resolveStale = resolve;
          }),
      )
      .mockResolvedValueOnce(current);
    const client = { request } as unknown as GatewayBrowserClient;
    const firstHello = {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["openclaw.setup.detect"] },
    };
    const gateway = {
      snapshot: {
        client,
        phase: "connected",
        hello: firstHello,
      } as ApplicationGatewaySnapshot,
    };
    const context = {
      gateway,
      agentSelection: { state: { selectedId: "research" } },
    } as unknown as ApplicationContext;
    const pending = page.loader?.(context, loaderOptions());

    expect(request).toHaveBeenCalledOnce();
    gateway.snapshot = { ...gateway.snapshot, phase: "reconnecting", hello: null };
    const currentHello = { ...firstHello };
    gateway.snapshot = { ...gateway.snapshot, phase: "connected", hello: currentHello };
    resolveStale(stale);

    await expect(pending).resolves.toEqual({
      state: { phase: "ready", result: current },
      connection: { client, hello: currentHello, agentId: "research" },
      firstRun: false,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("redacts secrets in initial detection failures", async () => {
    const request = vi.fn().mockRejectedValue(new Error("OPENAI_API_KEY=sk-1234567890abcdef"));
    const client = { request } as unknown as GatewayBrowserClient;
    const hello = {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["openclaw.setup.detect"] },
    };
    const context = {
      gateway: { snapshot: { client, phase: "connected", hello } },
      agentSelection: { state: { selectedId: "main" } },
    } as unknown as ApplicationContext;

    await expect(page.loader?.(context, loaderOptions())).resolves.toMatchObject({
      state: {
        phase: "detect-error",
        message: "OPENAI_API_KEY=sk-123...cdef",
      },
    });
  });
});
