import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withoutPluginInstallRecords } from "../plugins/installed-plugin-index-records.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { applyCrestodianModelSelection } from "./setup-apply.js";
import {
  activateSetupInference,
  detectSetupInference,
  listSetupInferenceManualProviders,
  verifySetupInference,
} from "./setup-inference.js";

const mocks = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(),
}));

vi.mock("./audit.js", () => ({
  appendCrestodianAuditEntry: mocks.appendAudit,
}));

vi.mock("../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: mocks.ensureSelectedAgentHarnessPlugin,
}));

vi.mock("../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistryAfterConfigMutation,
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: vi.fn(async () => ({
      exists: false,
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {},
    })),
  };
});

vi.mock("../commands/onboard-inference.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-inference.js")>();
  return {
    ...actual,
    detectNativeCodexAppServer: vi.fn(async () => ({
      command: "codex",
      found: false,
      error: "not found",
    })),
    detectInferenceBackends: vi.fn(async () => [
      {
        kind: "claude-cli",
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5",
        label: "Codex",
        detail: "installed, not logged in",
        credentials: false,
      },
    ]),
  };
});

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "setup-inference-test-"));
}

describe("applyCrestodianModelSelection", () => {
  it("overrides higher-priority runtime metadata on an inheriting default agent", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = await applyCrestodianModelSelection({
      config,
      model: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });

    expect(result.agents?.defaults?.model).toMatchObject({ primary: "openai/gpt-5.5" });
    expect(result.agents?.defaults?.models).toBeUndefined();
    expect(result.agents?.list?.[0]).toMatchObject({
      id: "ops",
      models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
    });
    expect(config.agents.list[0]?.models["openai/gpt-5.5"]?.agentRuntime?.id).toBe("openclaw");
  });

  it("pins a fresh runtime without creating a global model allowlist", async () => {
    const result = await applyCrestodianModelSelection({
      config: {},
      model: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });

    expect(result.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.agents?.defaults?.models).toBeUndefined();
    expect(result.agents?.list).toMatchObject([
      {
        id: "main",
        default: true,
        models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
      },
    ]);
  });

  it("adds an agent-owned cross-provider selection to the global visibility map", async () => {
    const config = {
      agents: {
        defaults: {
          models: { "openai/*": { alias: "OpenAI models" } },
        },
        list: [
          {
            id: "ops",
            default: true,
            model: { primary: "openai/gpt-5.4" },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = await applyCrestodianModelSelection({
      config,
      model: "anthropic/claude-opus-4-8",
      agentRuntimeId: "openclaw",
    });

    expect(result.agents?.defaults?.models).toMatchObject({
      "openai/*": { alias: "OpenAI models" },
      "anthropic/claude-opus-4-8": {},
    });
    expect(result.agents?.list?.[0]).toMatchObject({
      id: "ops",
      model: { primary: "anthropic/claude-opus-4-8" },
      models: {
        "anthropic/claude-opus-4-8": { agentRuntime: { id: "openclaw" } },
      },
    });
  });
});

describe("detectSetupInference", () => {
  it("preserves the shared inference candidate order", async () => {
    const resolveManifestProviderAuthChoices = vi.fn(() => []);
    const detection = await detectSetupInference({ resolveManifestProviderAuthChoices });
    expect(detection.candidates).toHaveLength(2);
    expect(detection.candidates[0]).toMatchObject({ kind: "claude-cli", recommended: false });
    expect(detection.candidates[1]).toMatchObject({ kind: "codex-cli", recommended: false });
    expect(detection.codexAppServerDetected).toBe(true);
    expect(detection.setupComplete).toBe(false);
    expect(detection.workspace.length).toBeGreaterThan(0);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ includeWorkspacePlugins: false }),
    );
  });

  it("surfaces an invalid existing config instead of treating it as fresh", async () => {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    vi.mocked(readConfigFileSnapshot).mockResolvedValueOnce({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      issues: [{ path: "agents.defaults.model", message: "Expected a model reference" }],
      config: {},
    } as never);

    await expect(detectSetupInference()).rejects.toThrow(
      "OpenClaw config /tmp/openclaw.json is invalid (agents.defaults.model: Expected a model reference)",
    );
  });

  it("lists text-inference key and token methods from provider manifests", () => {
    const choices: ProviderAuthChoiceMetadata[] = [
      {
        pluginId: "visuals",
        providerId: "visuals",
        methodId: "api-key",
        choiceId: "visuals-api-key",
        choiceLabel: "Visuals API key",
        appGuidedSecret: true,
        onboardingScopes: ["image-generation"],
      },
      {
        pluginId: "zeta",
        providerId: "zeta",
        methodId: "oauth",
        choiceId: "zeta-oauth",
        choiceLabel: "Zeta OAuth",
      },
      {
        pluginId: "zeta",
        providerId: "zeta",
        methodId: "direct-key",
        choiceId: "zeta-api-key",
        choiceLabel: "Zeta API key",
        choiceHint: "Direct key",
        optionKey: "zetaApiKey",
        cliOption: "--zeta-api-key <key>",
        appGuidedSecret: true,
      },
      {
        pluginId: "alpha",
        providerId: "alpha",
        methodId: "api-key",
        choiceId: "alpha-api-key",
        choiceLabel: "Alpha API key",
        appGuidedSecret: true,
      },
      {
        pluginId: "github-copilot",
        providerId: "github-copilot",
        methodId: "device",
        choiceId: "github-copilot",
        choiceLabel: "GitHub Copilot",
        optionKey: "githubCopilotToken",
        cliOption: "--github-copilot-token <token>",
        appGuidedSecret: true,
      },
    ];

    expect(listSetupInferenceManualProviders(choices)).toEqual([
      {
        id: "alpha-api-key",
        label: "Alpha API key",
      },
      {
        id: "github-copilot",
        label: "GitHub Copilot",
      },
      {
        id: "zeta-api-key",
        label: "Zeta API key",
        hint: "Direct key",
      },
    ]);
  });
});

