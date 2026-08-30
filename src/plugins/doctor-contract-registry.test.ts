// Covers plugin doctor contract registry discovery and validation.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();
const doctorContractWarnMock = vi.hoisted(() => vi.fn());
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
let collectRelevantDoctorPluginIdsForTouchedPaths: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIdsForTouchedPaths;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;
let listPluginDoctorSessionRouteStateOwners: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionRouteStateOwners;
let listPluginDoctorSessionStoreAgentIds: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionStoreAgentIds;
let setPluginDoctorContractRegistryModuleLoaderFactoryForTest:
  | typeof import("./doctor-contract-registry.test-fixtures.js").setPluginDoctorContractRegistryModuleLoaderFactoryForTest
  | undefined;

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-doctor-contract-registry", tempDirs);
}

function requireFirstCreateJitiCall(): [string, { tryNative?: boolean }] {
  const call = mocks.createJiti.mock.calls[0];
  if (!call) {
    throw new Error("expected createJiti call");
  }
  return call as [string, { tryNative?: boolean }];
}

afterEach(() => {
  setPluginDoctorContractRegistryModuleLoaderFactoryForTest?.(undefined);
  cleanupTrackedTempDirs(tempDirs);
});

describe("doctor-contract-registry module loader", () => {
  beforeEach(async () => {
    resetRegistryJitiMocks();
    doctorContractWarnMock.mockReset();
    vi.resetModules();
    ({
      applyPluginDoctorCompatibilityMigrations,
      collectRelevantDoctorPluginIds,
      collectRelevantDoctorPluginIdsForTouchedPaths,
      listPluginDoctorLegacyConfigRules,
      listPluginDoctorSessionRouteStateOwners,
      listPluginDoctorSessionStoreAgentIds,
    } = await import("./doctor-contract-registry.js"));
    ({
      clearPluginDoctorContractRegistryCache,
      setPluginDoctorContractRegistryModuleLoaderFactoryForTest,
    } = await import("./doctor-contract-registry.test-fixtures.js"));
    setPluginDoctorContractRegistryModuleLoaderFactoryForTest(mocks.createJiti);
    clearPluginDoctorContractRegistryCache();
  });

  it("preserves source artifact precedence across root and dist candidates", () => {
    const pluginRoot = makeTempDir();
    const distRoot = path.join(pluginRoot, "dist");
    fs.mkdirSync(distRoot);
    const rootDoctorTypeScript = path.join(pluginRoot, "doctor-contract-api.ts");
    const distDoctorTypeScript = path.join(distRoot, "doctor-contract-api.ts");
    const rootDoctorJavaScript = path.join(pluginRoot, "doctor-contract-api.js");
    const rootContractTypeScript = path.join(pluginRoot, "contract-api.ts");
    for (const filePath of [
      rootDoctorTypeScript,
      distDoctorTypeScript,
      rootDoctorJavaScript,
      rootContractTypeScript,
    ]) {
      fs.writeFileSync(filePath, "export {};\n", "utf-8");
    }

    expect(resolvePluginDoctorContractArtifactPath(pluginRoot)).toBe(rootDoctorTypeScript);
    fs.rmSync(rootDoctorTypeScript);
    expect(resolvePluginDoctorContractArtifactPath(pluginRoot)).toBe(distDoctorTypeScript);
    fs.rmSync(distDoctorTypeScript);
    expect(resolvePluginDoctorContractArtifactPath(pluginRoot)).toBe(rootDoctorJavaScript);
    fs.rmSync(rootDoctorJavaScript);
    expect(resolvePluginDoctorContractArtifactPath(pluginRoot)).toBe(rootContractTypeScript);
  });

  it.each([
    {
      name: "declared false skips loading",
      doctorContract: { configRepair: false },
      expectedRuleCount: 0,
      expectedLoadCount: 0,
    },
    {
      name: "absent declaration preserves loading",
      doctorContract: undefined,
      expectedRuleCount: 1,
      expectedLoadCount: 1,
    },
    {
      name: "declared true loads the authoritative module",
      doctorContract: { configRepair: true },
      expectedRuleCount: 1,
      expectedLoadCount: 1,
    },
  ])("gates config-repair artifacts: $name", (testCase) => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      legacyConfigRules: [{ path: ["plugins", "entries", "demo"], message: "demo rule" }],
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "test-plugin",
          rootDir: pluginRoot,
          ...(testCase.doctorContract ? { doctorContract: testCase.doctorContract } : {}),
        },
      ],
      diagnostics: [],
    });

    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} })).toHaveLength(
      testCase.expectedRuleCount,
    );
    expect(mocks.createJiti).toHaveBeenCalledTimes(testCase.expectedLoadCount);
  });

  it("loads a normalizer-only config-repair contract", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
      normalizeCompatibilityConfig: ({ cfg }: { cfg: Record<string, unknown> }) => ({
        config: { ...cfg, repaired: true },
        changes: ["repaired config"],
      }),
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "normalizer-only",
          rootDir: pluginRoot,
          doctorContract: { configRepair: true },
        },
      ],
      diagnostics: [],
    });

    expect(applyPluginDoctorCompatibilityMigrations({}, { env: {} })).toEqual({
      config: { repaired: true },
      changes: ["repaired config"],
    });
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("records doctor contract load failures with plugin and artifact context", () => {
    const pluginRoot = makeTempDir();
    const contractSource = path.join(pluginRoot, "doctor-contract-api.ts");
    fs.writeFileSync(contractSource, "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => {
      throw new Error("fixture module load failed");
    });
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "broken-doctor-plugin",
          rootDir: pluginRoot,
          doctorContract: { configRepair: true },
        },
      ],
      diagnostics: [],
    });

    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: pluginRoot, env: {} })).toEqual([]);
    expect(doctorContractWarnMock).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        `failed to load doctor contract for broken-doctor-plugin from ${contractSource}: fixture module load failed`,
      ),
    );
  });

  it("uses native require on Windows for compatible JavaScript contract-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "contract-api.js"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'legacy'], message: 'legacy demo key' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    withMockedPlatform("win32", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "legacy"],
          message: "legacy demo key",
        },
      ]);
    });

    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("falls back to the source-transform boundary on Windows for TypeScript contract-api modules", () => {
    const pluginRoot = makeTempDir();
    const contractApiPath = path.join(pluginRoot, "contract-api.ts");
    fs.writeFileSync(
      contractApiPath,
      "export const legacyConfigRules = [{ path: ['plugins', 'entries', 'demo', 'ts'], message: 'typescript contract' }];\n",
      "utf-8",
    );
    mocks.createJiti.mockImplementation(() => () => ({
      legacyConfigRules: [
        {
          path: ["plugins", "entries", "demo", "ts"],
          message: "typescript contract",
        },
      ],
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    withMockedPlatform("win32", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "ts"],
          message: "typescript contract",
        },
      ]);
    });

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    const [jitiPath, jitiOptions] = requireFirstCreateJitiCall();
    expect(jitiPath).toBe(pathToFileURL(contractApiPath, { windows: true }).href);
    expect(jitiOptions.tryNative).toBe(false);
  });

  it("prefers doctor-contract-api over the broader contract-api surface", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'doctor'], message: 'doctor contract' }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'broad'], message: 'broad contract' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    withMockedPlatform("darwin", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "doctor"],
          message: "doctor contract",
        },
      ]);
      expect(mocks.createJiti).not.toHaveBeenCalled();
    });
  });

  it("uses native require for compatible JavaScript contract modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'demo', 'legacy'], message: 'legacy demo key' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    withMockedPlatform("darwin", () => {
      expect(
        listPluginDoctorLegacyConfigRules({
          workspaceDir: pluginRoot,
          env: {},
        }),
      ).toEqual([
        {
          path: ["plugins", "entries", "demo", "legacy"],
          message: "legacy demo key",
        },
      ]);
      expect(mocks.createJiti).not.toHaveBeenCalled();
    });
  });

  it("loads session route-state owners from manifest records without loading modules", () => {
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "test-plugin",
          rootDir: "/plugins/test-plugin",
          sessionRouteStateOwners: [
            {
              id: "demo",
              label: "Demo",
              providerIds: ["demo"],
              runtimeIds: ["demo-cli"],
              cliSessionKeys: ["demo-cli"],
              authProfilePrefixes: ["demo:"],
            },
          ],
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionRouteStateOwners({
        workspaceDir: "/workspace",
        env: {},
      }),
    ).toEqual([
      {
        id: "demo",
        label: "Demo",
        providerIds: ["demo"],
        runtimeIds: ["demo-cli"],
        cliSessionKeys: ["demo-cli"],
        authProfilePrefixes: ["demo:"],
      },
    ]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("loads config-derived session-store agent IDs from doctor contract modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { resolveSessionStoreAgentIds: ({ cfg }) => [cfg.plugins.entries.demo.config.agentId, 'voice', ' '] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", packageName: "@openclaw/demo", rootDir: pluginRoot }],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionStoreAgentIds({
        config: {
          plugins: { entries: { demo: { config: { agentId: "cards" } } } },
        },
        workspaceDir: pluginRoot,
        env: {},
        pluginIds: ["@openclaw/demo"],
      }),
    ).toEqual(["cards", "voice"]);
  });

  it("deduplicates manifest owners by first id and sorts them by id", () => {
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "google",
          rootDir: "/plugins/google",
          channels: [],
          providers: ["google"],
          sessionRouteStateOwners: [
            {
              id: "google",
              label: "Google",
              providerIds: ["google", "google-antigravity", "google-gemini-cli", "google-vertex"],
              runtimeIds: ["google-gemini-cli"],
              cliSessionKeys: ["google-gemini-cli", "gemini-cli"],
              authProfilePrefixes: [
                "google:",
                "google-antigravity:",
                "google-gemini-cli:",
                "google-vertex:",
                "gemini-cli:",
              ],
            },
          ],
        },
        {
          id: "anthropic",
          rootDir: "/plugins/anthropic",
          channels: [],
          providers: ["anthropic"],
          sessionRouteStateOwners: [
            {
              id: "anthropic",
              label: "Anthropic",
              providerIds: ["anthropic", "claude-cli"],
              runtimeIds: ["claude-cli"],
              cliSessionKeys: ["claude-cli"],
              authProfilePrefixes: ["anthropic:", "claude-cli:"],
            },
          ],
        },
        {
          id: "google-shadow",
          rootDir: "/plugins/google-shadow",
          channels: [],
          providers: ["google-shadow"],
          sessionRouteStateOwners: [{ id: "google", label: "Ignored duplicate" }],
        },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionRouteStateOwners({
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["anthropic", "google", "google-shadow"],
      }),
    ).toEqual([
      {
        id: "anthropic",
        label: "Anthropic",
        providerIds: ["anthropic", "claude-cli"],
        runtimeIds: ["claude-cli"],
        cliSessionKeys: ["claude-cli"],
        authProfilePrefixes: ["anthropic:", "claude-cli:"],
      },
      {
        id: "google",
        label: "Google",
        providerIds: ["google", "google-antigravity", "google-gemini-cli", "google-vertex"],
        runtimeIds: ["google-gemini-cli"],
        cliSessionKeys: ["google-gemini-cli", "gemini-cli"],
        authProfilePrefixes: [
          "google:",
          "google-antigravity:",
          "google-gemini-cli:",
          "google-vertex:",
          "gemini-cli:",
        ],
      },
    ]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("passes active config to manifest registry discovery", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'load-path-doctor', 'config', 'summaryModel'], message: 'load path contract' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "load-path-doctor", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const config = {
      plugins: {
        load: { paths: [pluginRoot] },
        entries: {
          "load-path-doctor": {
            config: {
              summaryModel: "openai/gpt-5.4-mini",
            },
          },
        },
      },
    };

    expect(
      listPluginDoctorLegacyConfigRules({
        config,
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["load-path-doctor"],
      }),
    ).toEqual([
      {
        path: ["plugins", "entries", "load-path-doctor", "config", "summaryModel"],
        message: "load path contract",
      },
    ]);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      env: {},
      includeDisabled: true,
    });
  });

  it("reads doctor contracts from the current manifest registry on each call", () => {
    const firstRoot = makeTempDir();
    const secondRoot = makeTempDir();
    fs.writeFileSync(
      path.join(firstRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'first'], message: 'first contract' }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(secondRoot, "doctor-contract-api.cjs"),
      "module.exports = { legacyConfigRules: [{ path: ['plugins', 'entries', 'second'], message: 'second contract' }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry
      .mockReturnValueOnce({
        plugins: [{ id: "first-plugin", rootDir: firstRoot }],
        diagnostics: [],
      })
      .mockReturnValueOnce({
        plugins: [{ id: "second-plugin", rootDir: secondRoot }],
        diagnostics: [],
      });

    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: "/workspace", env: {} })).toEqual([
      {
        path: ["plugins", "entries", "first"],
        message: "first contract",
      },
    ]);
    expect(listPluginDoctorLegacyConfigRules({ workspaceDir: "/workspace", env: {} })).toEqual([
      {
        path: ["plugins", "entries", "second"],
        message: "second contract",
      },
    ]);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
  });

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
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw,
        touchedPaths: [["channels", "modelByChannel", "discord", "guild"]],
      }),
    ).toStrictEqual(["openai"]);
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({ raw, touchedPaths: [["channels"]] }),
    ).toEqual(["discord", "openai"]);
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
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw,
        touchedPaths: [["tools", "media", "models", "2", "model"]],
      }),
    ).toEqual(["gemini", "openai", "xai"]);
  });

  it("loads a plugin doctor contract when scoped by a contributed provider alias", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.ts"), "export {};\n", "utf-8");
    mocks.createJiti.mockImplementation(() => () => ({
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
        changes: ["normalized ollama cloud provider endpoint"],
      }),
    }));
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "ollama",
          rootDir: pluginRoot,
          channels: [],
          providers: ["ollama"],
          providerAuthAliases: { "ollama-cloud": "ollama" },
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
      tools: { media: { image: { preferredModel: "opencode/hy3-free" } } },
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
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
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
        touchedPaths: [
          ["channels", "discord", "token"],
          ["plugins", "entries", "memory-wiki", "enabled"],
          ["models", "providers", "ollama-cloud", "baseUrl"],
          ["talk", "voiceId"],
        ],
      }),
    ).toEqual(["discord", "elevenlabs", "memory-wiki", "ollama-cloud"]);
  });

  it("keeps all configured model and policy providers active during touched scans", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
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
        touchedPaths: [
          ["agents", "defaults", "model"],
          ["agents", "entries", "worker", "modelPolicy", "allow", "0"],
          ["hooks", "gmail", "model"],
          ["channels", "modelByChannel", "slack", "room"],
        ],
      }),
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
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
          agents: { entries: { "worker.blue": { model: "provider.with.dots/model" } } },
          plugins: { entries: { other: {} } },
        },
        touchedPaths: [["plugins", "entries", "other", "enabled"]],
      }),
    ).toEqual(["other", "provider.with.dots"]);
  });

  it("falls back to the full doctor-id set when touched paths are too broad", () => {
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw: {
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
        touchedPaths: [["channels"]],
      }),
    ).toEqual(["discord", "memory-wiki", "telegram"]);
  });
});
