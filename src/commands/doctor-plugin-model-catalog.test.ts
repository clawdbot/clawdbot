// Doctor preserves provider credentials while migrating released catalog sidecars to SQLite.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeMigrateLegacyPluginModelCatalogs } from "./doctor-plugin-model-catalog.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function listPersistedPluginModelCatalogs(agentDir: string) {
  return loadPersistedPluginModelCatalogs(agentDir).catalogs;
}

const tempDirs: string[] = [];

function createAgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-model-catalog-"));
  tempDirs.push(agentDir);
  return agentDir;
}

function generatedCatalog(provider: string, apiKey = "persisted-test-key"): string {
  return `${JSON.stringify(
    {
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: `https://${provider}.example/v1`,
          apiKey,
          models: [{ id: `${provider}-model`, name: `${provider} model` }],
        },
      },
    },
    null,
    2,
  )}\n`;
}

function writeLegacyCatalog(agentDir: string, pluginId: string, contents: string): string {
  const sourcePath = path.join(agentDir, encodePluginModelCatalogRelativePath(pluginId));
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, contents, "utf8");
  return sourcePath;
}

function prompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirmAutoFix: vi.fn(async () => shouldRepair),
    shouldRepair,
  } as unknown as DoctorPrompter;
}

function migrationParams(agentDirs: string[], shouldRepair = true) {
  return {
    cfg: {} as OpenClawConfig,
    agentDirs,
    prompter: prompter(shouldRepair),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
    note: vi.fn(),
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const agentDir of tempDirs.splice(0)) {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

describe("doctor generated plugin model catalog migration", () => {
  it("does not create agent SQLite for a legacy-free profile", async () => {
    const agentDir = createAgentDir();

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
    ).resolves.toEqual({ detected: 0, migrated: 0, warnings: [] });
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("verifies a shipped sidecar and preserves its provider credential in SQLite", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai", "persisted-zai-test-key");
    const sourcePath = writeLegacyCatalog(agentDir, "zai", contents);

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
    ).resolves.toEqual({ detected: 1, migrated: 1, warnings: [] });

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("discovers and repairs a retained migration claim after an interrupted upgrade", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai", "interrupted-zai-provider-test-key");
    const pluginDir = path.join(agentDir, "plugins", "zai");
    const claimPath = path.join(pluginDir, "catalog.json.doctor-importing-previous-process");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(claimPath, contents, "utf8");

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
    ).resolves.toEqual({ detected: 1, migrated: 1, warnings: [] });
    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([{ pluginId: "zai", contents }]);
    expect(fs.existsSync(claimPath)).toBe(false);
  });

  it("reports and preserves conflicting retained migration claims", async () => {
    const agentDir = createAgentDir();
    const pluginDir = path.join(agentDir, "plugins", "zai");
    const firstPath = path.join(pluginDir, "catalog.json.doctor-importing-first");
    const secondPath = path.join(pluginDir, "catalog.json.doctor-importing-second");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(firstPath, generatedCatalog("zai", "first-provider-test-key"), "utf8");
    fs.writeFileSync(secondPath, generatedCatalog("zai", "second-provider-test-key"), "utf8");
    const params = migrationParams([agentDir]);

    await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
      detected: 0,
      migrated: 0,
      warnings: [expect.stringContaining("Conflicting retained legacy provider catalogs")],
    });
    expect(params.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Conflicting retained legacy provider catalogs"),
    );
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.existsSync(secondPath)).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("does not migrate a provider while one of its retained claims is unreadable", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const pluginDir = path.join(agentDir, "plugins", "zai");
    const claimPath = path.join(pluginDir, "catalog.json.doctor-importing-previous-process");
    const sourcePath = path.join(pluginDir, "catalog.json");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(claimPath, generatedCatalog("zai", "retained-provider-test-key"), "utf8");
    fs.writeFileSync(sourcePath, generatedCatalog("zai", "canonical-provider-test-key"), "utf8");
    fs.chmodSync(claimPath, 0o000);

    try {
      await expect(
        maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
      ).resolves.toEqual({
        detected: 0,
        migrated: 0,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(fs.existsSync(claimPath)).toBe(true);
      expect(fs.existsSync(sourcePath)).toBe(true);
      expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
    } finally {
      fs.chmodSync(claimPath, 0o600);
    }
  });

  it("migrates every configured agent without mixing provider ownership", async () => {
    const mainDir = createAgentDir();
    const workerDir = createAgentDir();
    const mainContents = generatedCatalog("openai", "main-provider-test-key");
    const workerContents = generatedCatalog("anthropic", "worker-provider-test-key");
    const mainPath = writeLegacyCatalog(mainDir, "openai", mainContents);
    const workerPath = writeLegacyCatalog(workerDir, "anthropic", workerContents);

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([workerDir, mainDir])),
    ).resolves.toEqual({ detected: 2, migrated: 2, warnings: [] });

    expect(listPersistedPluginModelCatalogs(mainDir)).toEqual([
      { pluginId: "openai", contents: mainContents },
    ]);
    expect(listPersistedPluginModelCatalogs(workerDir)).toEqual([
      { pluginId: "anthropic", contents: workerContents },
    ]);
    expect(fs.existsSync(mainPath)).toBe(false);
    expect(fs.existsSync(workerPath)).toBe(false);
  });

  it("discovers every explicit-roster agent without requiring a legacy default", async () => {
    const mainDir = createAgentDir();
    const helperDir = createAgentDir();
    const thirdDir = createAgentDir();
    const mainContents = generatedCatalog("openai", "main-explicit-provider-test-key");
    const helperContents = generatedCatalog("anthropic", "helper-explicit-provider-test-key");
    writeLegacyCatalog(mainDir, "openai", mainContents);
    writeLegacyCatalog(helperDir, "anthropic", helperContents);
    const params = {
      ...migrationParams([], true),
      agentDirs: undefined,
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: {
            main: { agentDir: mainDir },
            helper: { agentDir: helperDir },
            third: { agentDir: thirdDir },
          },
        },
      } satisfies OpenClawConfig,
    };

    await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
      detected: 2,
      migrated: 2,
      warnings: [],
    });
    expect(listPersistedPluginModelCatalogs(mainDir)).toEqual([
      { pluginId: "openai", contents: mainContents },
    ]);
    expect(listPersistedPluginModelCatalogs(helperDir)).toEqual([
      { pluginId: "anthropic", contents: helperContents },
    ]);
  });

  it("preserves legacy credentials and does not create SQLite when repair is declined", async () => {
    const agentDir = createAgentDir();
    const contents = generatedCatalog("zai");
    const sourcePath = writeLegacyCatalog(agentDir, "zai", contents);
    const params = migrationParams([agentDir], false);

    await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
      detected: 1,
      migrated: 0,
      warnings: [],
    });

    expect(params.prompter.confirmAutoFix).toHaveBeenCalledOnce();
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(contents);
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("ignores user-authored and malformed catalog lookalikes", async () => {
    const agentDir = createAgentDir();
    const authoredPath = writeLegacyCatalog(
      agentDir,
      "authored",
      JSON.stringify({ providers: { authored: { apiKey: "do-not-touch" } } }),
    );
    const malformedPath = writeLegacyCatalog(agentDir, "malformed", "{not-json");

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
    ).resolves.toEqual({ detected: 0, migrated: 0, warnings: [] });

    expect(fs.existsSync(authoredPath)).toBe(true);
    expect(fs.existsSync(malformedPath)).toBe(true);
    expect(fs.existsSync(path.join(agentDir, "openclaw-agent.sqlite"))).toBe(false);
  });

  it("migrates readable providers when another legacy catalog is unreadable", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const agentDir = createAgentDir();
    const unreadablePath = writeLegacyCatalog(agentDir, "zai", generatedCatalog("zai"));
    const readableContents = generatedCatalog("anthropic", "readable-provider-test-key");
    const readablePath = writeLegacyCatalog(agentDir, "anthropic", readableContents);
    fs.chmodSync(unreadablePath, 0o000);

    try {
      const params = migrationParams([agentDir]);
      await expect(maybeMigrateLegacyPluginModelCatalogs(params)).resolves.toEqual({
        detected: 1,
        migrated: 1,
        warnings: [expect.stringContaining("Could not read legacy provider catalog")],
      });
      expect(params.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("Could not read legacy provider catalog"),
      );
      expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
        { pluginId: "anthropic", contents: readableContents },
      ]);
      expect(fs.existsSync(unreadablePath)).toBe(true);
      expect(fs.existsSync(readablePath)).toBe(false);
    } finally {
      fs.chmodSync(unreadablePath, 0o600);
    }
  });

  it("preserves the released provider credential over a conflicting regenerated catalog", async () => {
    const agentDir = createAgentDir();
    const regenerated = generatedCatalog("zai", "regenerated-sqlite-test-key");
    const released = generatedCatalog("zai", "released-sidecar-test-key");
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("zai")]: regenerated,
      },
    });
    const sourcePath = writeLegacyCatalog(agentDir, "zai", released);

    await expect(
      maybeMigrateLegacyPluginModelCatalogs(migrationParams([agentDir])),
    ).resolves.toEqual({ detected: 1, migrated: 1, warnings: [] });

    expect(listPersistedPluginModelCatalogs(agentDir)).toEqual([
      { pluginId: "zai", contents: released },
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });
});
