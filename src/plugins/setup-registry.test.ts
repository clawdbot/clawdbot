import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// Verifies plugin setup registry discovery and lookup behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

const setupRegistryWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "plugins/setup-registry"
        ? { ...logger, warn: setupRegistryWarn }
        : logger;
    },
  };
});

// plugin-module-loader-cache prefers native require() for compiled .js before
// falling back to jiti. These tests script plugin-loading behavior through the
// source-transform mock, so force the fallback path and keep the fixture
// transformer authoritative.
vi.mock("./native-module-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-module-require.js")>()),
  isJavaScriptModulePath: (_modulePath: string) => false,
  tryNativeRequireJavaScriptModule: (_modulePath: string) => ({ ok: false }),
}));

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

type SetupRegistryApi = Pick<
  import("./types.js").OpenClawPluginApi,
  "registerProvider" | "registerCliBackend" | "registerConfigMigration" | "registerAutoEnableProbe"
>;

let clearPluginSetupRegistryCache: typeof import("./setup-registry.test-fixtures.js").clearPluginSetupRegistryCache;
let resolvePluginSetupRegistry: typeof import("./setup-registry.js").resolvePluginSetupRegistry;
let resolvePluginSetupProviderCore: typeof import("./setup-registry.js").resolvePluginSetupProviderCore;
let resolvePluginSetupCliBackend: typeof import("./setup-registry.js").resolvePluginSetupCliBackend;
let runPluginSetupConfigMigrations: typeof import("./setup-registry.js").runPluginSetupConfigMigrations;
let setPluginSetupRegistryModuleLoaderFactoryForTest: typeof import("./setup-registry.test-fixtures.js").setPluginSetupRegistryModuleLoaderFactoryForTest;

function forceNodeRuntimeVersionsForTest(): () => void {
  const originalVersions = process.versions;
  const nodeVersions = { ...originalVersions } as NodeJS.ProcessVersions & {
    bun?: string | undefined;
  };
  delete nodeVersions.bun;
  Object.defineProperty(process, "versions", {
    configurable: true,
    value: nodeVersions,
  });
  return () => {
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: originalVersions,
    });
  };
}

function makeTempDir(): string {
  return makeTrackedTempDir("openclaw-setup-registry", tempDirs);
}

function writeSetupApiStub(pluginRoot: string): void {
  fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
}

function mockSinglePlugin(plugin: {
  id: string;
  rootDir: string;
  setup?: unknown;
  configContracts?: unknown;
}) {
  mocks.loadPluginManifestRegistry.mockReturnValue({
    plugins: [plugin],
    diagnostics: [],
  });
}

function mockVoiceCallConfigMigrationRegistration(registerResult?: () => Promise<void>) {
  const pluginRoot = makeTempDir();
  writeSetupApiStub(pluginRoot);
  mockSinglePlugin({ id: "voice-call", rootDir: pluginRoot });
  mocks.createJiti.mockImplementation(() => {
    return () => ({
      default: {
        register(api: {
          registerConfigMigration: (migrate: (config: unknown) => unknown) => void;
        }) {
          api.registerConfigMigration((config) => ({ config, changes: ["voice-call"] }));
          return registerResult?.();
        },
      },
    });
  });
}

function mockOpenAiCliBackendRegistration(params: {
  requiresRuntime?: boolean;
  registerResult?: () => Promise<void>;
}) {
  const pluginRoot = makeTempDir();
  writeSetupApiStub(pluginRoot);
  mockSinglePlugin({
    id: "openai",
    rootDir: pluginRoot,
    setup: {
      cliBackends: ["codex-cli"],
      ...(params.requiresRuntime ? { requiresRuntime: true } : {}),
    },
  });
  mocks.createJiti.mockImplementation(() => {
    return () => ({
      default: {
        register(api: {
          registerCliBackend: (backend: { id: string; config: { command: string } }) => void;
        }) {
          api.registerCliBackend({
            id: "codex-cli",
            config: { command: "codex" },
          });
          return params.registerResult?.();
        },
      },
    });
  });
}

function mockDuplicateSetupClaims(params: {
  duplicatePluginId: boolean;
  kind: "cliBackend" | "provider";
}) {
  const bundledRoot = makeTempDir();
  const workspaceRoot = makeTempDir();
  writeSetupApiStub(bundledRoot);
  writeSetupApiStub(workspaceRoot);
  const setup =
    params.kind === "provider"
      ? {
          bundled: { providers: [{ id: "openai" }] },
          workspace: { providers: [{ id: "OpenAI" }] },
        }
      : {
          bundled: { cliBackends: ["codex-cli"] },
          workspace: { cliBackends: ["CODEX-CLI"] },
        };
  mocks.loadPluginManifestRegistry.mockReturnValue({
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        rootDir: bundledRoot,
        setup: setup.bundled,
      },
      {
        id: params.duplicatePluginId ? "openai" : "workspace-shadow",
        origin: "workspace",
        rootDir: workspaceRoot,
        setup: setup.workspace,
      },
    ],
    diagnostics: [],
  });
}

