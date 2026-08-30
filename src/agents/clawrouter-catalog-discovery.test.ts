import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import { runPreparedModelCatalogWorkerRequest } from "./prepared-model-catalog.worker.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";

// Exercise the worker request handler without bootstrapping it on Vitest's own worker port.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: null,
}));

describe("ClawRouter cold prepared catalog", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "clawrouter-catalog",
      env: {
        CLAWROUTER_API_KEY: "catalog-test-key",
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        CODEX_HOME: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await state.cleanup();
  });

  it.each([false, true])("publishes metadata with a sibling catalog=%s", async (sibling) => {
    // Distinct catalog URLs keep each scenario cold across plugin module loaders.
    const baseUrl = `https://${sibling ? "mixed" : "single"}.example.test/private`;
    const agentId = "private-openclaw";
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "none" },
        allow: sibling ? ["clawrouter", "openai"] : ["clawrouter"],
        entries: {
          clawrouter: { enabled: true },
          ...(sibling ? { openai: { enabled: true } } : {}),
        },
      },
      models: {
        providers: {
          clawrouter: {
            baseUrl,
            apiKey: { source: "env", provider: "default", id: "CLAWROUTER_API_KEY" },
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: sibling ? "openai/codex-latest" : "clawrouter/codex-latest" },
          models: {
            "clawrouter/codex-latest": { agentRuntime: { id: "openclaw" } },
            ...(sibling ? { "openai/codex-latest": { agentRuntime: { id: "openclaw" } } } : {}),
          },
          modelPolicy: { allow: ["clawrouter/codex-latest"] },
        },
        list: [{ id: agentId, model: { primary: "clawrouter/codex-latest" } }],
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`${baseUrl}/v1/catalog`);
      expect(request.headers.get("authorization")).toBe("Bearer catalog-test-key");
      return Response.json({
        providers: [
          {
            id: "private",
            displayName: "Synthetic provider",
            openaiCompatible: true,
            nativeBaseUrl: "/v1/native/private",
            models: [
              {
                id: "codex-latest",
                displayName: "Codex (Latest)",
                upstream: "codex-latest",
                capabilities: ["llm.responses"],
                supportedReasoningEfforts: ["low", "high"],
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      agentId,
      agentDir: state.agentDir(agentId),
      workspaceDir: state.workspaceDir,
      config,
      env: state.env,
      skipCredentials: true,
    };
    const prepared = await prepareWorkspaceBuildGroup([input], "static");
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    const result = await runPreparedModelCatalogWorkerRequest(value, {
      kind: "catalog",
      requestId: 1,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.kind !== "catalog") {
      throw new Error("catalog worker did not publish a catalog");
    }
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: config,
      agentId,
      snapshot: result.snapshot,
      metadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: prepared.pluginGeneration.pluginRegistry,
      preparedAuthStore: result.authStore,
      preparedRuntimeAuthModes: result.authModes,
    });
    const catalog = await buildModelsListResult({
      context: { getRuntimeConfig: () => config } as GatewayRequestContext,
      agentId,
      params: { view: "configured", preparedOnly: true },
      preloadedCatalog: { agentId, config, snapshot: result.snapshot },
      preloadedOnly: true,
      catalogProjector: projector,
    });
    expect(catalog.models).toContainEqual(
      expect.objectContaining({
        provider: "clawrouter",
        id: "codex-latest",
        name: "Codex (Latest)",
        reasoning: true,
        available: true,
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
