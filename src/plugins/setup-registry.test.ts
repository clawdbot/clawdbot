import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldExpectNativeJitiForJavaScriptTestRuntime } from "../test-utils/jiti-runtime.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import {
  getRegistryJitiMocks,
  resetRegistryJitiMocks,
} from "./test-helpers/registry-jiti-mocks.js";

// plugin-module-loader-cache prefers native require() for compiled .js before falling
// back to jiti. These tests scripts plugin-loading behaviour through the
// source-transform mock — disable the native-require fast path so the mocked source transformer
// stays authoritative for the test fixture files on disk.
vi.mock("./native-module-require.js", () => ({
  isJavaScriptModulePath: (_modulePath: string) => false,
  tryNativeRequireJavaScriptModule: (_modulePath: string) => ({ ok: false }),
}));

const tempDirs: string[] = [];
const mocks = getRegistryJitiMocks();

let clearPluginSetupRegistryCache: typeof import("./setup-registry.js").clearPluginSetupRegistryCache;
let resolvePluginSetupRegistry: typeof import("./setup-registry.js").resolvePluginSetupRegistry;
let resolvePluginSetupProvider: typeof import("./setup-registry.js").resolvePluginSetupProvider;
let resolvePluginSetupCliBackend: typeof import("./setup-registry.js").resolvePluginSetupCliBackend;
let runPluginSetupConfigMigrations: typeof import("./setup-registry.js").runPluginSetupConfigMigrations;

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
  expect(unhandledRejections).toEqual([]);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("setup-registry module loader", () => {
  beforeEach(async () => {
    resetRegistryJitiMocks();
    vi.resetModules();
    ({
      clearPluginSetupRegistryCache,
      resolvePluginSetupRegistry,
      resolvePluginSetupProvider,
      resolvePluginSetupCliBackend,
      runPluginSetupConfigMigrations,
    } = await import("./setup-registry.js"));
    clearPluginSetupRegistryCache();
  });

  it("uses the runtime-supported source-transform boundary on Windows for setup-api modules", () => {
    const pluginRoot = makeTempDir();
    fs.writeFileSync(path.join(pluginRoot, "setup-api.js"), "export default {};\n", "utf-8");
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "test-plugin", rootDir: pluginRoot }],
      diagnostics: [],
    });
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const restoreVersions = forceNodeRuntimeVersionsForTest();
    const expectedTryNative = shouldExpectNativeJitiForJavaScriptTestRuntime();

    try {
      resolvePluginSetupRegistry({
        workspaceDir: pluginRoot,
        env: {},
      });
    } finally {
      restoreVersions();
      platformSpy.mockRestore();
    }

    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(
      pathToFileURL(path.join(pluginRoot, "setup-api.js"), { windows: true }).href,
    );
    expect(mocks.createJiti.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        tryNative: expectedTryNative,
      }),
    );
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

    expect(mocks.loadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["test-plugin"],
      }),
    );
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

    expect(result.changes).toEqual([]);
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
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(bedrockRoot, "setup-api.js"));
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

    expect(resolvePluginSetupProvider({ provider: "amazon-bedrock", env: {} })).toEqual(
      expect.objectContaining({
        id: "amazon-bedrock",
        label: "Amazon Bedrock",
      }),
    );
    expect(resolvePluginSetupProvider({ provider: "legacy-bedrock", env: {} })).toBeUndefined();
    expect(mocks.createJiti).toHaveBeenCalledTimes(1);
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(pluginRoot, "setup-api.js"));
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

    expect(resolvePluginSetupProvider({ provider: "openai", env: {} })).toBeUndefined();
    expect(resolvePluginSetupCliBackend({ backend: "codex-cli", env: {} })).toBeUndefined();
    expect(resolvePluginSetupRegistry({ env: {} })).toEqual({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [
        expect.objectContaining({
          pluginId: "openai",
          code: "setup-descriptor-runtime-disabled",
        }),
      ],
    });
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

  it("reports setup descriptor drift without rejecting runtime registrations", () => {
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
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({
        pluginId: "openai",
        code: "setup-descriptor-provider-missing-runtime",
        declaredId: "openai",
      }),
      expect.objectContaining({
        pluginId: "openai",
        code: "setup-descriptor-provider-runtime-undeclared",
        runtimeId: "anthropic",
      }),
      expect.objectContaining({
        pluginId: "openai",
        code: "setup-descriptor-cli-backend-missing-runtime",
        declaredId: "codex-cli",
      }),
      expect.objectContaining({
        pluginId: "openai",
        code: "setup-descriptor-cli-backend-runtime-undeclared",
        runtimeId: "claude-cli",
      }),
    ]);
  });

  it("does not report drift when setup descriptors match runtime registrations", () => {
    mockOpenAiCliBackendRegistration({
      requiresRuntime: true,
    });

    expect(resolvePluginSetupRegistry({ env: {} }).diagnostics).toEqual([]);
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
      expect(resolvePluginSetupProvider({ provider: "openai", env: {} })).toBeUndefined();
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
    expect(mocks.createJiti.mock.calls[0]?.[0]).toBe(path.join(openaiRoot, "setup-api.js"));
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
      expect(resolvePluginSetupProvider({ provider: "openai", env: {} })).toEqual(
        expect.objectContaining({
          id: "openai",
          label: "OpenAI",
        }),
      );
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

  it("fails closed when multiple plugins claim the same setup provider id", () => {
    mockDuplicateSetupClaims({
      duplicatePluginId: false,
      kind: "provider",
    });

    expect(resolvePluginSetupProvider({ provider: "openai", env: {} })).toBeUndefined();
    expect(mocks.createJiti).not.toHaveBeenCalled();
  });

  it("fails closed when duplicate plugin ids shadow the same setup provider id", () => {
    mockDuplicateSetupClaims({
      duplicatePluginId: true,
      kind: "provider",
    });

    expect(resolvePluginSetupProvider({ provider: "openai", env: {} })).toBeUndefined();
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
    const loadSetupModule = vi.fn(() => ({
      default: {
        register(api: {
          registerProvider: (provider: { id: string; label: string; auth: [] }) => void;
          registerCliBackend: (backend: { id: string; config: { command: string } }) => void;
        }) {
          api.registerProvider({ id: "openai", label: "OpenAI", auth: [] });
          api.registerProvider({ id: "anthropic", label: "Anthropic", auth: [] });
          api.registerCliBackend({ id: "codex-cli", config: { command: "codex" } });
          api.registerCliBackend({ id: "claude-cli", config: { command: "claude" } });
        },
      },
    }));
    mocks.createJiti.mockImplementation(() => loadSetupModule);

    expect(resolvePluginSetupProvider({ provider: "openai", env: {} })?.id).toBe("openai");
    expect(resolvePluginSetupProvider({ provider: "anthropic", env: {} })?.id).toBe("anthropic");
    expect(resolvePluginSetupProvider({ provider: "openai", env: {} })?.id).toBe("openai");

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
    expect(loadSetupModule).toHaveBeenCalledTimes(7);
  });
});
