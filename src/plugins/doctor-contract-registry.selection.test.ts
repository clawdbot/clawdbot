// Covers plugin doctor selection from config and touched paths.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();
const doctorContractWarnMock = vi.hoisted(() => vi.fn());
const retainedConfigDoctorMock = vi.hoisted(() => vi.fn());
vi.mock("./public-surface-loader.js", () => ({
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: retainedConfigDoctorMock,
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: doctorContractWarnMock,
    }),
  };
});

let applyPluginDoctorCompatibilityMigrations: typeof import("./doctor-contract-registry.js").applyPluginDoctorCompatibilityMigrations;
let clearPluginDoctorContractRegistryCache: typeof import("./doctor-contract-registry.test-fixtures.js").clearPluginDoctorContractRegistryCache;
let collectRelevantDoctorPluginIds: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIds;
let collectDoctorConfigRepairPluginIds: typeof import("./doctor-contract-registry.js").collectDoctorConfigRepairPluginIds;
let listPluginDoctorSessionStoreAgentIds: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionStoreAgentIds;
let setPluginDoctorContractRegistryModuleLoaderFactoryForTest:
  | typeof import("./doctor-contract-registry.test-fixtures.js").setPluginDoctorContractRegistryModuleLoaderFactoryForTest
  | undefined;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

