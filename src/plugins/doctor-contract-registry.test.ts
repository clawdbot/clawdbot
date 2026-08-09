// Covers plugin doctor contract registry discovery and validation.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BundledChannelLegacyStateMigrationDetector } from "../plugin-sdk/channel-entry-contract.types.js";
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
const listLegacyChannelMigrationEntriesMock = vi.hoisted(() =>
  vi.fn<
    (options?: { config?: unknown; pluginIds?: readonly string[] }) => Array<{
      pluginId: string;
      detector: BundledChannelLegacyStateMigrationDetector;
    }>
  >(() => []),
);

vi.mock("../channels/plugins/bundled.js", () => ({
  listBundledChannelLegacyStateMigrationDetectorEntries: listLegacyChannelMigrationEntriesMock,
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
let collectRelevantDoctorPluginIdsForTouchedPaths: typeof import("./doctor-contract-registry.js").collectRelevantDoctorPluginIdsForTouchedPaths;
let listPluginDoctorLegacyConfigRules: typeof import("./doctor-contract-registry.js").listPluginDoctorLegacyConfigRules;
let listPluginDoctorSessionRouteStateOwners: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionRouteStateOwners;
let listPluginDoctorSessionStoreAgentIds: typeof import("./doctor-contract-registry.js").listPluginDoctorSessionStoreAgentIds;
let listPluginDoctorStateMigrationEntries: typeof import("./doctor-contract-registry.js").listPluginDoctorStateMigrationEntries;
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
    listLegacyChannelMigrationEntriesMock.mockReset();
    listLegacyChannelMigrationEntriesMock.mockReturnValue([]);
    vi.resetModules();
    ({
      applyPluginDoctorCompatibilityMigrations,
      collectRelevantDoctorPluginIds,
      collectRelevantDoctorPluginIdsForTouchedPaths,
      listPluginDoctorLegacyConfigRules,
      listPluginDoctorSessionRouteStateOwners,
      listPluginDoctorSessionStoreAgentIds,
      listPluginDoctorStateMigrationEntries,
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

  it("adapts deprecated channel detectors into scoped plugin migrations", async () => {
    const detector = vi.fn(() => [
      {
        kind: "move" as const,
        label: "Legacy credentials",
        sourcePath: "/oauth/legacy.json",
        targetPath: "/oauth/demo/legacy.json",
      },
    ]);
    listLegacyChannelMigrationEntriesMock.mockReturnValue([
      { pluginId: "legacy-channel", detector },
    ]);
    mocks.loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });

    const entries = listPluginDoctorStateMigrationEntries({
      config: {},
      env: {},
      pluginIds: ["legacy-channel"],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.pluginId).toBe("legacy-channel");
    await expect(
      entries[0]?.migration.detectLegacyState({
        config: {},
        env: {},
        stateDir: "/state",
        oauthDir: "/oauth",
        context: { openPluginStateKeyedStore: vi.fn() } as never,
      }),
    ).resolves.toEqual({
      preview: ["- Legacy credentials: /oauth/legacy.json → /oauth/demo/legacy.json"],
    });
    expect(detector).toHaveBeenCalledTimes(1);
    expect(listLegacyChannelMigrationEntriesMock).toHaveBeenCalledWith({
      config: {},
      pluginIds: ["legacy-channel"],
    });
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

  it("loads a plugin doctor contract when scoped by a contributed provider id", () => {
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
          providers: ["ollama", "ollama-cloud"],
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
