// Verifies provider-auth warm worker input preserves runtime-only profile stores.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withEnvAsync } from "../test-utils/env.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  resolveInlineProviderApiKeyUsageId,
} from "./auth-profiles.js";
import type { ProviderAuthWarmWorkerInput } from "./model-provider-auth-warm.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthStateOffMainThread,
} from "./model-provider-auth.js";
import { runProviderAuthWarmWorkerInput } from "./model-provider-auth.worker.js";

const tempDirs: string[] = [];

function syntheticAuthScopes(cfg: OpenClawConfig): ProviderAuthWarmWorkerInput["syntheticAuth"] {
  return listAgentIds(cfg).map((agentId) => {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const { normalizePluginId: _normalizePluginId, ...metadataSnapshot } =
      loadPluginMetadataSnapshot({
        config: cfg,
        workspaceDir,
      });
    return { agentId, workspaceDir, metadataSnapshot, facts: [] };
  });
}

vi.mock("./prepared-model-catalog.js", () => ({
  getPreparedModelCatalogOwnerSnapshot: () => undefined,
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: vi.fn(
    async (params: { agentDir: string; agentId?: string; config: OpenClawConfig }) => ({
      agentDir: params.agentDir,
      agentId: params.agentId,
      config: params.config,
      modelCatalog: {
        entries: Object.entries(params.config.models?.providers ?? {}).flatMap(
          ([provider, providerConfig]) =>
            (providerConfig.models ?? []).map((model) => ({
              id: model.id,
              name: model.name ?? model.id,
              provider,
            })),
        ),
        routeVariants: [],
      },
    }),
  ),
}));

describe("provider auth warm worker", () => {
  afterEach(() => {
    clearCurrentProviderAuthState();
    clearRuntimeAuthProfileStoreSnapshots();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launches the default source worker without an injected URL", async () => {
    await expect(
      warmCurrentProviderAuthStateOffMainThread({ agents: { list: [] } }, { timeoutMs: 30_000 }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("rejects missing prepared scopes instead of probing auth in the worker", async () => {
    const result = await runProviderAuthWarmWorkerInput({
      cfg: { agents: { list: [{ id: "main" }] } },
      syntheticAuth: [],
    });
    expect(result).toEqual({
      status: "failed",
      error: "Error: Prepared synthetic auth scope is missing for main",
    });
  });

  it("preserves runtime-only auth profile snapshots in the worker warm input", async () => {
    // Runtime-only profiles are not persisted to disk, so the worker input must
    // carry them explicitly or warming loses provider availability.
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-provider-auth-worker-"));
    tempDirs.push(root);

    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
      async () => {
        const agentDir = path.join(root, "agent");
        const cfg = {
          agents: { list: [{ id: "main", agentDir }] },
          models: {
            providers: {
              "runtime-only": {
                baseUrl: "https://example.com/v1",
                api: "openai",
                models: [{ id: "runtime-model", name: "Runtime Model" }],
              },
            },
          },
        } as unknown as OpenClawConfig;
        const result = await runProviderAuthWarmWorkerInput({
          cfg,
          syntheticAuth: syntheticAuthScopes(cfg),
          runtimeAuthStores: [
            {
              agentDir,
              store: {
                version: 1,
                profiles: {
                  "runtime-only:default": {
                    type: "api_key",
                    provider: "runtime-only",
                  },
                },
              },
            },
          ],
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          return;
        }
        expect(result.snapshot.agents[0]?.providers).toContainEqual(["runtime-only", true]);
      },
    );
  }, 30_000);

  it("respects cooled-down inline api keys in the worker warm input", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-provider-auth-worker-cooldown-"));
    tempDirs.push(root);

    await withEnvAsync(
      {
        OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
      async () => {
        const agentDir = path.join(root, "agent");
        const cfg = {
          agents: { list: [{ id: "main", agentDir }] },
          models: {
            providers: {
              "cooled-down": {
                apiKey: "some-key",
                baseUrl: "https://example.com/v1",
                api: "openai",
                models: [{ id: "some-model", name: "Some Model" }],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const usageId = resolveInlineProviderApiKeyUsageId("cooled-down");
        const result = await runProviderAuthWarmWorkerInput({
          cfg,
          syntheticAuth: syntheticAuthScopes(cfg),
          runtimeAuthStores: [
            {
              agentDir,
              store: {
                version: 1,
                profiles: {},
                usageStats: {
                  [usageId]: {
                    disabledUntil: Date.now() + 60_000,
                    disabledReason: "billing",
                  },
                },
              },
            },
          ],
        });

        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          return;
        }
        // Should NOT contain the provider because the inline key is in cooldown
        expect(result.snapshot.agents[0]?.providers).not.toContainEqual(["cooled-down", true]);
      },
    );
  }, 30_000);
});
