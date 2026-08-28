// Verifies models.json writes, plugin catalog writes, and ready-cache serialization.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";

function listPersistedPluginModelCatalogs(agentDir: string) {
  return loadPersistedPluginModelCatalogs(agentDir).catalogs;
}

function readRawCatalogCacheRow(
  agentDir: string,
  pluginId: string,
): {
  value_json: string;
  updated_at: number;
} {
  const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT value_json, updated_at FROM cache_entries WHERE scope = ? AND key = ?")
      .get("plugin-model-catalog-v1", pluginId) as
      | { value_json: string; updated_at: number }
      | undefined;
    if (!row) {
      throw new Error(`Missing generated catalog cache row for ${pluginId}`);
    }
    return row;
  } finally {
    database.close();
  }
}

const planOpenClawModelsJsonMock = vi.fn();
const writePrivateStoreTextWriteMock = vi.fn();
let actualPrivateFileStore:
  | typeof import("../infra/private-file-store.js").privateFileStore
  | undefined;

installModelsConfigTestHooks();

let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let planOpenClawModelsJsonSource: typeof import("./models-config.js").planOpenClawModelsJsonSource;
let clearPluginMetadataLifecycleCaches: typeof import("../plugins/plugin-metadata-lifecycle.js").clearPluginMetadataLifecycleCaches;
let setCurrentPluginMetadataSnapshot: typeof import("../plugins/current-plugin-metadata.test-support.js").setCurrentPluginMetadataSnapshot;

function createPluginMetadataSnapshot(workspaceDir: string): PluginMetadataSnapshot {
  // Minimal process snapshot used to prove when metadata may be reused.
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  return {
    policyHash,
    workspaceDir,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
}

async function expectMissingPath(operation: Promise<unknown>) {
  // Filesystem deletion assertions should fail on the errno, not path text.
  let error: NodeJS.ErrnoException | undefined;
  try {
    await operation;
  } catch (caught) {
    error = caught as NodeJS.ErrnoException;
  }
  expect(error?.code).toBe("ENOENT");
}

function planParamsAt(callIndex: number): {
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  providerDiscoveryProviderIds?: string[];
  providerDiscoveryTimeoutMs?: number;
  workspaceDir?: string;
} {
  // Planner call shape is the contract between ensureOpenClawModelsJson and planning.
  const call = planOpenClawModelsJsonMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected models planner call #${callIndex + 1}`);
  }
  return (
    call[0] as {
      context: {
        pluginMetadataSnapshot?: PluginMetadataSnapshot;
        providerDiscoveryProviderIds?: string[];
        providerDiscoveryTimeoutMs?: number;
        workspaceDir?: string;
      };
    }
  ).context;
}

beforeAll(async () => {
  vi.doMock("./models-config.plan.js", () => ({
    planOpenClawModelsJson: (...args: unknown[]) => planOpenClawModelsJsonMock(...args),
  }));
  vi.doMock("../infra/private-file-store.js", async () => {
    const actual = await vi.importActual<typeof import("../infra/private-file-store.js")>(
      "../infra/private-file-store.js",
    );
    actualPrivateFileStore = actual.privateFileStore;
    return {
      ...actual,
      privateFileStore: (rootDir: string) => {
        const store = actual.privateFileStore(rootDir);
        return {
          ...store,
          writeText: (relativePath: string, content: string | Uint8Array) =>
            writePrivateStoreTextWriteMock({
              rootDir,
              filePath: path.join(rootDir, relativePath),
              content,
            }),
        };
      },
    };
  });
  ({ ensureOpenClawModelsJson, planOpenClawModelsJsonSource } = await import("./models-config.js"));
  ({ clearPluginMetadataLifecycleCaches } =
    await import("../plugins/plugin-metadata-lifecycle.js"));
  ({ setCurrentPluginMetadataSnapshot } =
    await import("../plugins/current-plugin-metadata.test-support.js"));
});

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  writePrivateStoreTextWriteMock
    .mockReset()
    .mockImplementation(
      async (params: { filePath: string; rootDir: string; content: string | Uint8Array }) => {
        if (!actualPrivateFileStore) {
          throw new Error("private file store mock not initialized");
        }
        return await actualPrivateFileStore(params.rootDir).writeText(
          path.basename(params.filePath),
          params.content,
        );
      },
    );
  planOpenClawModelsJsonMock
    .mockReset()
    .mockImplementation(
      async (params: { context: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG } }) => ({
        action: "write",
        contents: `${JSON.stringify({ providers: params.context.cfg?.models?.providers ?? {} }, null, 2)}\n`,
      }),
    );
});

