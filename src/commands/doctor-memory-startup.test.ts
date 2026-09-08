import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureMemoryIndexSchema } from "../plugin-sdk/memory-core-host-engine-storage.js";
import { createPluginStateKeyedStoreForTests } from "../plugin-sdk/plugin-state-test-runtime.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { loadBundledPluginPublicSurface } from "../plugin-sdk/test-helpers/public-surface-loader.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import {
  getRegisteredEmbeddingProvider,
  registerEmbeddingProvider,
} from "../plugins/embedding-providers.js";
import { resolveNativePluginModelAuth } from "../plugins/loader-runtime-load.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

beforeEach(async () => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  // The shared loader resolves manifest-owned public artifacts from checkout source, never dist.
  const { default: openaiPlugin } = await loadBundledPluginPublicSurface<{
    default: OpenClawPluginDefinition;
  }>({ pluginId: "openai", artifactBasename: "index.js" });
  assert(openaiPlugin.register);
  openaiPlugin.register(
    createTestPluginApi({
      registrationMode: "discovery",
      runtime: createPluginRuntimeMock({ modelAuth: resolveNativePluginModelAuth() }),
      registerEmbeddingProvider,
    }),
  );
});

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Memory Core cold startup migrations", () => {
  it.each(["stored", "missing"] as const)(
    "preserves semantic data and reaches auth activation with a %s store SecretRef",
    async (entryState) => {
      await withOpenClawTestState({ label: "memory-startup" }, async (state) => {
        clearSecretsRuntimeSnapshot();
        const profileId = "openai:memory-startup";
        const ref = { source: "store", provider: "default", id: "MEMORY_STARTUP_KEY" } as const;
        const value = "synthetic-memory-bootstrap-key";
        const config: OpenClawConfig = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          auth: { profiles: { [profileId]: { provider: "openai", mode: "api_key" } } },
          memory: { search: { provider: "openai", fallback: "none" } },
        };
        const databasePath = await state.writeAuthProfiles({
          version: 1,
          profiles: { [profileId]: { type: "api_key", provider: "openai", keyRef: ref } },
        });
        if (entryState === "stored") {
          writeSecretStoreEntry({
            scope: { kind: "team" },
            name: ref.id,
            value,
            kind: "secret",
            updatedBy: "test",
            database: { env: state.env },
          });
        }
        const db = new DatabaseSync(databasePath);
        try {
          ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
          db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
            "memory_index_meta_v1",
            JSON.stringify({ model: "text-embedding-3-small", vectorDims: 3 }),
          );
          db.prepare(
            `INSERT INTO memory_index_chunks
             (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            "preserved-chunk",
            "MEMORY.md",
            "memory",
            1,
            1,
            "chunk-hash",
            "text-embedding-3-small",
            "Keep this semantic memory.",
            "[1,0,0]",
            1,
          );
          const readSemanticData = () => ({
            metadata: db.prepare("SELECT * FROM memory_index_meta ORDER BY key").all(),
            chunks: db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(),
          });
          const before = readSemanticData();
          const authParams = {
            cfg: config,
            store: loadAuthProfileStoreForSecretsRuntime(state.agentDir()),
            profileId,
            agentDir: state.agentDir(),
          };
          // Even a valid stored ref is unavailable until the runtime publishes it.
          await expect(resolveApiKeyForProfile(authParams)).rejects.toMatchObject({
            code: "SECRET_SURFACE_UNAVAILABLE",
          });

          const embeddingAdapter = getRegisteredEmbeddingProvider("openai")?.adapter;
          assert(embeddingAdapter);
          await expect(
            embeddingAdapter.create({
              config,
              agentDir: state.agentDir(),
              model: "text-embedding-3-small",
            }),
          ).rejects.toMatchObject({ code: "SECRET_SURFACE_UNAVAILABLE" });

          const context: PluginDoctorStateMigrationContext = {
            openPluginStateKeyedStore: (options) =>
              createPluginStateKeyedStoreForTests("memory-core", { ...options, env: state.env }),
          };
          const params = {
            config,
            env: state.env,
            stateDir: state.stateDir,
            oauthDir: path.join(state.stateDir, "credentials"),
            context,
          };
          const { stateMigrations } = coercePluginDoctorContractModule(
            await loadBundledPluginPublicSurface<PluginDoctorContractModule>({
              pluginId: "memory-core",
              artifactBasename: "doctor-contract-api.js",
            }),
          );
          expect(stateMigrations.length).toBeGreaterThan(0);
          const warnings: string[] = [];
          for (const migration of stateMigrations) {
            if (await migration.detectLegacyState(params)) {
              warnings.push(...(await migration.migrateLegacyState(params)).warnings);
            }
          }
          expect(readSemanticData()).toEqual(before);
          // Startup refuses migration warnings before it can activate auth profiles.
          expect(warnings).toEqual([]);

          const snapshot = await prepareSecretsRuntimeSnapshot({
            config,
            env: state.env,
            agentDirs: [state.agentDir()],
            allowUnavailableSecretOwners: true,
          });
          activateSecretsRuntimeSnapshot(snapshot);
          if (entryState === "stored") {
            await expect(resolveApiKeyForProfile(authParams)).resolves.toMatchObject({
              provider: "openai",
              apiKey: value,
            });
            expect(snapshot.degradedOwners).toEqual([]);
          } else {
            await expect(resolveApiKeyForProfile(authParams)).rejects.toMatchObject({
              code: "SECRET_SURFACE_UNAVAILABLE",
              ownerKind: "account",
            });
            expect(snapshot.degradedOwners).toEqual([
              expect.objectContaining({ ownerKind: "account", state: "unavailable" }),
            ]);
          }
          expect(readSemanticData()).toEqual(before);
        } finally {
          db.close();
          clearSecretsRuntimeSnapshot();
        }
      });
    },
  );
});
