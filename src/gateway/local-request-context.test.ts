/**
 * Local gateway request-context tests.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugins.js";

describe("local gateway request context", () => {
  let response: Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>;

  beforeAll(async () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    } as OpenClawConfig;

    response = await withLocalGatewayRequestScope(
      {
        deps: {} as CliDeps,
        getRuntimeConfig: () => cfg,
      },
      () =>
        dispatchGatewayMethodInProcessRaw("agent.identity.get", {
          agentId: "main",
        }),
    );
  });

  it("lets embedded local runs dispatch gateway methods in-process", () => {
    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({ agentId: "main" });
  });

  it("defaults local model catalog snapshot reads to read-only", async () => {
    const cfg = {} as OpenClawConfig;
    const loadSnapshot = vi
      .spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot")
      .mockResolvedValue({ entries: [], routeVariants: [] });

    await withLocalGatewayRequestScope(
      {
        deps: {} as CliDeps,
        getRuntimeConfig: () => cfg,
      },
      async () => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local gateway request context");
        }
        await context.loadGatewayModelCatalogSnapshot();
      },
    );

    expect(loadSnapshot).toHaveBeenCalledWith({ config: cfg, readOnly: true });
    loadSnapshot.mockRestore();
  });
});
