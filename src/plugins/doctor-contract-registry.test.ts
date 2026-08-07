// Covers plugin doctor contract registry discovery and validation.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

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

  it("uses native require on Windows for compatible JavaScript contract-api modules", () => {
    const pluginRoot = makeTempDir();
    // Anchor the fixture scope to CJS so `.js` contract files stay loadable
    // even when an ancestor package.json declares "type": "module".
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
      "utf-8",
    );
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

  it("loads session route-state owners from doctor contract modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      "module.exports = { sessionRouteStateOwners: [{ id: 'demo', label: 'Demo', providerIds: ['demo'], runtimeIds: ['demo-cli'], cliSessionKeys: ['demo-cli'], authProfilePrefixes: ['demo:'] }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionRouteStateOwners({
        workspaceDir: pluginRoot,
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

  it("loads multiple bundled CLI route-state owners from doctor contract modules", () => {
    const anthropicRoot = makeTempDir();
    const googleRoot = makeTempDir();
    fs.writeFileSync(
      path.join(anthropicRoot, "doctor-contract-api.cjs"),
      "module.exports = { sessionRouteStateOwners: [{ id: 'anthropic', label: 'Anthropic', providerIds: ['anthropic', 'claude-cli'], runtimeIds: ['claude-cli'], cliSessionKeys: ['claude-cli'], authProfilePrefixes: ['anthropic:', 'claude-cli:'] }] };\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(googleRoot, "doctor-contract-api.cjs"),
      "module.exports = { sessionRouteStateOwners: [{ id: 'google', label: 'Google', providerIds: ['google', 'google-antigravity', 'google-gemini-cli', 'google-vertex'], runtimeIds: ['google-gemini-cli'], cliSessionKeys: ['google-gemini-cli', 'gemini-cli'], authProfilePrefixes: ['google:', 'google-antigravity:', 'google-gemini-cli:', 'google-vertex:', 'gemini-cli:'] }] };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        { id: "anthropic", rootDir: anthropicRoot },
        { id: "google", rootDir: googleRoot },
      ],
      diagnostics: [],
    });

    expect(
      listPluginDoctorSessionRouteStateOwners({
        workspaceDir: "/workspace",
        env: {},
        pluginIds: ["anthropic", "google"],
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

  it("collects provider ids from agent-only model refs", () => {
    const raw = {
      agents: {
        defaults: {
          model: {
            primary: "opencode/hy3-free",
            fallbacks: ["opencode-go/kimi-k3@work"],
          },
          models: {
            "opencode/laguna-s-2.1-free": {},
          },
          subagents: {
            model: "openai/gpt-5.6-sol",
          },
        },
        list: [{ id: "main", model: "anthropic/claude-opus-5" }],
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual([
      "anthropic",
      "openai",
      "opencode",
      "opencode-go",
    ]);
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw,
        touchedPaths: [["agents", "defaults", "model", "primary"]],
      }),
    ).toEqual(["anthropic", "openai", "opencode", "opencode-go"]);
  });

  // Each selector gets a distinct provider id so a dropped selector fails on its
  // own row instead of hiding behind a sibling that resolves the same id.
  it.each([
    ["utilityModel", { utilityModel: "sel-utility/m" }, "sel-utility"],
    ["imageModel", { imageModel: "sel-image/m" }, "sel-image"],
    ["voiceModel", { voiceModel: "sel-voice/m" }, "sel-voice"],
    ["pdfModel", { pdfModel: "sel-pdf/m" }, "sel-pdf"],
    ["mediaModels.image", { mediaModels: { image: "sel-media-image/m" } }, "sel-media-image"],
    ["mediaModels.video", { mediaModels: { video: "sel-media-video/m" } }, "sel-media-video"],
    ["mediaModels.music", { mediaModels: { music: "sel-media-music/m" } }, "sel-media-music"],
    ["heartbeat.model", { heartbeat: { model: "sel-heartbeat/m" } }, "sel-heartbeat"],
    ["compaction.model", { compaction: { model: "sel-compaction/m" } }, "sel-compaction"],
    [
      "compaction.memoryFlush.model",
      { compaction: { memoryFlush: { model: "sel-flush/m" } } },
      "sel-flush",
    ],
    ["subagents.model", { subagents: { model: "sel-subagents/m" } }, "sel-subagents"],
  ])(
    "loads the doctor contract for a config whose only model ref is agents.defaults.%s",
    (_selector, defaults, expectedProviderId) => {
      expect(collectRelevantDoctorPluginIds({ agents: { defaults } })).toEqual([
        expectedProviderId,
      ]);
    },
  );

  it("collects provider ids from keyed agents.entries without agents.list", () => {
    const raw = {
      agents: {
        entries: {
          main: { default: true, model: "opencode/hy3-free" },
          worker: { model: { primary: "opencode-go/kimi-k3" } },
        },
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["opencode", "opencode-go"]);
  });

  it("collects provider ids from modelPolicy.allow (omitted by canonical traversal)", () => {
    const raw = {
      agents: {
        defaults: {
          modelPolicy: { allow: ["opencode/hy3-free"] },
        },
        entries: {
          main: { modelPolicy: { allow: ["opencode-go/kimi-k3"] } },
        },
      },
    };

    expect(collectRelevantDoctorPluginIds(raw).toSorted()).toEqual(["opencode", "opencode-go"]);
  });

  it("harvests modelPolicy.allow from the agents.list projection", () => {
    const raw = {
      agents: {
        list: [{ id: "main", modelPolicy: { allow: ["opencode/hy3-free@work"] } }],
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["opencode"]);
  });

  it("returns no plugin ids for configs without model references", () => {
    expect(collectRelevantDoctorPluginIds({})).toEqual([]);
    expect(collectRelevantDoctorPluginIds({ agents: {} })).toEqual([]);
    expect(collectRelevantDoctorPluginIds({ agents: { defaults: {} } })).toEqual([]);
  });

  it("skips non-string agent model values instead of inventing provider ids", () => {
    const raw = {
      agents: {
        defaults: {
          model: 42,
          utilityModel: null,
          imageModel: true,
          heartbeat: { model: [] },
        },
      },
    };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual([]);
  });

  it("loads agent provider ids when only agents paths are touched", () => {
    const raw = {
      agents: {
        defaults: { utilityModel: "opencode/kimi-k3" },
      },
    };

    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw,
        touchedPaths: [["agents", "defaults", "utilityModel"]],
      }),
    ).toEqual(["opencode"]);
  });

  it("harvests non-agent configured model refs so their contracts still load", () => {
    // The canonical traversal also owns tts/hooks/channel-override refs. Loading
    // an extra contract is safe (its rules are filtered by touched paths), while
    // missing one leaves a retired ref unrepaired.
    const raw = { tts: { summaryModel: "opencode/hy3-free" } };

    expect(collectRelevantDoctorPluginIds(raw)).toEqual(["opencode"]);
    expect(
      collectRelevantDoctorPluginIdsForTouchedPaths({
        raw,
        touchedPaths: [["agents", "defaults", "model"]],
      }),
    ).toEqual(["opencode"]);
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
