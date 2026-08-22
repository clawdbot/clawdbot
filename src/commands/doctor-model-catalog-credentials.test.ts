// Doctor migrates model credentials before removing plaintext from generated catalogs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeMigrateModelCatalogCredentials } from "./doctor-model-catalog-credentials.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const tempDirs: string[] = [];

function createState(): { agentDir: string; env: NodeJS.ProcessEnv; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-catalog-credentials-"));
  tempDirs.push(stateDir);
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    agentDir,
    stateDir,
    env: { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
  };
}

function provider(apiKey: string) {
  return {
    api: "openai-completions" as const,
    apiKey,
    baseUrl: "https://models.example/v1",
    models: [
      {
        id: "example-model",
        name: "Example model",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  };
}

function migrationParams(state: ReturnType<typeof createState>, cfg: OpenClawConfig) {
  return {
    cfg,
    env: state.env,
    prompter: { shouldRepair: true } as DoctorPrompter,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor model catalog credential migration", () => {
  it("copies config, root, and plugin catalog keys before runtime retires plaintext", async () => {
    const state = createState();
    const { agentDir } = state;
    const cfg: OpenClawConfig = {
      models: { providers: { configured: provider("configured-secret") } },
    };
    const rootContents = `{
      // Root catalogs use the same comment-tolerant syntax as ModelRegistry.
      "providers": { "root": ${JSON.stringify(provider("root-secret"))}, },
    }\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootContents);
    const pluginContents = `${JSON.stringify(
      {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: { plugin: provider("plugin-secret") },
      },
      null,
      2,
    )}\n`;
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("plugin-owner")]: pluginContents,
      },
    });

    const first = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));

    expect(first.detected).toBe(3);
    expect(first.migrated).toBe(3);
    expect(first.warnings).toEqual([]);
    expect(cfg.models?.providers?.configured?.apiKey).toBe("configured-secret");
    // A fresh root records state-db shared ownership, so the migrated credentials persist in the
    // shared store rather than the agent file. Read through the owner for this state root instead of
    // pinning the storage layout.
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = state.stateDir;
    let migratedProfiles: Record<string, unknown>;
    try {
      migratedProfiles = loadPersistedAuthProfileStore(undefined)?.profiles ?? {};
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
    expect(migratedProfiles).toMatchObject({
      "configured:default": {
        type: "api_key",
        provider: "configured",
        key: "configured-secret",
      },
      "root:default": { type: "api_key", provider: "root", key: "root-secret" },
      "plugin:default": { type: "api_key", provider: "plugin", key: "plugin-secret" },
    });
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
    const pluginCatalog = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0];
    expect(pluginCatalog?.contents).toBe(pluginContents);

    const second = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));
    expect(second).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
  });

  it("never overwrites an occupied default profile while preserving the catalog key", async () => {
    const state = createState();
    const { agentDir } = state;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": {
            type: "api_key",
            provider: "custom",
            key: "existing-secret",
          },
        },
        order: { custom: ["custom:default"] },
      },
      agentDir,
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("catalog-secret") } }, null, 2)}\n`,
    );

    await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    const store = loadPersistedAuthProfileStore(agentDir);
    expect(store?.profiles["custom:default"]).toMatchObject({ key: "existing-secret" });
    expect(store?.profiles["custom:models-json"]).toMatchObject({ key: "catalog-secret" });
    expect(store?.order?.custom).toEqual(["custom:default"]);
  });

  it("refuses to overwrite an unreadable canonical auth store", async () => {
    const state = createState();
    const { agentDir } = state;
    const unreadable = { version: 1, profiles: "not-a-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadable, agentDir);
    const rootContents = `${JSON.stringify({ providers: { custom: provider("catalog-secret") } })}\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootContents);

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    expect(result.migrated).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadable);
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
  });

  it("recognizes profile references inherited from the shared main store", async () => {
    const state = createState();
    const childAgentDir = path.join(state.stateDir, "agents", "child", "agent");
    fs.mkdirSync(childAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "stored-secret" },
        },
      },
      state.agentDir,
    );
    fs.writeFileSync(
      path.join(childAgentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("custom:default") } })}\n`,
    );

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    expect(result).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
    expect(loadPersistedAuthProfileStore(childAgentDir)).toBeNull();
  });

  it("scans an explicit multi-agent roster without requiring a legacy default", async () => {
    const state = createState();
    const helperAgentDir = path.join(state.stateDir, "agents", "helper", "agent");
    const thirdAgentDir = path.join(state.stateDir, "agents", "third", "agent");
    fs.mkdirSync(helperAgentDir, { recursive: true });
    fs.mkdirSync(thirdAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(helperAgentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("helper-catalog-secret") } })}\n`,
    );
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { agentDir: state.agentDir },
          helper: { agentDir: helperAgentDir },
          third: { agentDir: thirdAgentDir },
        },
      },
    } satisfies OpenClawConfig;

    await expect(maybeMigrateModelCatalogCredentials(migrationParams(state, cfg))).resolves.toEqual(
      { detected: 1, migrated: 1, warnings: [] },
    );
    expect(loadPersistedAuthProfileStore(helperAgentDir)?.profiles["custom:default"]).toMatchObject(
      {
        key: "helper-catalog-secret",
      },
    );
  });

  it("allocates a global config profile that child stores cannot shadow", async () => {
    const state = createState();
    const childAgentDir = path.join(state.stateDir, "agents", "child", "agent");
    fs.mkdirSync(childAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "configured-secret" },
        },
      },
      state.agentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "child-secret" },
        },
      },
      childAgentDir,
    );

    const result = await maybeMigrateModelCatalogCredentials(
      migrationParams(state, {
        models: { providers: { custom: provider("configured-secret") } },
      }),
    );

    expect(result).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    expect(
      loadPersistedAuthProfileStore(state.agentDir)?.profiles["custom:models-json"],
    ).toMatchObject({ key: "configured-secret" });
    expect(loadPersistedAuthProfileStore(childAgentDir)?.profiles["custom:default"]).toMatchObject({
      key: "child-secret",
    });
  });
});
