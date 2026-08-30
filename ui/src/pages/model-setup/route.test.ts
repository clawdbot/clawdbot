import { createRouter, type RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";

const location: RouteLocation = {
  pathname: "/settings/model-setup",
  search: "",
  hash: "",
};

describe("model setup route", () => {
  it("keys loader data by the first-run query", () => {
    const context = {
      agentSelection: { state: { selectedId: "main" } },
    } as ApplicationContext;

    expect(page.loaderDeps?.(context, location)).toBe("");
    expect(page.loaderDeps?.(context, { ...location, search: "?firstRun=1" })).toBe("?firstRun=1");
  });

  it("settles navigation without waiting for provider detection", async () => {
    const detected = createDeferred<SystemAgentSetupDetectResult>();
    const request = vi.fn(() => detected.promise);
    const context = {
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: {
            auth: { role: "operator", scopes: ["operator.admin"] },
            features: { methods: ["openclaw.setup.detect"] },
          },
        },
      },
      agentSelection: { state: { selectedId: "main" } },
    } as unknown as ApplicationContext;
    const router = createRouter({ routes: [{ ...page, component: () => null }] });
    const navigation = router.navigate("model-setup", context);
    try {
      await vi.waitFor(() => expect(router.getState().matches[0]?.status).toBe("success"));
    } finally {
      detected.resolve({
        candidates: [],
        manualProviders: [],
        workspace: "",
        setupComplete: false,
      });
      await navigation;
      router.stop();
    }
  });
});
