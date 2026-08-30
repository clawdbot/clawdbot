// Runtime plugin tests cover run-owned registry handles for isolated cron turns.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import * as providerModelNormalization from "../../agents/provider-model-normalization.runtime.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  ensureAgentWorkspaceMock,
  acquirePreparedModelRuntimeMock,
  loadModelCatalogOwnerMock,
  loadRunCronIsolatedAgentTurn,
  resolveSessionAuthSelectionMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn runtime plugin owner", () => {
  setupRunCronIsolatedAgentTurnSuite();

  beforeEach(() => {
    // These canonical fixture models need no provider rewrite; keep runtime
    // execution separate from the metadata handoff exercised by this suite.
    const normalizer = vi
      .spyOn(providerModelNormalization, "normalizeProviderModelIdWithRuntime")
      .mockImplementation(({ context }) => context.modelId);
    onTestFinished(() => normalizer.mockRestore());
  });

  it("carries a gateway-bindable selected registry handle into the run", async () => {
    const params = makeIsolatedAgentParamsFixture({
      job: {
        payload: {
          kind: "agentTurn",
          message: "test",
          fallbacks: ["anthropic/claude-sonnet-4-6"],
        },
      },
    });

    await expect(runCronIsolatedAgentTurn(params)).resolves.toMatchObject({ status: "ok" });
    expect(loadModelCatalogOwnerMock).toHaveBeenCalledWith({
      config: params.cfg,
      agentId: "main",
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expect(acquirePreparedModelRuntimeMock).toHaveBeenCalledWith(
      {
        config: { agents: { defaults: {} } },
        agentId: "main",
        agentDir: "/tmp/agent-dir",
        workspaceDir: "/tmp/workspace",
        allowGatewaySubagentBinding: true,
        runtimePluginSelections: [
          { provider: "openai", modelId: "gpt-5.4", agentId: "main" },
          { provider: "anthropic", modelId: "claude-sonnet-4-6", agentId: "main" },
        ],
      },
      {
        catalogMode: "static",
        pluginMetadataSnapshot: (await loadModelCatalogOwnerMock.mock.results[0]?.value)
          ?.metadataSnapshot,
        abortSignal: expect.any(AbortSignal),
      },
    );
  });

  it("reuses the published owner metadata snapshot for auth and the run registry", async () => {
    const params = makeIsolatedAgentParamsFixture({
      cfg: { auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } } },
    });
    const workspaceDir = "/tmp/cron-workspace";
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: params.cfg,
      workspaceDir,
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    ensureAgentWorkspaceMock.mockResolvedValue({ dir: workspaceDir });
    loadModelCatalogOwnerMock.mockImplementation(async (ownerParams) => ({
      catalogOwner: { agentId: ownerParams.agentId ?? "default", workspaceDir },
      agentId: ownerParams.agentId ?? "default",
      agentDir: "/tmp/agent-dir",
      workspaceDir,
      config: ownerParams.config,
      authModes: {},
      authStore: { version: 1, profiles: {} },
      metadataSnapshot,
      modelCatalog: { entries: [], routeVariants: [] },
    }));

    await expect(runCronIsolatedAgentTurn(params)).resolves.toMatchObject({ status: "ok" });
    expect(resolveSessionAuthSelectionMock).toHaveBeenCalledOnce();
    const authParams = resolveSessionAuthSelectionMock.mock.calls[0]?.[0];
    expect(authParams.workspaceDir).toBe(workspaceDir);
    expect(authParams.pluginMetadataSnapshot).toBe(metadataSnapshot);
    expect(acquirePreparedModelRuntimeMock).toHaveBeenCalledOnce();
    // Exact snapshot identity: a rebuilt copy would still re-hash every installed plugin.
    expect(acquirePreparedModelRuntimeMock.mock.calls[0]?.[1].pluginMetadataSnapshot).toBe(
      metadataSnapshot,
    );
  });
});
