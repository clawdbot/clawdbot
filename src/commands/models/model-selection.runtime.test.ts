import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelExtraParamSources } from "../../agents/model-extra-params.js";
import {
  readConfigFileSnapshot,
  resetConfigRuntimeState,
  type OpenClawConfig,
} from "../../config/config.js";
import { DEFAULT_MODEL_ALIASES } from "../../config/defaults.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import {
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resolvePluginProviderRegistryCore } from "../../plugins/providers.runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { modelsAliasesAddCommand } from "./aliases.js";
import { addFallbackCommand, removeFallbackCommand } from "./fallbacks-shared.js";
import { modelsSetImageCommand } from "./set-image.js";
import { modelsSetCommand } from "./set.js";

describe("model command provider preparation", () => {
  let root: string;
  let configPath: string;
  let config: OpenClawConfig;
  let runtime: RuntimeEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-command-"));
    configPath = path.join(root, "openclaw.json");
    const pluginDir = path.join(root, "provider");
    fs.mkdirSync(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "alias-fixture",
        providers: ["fixture", "custom"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = {
        id: "alias-fixture",
        register(api) {
          api.registerProvider({
            id: "fixture", label: "Fixture", hookAliases: ["custom"], auth: [],
            normalizeModelId: ({ modelId }) => modelId === "legacy" ? "current" : undefined,
          });
        },
      };`,
    );
    config = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "probe" } },
        entries: { probe: {} },
      },
      plugins: { allow: ["alias-fixture"], load: { paths: [pluginDir] } },
    };
    runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  });

  afterEach(async () => {
    resetConfigRuntimeState();
    resetPluginLoaderTestStateForTest();
    clearPluginMetadataLifecycleCaches();
    await cleanupSessionStateForTest({ stateDir: root });
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function isolated(run: () => Promise<void>) {
    fs.writeFileSync(configPath, JSON.stringify(config));
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      },
      run,
    );
  }

  function readConfig(): OpenClawConfig {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  it.each([
    { raw: "fixture/legacy", expected: "fixture/current" },
    { raw: "fixture/LEGACY", expected: "fixture/LEGACY" },
    { raw: "friendly", expected: "fixture/current" },
  ])("saves $raw using its cold provider's exact alias rules", async ({ raw, expected }) => {
    config.agents!.defaults!.models = { "fixture/legacy": { alias: "friendly" } };
    await isolated(() => modelsSetCommand(raw, runtime));
    expect(readConfig().agents?.defaults?.model).toEqual({ primary: expected });
    expect(runtime.log).toHaveBeenCalledWith(`Default model: ${expected}`);
  });

  it.each([
    { provider: "fixture", api: "openai-completions" },
    { provider: "custom", api: "openai-completions" },
  ] as const)("keeps the $provider/$api owner's model literal", async ({ provider, api }) => {
    config.models = {
      providers: {
        [provider]: {
          api,
          baseUrl: "https://custom.example.invalid/v1",
          models: [
            {
              id: "legacy",
              name: "Literal model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1024,
            },
          ],
        },
      },
    };
    config.agents!.defaults!.models = {
      [`${provider}/legacy`]: { alias: "friendly", params: { temperature: 0.2 } },
    };
    await isolated(async () => {
      await modelsSetCommand(`${provider}/legacy`, runtime);
      await modelsAliasesAddCommand("Friendly", `${provider}/legacy`, runtime);
      await modelsAliasesAddCommand("Friendly", `${provider}/legacy`, runtime);
      await expect(
        modelsAliasesAddCommand("friendly", `${provider}/current`, runtime),
      ).rejects.toThrow(`Alias friendly already points to ${provider}/legacy.`);
    });
    expect(readConfig().agents?.defaults?.model).toEqual({ primary: `${provider}/legacy` });
    expect(readConfig().agents?.defaults?.models).toEqual({
      [`${provider}/legacy`]: { alias: "Friendly", params: { temperature: 0.2 } },
    });
  });

  it.each(
    [false, true].flatMap((hasCanonicalEntry) =>
      [false, true].flatMap((included) =>
        ["same", "different", "missing"].map((priorAlias) => ({
          hasCanonicalEntry,
          included,
          priorAlias,
        })),
      ),
    ),
  )(
    "preserves alias source settings across canonical moves (existing: $hasCanonicalEntry, include: $included, alias: $priorAlias)",
    async ({ hasCanonicalEntry, included, priorAlias }) => {
      config.agents!.defaults!.models = {
        "fixture/legacy": {
          ...(priorAlias === "missing"
            ? {}
            : { alias: priorAlias === "same" ? "${MODEL_ALIAS}" : "old" }),
          params: {
            temperature: 0.2,
            maxTokens: 128,
            cacheRetention: "${ALIAS_CACHE_RETENTION}",
            credential: { source: "env", provider: "default", id: "MODEL_SECRET" },
          },
          streaming: false,
        },
        ...(hasCanonicalEntry
          ? { "fixture/current": { params: { temperature: 0.7 }, codeMode: false } }
          : {}),
        "unrelated/legacy": {
          alias: "other",
          params: { temperature: 0.9, cacheRetention: "long" },
        },
      };
      await withEnvAsync({ MODEL_ALIAS: "friendly", ALIAS_CACHE_RETENTION: "long" }, () =>
        isolated(async () => {
          const agentsPath = path.join(root, "agents.json");
          if (included) {
            fs.writeFileSync(agentsPath, JSON.stringify(config.agents));
            fs.writeFileSync(
              configPath,
              JSON.stringify({ ...config, agents: { $include: "agents.json" } }),
            );
          }
          const readAgents = (): OpenClawConfig["agents"] =>
            included ? JSON.parse(fs.readFileSync(agentsPath, "utf8")) : readConfig().agents;
          await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
          const expectedModels = {
            "fixture/current": {
              alias: "friendly",
              params: {
                temperature: hasCanonicalEntry ? 0.7 : 0.2,
                maxTokens: 128,
                cacheRetention: "${ALIAS_CACHE_RETENTION}",
                credential: { source: "env", provider: "default", id: "MODEL_SECRET" },
              },
              streaming: false,
              ...(hasCanonicalEntry ? { codeMode: false } : {}),
            },
            "unrelated/legacy": {
              alias: "other",
              params: { temperature: 0.9, cacheRetention: "long" },
            },
          };
          expect(readAgents()?.defaults?.models).toEqual(expectedModels);
          await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
          expect(readAgents()?.defaults?.models).toEqual(expectedModels);
          await expect(
            modelsAliasesAddCommand("FRIENDLY", "fixture/different", runtime),
          ).rejects.toThrow("Alias FRIENDLY already points to fixture/current.");
          expect(readAgents()?.defaults?.models).toEqual(expectedModels);
          await addFallbackCommand({ label: "Fallbacks", key: "model" }, "friendly", runtime);
          expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
            fallbacks: ["fixture/current"],
          });
          await removeFallbackCommand(
            { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
            "fixture/legacy",
            runtime,
          );
          expect((await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model).toEqual({
            fallbacks: [],
          });
          if (included) {
            expect(readConfig().agents).toMatchObject({ $include: "agents.json" });
          }
        }),
      );
    },
  );

  it.each(
    ["set", "set-image", "fallback", "image-fallback"].flatMap((command) => [
      {
        command,
        provider: "openrouter",
        sourceKey: "openrouter/openrouter/hunter-alpha",
        input: "openrouter/hunter-alpha",
        modelId: "hunter-alpha",
      },
      {
        command,
        provider: "fixture",
        sourceKey: "fixture/legacy",
        input: "fixture/legacy",
        modelId: "current",
      },
    ]),
  )(
    "preserves source and request settings when $command canonicalizes $sourceKey",
    async ({ command, provider, sourceKey, input, modelId }) => {
      if (provider === "openrouter") {
        const pluginDir = path.join(root, "provider");
        fs.writeFileSync(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: "alias-fixture",
            providers: [provider],
            configSchema: { type: "object", additionalProperties: false, properties: {} },
          }),
        );
        const pluginFile = path.join(pluginDir, "index.cjs");
        fs.writeFileSync(
          pluginFile,
          fs
            .readFileSync(pluginFile, "utf8")
            .replace('id: "fixture", label:', 'id: "openrouter", label:'),
        );
      }
      const entry = {
        params: {
          cacheRetention: "${ALIAS_CACHE_RETENTION}",
          credential: { source: "env", provider: "default", id: "MODEL_SECRET" },
        },
        streaming: false,
      };
      config.agents!.defaults!.models = { [sourceKey]: entry };
      await withEnvAsync({ ALIAS_CACHE_RETENTION: "long" }, () =>
        isolated(async () => {
          const key = command.includes("image") ? "imageModel" : "model";
          if (command === "set") {
            await modelsSetCommand(input, runtime);
          } else if (command === "set-image") {
            await modelsSetImageCommand(input, runtime);
          } else {
            await addFallbackCommand({ label: "Fallbacks", key }, input, runtime);
          }
          const canonicalKey = `${provider}/${modelId}`;
          expect(readConfig().agents?.defaults?.models).toEqual({
            [canonicalKey]: entry,
          });
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.sourceConfig.agents?.defaults?.[key]).toEqual(
            command.startsWith("set") ? { primary: canonicalKey } : { fallbacks: [canonicalKey] },
          );
          expect(
            resolveModelExtraParamSources({ config: snapshot.runtimeConfig, provider, modelId })
              .modelParams,
          ).toEqual({ ...entry.params, cacheRetention: "long" });
        }),
      );
    },
  );

  it.each([false, true])(
    "preserves nested include ownership with sibling overrides=%s",
    async (siblingOverrides) => {
      const models = {
        "fixture/legacy": {
          alias: "friendly",
          params: { cacheRetention: "${ALIAS_CACHE_RETENTION}" },
        },
      };
      config.agents!.defaults!.models = models;
      await withEnvAsync({ ALIAS_CACHE_RETENTION: "long" }, () =>
        isolated(async () => {
          const modelsPath = path.join(root, "models.json");
          const modelsRaw = JSON.stringify(models);
          const rootRaw = JSON.stringify({
            ...config,
            agents: {
              ...config.agents,
              defaults: {
                ...config.agents?.defaults,
                models: {
                  $include: "models.json",
                  ...(siblingOverrides ? { "fixture/other": { alias: "other" } } : {}),
                },
              },
            },
          });
          fs.writeFileSync(modelsPath, modelsRaw);
          fs.writeFileSync(configPath, rootRaw);
          if (siblingOverrides) {
            await expect(
              modelsAliasesAddCommand("friendly", "fixture/legacy", runtime),
            ).rejects.toThrow("$include");
            expect(fs.readFileSync(modelsPath, "utf8")).toBe(modelsRaw);
          } else {
            await modelsAliasesAddCommand("friendly", "fixture/legacy", runtime);
            expect(JSON.parse(fs.readFileSync(modelsPath, "utf8"))).toEqual({
              "fixture/current": models["fixture/legacy"],
            });
          }
          expect(fs.readFileSync(configPath, "utf8")).toBe(rootRaw);
        }),
      );
    },
  );

  it("excludes unrelated hooks when reusing an already-loaded registry", async () => {
    const foreignDir = path.join(root, "aaa-foreign");
    fs.mkdirSync(foreignDir);
    fs.writeFileSync(
      path.join(foreignDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "aaa-foreign",
        providers: ["foreign"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(foreignDir, "index.cjs"),
      `module.exports = { id: "aaa-foreign", register(api) {
        api.registerProvider({ id: "foreign", label: "Foreign", auth: [],
          hookAliases: ["fixture"], normalizeModelId: () => "wrong-owner" });
      }};`,
    );
    config.plugins!.allow!.unshift("aaa-foreign");
    config.plugins!.load!.paths!.unshift(foreignDir);
    config.agents!.entries!.probe = { workspace: root };
    await isolated(async () => {
      const registry = loadOpenClawPlugins({ config, workspaceDir: root, env: process.env });
      expect(registry.providers.map((entry) => entry.pluginId)).toEqual([
        "aaa-foreign",
        "alias-fixture",
      ]);
      await modelsSetCommand("fixture/legacy", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: "fixture/current" });
    });
  });

  it.each(["exact", "retained", "empty"] as const)(
    "prepares runtime-only aliases with %s ownership while preserving source refs",
    async (scope) => {
      const marker = path.join(root, "registrations");
      const pluginFile = path.join(root, "provider", "index.cjs");
      fs.writeFileSync(
        pluginFile,
        fs
          .readFileSync(pluginFile, "utf8")
          .replace(
            "register(api) {",
            `register(api) {
              const fs = require("node:fs");
              const model = fs.existsSync(${JSON.stringify(marker)}) ? "current" : "stale";
              fs.appendFileSync(${JSON.stringify(marker)}, "registered\\n");`,
          )
          .replace('hookAliases: ["custom"]', 'hookAliases: ["compat"]')
          .replace('? "current" : undefined', "? model : undefined"),
      );
      const entry = { params: { cacheRetention: "${ALIAS_CACHE_RETENTION}" }, streaming: false };
      config.agents!.defaults!.models = { "compat/legacy": entry };
      config.agents!.entries!.probe = { workspace: root };
      await withEnvAsync({ ALIAS_CACHE_RETENTION: "long" }, () =>
        isolated(async () => {
          const metadataSnapshot = loadManifestMetadataSnapshot({
            config,
            env: process.env,
            workspaceDir: root,
          });
          const registry = loadOpenClawPlugins({ config, env: process.env, workspaceDir: root });
          expect(
            resolvePluginProviderRegistryCore({
              config,
              workspaceDir: root,
              providerRefs: ["compat"],
            })?.registry,
          ).toBe(registry);
          expect(fs.readFileSync(marker, "utf8")).toBe("registered\n");
          const run = () => modelsAliasesAddCommand("friendly", "compat/legacy", runtime);
          if (scope === "exact") {
            await run();
          } else {
            await withPluginRuntimeGenerationScope(
              { metadataSnapshot, ...(scope === "retained" ? { pluginRegistry: registry } : {}) },
              run,
            );
          }
          const model = scope === "exact" ? "current" : scope === "retained" ? "stale" : "legacy";
          expect(readConfig().agents?.defaults?.models).toEqual({
            [`compat/${model}`]: { ...entry, alias: "friendly" },
          });
          expect(runtime.log).toHaveBeenCalledWith(`Alias friendly -> compat/${model}`);
          expect(fs.readFileSync(marker, "utf8")).toBe(
            "registered\n".repeat(scope === "exact" ? 2 : 1),
          );
        }),
      );
    },
  );

  it("does not activate an unused provider for a runtime-only alias", async () => {
    const canonical = DEFAULT_MODEL_ALIASES.sonnet;
    if (!canonical) {
      throw new Error("Expected the built-in sonnet alias");
    }
    config.agents!.defaults!.models = { [canonical]: {} };
    const providerDir = path.join(root, "provider");
    fs.writeFileSync(
      path.join(providerDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "alias-fixture",
        providers: ["anthropic"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    const providerFile = path.join(providerDir, "index.cjs");
    fs.writeFileSync(
      providerFile,
      fs
        .readFileSync(providerFile, "utf8")
        .replace('id: "fixture", label:', 'id: "anthropic", label:'),
    );
    const unusedDir = path.join(root, "unused");
    const marker = path.join(root, "unused-imported");
    fs.mkdirSync(unusedDir);
    fs.writeFileSync(
      path.join(unusedDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "unused-provider",
        providers: ["openai"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fs.writeFileSync(
      path.join(unusedDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");
      module.exports = { id: "unused-provider", register(api) {
        api.registerProvider({ id: "openai", label: "Unused", auth: [] });
      }};`,
    );
    config.plugins!.allow!.push("unused-provider");
    config.plugins!.load!.paths!.push(unusedDir);

    await isolated(async () => {
      await modelsSetCommand("sonnet", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical });
      await addFallbackCommand({ label: "Fallbacks", key: "model" }, "sonnet", runtime);
      expect(readConfig().agents?.defaults?.model).toEqual({
        primary: canonical,
        fallbacks: [canonical],
      });
      await removeFallbackCommand(
        { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
        "sonnet",
        runtime,
      );
      expect(readConfig().agents?.defaults?.model).toEqual({ primary: canonical, fallbacks: [] });
      await modelsAliasesAddCommand("friendly", "sonnet", runtime);
      await modelsAliasesAddCommand("friendly", canonical, runtime);
      expect(readConfig().agents?.defaults?.models?.[canonical]?.alias).toBe("friendly");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(["model", "imageModel"] as const)(
    "repairs %s entry settings while preserving an existing fallback placeholder",
    async (key) => {
      config.agents!.defaults![key] = { fallbacks: ["${FALLBACK_REF}"] };
      const entry = { params: { temperature: 0.2 }, streaming: false };
      config.agents!.defaults!.models = { "fixture/legacy": entry };
      await withEnvAsync({ FALLBACK_REF: "fixture/legacy" }, () =>
        isolated(async () => {
          await addFallbackCommand({ label: "Fallbacks", key }, "fixture/current", runtime);
          expect(readConfig().agents?.defaults?.[key]).toEqual({ fallbacks: ["${FALLBACK_REF}"] });
          expect(readConfig().agents?.defaults?.models).toEqual({ "fixture/current": entry });
          await removeFallbackCommand(
            { label: "Fallbacks", key, notFoundLabel: "Fallback" },
            "fixture/current",
            runtime,
          );
          expect(readConfig().agents?.defaults?.[key]).toEqual({ fallbacks: [] });
        }),
      );
    },
  );

  it("rejects config replacement during provider preparation", async () => {
    const pluginFile = path.join(root, "provider", "index.cjs");
    fs.writeFileSync(
      pluginFile,
      fs.readFileSync(pluginFile, "utf8").replace(
        "register(api) {",
        `register(api) {
          const fs = require("node:fs");
          const file = ${JSON.stringify(configPath)};
          const newer = JSON.parse(fs.readFileSync(file, "utf8"));
          newer.update = { channel: "beta" };
          fs.writeFileSync(file, JSON.stringify(newer));`,
      ),
    );
    await isolated(async () => {
      await expect(modelsSetCommand("fixture/legacy", runtime)).rejects.toBeInstanceOf(
        ConfigMutationConflictError,
      );
    });
    expect(readConfig().update?.channel).toBe("beta");
    expect(readConfig().agents?.defaults?.model).toBeUndefined();
  });

  it("rejects an invalid fallback target before activating existing providers", async () => {
    config.agents!.defaults!.model = { fallbacks: ["fixture/legacy"] };
    const marker = path.join(root, "provider-imported");
    const pluginFile = path.join(root, "provider", "index.cjs");
    fs.writeFileSync(
      pluginFile,
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");\n` +
        fs.readFileSync(pluginFile, "utf8"),
    );
    await isolated(async () => {
      await expect(
        removeFallbackCommand(
          { label: "Fallbacks", key: "model", notFoundLabel: "Fallback" },
          "/invalid",
          runtime,
        ),
      ).rejects.toThrow("Invalid model reference: /invalid");
    });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
