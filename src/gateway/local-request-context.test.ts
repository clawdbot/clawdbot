/**
 * Local gateway request-context tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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

  it("commits agent deletion through the canonical cron store", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-cron-delete-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg = {
      cron: { store: path.join(stateDir, "cron", "jobs.json") },
      agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
    } as OpenClawConfig;
    try {
      await withLocalGatewayRequestScope(
        { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
        async () => {
          const context = getPluginRuntimeGatewayRequestScope()?.context;
          if (!context) {
            throw new Error("expected local gateway request context");
          }
          await expect(
            context.cron.removeAgentJobsTransactional("worker", async () => "committed"),
          ).resolves.toBe("committed");
        },
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
