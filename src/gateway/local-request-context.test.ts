/**
 * Local gateway request-context tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as preparedModelCatalog from "../agents/prepared-model-catalog.js";
import type { PublishedModelCatalogOwnerCandidate } from "../agents/prepared-model-catalog.types.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { loadCronStore, resolveCronJobsStorePath, saveCronStore } from "../cron/store.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  dispatchGatewayMethodInProcess,
  dispatchGatewayMethodInProcessRaw,
} from "./server-plugins.js";

const createAgentTurnService = vi.hoisted(() =>
  vi.fn<typeof import("./agent-turn/agent-turn-service.js").createAgentTurnService>(),
);

vi.mock("./agent-turn/agent-turn-service.js", () => ({ createAgentTurnService }));

type PublishedOwnerSnapshot = Awaited<
  ReturnType<typeof preparedModelCatalog.loadPublishedPreparedModelCatalogOwnerSnapshot>
>;

const asPublishedOwner = (value: PublishedModelCatalogOwnerCandidate): PublishedOwnerSnapshot =>
  value as unknown as PublishedOwnerSnapshot;

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

  it("does not claim Gateway application readiness without a running Gateway", () => {
    withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => ({}) }, () =>
      expect(getPluginRuntimeGatewayRequestScope()?.context?.isConfigReloadSettled()).toBe(false),
    );
  });

  it("binds typed agent turns to the embedded context", async () => {
    await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => ({}) },
      async () => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local gateway request context");
        }
        const payload = { runId: "local-turn", status: "accepted" };
        createAgentTurnService.mockReturnValue({
          startTurn: async ({ io }) => io.emitAcceptance([true, payload, undefined]),
          waitForTurn: vi.fn(),
        });

        await expect(
          dispatchGatewayMethodInProcess(
            "agent",
            { message: "local turn", idempotencyKey: "local-turn" },
            { forceSyntheticClient: true, operatorRoleActor: { kind: "system" } },
          ),
        ).resolves.toEqual(payload);
        expect(createAgentTurnService).toHaveBeenCalledWith(
          expect.objectContaining({ context }),
          expect.any(Function),
        );
      },
    );
  });

  it("defaults local model catalog snapshot reads to read-only", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "worker",
            default: true,
            agentDir: "/tmp/local-model-catalog-agent",
            workspace: "/tmp/local-model-catalog-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    const loadOwner = vi
      .spyOn(preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot")
      .mockResolvedValue(
        asPublishedOwner({
          catalogOwner: { agentId: "worker", workspaceDir: "/tmp/local-model-catalog-workspace" },
          agentId: "worker",
          agentDir: "/tmp/local-model-catalog-agent",
          workspaceDir: "/tmp/local-model-catalog-workspace",
          config: cfg,
          authModes: {},
          authStore: { version: 1, profiles: {} },
          metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
          modelCatalog: { entries: [], routeVariants: [] },
        }),
      );

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
        const snapshot = await context.loadGatewayModelCatalogSnapshot({ agentId: "worker" });
        expect(snapshot).toMatchObject({
          agentId: "worker",
          workspaceDir: "/tmp/local-model-catalog-workspace",
        });
      },
    );

    expect(loadOwner).toHaveBeenCalledWith({ agentId: "worker", config: cfg, readOnly: true });
    loadOwner.mockRestore();
  });

  it("refreshes local models.list auth after login and logout", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            agentDir: "/tmp/local-model-auth-agent",
            workspace: "/tmp/local-model-auth-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    const model = {
      provider: "local-auth-provider",
      id: "local-auth-model",
      name: "Local auth model",
      api: "openai-completions" as const,
    };
    const candidate = {
      catalogOwner: { agentId: "main", workspaceDir: "/tmp/local-model-auth-workspace" },
      agentId: "main",
      agentDir: "/tmp/local-model-auth-agent",
      workspaceDir: "/tmp/local-model-auth-workspace",
      config: cfg,
      authModes: {},
      authStore: { version: 1 as const, profiles: {} },
      metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
      modelCatalog: { entries: [model], routeVariants: [model] },
    } satisfies PublishedModelCatalogOwnerCandidate;
    const refreshAuth = vi
      .fn()
      .mockResolvedValueOnce({
        authModes: { "local-auth-provider": "api_key" },
        authStore: {
          version: 1,
          profiles: {
            "local-auth-provider:default": {
              type: "api_key",
              provider: "local-auth-provider",
              key: "local-auth-key-not-real",
            },
          },
        },
      })
      .mockResolvedValueOnce({ authModes: {}, authStore: { version: 1, profiles: {} } });
    const loadOwner = vi
      .spyOn(preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(async () => {
        const auth = await refreshAuth({ providerIds: ["local-auth-provider"] });
        return asPublishedOwner({
          ...candidate,
          authModes: auth.authModes,
          authStore: auth.authStore,
        });
      });

    const list = () =>
      withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
        dispatchGatewayMethodInProcessRaw("models.list", { view: "configured", refresh: true }),
      );
    const loggedIn = await list();
    const loggedOut = await list();

    expect(loggedIn).toMatchObject({
      ok: true,
      payload: { models: [expect.objectContaining({ id: "local-auth-model", available: true })] },
    });
    expect(loggedOut).toMatchObject({
      ok: true,
      payload: { models: [] },
    });
    expect(refreshAuth).toHaveBeenNthCalledWith(1, {
      providerIds: ["local-auth-provider"],
    });
    expect(refreshAuth).toHaveBeenNthCalledWith(2, {
      providerIds: ["local-auth-provider"],
    });
    expect(loadOwner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
    );
    expect(loadOwner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ readOnly: false, refreshFullCatalog: true }),
    );
    loadOwner.mockRestore();
  });

  it("uses the prepared local owner when a catalog read times out", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            agentDir: "/tmp/local-model-timeout-agent",
            workspace: "/tmp/local-model-timeout-workspace",
          },
        ],
      },
    } as OpenClawConfig;
    const candidate = {
      catalogOwner: { agentId: "main", workspaceDir: "/tmp/local-model-timeout-workspace" },
      agentId: "main",
      agentDir: "/tmp/local-model-timeout-agent",
      workspaceDir: "/tmp/local-model-timeout-workspace",
      config: cfg,
      authModes: {},
      authStore: { version: 1 as const, profiles: {} },
      metadataSnapshot: { index: { plugins: [] }, plugins: [] } as never,
      modelCatalog: { entries: [], routeVariants: [] },
    } satisfies PublishedModelCatalogOwnerCandidate;
    const loadOwner = vi
      .spyOn(preparedModelCatalog, "loadPublishedPreparedModelCatalogOwnerSnapshot")
      .mockImplementation(() => new Promise(() => {}));
    const readOwner = vi
      .spyOn(preparedModelCatalog, "getPublishedPreparedModelCatalogOwnerSnapshot")
      .mockReturnValue(asPublishedOwner(candidate));

    const result = await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
      () => dispatchGatewayMethodInProcessRaw("models.list", { view: "default" }),
    );

    expect(result).toMatchObject({ ok: true, payload: { models: [] } });
    expect(loadOwner).toHaveBeenCalledOnce();
    expect(readOwner).toHaveBeenCalledOnce();
    loadOwner.mockRestore();
    readOwner.mockRestore();
  });

  it("commits agent deletion through the canonical cron store", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-cron-delete-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg = {
      cron: { store: path.join(stateDir, "cron", "jobs.json") },
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, worker: {} },
      },
    } as OpenClawConfig;
    try {
      const now = Date.now();
      const storePath = resolveCronJobsStorePath();
      await saveCronStore(storePath, {
        version: 1,
        jobs: [
          makeCronJob({
            id: "worker-job",
            name: "worker-job",
            agentId: "worker",
            schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now },
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "remove" },
            state: { nextRunAtMs: now + 3_600_000 },
          }),
          makeCronJob({
            id: "agentless-system-job",
            name: "agentless-system-job",
            schedule: { kind: "every", everyMs: 3_600_000, anchorMs: now },
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "keep" },
            state: { nextRunAtMs: now + 3_600_000 },
          }),
        ],
      });
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
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "agentless-system-job",
      ]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