async function expectNoUnhandledRejection(run: () => void | Promise<void>): Promise<void> {
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await run();
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  expect(unhandledRejections).toStrictEqual([]);
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockCall(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
): ReadonlyArray<unknown> {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex + 1}`);
  }
  return call;
}

function mockArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex: number,
  argIndex: number,
): unknown {
  return mockCall(mock, callIndex)[argIndex];
}

function firstRecordArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return requireRecord(mockArg(mock, 0, 0));
}

afterEach(() => {
  setPluginSetupRegistryModuleLoaderFactoryForTest(undefined);
  cleanupTrackedTempDirs(tempDirs);
});

describe("setup-registry module loader", () => {
  let windowsSourceTransformCase: {
    expectedFilename: string;
    filename: unknown;
    options: Record<string, unknown>;
  };

  beforeAll(async () => {
    resetRegistryJitiMocks();
    // The non-isolated plugin shard may cache this owner through a sibling first.
    // Refresh it once after this file's hoisted mocks, then reuse it for every case.
    vi.resetModules();
    ({
      resolvePluginSetupRegistry,
      resolvePluginSetupProviderCore,
      resolvePluginSetupCliBackend,
      runPluginSetupConfigMigrations,
    } = await import("./setup-registry.js"));
    ({ clearPluginSetupRegistryCache, setPluginSetupRegistryModuleLoaderFactoryForTest } =
      await import("./setup-registry.test-fixtures.js"));
    setPluginSetupRegistryModuleLoaderFactoryForTest(mocks.createJiti);
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const restoreVersions = forceNodeRuntimeVersionsForTest();

    try {
      withMockedWindowsPlatform(() => {
        resolvePluginSetupRegistry({
          workspaceDir: pluginRoot,
          env: {},
        });
      });
    } finally {
      restoreVersions();
    }

    windowsSourceTransformCase = {
      expectedFilename: pathToFileURL(path.join(pluginRoot, "setup-api.js"), {
        windows: true,
      }).href,
      filename: mockArg(mocks.createJiti, 0, 0),
      options: requireRecord(mockArg(mocks.createJiti, 0, 1)),
    };
    setPluginSetupRegistryModuleLoaderFactoryForTest(undefined);
  });

  beforeEach(() => {
    resetRegistryJitiMocks();
    setupRegistryWarn.mockReset();
    setPluginSetupRegistryModuleLoaderFactoryForTest(mocks.createJiti);
  });

  it("uses the runtime-supported source-transform boundary on Windows for setup-api modules", () => {
    expect(windowsSourceTransformCase.filename).toBe(windowsSourceTransformCase.expectedFilename);
    expect(windowsSourceTransformCase.options.tryNative).toBe(false);
  });

  it("passes explicit plugin id scope into setup manifest reads", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });

    resolvePluginSetupRegistry({
      pluginIds: ["test-plugin"],
      env: {},
    });

    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    expect(firstRecordArg(mocks.loadPluginManifestRegistry).pluginIds).toEqual(["test-plugin"]);
  });

  it.each([
    {
      name: "uses root builds for bundled source records",
      artifactRootName: "dist",
      packageManifest: undefined,
      expectedLabel: "artifact",
    },
    {
      name: "ignores stale staging builds for source-external records",
      artifactRootName: "dist-runtime",
      packageManifest: { build: { bundledDist: false as const } },
      expectedLabel: "source",
    },
  ])("$name", ({ artifactRootName, packageManifest, expectedLabel }) => {
    const packageRoot = makeTempDir();
    const pluginRoot = path.join(packageRoot, "extensions", "fixture");
    const sourceSetup = path.join(pluginRoot, "setup-api.ts");
    const artifactSetup = path.join(
      packageRoot,
      artifactRootName,
      "extensions",
      "fixture",
      "setup-api.js",
    );
    fs.mkdirSync(path.dirname(sourceSetup), { recursive: true });
    fs.mkdirSync(path.dirname(artifactSetup), { recursive: true });
    fs.writeFileSync(sourceSetup, "export default {};\n", "utf-8");
    fs.writeFileSync(artifactSetup, "export default {};\n", "utf-8");
    fs.writeFileSync(
      path.join(path.dirname(artifactSetup), "package.json"),
      JSON.stringify({ openclaw: { extensions: ["./index.js"] } }),
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "fixture",
          origin: "bundled",
          rootDir: pluginRoot,
          setupSource: sourceSetup,
          packageManifest,
          setup: { providers: [{ id: "fixture" }] },
        },
      ],
      diagnostics: [],
    });
    const artifactRealPath = fs.realpathSync(artifactSetup);
    mocks.createJiti.mockImplementation(() => (modulePath: string) => ({
      default: {
        register(api: {
          registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
        }) {
          api.registerProvider({
            id: "fixture",
            label: modulePath === artifactRealPath ? "artifact" : "source",
            auth: [],
          });
        },
      },
    }));

    expect(resolvePluginSetupProviderCore({ provider: "fixture", env: {} })?.label).toBe(
      expectedLabel,
    );
  });

  it("keeps bundled setup artifact selection independent of active runtime state", () => {
    const setupRegistrySource = fs.readFileSync(
      new URL("./setup-registry.ts", import.meta.url),
      "utf8",
    );
    const selectionSource = fs.readFileSync(
      new URL("./plugin-runtime-artifact-selection.ts", import.meta.url),
      "utf8",
    );

    expect(setupRegistrySource).not.toContain("plugin-runtime-artifact-resolution");
    expect(setupRegistrySource).not.toContain('from "./runtime.js"');
    expect(selectionSource).not.toContain("plugin-runtime-artifact-resolution");
    expect(selectionSource).not.toMatch(/from ["']\.\/runtime(?:\.js|\/)/u);
  });

  it("skips setup-api loading when config has no relevant migration triggers", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "amazon-bedrock",
          rootDir: pluginRoot,
          configContracts: {
            compatibilityMigrationPaths: ["models.bedrockDiscovery"],
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerConfigMigration: (migrate: (config: unknown) => unknown) => void;
          }) {
            api.registerConfigMigration((config) => ({ config, changes: ["unexpected"] }));
          },
        },
      });
    });

    const result = runPluginSetupConfigMigrations({
      config: {
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1" },
          },
        },
      } as never,
      env: {},
    });

    expect(result.changes).toStrictEqual([]);
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("loads only plugins whose manifest migration triggers match the config", () => {
    const bedrockRoot = makeTempDir();
    const voiceCallRoot = makeTempDir();
    fs.writeFileSync(path.join(bedrockRoot, "setup-api.js"), "export default {};\n", "utf-8");
    fs.writeFileSync(path.join(voiceCallRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "amazon-bedrock",
          rootDir: bedrockRoot,
          configContracts: {
            compatibilityMigrationPaths: ["models.bedrockDiscovery"],
          },
        },
        {
          id: "voice-call",
          rootDir: voiceCallRoot,
          configContracts: {
            compatibilityMigrationPaths: ["plugins.entries.voice-call.config"],
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation((modulePath: string) => {
      const pluginId = modulePath.includes(bedrockRoot) ? "amazon-bedrock" : "voice-call";
      return () => ({
        default: {
          register(api: {
            registerConfigMigration: (migrate: (config: unknown) => unknown) => void;
          }) {
            api.registerConfigMigration((config) => ({
              config,
              changes: [pluginId],
            }));
          },
        },
      });
    });

    const result = runPluginSetupConfigMigrations({
      config: {
        models: {
          bedrockDiscovery: {
            enabled: true,
          },
        },
      } as never,
      env: {},
    });

    expect(result.changes).toEqual(["amazon-bedrock"]);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mockArg(mocks.createJiti, 0, 0)).toBe(path.join(bedrockRoot, "setup-api.js"));
  });

  it("still loads explicitly configured plugin entries without manifest trigger metadata", () => {
    mockVoiceCallConfigMigrationRegistration();

    const result = runPluginSetupConfigMigrations({
      config: {
        plugins: {
          entries: {
            "voice-call": {
              config: {
                provider: "log",
              },
            },
          },
        },
      } as never,
      env: {},
    });

    expect(result.changes).toEqual(["voice-call"]);
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
  });

  it("prefers setup provider descriptors over top-level provider ids", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "amazon-bedrock",
          rootDir: pluginRoot,
          providers: ["legacy-bedrock"],
          setup: {
            providers: [{ id: "amazon-bedrock" }],
            requiresRuntime: true,
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
          }) {
            api.registerProvider({
              id: "amazon-bedrock",
              label: "Amazon Bedrock",
              auth: [],
            });
          },
        },
      });
    });

    const provider = requireRecord(
      resolvePluginSetupProviderCore({ provider: "amazon-bedrock", env: {} }),
    );
    expect(provider.id).toBe("amazon-bedrock");
    expect(provider.label).toBe("Amazon Bedrock");
    expect(resolvePluginSetupProviderCore({ provider: "legacy-bedrock", env: {} })).toBeUndefined();
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mockArg(mocks.createJiti, 0, 0)).toBe(path.join(pluginRoot, "setup-api.js"));
  });

  it("uses provider auth aliases to route setup provider owner lookup", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: pluginRoot,
          providerAuthAliases: { openai: "openai" },
          setup: {
            providers: [{ id: "openai" }],
            requiresRuntime: true,
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerProvider: (provider: {
              id: string;
              aliases?: string[];
              hookAliases?: string[];
              label: string;
              auth: [];
            }) => void;
          }) {
            api.registerProvider({
              id: "openai",
              aliases: ["openai"],
              label: "OpenAI legacy match",
              auth: [],
            });
            api.registerProvider({
              id: "openai-current",
              hookAliases: ["openai"],
              label: "OpenAI current match",
              auth: [],
            });
          },
        },
      });
    });

    const provider = requireRecord(resolvePluginSetupProviderCore({ provider: "openai", env: {} }));
    expect(provider.id).toBe("openai-current");
    expect(provider.label).toBe("OpenAI current match");
  });

  it("treats explicit descriptor-only setup as a runtime cutoff", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(
      path.join(pluginRoot, "setup-api.js"),
      "export default { register(api) { api.registerProvider({ id: 'openai', label: 'OpenAI', auth: [] }); api.registerCliBackend({ id: 'codex-cli', config: { command: 'codex' } }); } };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "openai" }],
            cliBackends: ["codex-cli"],
            requiresRuntime: false,
          },
        },
      ],
      diagnostics: [],
    });

    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toBeUndefined();
    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toBeUndefined();
    const registry = resolvePluginSetupRegistry({ env: {} });
    expect(registry.providers).toEqual([]);
    expect(registry.cliBackends).toEqual([]);
    expect(registry.configMigrations).toEqual([]);
    expect(registry.autoEnableProbes).toEqual([]);
    expect(registry.diagnostics).toHaveLength(1);
    expect(registry.diagnostics[0]?.pluginId).toBe("openai");
    expect(registry.diagnostics[0]?.code).toBe("setup-descriptor-runtime-disabled");
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("does not report descriptor-only diagnostics for bundled setup-api fallback paths", () => {
    const parentDir = makeTempDir();
    const pluginRoot = path.join(parentDir, "openai");
    fs.mkdirSync(pluginRoot);
    expect(fs.existsSync(path.join(process.cwd(), "extensions", "openai", "setup-api.ts"))).toBe(
      true,
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-openai",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "workspace-openai" }],
            requiresRuntime: false,
          },
        },
      ],
      diagnostics: [],
    });

    expect(resolvePluginSetupRegistry({ env: {} })).toEqual({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("allows provider descriptors to remain metadata-only beside other setup hooks", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "openai" }, { id: "elevenlabs" }],
            cliBackends: ["codex-cli"],
            requiresRuntime: true,
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: SetupRegistryApi) {
            api.registerCliBackend({
              id: "codex-cli",
              config: { command: "codex" },
            });
            api.registerConfigMigration((config) => ({
              config,
              changes: ["openai"],
            }));
            api.registerAutoEnableProbe(() => "openai configured");
          },
        },
      });
    });

    const registry = resolvePluginSetupRegistry({ env: {} });

    expect(registry.providers).toStrictEqual([]);
    expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["codex-cli"]);
    expect(registry.configMigrations).toHaveLength(1);
    expect(registry.autoEnableProbes).toHaveLength(1);
    expect(registry.diagnostics).toStrictEqual([]);
  });

  it("reports undeclared runtime contributions and missing CLI backends", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "openai" }],
            cliBackends: ["codex-cli"],
            requiresRuntime: true,
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
            registerCliBackend: (backend: { id: string; config: { command: string } }) => void;
          }) {
            api.registerProvider({
              id: "anthropic",
              label: "Anthropic",
              auth: [],
            });
            api.registerCliBackend({
              id: "claude-cli",
              config: { command: "claude" },
            });
          },
        },
      });
    });

    const registry = resolvePluginSetupRegistry({ env: {} });

    expect(registry.providers.map((entry) => entry.provider.id)).toEqual(["anthropic"]);
    expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["claude-cli"]);
    expect(registry.diagnostics).toHaveLength(3);
    expect(registry.diagnostics[0]?.pluginId).toBe("openai");
    expect(registry.diagnostics[0]?.code).toBe("setup-descriptor-provider-runtime-undeclared");
    expect(registry.diagnostics[0]?.runtimeId).toBe("anthropic");
    expect(registry.diagnostics[1]?.pluginId).toBe("openai");
    expect(registry.diagnostics[1]?.code).toBe("setup-descriptor-cli-backend-missing-runtime");
    expect(registry.diagnostics[1]?.declaredId).toBe("codex-cli");
    expect(registry.diagnostics[2]?.pluginId).toBe("openai");
    expect(registry.diagnostics[2]?.code).toBe("setup-descriptor-cli-backend-runtime-undeclared");
    expect(registry.diagnostics[2]?.runtimeId).toBe("claude-cli");
  });

  it("does not report drift when setup descriptors match runtime registrations", () => {
    mockOpenAiCliBackendRegistration({
      requiresRuntime: true,
    });

    expect(resolvePluginSetupRegistry({ env: {} }).diagnostics).toStrictEqual([]);
  });

  it("does not load setup-api modules from the current working directory", () => {
    const pluginRoot = makeTempDir();
    const workspaceRoot = makeTempDir();
    // The old cwd-fallback derived the lookup subdirectory from
    // `path.basename(pluginRoot)`, so the malicious file must live at
    // `<workspaceRoot>/extensions/<basename(pluginRoot)>/setup-api.js` to
    // actually reproduce the pre-fix behavior. Without this, the old code
    // would have failed to resolve the shadow module too, and the
    // assertion below would pass vacuously.
    const shadowDirName = path.basename(pluginRoot);
    const maliciousExtensionRoot = path.join(workspaceRoot, "extensions", shadowDirName);
    fs.mkdirSync(maliciousExtensionRoot, { recursive: true });
    fs.writeFileSync(
      path.join(maliciousExtensionRoot, "setup-api.js"),
      "export default { register(api) { api.registerProvider({ id: 'openai', label: 'OpenAI', auth: [] }); } };\n",
      "utf-8",
    );
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "workspace-shadow",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "openai" }],
          },
        },
      ],
      diagnostics: [],
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(workspaceRoot);
    try {
      expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toBeUndefined();
    } finally {
      cwdSpy.mockRestore();
    }

    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("resolves setup cli backends from descriptors without loading every setup-api", () => {
    const openaiRoot = makeTempDir();
    const anthropicRoot = makeTempDir();
    fs.writeFileSync(path.join(openaiRoot, "setup-api.js"), "export default {};\n", "utf-8");
    fs.writeFileSync(path.join(anthropicRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: openaiRoot,
          cliBackends: ["legacy-openai-cli"],
          setup: {
            cliBackends: ["codex-cli"],
            requiresRuntime: true,
          },
        },
        {
          id: "anthropic",
          rootDir: anthropicRoot,
          cliBackends: ["claude-cli"],
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation((modulePath: string) => {
      return () => ({
        default: {
          register(api: {
            registerCliBackend: (backend: { id: string; config: { command: string } }) => void;
          }) {
            api.registerCliBackend(
              modulePath.includes(openaiRoot)
                ? { id: "codex-cli", config: { command: "codex" } }
                : { id: "claude-cli", config: { command: "claude" } },
            );
          },
        },
      });
    });

    const first = resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} });
    const second = resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} });

    expect(first).toEqual({
      pluginId: "openai",
      backend: {
        id: "codex-cli",
        config: {
          command: "codex",
        },
      },
    });
    expect(second).toEqual(first);
    expect(resolvePluginSetupCliBackend({ backend: "legacy-openai-cli", env: {} })).toBeUndefined();
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mockArg(mocks.createJiti, 0, 0)).toBe(path.join(openaiRoot, "setup-api.js"));
  });

  it("keeps synchronously registered cli backends even when register returns a promise", () => {
    mockOpenAiCliBackendRegistration({
      requiresRuntime: true,
      registerResult: () => Promise.resolve(),
    });

    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toEqual({
      pluginId: "openai",
      backend: {
        id: "codex-cli",
        config: {
          command: "codex",
        },
      },
    });
  });

  it("swallows rejected async setup provider registration returns", async () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "openai" }],
          },
        },
      ],
      diagnostics: [],
    });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: {
            registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
          }) {
            api.registerProvider({
              id: "openai",
              label: "OpenAI",
              auth: [],
            });
            return Promise.reject(new Error("async provider register failed"));
          },
        },
      });
    });

    await expectNoUnhandledRejection(() => {
      const provider = requireRecord(
        resolvePluginSetupProviderCore({ provider: "openai", env: {} }),
      );
      expect(provider.id).toBe("openai");
      expect(provider.label).toBe("OpenAI");
    });
  });

  it("swallows rejected async setup cli backend registration returns", async () => {
    mockOpenAiCliBackendRegistration({
      registerResult: () => Promise.reject(new Error("async cli backend register failed")),
    });

    await expectNoUnhandledRejection(() => {
      expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toEqual({
        pluginId: "openai",
        backend: {
          id: "codex-cli",
          config: {
            command: "codex",
          },
        },
      });
    });
  });

  it("swallows rejected async setup registry registration returns", async () => {
    mockVoiceCallConfigMigrationRegistration(() =>
      Promise.reject(new Error("async setup registry register failed")),
    );

    await expectNoUnhandledRejection(() => {
      expect(resolvePluginSetupRegistry({ env: {} }).configMigrations).toHaveLength(1);
    });
  });

  it("records a diagnostic when the setup entry fails to load", () => {
    const brokenRoot = makeTempDir();
    writeSetupApiStub(brokenRoot);
    mockSinglePlugin({ id: "broken-entry", rootDir: brokenRoot });
    mocks.createJiti.mockImplementation(() => () => {
      throw new Error("module parse failed");
    });

    const registry = resolvePluginSetupRegistry({ env: {} });

    // A broken setup entry removes the plugin from onboarding; the reason must
    // be recorded instead of vanishing.
    expect(registry.providers).toStrictEqual([]);
    expect(registry.diagnostics).toMatchObject([
      { pluginId: "broken-entry", code: "setup-entry-load-failed" },
    ]);
  });

  it("surfaces setup entry load failures from targeted provider lookup", () => {
    const brokenRoot = makeTempDir();
    writeSetupApiStub(brokenRoot);
    mockSinglePlugin({
      id: "broken-provider",
      rootDir: brokenRoot,
      setup: { providers: [{ id: "broken-provider" }] },
    });
    mocks.createJiti.mockImplementation(() => () => {
      throw new Error("targeted module parse failed");
    });

    expect(
      resolvePluginSetupProviderCore({ provider: "broken-provider", env: {} }),
    ).toBeUndefined();
    expect(setupRegistryWarn).toHaveBeenCalledWith(
      expect.stringContaining("setup-entry-load-failed"),
    );
  });

  it("reports unavailable setup runtime access with the plugin id and registration mode", () => {
    const pluginRoot = makeTempDir();
    writeSetupApiStub(pluginRoot);
    mockSinglePlugin({ id: "runtime-dependent-setup", rootDir: pluginRoot });
    mocks.createJiti.mockImplementation(() => () => ({
      default: {
        register(api: import("./types.js").OpenClawPluginApi) {
          api.runtime.state.openSyncKeyedStore({ namespace: "example", maxEntries: 1 });
        },
      },
    }));

    expect(resolvePluginSetupRegistry({ env: {} }).diagnostics).toMatchObject([
      {
        pluginId: "runtime-dependent-setup",
        code: "setup-registration-failed",
        message: expect.stringContaining(
          'Plugin "runtime-dependent-setup" runtime is intentionally unavailable during "setup-only" registration.',
        ),
      },
    ]);
  });

  it("publishes each plugin setup registration atomically on synchronous success", () => {
    const throwingRoot = makeTempDir();
    const healthyRoot = makeTempDir();
    writeSetupApiStub(throwingRoot);
    writeSetupApiStub(healthyRoot);
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "shared-plugin",
          rootDir: throwingRoot,
          setup: {
            providers: [{ id: "shared-provider" }],
            cliBackends: ["shared-cli"],
          },
        },
        {
          id: "shared-plugin",
          rootDir: healthyRoot,
          setup: {
            providers: [{ id: "shared-provider" }],
            cliBackends: ["shared-cli"],
          },
        },
      ],
      diagnostics: [],
    });
    const throwingRegister = vi.fn((api: SetupRegistryApi) => {
      api.registerProvider({ id: "shared-provider", label: "Throwing", auth: [] });
      api.registerProvider({ id: "SHARED-PROVIDER", label: "Throwing duplicate", auth: [] });
      api.registerCliBackend({ id: "shared-cli", config: { command: "throwing" } });
      api.registerCliBackend({ id: "SHARED-CLI", config: { command: "throwing-duplicate" } });
      api.registerConfigMigration((config) => ({ config, changes: ["throwing"] }));
      api.registerAutoEnableProbe(() => "throwing");
      throw new Error("setup registration failed");
    });
    const healthyRegister = vi.fn((api: SetupRegistryApi) => {
      api.registerProvider({ id: "shared-provider", label: "Healthy", auth: [] });
      api.registerProvider({ id: "SHARED-PROVIDER", label: "Healthy duplicate", auth: [] });
      api.registerCliBackend({ id: "shared-cli", config: { command: "healthy" } });
      api.registerCliBackend({ id: "SHARED-CLI", config: { command: "healthy-duplicate" } });
      api.registerConfigMigration((config) => ({ config, changes: ["healthy"] }));
      api.registerAutoEnableProbe(() => "healthy");
    });
    mocks.createJiti.mockImplementation((modulePath: string) => {
      const register = modulePath.includes(throwingRoot) ? throwingRegister : healthyRegister;
      return () => ({ default: { register } });
    });

    const first = resolvePluginSetupRegistry();
    const second = resolvePluginSetupRegistry();

    for (const registry of [first, second]) {
      expect(
        registry.providers.map(({ pluginId, provider }) => ({
          pluginId,
          id: provider.id,
          label: provider.label,
        })),
      ).toEqual([{ pluginId: "shared-plugin", id: "shared-provider", label: "Healthy" }]);
      expect(
        registry.cliBackends.map(({ pluginId, backend }) => ({
          pluginId,
          id: backend.id,
          command: backend.config.command,
        })),
      ).toEqual([{ pluginId: "shared-plugin", id: "shared-cli", command: "healthy" }]);
      expect(registry.configMigrations).toHaveLength(1);
      expect(registry.configMigrations[0]?.migrate({} as never)?.changes).toEqual(["healthy"]);
      expect(registry.autoEnableProbes).toHaveLength(1);
      expect(registry.autoEnableProbes[0]?.probe({ config: {}, env: {} } as never)).toBe("healthy");
      // The throwing registration is recorded, not silently dropped.
      expect(registry.diagnostics).toMatchObject([
        { pluginId: "shared-plugin", code: "setup-registration-failed" },
      ]);
    }
    expect(second).not.toBe(first);
    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    expect(throwingRegister).toHaveBeenCalledTimes(1);
    expect(healthyRegister).toHaveBeenCalledTimes(1);
  });

  it("ignores setup contributions registered after the synchronous callback returns", async () => {
    const pluginRoot = makeTempDir();
    writeSetupApiStub(pluginRoot);
    mockSinglePlugin({ id: "async-plugin", rootDir: pluginRoot });
    mocks.createJiti.mockImplementation(() => {
      return () => ({
        default: {
          register(api: SetupRegistryApi) {
            api.registerProvider({ id: "sync-provider", label: "Sync", auth: [] });
            api.registerCliBackend({ id: "sync-cli", config: { command: "sync" } });
            api.registerConfigMigration((config) => ({ config, changes: ["sync"] }));
            api.registerAutoEnableProbe(() => "sync");
            return Promise.resolve().then(() => {
              api.registerProvider({ id: "async-provider", label: "Async", auth: [] });
              api.registerCliBackend({ id: "async-cli", config: { command: "async" } });
              api.registerConfigMigration((config) => ({ config, changes: ["async"] }));
              api.registerAutoEnableProbe(() => "async");
            });
          },
        },
      });
    });

    const first = resolvePluginSetupRegistry();
    await Promise.resolve();
    await Promise.resolve();
    const second = resolvePluginSetupRegistry();

    for (const registry of [first, second]) {
      expect(registry.providers.map((entry) => entry.provider.id)).toEqual(["sync-provider"]);
      expect(registry.cliBackends.map((entry) => entry.backend.id)).toEqual(["sync-cli"]);
      expect(registry.configMigrations).toHaveLength(1);
      expect(registry.autoEnableProbes).toHaveLength(1);
    }
  });

  it("fails closed when multiple plugins claim the same setup provider id", () => {
    mockDuplicateSetupClaims({
      duplicatePluginId: false,
      kind: "provider",
    });

    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toBeUndefined();
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("fails closed when duplicate plugin ids shadow the same setup provider id", () => {
    mockDuplicateSetupClaims({
      duplicatePluginId: true,
      kind: "provider",
    });

    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })).toBeUndefined();
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("fails closed when multiple plugins claim the same setup cli backend id", () => {
    mockDuplicateSetupClaims({
      duplicatePluginId: false,
      kind: "cliBackend",
    });

    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toBeUndefined();
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("fails closed when duplicate plugin ids shadow the same setup cli backend id", () => {
    mockDuplicateSetupClaims({
      duplicatePluginId: true,
      kind: "cliBackend",
    });

    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toBeUndefined();
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("does not retain setup lookup cache entries", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          rootDir: pluginRoot,
          setup: {
            providers: [{ id: "openai" }, { id: "anthropic" }],
            cliBackends: ["codex-cli", "claude-cli"],
            requiresRuntime: true,
          },
        },
      ],
      diagnostics: [],
    });
    const registerSetup = vi.fn(
      (api: {
        registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
        registerCliBackend: (backend: { id: string; config: { command: string } }) => void;
      }) => {
        api.registerProvider({ id: "openai", label: "OpenAI", auth: [] });
        api.registerProvider({ id: "anthropic", label: "Anthropic", auth: [] });
        api.registerCliBackend({ id: "codex-cli", config: { command: "codex" } });
        api.registerCliBackend({ id: "claude-cli", config: { command: "claude" } });
      },
    );
    const loadSetupModule = vi.fn(() => ({
      default: {
        register: registerSetup,
      },
    }));
    mocks.createJiti.mockImplementation(() => loadSetupModule);

    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })?.id).toBe("openai");
    expect(resolvePluginSetupProviderCore({ provider: "anthropic", env: {} })?.id).toBe(
      "anthropic",
    );
    expect(resolvePluginSetupProviderCore({ provider: "openai", env: {} })?.id).toBe("openai");

    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })?.backend.id).toBe(
      "codex-cli",
    );
    expect(resolvePluginSetupCliBackend({ backend: "claude-cli", env: {} })?.backend.id).toBe(
      "claude-cli",
    );
    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })?.backend.id).toBe(
      "codex-cli",
    );

    resolvePluginSetupRegistry({
      env: {},
      pluginIds: ["openai"],
    });
    resolvePluginSetupRegistry({
      env: {},
      pluginIds: ["anthropic"],
    });
    expect(loadSetupModule).toHaveBeenCalledTimes(1);
    expect(registerSetup).toHaveBeenCalledTimes(7);
  });

  describe("result cache (ambient process.env)", () => {
    it("keeps setup registrations isolated between plugin cache operations", () => {
      const firstRoot = makeTempDir();
      const secondRoot = makeTempDir();
      writeSetupApiStub(firstRoot);
      writeSetupApiStub(secondRoot);
      const firstCache = createPluginCache();
      const secondCache = createPluginCache();
      const roots = new Map([
        [firstCache, firstRoot],
        [secondCache, secondRoot],
      ]);
      const labels = new Map([
        [firstRoot, "first operation"],
        [secondRoot, "second operation"],
      ]);
      const resolveFor = (cache: typeof firstCache) =>
        withPluginCache(cache, () => {
          const rootDir = roots.get(cache)!;
          mockSinglePlugin({
            id: "setup-owner",
            rootDir,
            setup: { requiresRuntime: true, providers: [{ id: "setup-owner" }] },
          });
          return resolvePluginSetupRegistry().providers[0]?.provider.label;
        });
      mocks.createJiti.mockImplementation(() => (modulePath: string) => ({
        default: {
          register(api: SetupRegistryApi) {
            const label = [...labels].find(
              ([rootDir]) =>
                modulePath === path.join(rootDir, "setup-api.js") ||
                modulePath === pathToFileURL(path.join(rootDir, "setup-api.js")).href,
            )?.[1];
            if (!label) {
              throw new Error(`Unexpected setup artifact: ${modulePath}`);
            }
            api.registerProvider({ id: "setup-owner", label, auth: [] });
          },
        },
      }));

      expect(resolveFor(firstCache)).toBe("first operation");
      expect(resolveFor(secondCache)).toBe("second operation");
      expect(resolveFor(firstCache)).toBe("first operation");
    });

    function mockOpenAiProviderPlugin(): void {
      mocks.loadPluginManifestRegistry.mockReturnValue({
        plugins: [
          {
            id: "openai",
            origin: "bundled",
            rootDir: makeTempDir(),
            setup: { providers: [{ id: "openai" }] },
          },
        ],
        diagnostics: [],
      });
    }

    it("memoizes no-config resolutions without rescanning manifests", () => {
      mockOpenAiProviderPlugin();
      mocks.loadPluginManifestRegistry.mockClear();
      const first = resolvePluginSetupRegistry();
      const second = resolvePluginSetupRegistry();
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    });

    it("recomputes after clearPluginSetupRegistryCache (reset contract)", () => {
      mockOpenAiProviderPlugin();
      mocks.loadPluginManifestRegistry.mockClear();
      const first = resolvePluginSetupRegistry();
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
      clearPluginSetupRegistryCache();
      // A hit also returns a fresh clone; only the loader call count proves invalidation.
      const second = resolvePluginSetupRegistry();
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
    });

    it("recomputes after clearPluginMetadataLifecycleCaches (install/reload/doctor)", async () => {
      const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");
      mockOpenAiProviderPlugin();
      mocks.loadPluginManifestRegistry.mockClear();
      const first = resolvePluginSetupRegistry();
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
      clearPluginMetadataLifecycleCaches();
      const second = resolvePluginSetupRegistry();
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
    });

    it("keys distinct plugin-id scopes without collision", () => {
      mockOpenAiProviderPlugin();
      const all = resolvePluginSetupRegistry();
      const scoped = resolvePluginSetupRegistry({ pluginIds: ["__no_such_plugin__"] });
      expect(scoped).not.toBe(all);
      expect(scoped.providers).toStrictEqual([]);
      const scopedAgain = resolvePluginSetupRegistry({ pluginIds: ["__no_such_plugin__"] });
      expect(scopedAgain).toEqual(scoped);
      expect(scopedAgain).not.toBe(scoped);
    });

    it("does not let returned entries mutate cached setup results", () => {
      const pluginRoot = makeTempDir();
      writeSetupApiStub(pluginRoot);
      mocks.loadPluginManifestRegistry.mockReturnValue({
        plugins: [
          {
            id: "openai",
            origin: "bundled",
            rootDir: pluginRoot,
            setup: {
              providers: [{ id: "openai" }],
              cliBackends: ["codex-cli"],
              requiresRuntime: true,
            },
          },
        ],
        diagnostics: [],
      });
      mocks.createJiti.mockImplementation(() => {
        return () => ({
          default: {
            register(api: {
              registerProvider: (provider: {
                id: string;
                label: string;
                aliases: string[];
                auth: [];
              }) => void;
              registerCliBackend: (backend: {
                id: string;
                config: { command: string; args: string[] };
              }) => void;
            }) {
              api.registerProvider({
                id: "openai",
                label: "OpenAI",
                aliases: ["openai"],
                auth: [],
              });
              api.registerCliBackend({
                id: "codex-cli",
                config: { command: "codex", args: ["run"] },
              });
            },
          },
        });
      });

      const first = resolvePluginSetupRegistry();
      const firstProvider = first.providers[0]?.provider;
      const firstBackend = first.cliBackends[0]?.backend;
      if (!firstProvider || !firstBackend) {
        throw new Error("Expected setup provider and CLI backend");
      }
      firstProvider.label = "Mutated";
      firstProvider.aliases?.push("mutated");
      const firstBackendConfig = firstBackend.config as { command: string; args: string[] };
      firstBackendConfig.command = "mutated";
      firstBackendConfig.args.push("mutated");

      const second = resolvePluginSetupRegistry();
      expect(second.providers[0]?.provider).toMatchObject({
        id: "openai",
        label: "OpenAI",
        aliases: ["openai"],
      });
      expect(second.cliBackends[0]?.backend.config).toMatchObject({
        command: "codex",
        args: ["run"],
      });

      second.providers[0]?.provider.aliases?.push("mutated-again");
      const secondBackendConfig = second.cliBackends[0]?.backend.config as {
        command: string;
        args: string[];
      };
      secondBackendConfig.args.push("mutated-again");

      const third = resolvePluginSetupRegistry();
      expect(third.providers[0]?.provider.aliases).toEqual(["openai"]);
      expect(third.cliBackends[0]?.backend.config).toMatchObject({
        command: "codex",
        args: ["run"],
      });
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(1);
    });

    it("keys ambient entries by discovery environment", () => {
      const firstRoot = makeTempDir();
      const secondRoot = makeTempDir();
      writeSetupApiStub(firstRoot);
      writeSetupApiStub(secondRoot);
      mocks.loadPluginManifestRegistry.mockImplementation(
        (params?: { env?: NodeJS.ProcessEnv }) => {
          const id = params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR === secondRoot ? "second" : "first";
          return {
            plugins: [
              {
                id,
                origin: "bundled",
                rootDir: id === "second" ? secondRoot : firstRoot,
                setup: { providers: [{ id }] },
              },
            ],
            diagnostics: [],
          };
        },
      );
      mocks.createJiti.mockImplementation((modulePath: string) => {
        const id = modulePath.includes(secondRoot) ? "second" : "first";
        return () => ({
          default: {
            register(api: {
              registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
            }) {
              api.registerProvider({ id, label: id, auth: [] });
            },
          },
        });
      });
      const previousBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

      try {
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = firstRoot;
        expect(resolvePluginSetupRegistry().providers.map((entry) => entry.provider.id)).toEqual([
          "first",
        ]);
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = secondRoot;
        expect(resolvePluginSetupRegistry().providers.map((entry) => entry.provider.id)).toEqual([
          "second",
        ]);
      } finally {
        if (previousBundledDir === undefined) {
          delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
        } else {
          process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledDir;
        }
      }
      expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledTimes(2);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