afterEach(() => {
  setPluginDoctorContractRegistryModuleLoaderFactoryForTest?.(undefined);
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry module loader", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({
      applyPluginDoctorCompatibilityMigrations,
      collectRelevantDoctorPluginIds,
      collectDoctorConfigRepairPluginIds,
      listPluginDoctorSessionStoreAgentIds,
    } = await import("./doctor-contract-registry.js"));
    ({
      clearPluginDoctorContractRegistryCache,
      setPluginDoctorContractRegistryModuleLoaderFactoryForTest,
    } = await import("./doctor-contract-registry.test-fixtures.js"));
  });

  beforeEach(() => {
    resetRegistryJitiMocks();
    mocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
    doctorContractWarnMock.mockReset();
    retainedConfigDoctorMock.mockReset().mockReturnValue(null);
    // Loaded once in beforeAll; afterEach guards the same binding optionally because it
    // can fire when that import never completed. Fail loudly here instead of silently
    // running a case against the real module loader.
    if (!setPluginDoctorContractRegistryModuleLoaderFactoryForTest) {
      throw new Error("doctor contract registry test fixtures were not loaded");
    }
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(mocks.createJiti);
    clearPluginDoctorContractRegistryCache();
  });

  it.each([
    { name: "full scan", touchedPaths: undefined, configRepair: true, expected: true },
    { name: "parent edit", touchedPaths: [["legacyRoots"]], configRepair: true, expected: true },
    {
      name: "dotted owner edit",
      touchedPaths: [["legacyRoots", "store.with.dots", "root"]],
      configRepair: true,
      expected: true,
    },
    {
      name: "unrelated edit",
      touchedPaths: [["gateway", "port"]],
      configRepair: true,
      expected: false,
    },
    { name: "empty edit", touchedPaths: [], configRepair: true, expected: false },
    { name: "undeclared repair", touchedPaths: undefined, configRepair: false, expected: false },
  ])(
    "discovers declared config migration sources without plugin entries: $name",
    async ({ touchedPaths, configRepair, expected }) => {
      const pluginRoot = makeTempDir();
      fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
      const rule = {
        path: ["legacyRoots", "store.with.dots", "root"],
        message: "Migrate legacy root",
      };
      mocks.createJiti.mockImplementation(() => () => ({
        legacyConfigRules: [rule],
        resolveSessionStoreAgentIds: () => ["unexpected-owner"],
      }));
      mocks.loadPluginManifestRegistry.mockReturnValue({
        plugins: [
          {
            id: "root-owner",
            rootDir: pluginRoot,
            channels: [],
            providers: [],
            doctorContract: { configRepair, resolveSessionStoreAgentIds: true },
            configContracts: { compatibilityMigrationPaths: ["legacyRoots.*.root"] },
          },
        ],
        diagnostics: [],
      });
      const raw = { legacyRoots: { "store.with.dots": { root: "/legacy/documents" } } };
      const { findDoctorLegacyConfigIssues } =
        await import("../commands/doctor/shared/legacy-config-issues.js");
      expect(findDoctorLegacyConfigIssues(raw, raw, touchedPaths)).toEqual(
        expected ? [{ path: rule.path.join("."), message: rule.message }] : [],
      );
      expect(mocks.createJiti).toHaveBeenCalledTimes(expected ? 1 : 0);
      // Config migration declarations must not select new session-store owners.
      const pluginIds = collectRelevantDoctorPluginIds(raw);
      expect(pluginIds).toEqual([]);
      expect(listPluginDoctorSessionStoreAgentIds({ pluginIds })).toEqual([]);
    },
  );

  it("collects model provider ids for doctor compatibility migrations", () => {
    expect(
      collectRelevantDoctorPluginIds({
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ai.ollama.com",
            },
          },
        },
      }),
    ).toEqual(["ollama-cloud"]);
  });

  it("collects distinct provider ids from every canonical model selector and model policy", () => {
    const providerIds = collectRelevantDoctorPluginIds({
      agents: {
        defaults: {
          model: {
            primary: "default-primary/model",
            fallbacks: ["default-fallback/model", 42],
          },
          utilityModel: "default-utility/model",
          imageModel: "default-image/model",
          voiceModel: "default-voice/model",
          pdfModel: "default-pdf/model",
          mediaModels: {
            image: "media-image/model",
            video: "media-video/model",
            music: "media-music/model",
          },
          heartbeat: { model: "heartbeat/model" },
          subagents: {
            model: { primary: "subagent-primary/model", fallbacks: ["subagent-fallback/model"] },
          },
          compaction: {
            model: "compaction/model",
            memoryFlush: { model: "memory-flush/model" },
          },
          models: {
            "default-map/model": {},
            bare: {},
          },
          modelPolicy: { allow: ["default-policy/*", 42, "bare"] },
        },
        entries: {
          worker: {
            model: "entry-model/model",
            models: { "entry-map/model": {} },
            modelPolicy: { allow: ["entry-policy/model", null] },
            tools: { exec: { reviewer: { model: "entry-reviewer/model" } } },
            tts: { summaryModel: "entry-tts/model" },
          },
        },
        list: [
          {
            id: "shadow",
            model: "shadow-model/model",
            modelPolicy: { allow: ["shadow-policy/model"] },
          },
        ],
      },
      tools: { exec: { reviewer: { model: "global-reviewer/model" } } },
      hooks: {
        mappings: [{ model: "hook-mapping/model" }, { model: 42 }],
        gmail: { model: "hook-gmail/model" },
      },
      tts: { summaryModel: "tts-summary/model" },
      channels: {
        modelByChannel: { discord: { guild: "channel-override/model" } },
        discord: {
          voice: {
            model: "discord-voice/model",
            tts: { summaryModel: "discord-voice-tts/model" },
          },
          accounts: {
            work: {
              voice: {
                model: "discord-account-voice/model",
                tts: { summaryModel: "discord-account-tts/model" },
              },
            },
          },
        },
      },
    });

    expect(providerIds).toEqual(
      [
        "channel-override",
        "compaction",
        "default-fallback",
        "default-image",
        "default-map",
        "default-pdf",
        "default-policy",
        "default-primary",
        "default-utility",
        "default-voice",
        "discord",
        "discord-account-tts",
        "discord-account-voice",
        "discord-voice",
        "discord-voice-tts",
        "entry-map",
        "entry-model",
        "entry-policy",
        "entry-reviewer",
        "entry-tts",
        "global-reviewer",
        "heartbeat",
        "hook-gmail",
        "hook-mapping",
        "media-image",
        "media-music",
        "media-video",
        "memory-flush",
        "subagent-fallback",
        "subagent-primary",
        "tts-summary",
      ].toSorted(),
    );
    expect(providerIds).not.toContain("shadow-model");
    expect(providerIds).not.toContain("shadow-policy");
  });

  it("collects model and policy providers from the legacy list when entries is absent", () => {
    expect(
      collectRelevantDoctorPluginIds({
        agents: {
          list: [
            {
              id: "legacy",
              model: "legacy-model/model",
              modelPolicy: { allow: ["legacy-policy/*"] },
            },
          ],
        },
      }),
    ).toEqual(["legacy-model", "legacy-policy"]);
  });

  it("does not collect shadow-list policy providers when entries is null", () => {
    expect(
      collectRelevantDoctorPluginIds({
        agents: {
          entries: null,
          list: [{ id: "shadow", modelPolicy: { allow: ["shadow-policy/*"] } }],
        },
      }),
    ).toEqual([]);
  });

  it("excludes channel metadata and blank ids from full and touched doctor scans", () => {
    const raw = {
      channels: {
        defaults: {},
        modelByChannel: { discord: { guild: "openai/gpt-5.6-luna" } },
        " ": {},
        discord: {},
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["discord", "openai"]);
    expect(
      collectDoctorConfigRepairPluginIds(raw, [["channels", "modelByChannel", "discord", "guild"]]),
    ).toStrictEqual(["openai"]);
    expect(collectDoctorConfigRepairPluginIds(raw, [["channels"]])).toEqual(["discord", "openai"]);
  });

  it("collects provider ids from media model entries", () => {
    const raw = {
      tools: {
        media: {
          models: [
            { provider: " xAI " },
            { provider: " " },
            { provider: "XAI", model: "grok-stt", capabilities: ["audio"] },
            { provider: "openai", model: "gpt-5.5", capabilities: ["image"] },
            { provider: "gemini", model: "veo", capabilities: ["video"] },
          ],
        },
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["gemini", "openai", "xai"]);
    expect(
      collectDoctorConfigRepairPluginIds(raw, [["tools", "media", "models", "2", "model"]]),
    ).toEqual(["gemini", "openai", "xai"]);
  });

  it("loads a plugin doctor contract when scoped by a contributed provider alias", () => {
    const pluginRoot = makeTempDir();
    const unrelatedRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    fs.writeFileSync(path.join(unrelatedRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => (modulePath: string) => ({
      normalizeCompatibilityConfig: ({
        cfg,
      }: {
        cfg: { models?: { providers?: Record<string, Record<string, unknown>> } };
      }) => ({
        config: {
          ...cfg,
          models: {
            ...cfg.models,
            providers: {
              ...cfg.models?.providers,
              "ollama-cloud": {
                ...cfg.models?.providers?.["ollama-cloud"],
                baseUrl: "https://ollama.com",
              },
            },
          },
        },
        changes: [
          modulePath.startsWith(unrelatedRoot)
            ? "wrong unrelated provider contract"
            : "normalized ollama cloud provider endpoint",
        ],
      }),
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "ollama",
          rootDir: pluginRoot,
          channels: [],
          providers: ["OlLaMa"],
          providerAuthAliases: { "Ollama-Cloud": "OLLAMA" },
        },
        {
          id: "unrelated",
          rootDir: unrelatedRoot,
          channels: [],
          providers: ["unrelated"],
          providerAuthAliases: { "ollama-cloud": "missing" },
        },
      ],
      diagnostics: [],
    });
    const config = {
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ai.ollama.com",
            models: [],
          },
        },
      },
    };

    const result = applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: {},
      pluginIds: ["ollama-cloud"],
    });

    expect(result.changes).toEqual(["normalized ollama cloud provider endpoint"]);
    expect(result.config.models?.providers?.["ollama-cloud"]).toEqual({
      baseUrl: "https://ollama.com",
      models: [],
    });
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("loads a provider doctor contract when a media preference is its only activation", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => ({
        config: { ...cfg, repaired: true },
        changes: ["repaired configured provider model"],
      }),
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "opencode",
          rootDir: pluginRoot,
          channels: [],
          providers: ["opencode"],
          doctorContract: { configRepair: true },
        },
      ],
      diagnostics: [],
    });
    const config = {
      tools: { media: { image: { preferredModel: "opencode/gpt-5-nano" } } },
    };
    const pluginIds = collectRelevantDoctorPluginIds(config);

    expect(pluginIds).toEqual(["opencode"]);
    expect(
      applyPluginDoctorCompatibilityMigrations(config, { config, env: {}, pluginIds }),
    ).toEqual({
      config: { ...config, repaired: true },
      changes: ["repaired configured provider model"],
    });
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("narrows touched-path doctor ids for scoped dry-run validation", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
          models: {
            providers: {
              "ollama-cloud": {},
            },
          },
          talk: {
            voiceId: "legacy-voice",
          },
        },
        [
          ["channels", "discord", "token"],
          ["plugins", "entries", "memory-wiki", "enabled"],
          ["models", "providers", "ollama-cloud", "baseUrl"],
          ["talk", "voiceId"],
        ],
      ),
    ).toEqual(["discord", "elevenlabs", "memory-wiki", "ollama-cloud"]);
  });

  it("keeps all configured model and policy providers active during touched scans", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          agents: {
            defaults: {
              model: { primary: "agent-primary/model", fallbacks: ["agent-fallback/model"] },
            },
            entries: {
              worker: { modelPolicy: { allow: ["worker-policy/*"] } },
            },
          },
          hooks: { gmail: { model: "gmail-model/model" } },
          tts: { summaryModel: "untouched-tts/model" },
          channels: {
            modelByChannel: { slack: { room: "channel-model/model" } },
            discord: { voice: { model: "untouched-voice/model" } },
          },
        },
        [
          ["agents", "defaults", "model"],
          ["agents", "entries", "worker", "modelPolicy", "allow", "0"],
          ["hooks", "gmail", "model"],
          ["channels", "modelByChannel", "slack", "room"],
        ],
      ),
    ).toEqual([
      "agent-fallback",
      "agent-primary",
      "channel-model",
      "gmail-model",
      "untouched-tts",
      "untouched-voice",
      "worker-policy",
    ]);
  });

  it("does not infer touched-path ownership from dotted configured ids", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          agents: { entries: { "worker.blue": { model: "provider.with.dots/model" } } },
          plugins: { entries: { other: {} } },
        },
        [["plugins", "entries", "other", "enabled"]],
      ),
    ).toEqual(["other", "provider.with.dots"]);
  });

  it("falls back to the full doctor-id set when touched paths are too broad", () => {
    expect(
      collectDoctorConfigRepairPluginIds(
        {
          channels: {
            discord: {},
            telegram: {},
          },
          plugins: {
            entries: {
              "memory-wiki": {},
            },
          },
        },
        [["channels"]],
      ),
    ).toEqual(["discord", "memory-wiki", "telegram"]);
  });
});