describe("activateSetupInference", () => {
  beforeEach(() => {
    mocks.appendAudit.mockReset();
    mocks.ensureSelectedAgentHarnessPlugin.mockReset().mockResolvedValue(undefined);
    mocks.refreshPluginRegistryAfterConfigMutation.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runCodexSetupWithFinalConfig(params: {
    initialConfig?: OpenClawConfig;
    currentConfig: OpenClawConfig;
    sourceConfig: OpenClawConfig;
  }) {
    const initialConfig = params.initialConfig ?? params.sourceConfig;
    let persistedConfig = structuredClone(params.currentConfig);
    const applySetup = vi.fn(
      async (input: {
        configPatch?: unknown;
        finalizeConfig?: (config: OpenClawConfig, sourceConfig: OpenClawConfig) => OpenClawConfig;
      }) => {
        const patched =
          input.configPatch === undefined
            ? persistedConfig
            : (applyMergePatch(persistedConfig, input.configPatch) as OpenClawConfig);
        persistedConfig = input.finalizeConfig
          ? input.finalizeConfig(patched, params.sourceConfig)
          : patched;
        return { configPath: "/tmp/openclaw.json", lines: ["ok"] };
      },
    );
    const refreshPluginRegistry = vi.fn(async () => {});
    const transformConfig = vi.fn(
      async (input: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { sourceConfig: OpenClawConfig } },
        ) => { nextConfig: OpenClawConfig };
      }) => {
        const transformed = input.transform(persistedConfig, {
          snapshot: { sourceConfig: params.sourceConfig },
        });
        persistedConfig = withoutPluginInstallRecords(transformed.nextConfig);
        return { nextConfig: persistedConfig };
      },
    );
    const result = await activateSetupInference({
      kind: "codex-cli",
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
          cfg,
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    return { result, persistedConfig, applySetup, refreshPluginRegistry, transformConfig };
  }

  it("persists setup only after the live test succeeds", async () => {
    const applySetup = vi.fn(async (_params: unknown) => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before-setup",
      configHashAfter: "after-setup",
      lines: ["ok"],
    }));
    const runCliAgent = vi.fn(async (_params: unknown) => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelRef).toBe("claude-cli/claude-opus-4-8");
      expect(result.lines).toEqual(["ok"]);
    }
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledOnce();
    expect(mocks.appendAudit).toHaveBeenCalledWith({
      operation: "crestodian.setup",
      summary: "Configured AI access through Crestodian setup",
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before-setup",
      configHashAfter: "after-setup",
      details: {
        modelRef: "claude-cli/claude-opus-4-8",
        inferenceKind: "claude-cli",
      },
    });
    expect(applySetup.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-cli/claude-opus-4-8",
      expectedAgentId: "main",
      surface: "gateway",
    });
  });

  it("reports an audit warning without turning a committed setup into a failure", async () => {
    mocks.appendAudit.mockRejectedValueOnce(new Error("audit directory is read-only"));
    const error = vi.fn();
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime: { log: () => {}, error, exit: () => {} } as never,
      deps: {
        runCliAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: vi.fn(async () => ({
          configPath: "/tmp/openclaw.json",
          configHashBefore: "before-setup",
          configHashAfter: "after-setup",
          lines: ["Setup committed"],
        })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      lines: [
        "Setup committed",
        "Setup completed, but OpenClaw could not record its audit entry: audit directory is read-only",
      ],
    });
    expect(error).toHaveBeenCalledWith(
      "Setup completed, but OpenClaw could not record its audit entry: audit directory is read-only",
    );
  });

  it("lets an enclosing persistent operation own the setup audit", async () => {
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      recordSetupAudit: false,
      runtime,
      deps: {
        runCliAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: vi.fn(async () => ({
          configPath: "/tmp/openclaw.json",
          configHashBefore: "before-setup",
          configHashAfter: "after-setup",
          lines: ["Setup committed"],
        })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, lines: ["Setup committed"] });
    expect(mocks.appendAudit).not.toHaveBeenCalled();
  });

  it("surfaces an invalid existing config without probing or persisting", async () => {
    const runEmbeddedAgent = vi.fn();
    const applySetup = vi.fn();
    await expect(
      activateSetupInference({
        kind: "anthropic-api-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: false,
            path: "/tmp/openclaw.json",
            issues: [{ path: "gateway.port", message: "Expected a number" }],
            config: {},
          })) as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          applySetup: applySetup as never,
        },
      }),
    ).rejects.toThrow(
      "OpenClaw config /tmp/openclaw.json is invalid (gateway.port: Expected a number). Fix it before running setup.",
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "openai-api-key" as const,
      modelRef: "openai/gpt-5.6",
      staleRuntime: "codex",
    },
    {
      kind: "anthropic-api-key" as const,
      modelRef: "anthropic/claude-opus-4-8",
      staleRuntime: "claude-cli",
    },
  ])("pins $kind to the OpenClaw runtime after a passing test", async (testCase) => {
    const initialConfig: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            [testCase.modelRef]: {
              alias: "Keep me",
              agentRuntime: { id: testCase.staleRuntime },
            },
          },
        },
      },
    };
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));

    const result = await activateSetupInference({
      kind: testCase.kind,
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: testCase.modelRef });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              models: expect.objectContaining({
                [testCase.modelRef]: expect.objectContaining({
                  alias: "Keep me",
                  agentRuntime: { id: testCase.staleRuntime },
                }),
              }),
            }),
            list: expect.arrayContaining([
              expect.objectContaining({
                id: "main",
                models: {
                  [testCase.modelRef]: { agentRuntime: { id: "openclaw" } },
                },
              }),
            ]),
          }),
        }),
      }),
    );
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ model: testCase.modelRef, agentRuntimeId: "openclaw" }),
    );
  });

  it("enables detected Codex supervision while selecting Claude as the primary backend", async () => {
    const sourceConfig = {} satisfies OpenClawConfig;
    let persistedConfig: OpenClawConfig = {};
    const pendingCodexInstall = {
      source: "npm" as const,
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    };
    const transformConfig = vi.fn(
      async (input: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { sourceConfig: OpenClawConfig } },
        ) => { nextConfig: OpenClawConfig };
      }) => {
        const transformed = input.transform(persistedConfig, {
          snapshot: { sourceConfig },
        });
        persistedConfig = withoutPluginInstallRecords(transformed.nextConfig);
        return { nextConfig: persistedConfig };
      },
    );
    const ensureCodexRuntimePlugin = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          installs: { codex: pendingCodexInstall },
        },
      },
      required: true,
      installed: true,
      status: "installed" as const,
    }));
    const runCliAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const refreshPluginRegistry = vi.fn(async () => {});
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          sourceConfig,
          config: sourceConfig,
          runtimeConfig: sourceConfig,
        })) as never,
        detectNativeCodexAppServer: vi.fn(async () => ({ command: "codex", found: true })),
        ensureCodexRuntimePlugin: ensureCodexRuntimePlugin as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        runCliAgent: runCliAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude-cli", model: "claude-opus-4-8" }),
    );
    expect(ensureCodexRuntimePlugin).toHaveBeenCalledOnce();
    expect(transformConfig).toHaveBeenCalledTimes(2);
    expect(persistedConfig).toEqual({
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { supervision: { enabled: true } },
          },
        },
      },
    });
    expect(refreshPluginRegistry).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-cli/claude-opus-4-8" }),
    );
  });

  it("does not configure Codex supervision when native App Server detection fails", async () => {
    const ensureCodexRuntimePlugin = vi.fn();
    const transformConfig = vi.fn();
    const detectNativeCodexAppServer = vi.fn(async () => ({
      command: "codex",
      found: false,
      error: "not found",
    }));

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        detectNativeCodexAppServer,
        ensureCodexRuntimePlugin: ensureCodexRuntimePlugin as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        runCliAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(detectNativeCodexAppServer).toHaveBeenCalledOnce();
    expect(ensureCodexRuntimePlugin).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an explicitly disabled Codex plugin",
      { plugins: { entries: { codex: { enabled: false } } } } satisfies OpenClawConfig,
    ],
    [
      "an explicit supervision opt-out",
      {
        plugins: {
          entries: { codex: { config: { supervision: { enabled: false } } } },
        },
      } satisfies OpenClawConfig,
    ],
    ["plugin policy", { plugins: { deny: ["codex"] } } satisfies OpenClawConfig],
  ])("preserves %s while selecting another backend", async (_label, config) => {
    const detectNativeCodexAppServer = vi.fn(async () => ({ command: "codex", found: true }));
    const ensureCodexRuntimePlugin = vi.fn();
    const transformConfig = vi.fn();

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          sourceConfig: config,
          config,
          runtimeConfig: config,
        })) as never,
        detectNativeCodexAppServer,
        ensureCodexRuntimePlugin: ensureCodexRuntimePlugin as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        runCliAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(detectNativeCodexAppServer).not.toHaveBeenCalled();
    expect(ensureCodexRuntimePlugin).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it("does not touch config when the live test fails", async () => {
    const providerSecret = "gsk_abcdefghijklmnop";
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] }));
    const runCliAgent = vi.fn(async () => {
      throw new Error(`401 invalid_api_key ${providerSecret}`);
    });
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid_api_key");
      expect(result.error).not.toContain(providerSecret);
    }
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("treats an empty model reply as a failure", async () => {
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] }));
    const runEmbeddedAgent = vi.fn(async () => ({ payloads: [] }));
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result).toMatchObject({ ok: false, status: "format" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^probe-setup-inference-/),
        sessionId: expect.stringMatching(/^probe-setup-inference-.*-session$/),
        sessionKey: expect.stringMatching(/^temp:setup-inference:probe-setup-inference-/),
        lane: "session:probe-setup-inference:anthropic",
      }),
    );
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("probes a built-in API candidate through the effective default-agent route", async () => {
    const initialConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            model: { primary: "openai/gpt-5.4" },
            models: {
              "anthropic/claude-opus-4-8": { agentRuntime: { id: "codex" } },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));

    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "anthropic/claude-opus-4-8" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        provider: "anthropic",
        model: "claude-opus-4-8",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            list: [
              expect.objectContaining({
                id: "ops",
                model: { primary: "anthropic/claude-opus-4-8" },
                models: {
                  "anthropic/claude-opus-4-8": { agentRuntime: { id: "openclaw" } },
                },
              }),
            ],
          }),
        }),
      }),
    );
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic/claude-opus-4-8",
        agentRuntimeId: "openclaw",
      }),
    );
  });

  it("does not persist a model when the default agent changes during its live probe", async () => {
    const initialConfig = {
      agents: { list: [{ id: "ops", default: true }] },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: {
        list: [{ id: "ops" }, { id: "concurrent", default: true }],
      },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: initialConfig,
        runtimeConfig: initialConfig,
      })
      .mockResolvedValue({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: changedConfig,
        runtimeConfig: changedConfig,
      });
    const applySetup = vi.fn();

    await expect(
      activateSetupInference({
        kind: "anthropic-api-key",
        workspace: "/tmp/work",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          runEmbeddedAgent: vi.fn(async () => ({
            meta: { finalAssistantVisibleText: "OK" },
          })) as never,
          applySetup: applySetup as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow(
      "The default agent changed while AI access was being tested. Try setup again.",
    );
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not overwrite config that becomes invalid during a live probe", async () => {
    const initialConfig: OpenClawConfig = {};
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: initialConfig,
        runtimeConfig: initialConfig,
      })
      .mockResolvedValue({
        exists: true,
        valid: false,
        path: "/tmp/openclaw.json",
        issues: [{ path: "agents", message: "Expected an object" }],
        config: {},
      });
    const applySetup = vi.fn();

    await expect(
      activateSetupInference({
        kind: "anthropic-api-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          runEmbeddedAgent: vi.fn(async () => ({
            meta: { finalAssistantVisibleText: "OK" },
          })) as never,
          applySetup: applySetup as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow("agents: Expected an object");
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("aborts the activation when the config revision changes during its live probe", async () => {
    const initialConfig: OpenClawConfig = {};
    const changedConfig: OpenClawConfig = { gateway: { port: 19000 } };
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: "revision-a",
        issues: [],
        config: initialConfig,
        runtimeConfig: initialConfig,
      })
      .mockResolvedValue({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: "revision-b",
        issues: [],
        config: changedConfig,
        runtimeConfig: changedConfig,
      });
    const applySetup = vi.fn();

    await expect(
      activateSetupInference({
        kind: "anthropic-api-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          runEmbeddedAgent: vi.fn(async () => ({
            meta: { finalAssistantVisibleText: "OK" },
          })) as never,
          applySetup: applySetup as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow("OpenClaw config changed while AI access was being tested. Try setup again.");
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("binds existing-model activation to the exact detected model", async () => {
    const initialConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    } satisfies OpenClawConfig;
    const runEmbeddedAgent = vi.fn();
    const applySetup = vi.fn();

    const result = await activateSetupInference({
      kind: "existing-model",
      modelRef: "openai/gpt-5.5",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error:
        "The configured default model changed from openai/gpt-5.5 to openai/gpt-5.4. Try setup again.",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("accepts an authored alias for the unchanged existing model target", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "opus" },
          models: { "anthropic/claude-opus-4-8": { alias: "opus" } },
        },
      },
    } satisfies OpenClawConfig;
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] }));

    const result = await activateSetupInference({
      kind: "existing-model",
      modelRef: "opus",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config,
          runtimeConfig: config,
        })) as never,
        runEmbeddedAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelRef: "anthropic/claude-opus-4-8",
    });
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedModelRef: "anthropic/claude-opus-4-8",
      }),
    );
  });

  it("does not apply setup when the existing default model changes during its probe", async () => {
    const initialConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: initialConfig,
        runtimeConfig: initialConfig,
      })
      .mockResolvedValue({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: changedConfig,
        runtimeConfig: changedConfig,
      });
    const applySetup = vi.fn();

    await expect(
      activateSetupInference({
        kind: "existing-model",
        modelRef: "openai/gpt-5.4",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          runEmbeddedAgent: vi.fn(async () => ({
            meta: { finalAssistantVisibleText: "OK" },
          })) as never,
          applySetup: applySetup as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow(
      "The default model changed while AI access was being tested. Try setup again.",
    );
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("rejects manual activation without a supported provider", async () => {
    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: "definitely-not-a-provider",
      apiKey: "sk-test",
      surface: "gateway",
      runtime,
      deps: {
        createTempDir: makeTempDir,
        resolveManifestProviderAuthChoice: () => undefined,
        resolvePluginProviders: () => [],
      },
    });
    expect(result).toMatchObject({ ok: false, status: "unavailable" });
  });

  it.each([
    { name: "API-key", authKind: "api_key" as const, credentialType: "api_key" as const },
    { name: "token", authKind: "token" as const, credentialType: "token" as const },
  ])(
    "uses a provider-owned $name method, persists it, and redacts success lines",
    async ({ authKind, credentialType }) => {
      const stateDir = await makeTempDir();
      const agentDir = path.join(stateDir, "agent");
      const modelRef = "groq/llama-3.3-70b-versatile";
      const submittedKey = "test-groq-key";
      const initialConfig: OpenClawConfig = {
        agents: {
          defaults: {
            models: {
              [modelRef]: {
                alias: "Fast Groq",
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      };
      const runAuth = vi.fn(async (ctx: { opts?: { token?: string } }) => ({
        profiles: [
          {
            profileId: "groq:default",
            credential:
              credentialType === "api_key"
                ? { type: "api_key" as const, provider: "groq", key: ctx.opts?.token }
                : { type: "token" as const, provider: "groq", token: ctx.opts?.token ?? "" },
          },
        ],
        defaultModel: modelRef,
        configPatch: { agents: { defaults: { models: { [modelRef]: {} } } } },
      }));
      const provider: ProviderPlugin = {
        id: "groq",
        label: "Groq",
        pluginId: "groq",
        auth: [
          {
            id: "api-key",
            label: "Groq API key",
            kind: authKind,
            wizard: { choiceId: "groq-api-key" },
            run: runAuth as never,
          },
        ],
      };
      const resolvePluginProviders = vi.fn(() => [provider]);
      const enablePluginInConfig = vi.fn((config: OpenClawConfig, pluginId: string) => ({
        config: {
          ...config,
          plugins: { entries: { [pluginId]: { enabled: true } } },
        },
        enabled: true,
      }));
      const runEmbeddedAgent = vi.fn(async () => ({
        meta: { finalAssistantVisibleText: "OK" },
      }));
      const applySetup = vi.fn(async () => ({
        configPath: "/tmp/openclaw.json",
        lines: [`Saved ${submittedKey}`],
      }));

      try {
        const result = await activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: submittedKey,
          workspace: "/tmp/openclaw-workspace",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              path: "/tmp/openclaw.json",
              issues: [],
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders,
            enablePluginInConfig: enablePluginInConfig as never,
            resolveManifestProviderAuthChoice: () => ({
              pluginId: "groq",
              providerId: "groq",
              methodId: "api-key",
              choiceId: "groq-api-key",
              choiceLabel: "Groq API key",
              appGuidedSecret: true,
            }),
            resolveAgentDir: () => agentDir,
            runEmbeddedAgent: runEmbeddedAgent as never,
            applySetup: applySetup as never,
            createTempDir: makeTempDir,
          },
        });

        expect(result).toMatchObject({ ok: true, modelRef: "groq/llama-3.3-70b-versatile" });
        if (result.ok) {
          expect(result.lines).toEqual(["Saved [redacted]"]);
          expect(result.lines.join("\n")).not.toContain(submittedKey);
        }
        expect(resolvePluginProviders).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              plugins: { entries: { groq: { enabled: true } } },
            }),
            onlyPluginIds: ["groq"],
            workspaceDir: "/tmp/openclaw-workspace",
          }),
        );
        expect(runAuth).toHaveBeenCalledWith(
          expect.objectContaining({
            opts: expect.objectContaining({ token: "test-groq-key", tokenProvider: "groq" }),
            allowSecretRefPrompt: false,
            secretInputMode: "plaintext",
          }),
        );
        expect(runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "groq",
            model: "llama-3.3-70b-versatile",
            authProfileId: "groq:default",
            agentDir: expect.stringContaining("setup-inference-test-"),
            config: expect.objectContaining({
              agents: expect.objectContaining({
                defaults: expect.objectContaining({
                  models: {
                    [modelRef]: {
                      alias: "Fast Groq",
                      agentRuntime: { id: "codex" },
                    },
                  },
                }),
                list: expect.arrayContaining([
                  expect.objectContaining({
                    id: "main",
                    models: {
                      [modelRef]: { agentRuntime: { id: "openclaw" } },
                    },
                  }),
                ]),
              }),
            }),
          }),
        );
        expect(applySetup).toHaveBeenCalledWith(
          expect.objectContaining({
            model: modelRef,
            agentRuntimeId: "openclaw",
            expectedAgentDir: agentDir,
            expectedConfigHash: null,
            enablePluginId: "groq",
            configPatch: expect.any(Object),
          }),
        );
        expect(readAuthProfileStoreForTest(agentDir).profiles["groq:default"]).toMatchObject(
          credentialType === "api_key"
            ? { type: "api_key", provider: "groq", key: submittedKey }
            : { type: "token", provider: "groq", token: submittedKey },
        );
      } finally {
        await removeOAuthTestTempRoot(stateDir);
      }
    },
  );

  it.each([
    {
      name: "uses a provider starter model instead of an unrelated existing default",
      existingModel: "openai/gpt-5.2",
      starterModel: "github-copilot/claude-sonnet-4.5",
    },
    {
      name: "accepts an unchanged provider-owned dynamic model",
      existingModel: "github-copilot/claude-sonnet-4.5",
      starterModel: undefined,
    },
  ])("$name without starting interactive login", async ({ existingModel, starterModel }) => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const runInteractive = vi.fn();
    const runNonInteractive = vi.fn(
      async (ctx: {
        agentDir?: string;
        opts: { githubCopilotToken?: unknown };
        config: OpenClawConfig;
      }) => {
        const token =
          typeof ctx.opts.githubCopilotToken === "string" ? ctx.opts.githubCopilotToken : "";
        await upsertAuthProfileWithLock({
          profileId: "github-copilot:github",
          credential: { type: "token", provider: "github-copilot", token },
          agentDir: ctx.agentDir,
        });
        return {
          ...ctx.config,
          agents: {
            ...ctx.config.agents,
            defaults: {
              ...ctx.config.agents?.defaults,
              model: ctx.config.agents?.defaults?.model ?? {
                primary: "github-copilot/claude-sonnet-4.5",
              },
            },
          },
        } satisfies OpenClawConfig;
      },
    );
    const provider: ProviderPlugin = {
      id: "github-copilot",
      label: "GitHub Copilot",
      pluginId: "github-copilot",
      auth: [
        {
          id: "device",
          label: "GitHub device login",
          kind: "device_code",
          ...(starterModel ? { starterModel } : {}),
          run: runInteractive as never,
          runNonInteractive: runNonInteractive as never,
        },
      ],
    };
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const initialConfig = {
      gateway: { port: 18789 },
      agents: { defaults: { model: { primary: existingModel } } },
    } satisfies OpenClawConfig;
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      lines: ["ok"],
    }));

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "github-copilot",
        apiKey: "github-token",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          resolvePluginProviders: () => [provider],
          resolveManifestProviderAuthChoice: () => ({
            pluginId: "github-copilot",
            providerId: "github-copilot",
            methodId: "device",
            choiceId: "github-copilot",
            choiceLabel: "GitHub Copilot",
            optionKey: "githubCopilotToken",
            cliOption: "--github-copilot-token <token>",
            appGuidedSecret: true,
          }),
          resolveAgentDir: () => agentDir,
          runEmbeddedAgent: runEmbeddedAgent as never,
          applySetup: applySetup as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        modelRef: "github-copilot/claude-sonnet-4.5",
      });
      expect(runInteractive).not.toHaveBeenCalled();
      expect(runNonInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          opts: expect.objectContaining({ githubCopilotToken: "github-token" }),
        }),
      );
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: expect.stringContaining("setup-inference-test-"),
          authProfileId: "github-copilot:github",
          provider: "github-copilot",
          model: "claude-sonnet-4.5",
        }),
      );
      expect(readAuthProfileStoreForTest(agentDir).profiles["github-copilot:github"]).toMatchObject(
        {
          type: "token",
          provider: "github-copilot",
          token: "github-token",
        },
      );
      expect(applySetup).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedAgentDir: agentDir,
          enablePluginId: "github-copilot",
          configPatch: expect.any(Object),
        }),
      );
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("does not persist a provider key after a failed live test", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const provider: ProviderPlugin = {
      id: "groq",
      label: "Groq",
      pluginId: "groq",
      auth: [
        {
          id: "api-key",
          label: "Groq API key",
          kind: "api_key",
          wizard: { choiceId: "groq-api-key" },
          run: async (ctx) => ({
            profiles: [
              {
                profileId: "groq:default",
                credential: { type: "api_key", provider: "groq", key: ctx.opts?.token },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
          }),
        },
      ],
    };

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "groq-api-key",
        apiKey: "bad-groq-key",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        deps: {
          resolvePluginProviders: () => [provider],
          resolveManifestProviderAuthChoice: () => ({
            pluginId: "groq",
            providerId: "groq",
            methodId: "api-key",
            choiceId: "groq-api-key",
            choiceLabel: "Groq API key",
            appGuidedSecret: true,
          }),
          resolveAgentDir: () => agentDir,
          runEmbeddedAgent: vi.fn(async () => {
            throw new Error("401 rejected credential bad-groq-key");
          }) as never,
          applySetup: vi.fn() as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: false, status: "auth" });
      if (!result.ok) {
        expect(result.error).toContain("401 rejected credential [redacted]");
        expect(result.error).not.toContain("bad-groq-key");
      }
      expect(readAuthProfileStoreForTest(agentDir).profiles["groq:default"]).toBeUndefined();
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("aborts the config commit and preserves a concurrent auth update", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    await upsertAuthProfileWithLock({
      profileId: "groq:existing",
      credential: { type: "api_key", provider: "groq", key: "original-key" },
      agentDir,
    });
    await upsertAuthProfileWithLock({
      profileId: "groq:concurrent",
      credential: { type: "api_key", provider: "groq", key: "original-concurrent-key" },
      agentDir,
    });
    const provider: ProviderPlugin = {
      id: "groq",
      label: "Groq",
      pluginId: "groq",
      auth: [
        {
          id: "api-key",
          label: "Groq API key",
          kind: "api_key",
          wizard: { choiceId: "groq-api-key" },
          run: async (ctx) => ({
            profiles: [
              {
                profileId: "groq:existing",
                credential: { type: "api_key", provider: "groq", key: ctx.opts?.token },
              },
              {
                profileId: "groq:concurrent",
                credential: { type: "api_key", provider: "groq", key: ctx.opts?.token },
              },
              {
                profileId: "groq:new",
                credential: { type: "api_key", provider: "groq", key: ctx.opts?.token },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
          }),
        },
      ],
    };

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "replacement-key",
          workspace: "/tmp/openclaw-workspace",
          surface: "gateway",
          runtime,
          deps: {
            resolvePluginProviders: () => [provider],
            resolveManifestProviderAuthChoice: () => ({
              pluginId: "groq",
              providerId: "groq",
              methodId: "api-key",
              choiceId: "groq-api-key",
              choiceLabel: "Groq API key",
              appGuidedSecret: true,
            }),
            enablePluginInConfig: (config) => ({ config, enabled: true, pluginId: "groq" }),
            resolveAgentDir: () => agentDir,
            runEmbeddedAgent: vi.fn(async () => ({
              meta: { finalAssistantVisibleText: "OK" },
            })) as never,
            applySetup: vi.fn(async (setupParams: { assertCommitPreconditions?: () => void }) => {
              await upsertAuthProfileWithLock({
                profileId: "groq:concurrent",
                credential: { type: "api_key", provider: "groq", key: "third-party-key" },
                agentDir,
              });
              setupParams.assertCommitPreconditions?.();
              return {
                configPath: "/tmp/openclaw.json",
                configHashBefore: "before",
                configHashAfter: "after",
                lines: [],
              };
            }) as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("AI credentials changed while setup was being committed");

      const profiles = readAuthProfileStoreForTest(agentDir).profiles;
      expect(profiles["groq:existing"]).toMatchObject({ key: "original-key" });
      expect(profiles["groq:concurrent"]).toMatchObject({ key: "third-party-key" });
      expect(profiles["groq:new"]).toBeUndefined();
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("preserves and redacts provider preparation errors", async () => {
    const secret = "groq-secret-that-must-not-leak";
    const provider: ProviderPlugin = {
      id: "groq",
      label: "Groq",
      pluginId: "groq",
      auth: [
        {
          id: "api-key",
          label: "Groq API key",
          kind: "api_key",
          wizard: { choiceId: "groq-api-key" },
          run: vi.fn(async () => {
            throw new Error(`provider rejected ${secret} while preparing auth`);
          }),
        },
      ],
    };

    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: "groq-api-key",
      apiKey: secret,
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime,
      deps: {
        resolvePluginProviders: () => [provider],
        resolveManifestProviderAuthChoice: () => ({
          pluginId: "groq",
          providerId: "groq",
          methodId: "api-key",
          choiceId: "groq-api-key",
          choiceLabel: "Groq API key",
          appGuidedSecret: true,
        }),
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unavailable" });
    if (!result.ok) {
      expect(result.error).toContain("provider rejected [redacted] while preparing auth");
      expect(result.error).not.toContain(secret);
    }
  });

  it("installs the codex runtime independently of a custom OpenAI route", async () => {
    mocks.appendAudit.mockRejectedValueOnce(new Error("install audit unavailable"));
    const error = vi.fn();
    const events: string[] = [];
    const initialConfig = {
      gateway: { port: 18789 },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            model: {
              primary: "anthropic/claude-opus-4-8",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
      plugins: {
        entries: {
          codex: {
            config: { appServer: { command: "codex", mode: "yolo" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const applySetup = vi.fn(
      async (input: {
        configPatch?: unknown;
        finalizeConfig?: (config: OpenClawConfig, sourceConfig: OpenClawConfig) => OpenClawConfig;
      }) => {
        events.push("persist-setup");
        const patched =
          input.configPatch === undefined
            ? persistedConfig
            : (applyMergePatch(persistedConfig, input.configPatch) as OpenClawConfig);
        persistedConfig = input.finalizeConfig
          ? input.finalizeConfig(patched, persistedConfig)
          : patched;
        return { configPath: "/tmp/openclaw.json", lines: ["ok"] };
      },
    );
    const ensureCodex = vi.fn(async (params: { cfg: OpenClawConfig }) => {
      events.push("install-plugin");
      return {
        cfg: {
          ...params.cfg,
          plugins: {
            ...params.cfg.plugins,
            entries: {
              ...params.cfg.plugins?.entries,
              codex: {
                ...params.cfg.plugins?.entries?.codex,
                enabled: true,
              },
            },
            installs: {
              ...params.cfg.plugins?.installs,
              codex: {
                source: "npm" as const,
                spec: "@openclaw/codex",
                installPath: "/tmp/plugins/codex",
              },
            },
          },
        },
        required: true,
        installed: true,
        status: "installed" as const,
      };
    });
    const runEmbeddedAgent = vi.fn(async (_params: unknown) => {
      events.push("live-test");
      return { meta: { finalAssistantVisibleText: "OK" } };
    });
    const refreshPluginRegistryAfterConfigMutation = vi.fn(async () => {
      events.push("refresh-plugin-registry");
    });
    let persistedConfig: OpenClawConfig = {
      ...initialConfig,
      gateway: { port: 19000 },
    };
    const pendingCodexInstalls: unknown[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { sourceConfig: OpenClawConfig } },
        ) => { nextConfig: OpenClawConfig };
      }) => {
        const transformed = params.transform(persistedConfig, {
          snapshot: { sourceConfig: persistedConfig },
        }).nextConfig;
        const configuredRuntime =
          transformed.agents?.defaults?.models?.["openai/gpt-5.6-sol"]?.agentRuntime?.id ??
          transformed.agents?.list?.find((agent) => agent.id === "ops")?.models?.[
            "openai/gpt-5.6-sol"
          ]?.agentRuntime?.id;
        events.push(
          configuredRuntime === "codex" ? "persist-plugin-config" : "persist-plugin-install",
        );
        pendingCodexInstalls.push(transformed.plugins?.installs?.codex);
        persistedConfig = withoutPluginInstallRecords(transformed);
        return { nextConfig: persistedConfig };
      },
    );
    const result = await activateSetupInference({
      kind: "codex-cli",
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime: { log: () => {}, error, exit: () => {} } as never,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistryAfterConfigMutation as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lines).toContain(
        "Codex was installed, but OpenClaw could not record its audit entry: install audit unavailable",
      );
    }
    expect(error).toHaveBeenCalledWith(
      "Codex was installed, but OpenClaw could not record its audit entry: install audit unavailable",
    );
    expect(ensureCodex).toHaveBeenCalledOnce();
    expect(ensureCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              model: { primary: "openai/gpt-5.4" },
            }),
            list: expect.arrayContaining([
              expect.objectContaining({
                id: "ops",
                model: {
                  primary: "openai/gpt-5.6-sol",
                  fallbacks: ["google/gemini-3.1-pro-preview"],
                },
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
                  "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
                },
              }),
            ]),
          }),
          models: {
            providers: {
              openai: { baseUrl: "https://proxy.example.test/v1", models: [] },
            },
          },
        }),
        model: "openai/gpt-5.6-sol",
        agentId: "ops",
      }),
    );
    expect(events).toEqual([
      "install-plugin",
      "persist-plugin-install",
      "refresh-plugin-registry",
      "live-test",
      "persist-setup",
    ]);
    expect(transformConfig).toHaveBeenCalledOnce();
    // Harness selection: codex tests run embedded with the codex harness.
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        agentId: "ops",
        agentDir: expect.stringContaining("setup-inference-test-"),
        provider: "openai",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              model: { primary: "openai/gpt-5.4" },
            }),
            list: expect.arrayContaining([
              expect.objectContaining({
                id: "ops",
                model: {
                  primary: "openai/gpt-5.6-sol",
                  fallbacks: ["google/gemini-3.1-pro-preview"],
                },
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
                  "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
                },
              }),
            ]),
          }),
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              codex: expect.objectContaining({
                enabled: true,
                config: expect.objectContaining({
                  appServer: {
                    command: "codex",
                    mode: "yolo",
                    transport: "stdio",
                    homeScope: "user",
                  },
                  supervision: { enabled: true },
                }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toHaveProperty(
      "agentHarnessRuntimeOverride",
      "codex",
    );
    expect(persistedConfig).toMatchObject({
      gateway: { port: 19000 },
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1" },
        },
      },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          expect.objectContaining({
            id: "ops",
            model: {
              primary: "openai/gpt-5.6-sol",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            },
          }),
        ],
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                command: "codex",
                mode: "yolo",
                transport: "stdio",
                homeScope: "user",
              },
              supervision: { enabled: true },
            },
          },
        },
      },
    });
    expect(persistedConfig.plugins?.installs).toBeUndefined();
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5.6-sol",
        agentRuntimeId: "codex",
        expectedConfigHash: null,
        enablePluginId: "codex",
        refreshPluginRegistry: true,
        configPatch: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              codex: expect.objectContaining({
                config: expect.objectContaining({
                  appServer: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
                }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(pendingCodexInstalls[0]).toMatchObject({
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    });
    expect(pendingCodexInstalls).toHaveLength(1);
  });

  it("probes and persists an exact non-default model through the Codex route", async () => {
    const initialConfig: OpenClawConfig = {};
    let persistedConfig = initialConfig;
    const ensureCodex = vi.fn(async (params: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          entries: {
            ...params.cfg.plugins?.entries,
            codex: { ...params.cfg.plugins?.entries?.codex, enabled: true },
          },
        },
      },
      required: true,
      installed: true,
      status: "installed" as const,
    }));
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => {});
    const refreshPluginRegistryAfterConfigMutation = vi.fn(
      async (params: { logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.("best-effort refresh warning");
      },
    );
    const runEmbeddedAgent = vi.fn(async () => {
      expect(refreshPluginRegistryAfterConfigMutation).toHaveBeenCalledOnce();
      expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledOnce();
      return { meta: { finalAssistantVisibleText: "OK" } };
    });
    const transformConfig = vi.fn(
      async (params: { transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig } }) => {
        persistedConfig = params.transform(persistedConfig).nextConfig;
        return { nextConfig: persistedConfig };
      },
    );
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));
    const result = await activateSetupInference({
      kind: "codex-cli",
      modelRef: "openai/gpt-5.4",
      workspace: "/tmp/work",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPlugin as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistryAfterConfigMutation as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.4" });
    expect(ensureCodex).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/gpt-5.4" }));
    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        agentHarnessRuntimeOverride: "codex",
      }),
    );
    expect(refreshPluginRegistryAfterConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "source-changed",
        policyPluginIds: ["codex"],
        traceCommand: "crestodian-setup-probe",
        workspaceDir: "/tmp/work",
      }),
    );
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessRuntimeOverride: "codex",
        provider: "openai",
        model: "gpt-5.4",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({
              model: "openai/gpt-5.4",
            }),
            list: expect.arrayContaining([
              expect.objectContaining({
                id: "main",
                models: {
                  "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
                },
              }),
            ]),
          }),
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              codex: expect.objectContaining({
                enabled: true,
                config: expect.objectContaining({
                  appServer: expect.objectContaining({
                    transport: "stdio",
                    homeScope: "user",
                  }),
                  supervision: { enabled: true },
                }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-5.4",
        agentRuntimeId: "codex",
        enablePluginId: "codex",
        refreshPluginRegistry: true,
        configPatch: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              codex: expect.objectContaining({
                config: expect.objectContaining({
                  appServer: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
                }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it("commits only the refreshed codex record when authored install metadata is stale", async () => {
    const staleAuthoredRecords = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex@1.0.0",
        installPath: "/tmp/plugins/codex-v1",
      },
      unrelated: {
        source: "npm" as const,
        spec: "@openclaw/unrelated@1.0.0",
        installPath: "/tmp/plugins/unrelated-v1",
      },
    };
    const canonicalRecords = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex@2.0.0",
        installPath: "/tmp/plugins/codex-v2",
      },
      unrelated: {
        source: "npm" as const,
        spec: "@openclaw/unrelated@2.0.0",
        installPath: "/tmp/plugins/unrelated-v2",
      },
    };
    const refreshedCodexRecord = {
      source: "npm" as const,
      spec: "@openclaw/codex@3.0.0",
      installPath: "/tmp/plugins/codex-v3",
    };
    const sourceConfig = {
      plugins: { installs: staleAuthoredRecords },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      plugins: { installs: canonicalRecords },
    } satisfies OpenClawConfig;
    const ensureCodex = vi.fn(async (params: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          installs: { codex: refreshedCodexRecord },
        },
      },
      required: true,
      installed: true,
      status: "installed" as const,
    }));
    let persistedConfig: OpenClawConfig = sourceConfig;
    let installIndex: Record<string, PluginInstallRecord> = structuredClone(canonicalRecords);
    const pendingInstallRecords: unknown[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { sourceConfig: OpenClawConfig } },
        ) => { nextConfig: OpenClawConfig };
      }) => {
        const transformed = params.transform(persistedConfig, {
          snapshot: { sourceConfig: persistedConfig },
        }).nextConfig;
        const pending = transformed.plugins?.installs;
        pendingInstallRecords.push(pending);
        installIndex = { ...installIndex, ...pending };
        persistedConfig = withoutPluginInstallRecords(transformed);
        return { nextConfig: persistedConfig };
      },
    );

    const result = await activateSetupInference({
      kind: "codex-cli",
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: sourceConfig,
          runtimeConfig,
        })) as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        runEmbeddedAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        applySetup: vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(ensureCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.not.objectContaining({
          plugins: expect.objectContaining({ installs: expect.anything() }),
        }),
      }),
    );
    expect(pendingInstallRecords).toStrictEqual([{ codex: refreshedCodexRecord }]);
    expect(installIndex).toStrictEqual({
      codex: refreshedCodexRecord,
      unrelated: canonicalRecords.unrelated,
    });
    expect(persistedConfig.plugins?.installs).toBeUndefined();
  });

  it("does not run or persist when the codex runtime install fails", async () => {
    const runEmbeddedAgent = vi.fn();
    const applySetup = vi.fn();
    const transformConfig = vi.fn();
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        ensureCodexRuntimePlugin: vi.fn(async () => ({
          cfg: {},
          required: true,
          installed: false,
          status: "failed" as const,
          reason: "npm registry returned EAI_AGAIN while fetching @openclaw/codex",
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error:
        "Could not enable the Codex runtime plugin: npm registry returned EAI_AGAIN while fetching @openclaw/codex.",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("rebuilds the Codex probe from the current persisted exec policy", async () => {
    const initialConfig: OpenClawConfig = { tools: { exec: { mode: "full" } } };
    let persistedConfig: OpenClawConfig = initialConfig;
    let readCount = 0;
    const runEmbeddedAgent = vi.fn(async (params: { config: OpenClawConfig }) => {
      expect(params.config.tools?.exec?.mode).toBe("allowlist");
      throw new Error(
        "Codex app-server local execution is not available when tools.exec.mode=allowlist",
      );
    });
    const applySetup = vi.fn();
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => {
          const config = readCount++ === 0 ? initialConfig : persistedConfig;
          return {
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config,
            runtimeConfig: config,
          };
        }) as never,
        ensureCodexRuntimePlugin: vi.fn(async (params: { cfg: OpenClawConfig }) => ({
          cfg: {
            ...params.cfg,
            plugins: {
              entries: { codex: { enabled: true } },
              installs: {
                codex: {
                  source: "npm" as const,
                  spec: "@openclaw/codex",
                  installPath: "/tmp/plugins/codex",
                },
              },
            },
          },
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        transformConfigWithPendingPluginInstalls: vi.fn(
          async (params: {
            transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig };
          }) => {
            persistedConfig = {
              ...persistedConfig,
              tools: { exec: { mode: "allowlist" } },
            };
            persistedConfig = withoutPluginInstallRecords(
              params.transform(persistedConfig).nextConfig,
            );
            return { nextConfig: persistedConfig };
          },
        ) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not install codex when plugin policy blocks it", async () => {
    const ensureCodex = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const applySetup = vi.fn();
    const transformConfig = vi.fn();
    const blockedConfig: OpenClawConfig = { plugins: { allow: ["other"] } };
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: blockedConfig,
          runtimeConfig: blockedConfig,
        })) as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error: expect.stringContaining("blocked by allowlist"),
    });
    expect(ensureCodex).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("records codex install ownership but not setup when the live test fails", async () => {
    const applySetup = vi.fn();
    let pendingCodexInstall: unknown;
    let recordCommitConfig: OpenClawConfig | undefined;
    const transformConfig = vi.fn(
      async (params: { transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig } }) => {
        const transformed = params.transform({}).nextConfig;
        recordCommitConfig = transformed;
        pendingCodexInstall = transformed.plugins?.installs?.codex;
        return {
          nextConfig: withoutPluginInstallRecords(transformed),
          path: "/tmp/openclaw.json",
          previousHash: "before-install",
          persistedHash: "after-install",
        };
      },
    );
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        ensureCodexRuntimePlugin: vi.fn(async () => ({
          cfg: {
            plugins: {
              installs: {
                codex: {
                  source: "npm" as const,
                  spec: "@openclaw/codex",
                  installPath: "/tmp/plugins/codex",
                },
              },
            },
          },
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error("401 invalid_api_key");
        }) as never,
        applySetup: applySetup as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(transformConfig).toHaveBeenCalledOnce();
    expect(transformConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        afterWrite: {
          mode: "none",
          reason: "Crestodian records the installed Codex runtime before probing",
        },
      }),
    );
    expect(pendingCodexInstall).toMatchObject({
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    });
    expect(recordCommitConfig?.agents).toBeUndefined();
    expect(recordCommitConfig?.plugins?.entries).toBeUndefined();
    expect(mocks.appendAudit).toHaveBeenCalledOnce();
    expect(mocks.appendAudit).toHaveBeenCalledWith({
      operation: "plugin.install",
      summary: "Installed Codex runtime plugin",
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before-install",
      configHashAfter: "after-install",
      details: { pluginId: "codex", via: "crestodian.setup" },
    });
    expect(applySetup).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", {} satisfies OpenClawConfig],
    [
      "an empty object",
      {
        plugins: {
          entries: { codex: { config: { supervision: {} } } },
        },
      } satisfies OpenClawConfig,
    ],
  ])("enables Codex supervision when it is %s", async (_label, config) => {
    const { result, persistedConfig, applySetup, transformConfig } =
      await runCodexSetupWithFinalConfig({
        currentConfig: config,
        sourceConfig: config,
      });

    expect(result.ok).toBe(true);
    expect(persistedConfig.plugins?.entries?.codex).toMatchObject({
      enabled: true,
      config: { supervision: { enabled: true } },
    });
    expect(transformConfig).not.toHaveBeenCalled();
    expect(applySetup).toHaveBeenCalledOnce();
  });

  it("preserves an explicit Codex supervision opt-out from the latest config", async () => {
    const config = {
      plugins: {
        entries: {
          codex: {
            enabled: false,
            config: {
              discovery: { enabled: true },
              supervision: { enabled: false, allowRawTranscripts: true },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const { result, persistedConfig } = await runCodexSetupWithFinalConfig({
      currentConfig: config,
      sourceConfig: config,
    });

    expect(result.ok).toBe(true);
    expect(persistedConfig.plugins?.entries?.codex).toMatchObject({
      enabled: true,
      config: {
        appServer: { transport: "stdio", homeScope: "user" },
        discovery: { enabled: true },
        supervision: { enabled: false, allowRawTranscripts: true },
      },
    });
  });

  it("preserves a normalized Codex supervision opt-out", async () => {
    const config = {
      plugins: {
        allow: [" CODEX "],
        entries: {
          " CODEX ": {
            config: {
              appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
              supervision: { enabled: false },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const { result, persistedConfig } = await runCodexSetupWithFinalConfig({
      currentConfig: config,
      sourceConfig: config,
    });

    expect(result.ok).toBe(true);
    expect(persistedConfig.plugins?.allow).toEqual(["codex"]);
    expect(persistedConfig.plugins?.entries).toMatchObject({
      codex: {
        enabled: true,
        config: {
          appServer: { transport: "stdio", url: "ws://127.0.0.1:4500", homeScope: "user" },
          supervision: { enabled: false },
        },
      },
    });
  });

  it("preserves an include-owned Codex supervision opt-out without copying it to root", async () => {
    const resolvedSource = {
      plugins: {
        entries: {
          codex: { config: { supervision: { enabled: false } } },
        },
      },
    } satisfies OpenClawConfig;

    const { result, persistedConfig } = await runCodexSetupWithFinalConfig({
      initialConfig: resolvedSource,
      currentConfig: {},
      sourceConfig: resolvedSource,
    });

    expect(result.ok).toBe(true);
    expect(persistedConfig.plugins?.entries?.codex).toMatchObject({
      enabled: true,
      config: { appServer: { transport: "stdio", homeScope: "user" } },
    });
  });

  it("fails closed when effective plugin policy changes before the success commit", async () => {
    const denied = { plugins: { deny: ["codex"] } } satisfies OpenClawConfig;
    const { result, applySetup, refreshPluginRegistry } = await runCodexSetupWithFinalConfig({
      initialConfig: {},
      currentConfig: denied,
      sourceConfig: denied,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error: expect.stringContaining("blocked by denylist"),
    });
    expect(refreshPluginRegistry).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledOnce();
  });
});

describe("verifySetupInference", () => {
  function configuredSnapshot() {
    return {
      exists: true,
      valid: true,
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      },
    };
  }

  it("returns a passing live check without persisting setup", async () => {
    const applySetup = vi.fn();
    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not replace a passing result when temporary cleanup fails", async () => {
    const error = vi.fn();
    const result = await verifySetupInference({
      runtime: { log: () => {}, error, exit: () => {} } as never,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        createTempDir: makeTempDir,
        removeTempDir: vi.fn(async () => {
          throw new Error("cleanup denied");
        }),
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Could not remove temporary AI setup files: cleanup denied"),
    );
  });

  it("reports invalid config without starting a live check", async () => {
    const runEmbeddedAgent = vi.fn();
    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: false,
          path: "/tmp/openclaw.json",
          issues: [{ path: "agents.defaults.model", message: "Expected a model reference" }],
          config: {},
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "format",
      error: expect.stringContaining("agents.defaults.model: Expected a model reference"),
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("redacts live-check failures without writing config or auth", async () => {
    const applySetup = vi.fn();
    const secret = "sk-verifysetupsecret123"; // pragma: allowlist secret
    const result = await verifySetupInference({
      runtime,
      timeoutMs: 50,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error(`401 invalid_api_key OPENAI_API_KEY=${secret}`);
        }) as never,
        applySetup: applySetup as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    if (!result.ok) {
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain("OPENAI_API_KEY=");
    }
    expect(applySetup).not.toHaveBeenCalled();
  });
});