describe("models-config write serialization", () => {
  it("materializes an authoritative plugin catalog replacement without mutating state", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const workspaceDir = path.join(home, "workspace");
      const rootContents = `${JSON.stringify({ providers: { existing: { models: [] } } })}\n`;
      const existingPluginContents = `${JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {},
      })}\n`;
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "models.json"), rootContents);
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("existing-plugin")]: existingPluginContents,
        },
      });
      const originalPluginRow = readRawCatalogCacheRow(agentDir, "existing-plugin");
      const plannedPluginContents = `${JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {},
      })}\n`;
      planOpenClawModelsJsonMock.mockResolvedValue({
        action: "write",
        contents: `${JSON.stringify({ providers: { discovered: { models: [] } } })}\n`,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("planned-plugin")]: plannedPluginContents,
        },
      });

      const planned = await planOpenClawModelsJsonSource({}, agentDir, {
        workspaceDir,
        pluginMetadataSnapshot: createPluginMetadataSnapshot(workspaceDir),
      });

      expect(planned.modelsJsonContents).toContain("discovered");
      expect(planned.pluginCatalogs).toEqual([
        { pluginId: "planned-plugin", contents: plannedPluginContents },
      ]);
      expect(await fs.readFile(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
        { pluginId: "existing-plugin", contents: existingPluginContents },
      ]);
      expect(readRawCatalogCacheRow(agentDir, "existing-plugin")).toEqual(originalPluginRow);
      expect(writePrivateStoreTextWriteMock).not.toHaveBeenCalled();
    });
  });

  it("does not reuse default workspace plugin metadata for explicit agent dirs without workspace", async () => {
    await withModelsTempHome(async (home) => {
      const snapshot = createPluginMetadataSnapshot(path.join(home, "default-workspace"));
      setCurrentPluginMetadataSnapshot(snapshot, { config: {} });
      const agentDir = path.join(home, "agent-non-default");

      await ensureOpenClawModelsJson({}, agentDir);

      const params = planParamsAt(0);
      expect(params.pluginMetadataSnapshot).not.toBe(snapshot);
    });
  });

  it("reuses current plugin metadata for explicit agent dirs with matching workspace", async () => {
    await withModelsTempHome(async (home) => {
      const workspaceDir = path.join(home, "agent-workspace");
      const snapshot = createPluginMetadataSnapshot(workspaceDir);
      setCurrentPluginMetadataSnapshot(snapshot, { config: {} });
      const agentDir = path.join(home, "agent-non-default");

      await ensureOpenClawModelsJson({}, agentDir, { workspaceDir });

      const params = planParamsAt(0);
      expect(params.workspaceDir).toBe(workspaceDir);
      expect(params.pluginMetadataSnapshot).toBe(snapshot);
    });
  });

  it("does not reuse persisted plugin metadata for provider-scoped discovery", async () => {
    await withModelsTempHome(async (home) => {
      const workspaceDir = path.join(home, "agent-workspace");
      const snapshot = createPluginMetadataSnapshot(workspaceDir);
      setCurrentPluginMetadataSnapshot(snapshot, { config: {} });
      const agentDir = path.join(home, "agent-non-default");

      await ensureOpenClawModelsJson({}, agentDir, {
        workspaceDir,
        providerDiscoveryProviderIds: ["google"],
      });

      const params = planParamsAt(0);
      expect(params.pluginMetadataSnapshot).not.toBe(snapshot);
    });
  });

  it("writes implicit models.json into the configured default agent dir", async () => {
    await withModelsTempHome(async (home) => {
      const cfg = {
        agents: {
          list: [{ id: "main" }, { id: "ops", default: true }],
        },
      };

      const result = await ensureOpenClawModelsJson(cfg);

      expect(result.agentDir).toBe(path.join(home, ".openclaw", "agents", "ops", "agent"));
      await expect(fs.access(path.join(result.agentDir, "models.json"))).resolves.toBeUndefined();
      await expectMissingPath(
        fs.access(path.join(home, ".openclaw", "agents", "main", "agent", "models.json")),
      );
    });
  });

  it("migrates released provider credentials before model planning can regenerate a catalog", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const relativePath = encodePluginModelCatalogRelativePath("zai");
      const sourcePath = path.join(agentDir, relativePath);
      const contents = `${JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          zai: {
            baseUrl: "https://api.z.ai/api/paas/v4",
            api: "openai-completions",
            apiKey: "released-zai-provider-test-key",
            models: [{ id: "glm-5.1", name: "GLM 5.1" }],
          },
        },
      })}\n`;
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, contents, "utf8");
      planOpenClawModelsJsonMock.mockImplementation(async () => {
        expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
        return { action: "skip" };
      });

      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledOnce();
      await expectMissingPath(fs.access(sourcePath));
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    });
  });

  it("refuses to regenerate provider catalogs while released credentials cannot be read", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      const sourcePath = path.join(agentDir, encodePluginModelCatalogRelativePath("zai"));
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        JSON.stringify({
          generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
          providers: { zai: { apiKey: "unreadable-released-provider-test-key" } },
        }),
        "utf8",
      );
      await fs.chmod(sourcePath, 0o000);

      try {
        await expect(ensureOpenClawModelsJson({}, agentDir)).rejects.toThrow(
          "Cannot safely prepare provider models until legacy catalog migration succeeds",
        );
        expect(planOpenClawModelsJsonMock).not.toHaveBeenCalled();
      } finally {
        await fs.chmod(sourcePath, 0o600);
      }

      await expect(fs.access(sourcePath)).resolves.toBeUndefined();
    });
  });

  it("never promotes an unmarked cached plugin catalog into model planning", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: JSON.stringify({
            providers: {
              zai: {
                baseUrl: "https://unmarked.example/v1",
                api: "openai-completions",
                apiKey: "unmarked-provider-test-key",
                models: [{ id: "unmarked-model" }],
              },
            },
          }),
        },
      });
      const pluginMetadataSnapshot = {
        index: { plugins: [{ pluginId: "zai", enabled: true }] },
        normalizePluginId: (pluginId: string) => pluginId,
        manifestRegistry: { plugins: [], diagnostics: [] },
        owners: {
          providers: new Map([["zai", ["zai"]]]),
          modelCatalogProviders: new Map([["zai", ["zai"]]]),
          setupProviders: new Map(),
        },
      } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
      planOpenClawModelsJsonMock.mockImplementation(
        async (params: { existingParsed?: unknown }) => {
          expect(params.existingParsed).toEqual({ providers: {} });
          return { action: "skip" };
        },
      );

      await ensureOpenClawModelsJson({ models: { providers: {} } }, agentDir, {
        pluginMetadataSnapshot,
      });

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledOnce();
    });
  });

  it("writes plugin-owned model catalogs into the agent SQLite cache", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      planOpenClawModelsJsonMock.mockImplementation(async () => ({
        action: "write",
        contents: `${JSON.stringify({ providers: {} }, null, 2)}\n`,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: `${JSON.stringify(
            {
              generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
              providers: {
                zai: {
                  baseUrl: "https://api.z.ai/api/paas/v4",
                  api: "openai-completions",
                  apiKey: "ZAI_API_KEY",
                  models: [{ id: "glm-5.1", name: "GLM 5.1" }],
                },
              },
            },
            null,
            2,
          )}\n`,
        },
      }));

      await ensureOpenClawModelsJson({}, agentDir);

      const root = JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8")) as {
        providers?: Record<string, unknown>;
      };
      const stored = listPersistedPluginModelCatalogs(agentDir);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.pluginId).toBe("zai");
      const catalog = JSON.parse(stored[0]?.contents ?? "{}") as {
        providers?: Record<string, unknown>;
      };
      expect(root.providers).toEqual({});
      expect(root).not.toHaveProperty("pluginCatalogs");
      expect(Object.keys(catalog.providers ?? {})).toEqual(["zai"]);
      await expect(fs.access(path.join(agentDir, "plugins"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("removes stale plugin-owned model catalogs from the agent SQLite cache", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("old-provider")]: `${JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {},
          })}\n`,
        },
      });
      planOpenClawModelsJsonMock.mockImplementation(async () => ({
        action: "noop",
        pluginCatalogWrites: {},
      }));
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        `${JSON.stringify({ providers: {} })}\n`,
      );

      const result = await ensureOpenClawModelsJson({}, agentDir);

      expect(result.wrote).toBe(true);
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([]);
    });
  });

  it("keeps generated SQLite plugin catalogs on non-authoritative skip plans", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("zai")]: `${JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {},
          })}\n`,
        },
      });
      planOpenClawModelsJsonMock.mockImplementation(async () => ({ action: "skip" }));

      const result = await ensureOpenClawModelsJson({}, agentDir);

      expect(result.wrote).toBe(false);
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
        expect.objectContaining({ pluginId: "zai" }),
      ]);
    });
  });

  it("repairs malformed catalog state before startup planning and fingerprints it once", async () => {
    await withModelsTempHome(async (home) => {
      const agentDir = path.join(home, "agent");
      replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [encodePluginModelCatalogRelativePath("nvidia")]: JSON.stringify({
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: {
              nvidia: {
                baseUrl: "https://integrate.api.nvidia.com/v1",
                api: "openai-completions",
                apiKey: "NVIDIA_API_KEY",
                models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
              },
            },
          }),
        },
      });
      const malformed = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          nvidia: {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKey: "NVIDIA_API_KEY",
            models: [{ id: "meta-llama/llama-3.3-70b-instruct" }],
          },
        },
      });
      const database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
      try {
        database
          .prepare(
            "UPDATE cache_entries SET value_json = ?, updated_at = 42 WHERE scope = ? AND key = ?",
          )
          .run(malformed, "plugin-model-catalog-v1", "nvidia");
      } finally {
        database.close();
      }
      planOpenClawModelsJsonMock.mockImplementation(async () => {
        const parsed = JSON.parse(readRawCatalogCacheRow(agentDir, "nvidia").value_json) as {
          providers?: { nvidia?: { api?: string; models?: unknown[] } };
        };
        expect(parsed.providers?.nvidia?.models).toEqual([]);
        expect(parsed.providers?.nvidia).not.toHaveProperty("api");
        return { action: "skip" };
      });

      await ensureOpenClawModelsJson({}, agentDir);
      const repaired = readRawCatalogCacheRow(agentDir, "nvidia");
      expect(repaired.updated_at).not.toBe(42);
      await ensureOpenClawModelsJson({}, agentDir);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledOnce();
      expect(readRawCatalogCacheRow(agentDir, "nvidia")).toEqual(repaired);
    });
  });

  it("does not reuse scoped startup discovery cache for a different provider scope", async () => {
    await withModelsTempHome(async (home) => {
      planOpenClawModelsJsonMock.mockImplementation(async () => ({ action: "skip" }));
      const agentDir = path.join(home, "agent");
      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryTimeoutMs: 5000,
      });
      await ensureOpenClawModelsJson({}, agentDir, {
        providerDiscoveryProviderIds: ["anthropic"],
        providerDiscoveryTimeoutMs: 5000,
      });

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
      const params = planParamsAt(1);
      expect(params.providerDiscoveryProviderIds).toEqual(["anthropic"]);
      expect(params.providerDiscoveryTimeoutMs).toBe(5000);
    });
  });

  it("keeps the ready cache warm after models.json is written", async () => {
    await withModelsTempHome(async () => {
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(1);
    });
  });

  it("invalidates the ready cache when models.json changes externally", async () => {
    await withModelsTempHome(async () => {
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      const modelPath = path.join(resolveDefaultAgentDir({}), "models.json");
      await fs.writeFile(modelPath, `${JSON.stringify({ external: true })}\n`, "utf8");
      const externalMtime = new Date(Date.now() + 2000);
      await fs.utimes(modelPath, externalMtime, externalMtime);
      await ensureOpenClawModelsJson(CUSTOM_PROXY_MODELS_CONFIG);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps distinct config fingerprints cached without evicting each other", async () => {
    await withModelsTempHome(async () => {
      planOpenClawModelsJsonMock.mockImplementation(async () => ({ action: "noop" }));
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      first.agents = { defaults: { model: "openai/gpt-5.4" } };
      second.agents = { defaults: { model: "anthropic/claude-sonnet-4-5" } };

      await ensureOpenClawModelsJson(first);
      await ensureOpenClawModelsJson(second);
      await ensureOpenClawModelsJson(first);

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps full and scoped plugin metadata snapshots in distinct cache entries", async () => {
    await withModelsTempHome(async (home) => {
      planOpenClawModelsJsonMock.mockImplementation(async () => ({ action: "noop" }));
      const workspaceDir = path.join(home, "workspace");
      const agentDir = path.join(home, "agent");
      const fullSnapshot = createPluginMetadataSnapshot(workspaceDir);
      const scopedSnapshot = {
        ...createPluginMetadataSnapshot(workspaceDir),
        pluginIds: ["owner"],
      };

      await ensureOpenClawModelsJson({}, agentDir, {
        workspaceDir,
        pluginMetadataSnapshot: fullSnapshot,
      });
      await ensureOpenClawModelsJson({}, agentDir, {
        workspaceDir,
        pluginMetadataSnapshot: scopedSnapshot,
      });
      await ensureOpenClawModelsJson({}, agentDir, {
        workspaceDir,
        pluginMetadataSnapshot: fullSnapshot,
      });

      expect(planOpenClawModelsJsonMock).toHaveBeenCalledTimes(2);
    });
  });

  it("serializes concurrent models.json writes to avoid overlap", async () => {
    await withModelsTempHome(async () => {
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const firstModel = first.models?.providers?.["custom-proxy"]?.models?.[0];
      const secondModel = second.models?.providers?.["custom-proxy"]?.models?.[0];
      if (!firstModel || !secondModel) {
        throw new Error("custom-proxy fixture missing expected model entries");
      }
      firstModel.name = "Proxy A";
      secondModel.name = "Proxy B with longer name";

      let inFlightWrites = 0;
      let maxInFlightWrites = 0;
      let markFirstModelsWriteStarted: () => void = () => {};
      const firstModelsWriteStarted = new Promise<void>((resolve) => {
        markFirstModelsWriteStarted = resolve;
      });
      let releaseModelsWrites: () => void = () => {};
      const modelsWritesCanContinue = new Promise<void>((resolve) => {
        releaseModelsWrites = resolve;
      });
      let modelsWriteCount = 0;
      writePrivateStoreTextWriteMock.mockImplementation(
        async (params: { filePath: string; rootDir: string; content: string | Uint8Array }) => {
          // Hold both writes at the store boundary to prove the outer serializer works.
          const isModelsWrite = path.basename(params.filePath) === "models.json";
          if (isModelsWrite) {
            modelsWriteCount += 1;
            inFlightWrites += 1;
            if (inFlightWrites > maxInFlightWrites) {
              maxInFlightWrites = inFlightWrites;
            }
            if (modelsWriteCount === 1) {
              markFirstModelsWriteStarted();
            }
            await modelsWritesCanContinue;
          }
          try {
            if (!actualPrivateFileStore) {
              throw new Error("private file store mock not initialized");
            }
            return await actualPrivateFileStore(params.rootDir).writeText(
              path.basename(params.filePath),
              params.content,
            );
          } finally {
            if (isModelsWrite) {
              inFlightWrites -= 1;
            }
          }
        },
      );

      const writes = Promise.all([
        ensureOpenClawModelsJson(first),
        ensureOpenClawModelsJson(second),
      ]);
      await firstModelsWriteStarted;
      await Promise.resolve();
      releaseModelsWrites();
      await writes;

      expect(maxInFlightWrites).toBe(1);
      const parsed = await readGeneratedModelsJson<{
        providers: { "custom-proxy"?: { models?: Array<{ name?: string }> } };
      }>();
      expect(["Proxy A", "Proxy B with longer name"]).toContain(
        parsed.providers["custom-proxy"]?.models?.[0]?.name,
      );
    });
  }, 60_000);
});
