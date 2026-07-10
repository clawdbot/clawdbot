import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
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

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: false,
    valid: false,
    path: "/tmp/openclaw.json",
    issues: [],
    config: {},
  })),
}));

vi.mock("../commands/onboard-inference.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-inference.js")>();
  return {
    ...actual,
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
    expect(result.agents?.list?.[0]).toMatchObject({
      id: "ops",
      models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
    });
    expect(config.agents.list[0]?.models["openai/gpt-5.5"]?.agentRuntime?.id).toBe("openclaw");
  });
});

describe("detectSetupInference", () => {
  it("marks the first non-logged-out candidate recommended", async () => {
    const resolveManifestProviderAuthChoices = vi.fn(() => []);
    const detection = await detectSetupInference({ resolveManifestProviderAuthChoices });
    expect(detection.candidates).toHaveLength(2);
    expect(detection.candidates[0]).toMatchObject({ kind: "claude-cli", recommended: true });
    expect(detection.candidates[1]).toMatchObject({ kind: "codex-cli", recommended: false });
    expect(detection.setupComplete).toBe(false);
    expect(detection.workspace.length).toBeGreaterThan(0);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ includeWorkspacePlugins: false }),
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists setup only after the live test succeeds", async () => {
    const applySetup = vi.fn(async (_params: unknown) => ({
      configPath: "/tmp/openclaw.json",
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
    expect(applySetup.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-cli/claude-opus-4-8",
      surface: "gateway",
    });
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
                  "anthropic/claude-opus-4-8": { agentRuntime: { id: "codex" } },
                },
              }),
            ],
          }),
        }),
      }),
    );
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-opus-4-8" }),
    );
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
    "uses a provider-owned $name method and persists it after a passing test",
    async ({ authKind, credentialType }) => {
      const stateDir = await makeTempDir();
      const agentDir = path.join(stateDir, "agent");
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
        defaultModel: "groq/llama-3.3-70b-versatile",
        configPatch: { agents: { defaults: { models: { "groq/llama-3.3-70b-versatile": {} } } } },
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
      const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));
      let persistedConfig: OpenClawConfig = {};
      const updateConfig = vi.fn(async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
        persistedConfig = mutator(persistedConfig);
        return persistedConfig;
      });

      try {
        const result = await activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "test-groq-key",
          workspace: "/tmp/openclaw-workspace",
          surface: "gateway",
          runtime,
          deps: {
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
            updateConfig: updateConfig as never,
            applySetup: applySetup as never,
            createTempDir: makeTempDir,
          },
        });

        expect(result).toMatchObject({ ok: true, modelRef: "groq/llama-3.3-70b-versatile" });
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
          }),
        );
        expect(persistedConfig).toMatchObject({
          plugins: { entries: { groq: { enabled: true } } },
          auth: { profiles: { "groq:default": { provider: "groq", mode: credentialType } } },
        });
        expect(readAuthProfileStoreForTest(agentDir).profiles["groq:default"]).toMatchObject(
          credentialType === "api_key"
            ? { type: "api_key", provider: "groq", key: "test-groq-key" }
            : { type: "token", provider: "groq", token: "test-groq-key" },
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
    let persistedConfig: OpenClawConfig = {
      gateway: { port: 19000 },
      agents: { defaults: { model: { primary: existingModel } } },
    } satisfies OpenClawConfig;
    const updateConfig = vi.fn(async (mutator: (cfg: OpenClawConfig) => OpenClawConfig) => {
      persistedConfig = mutator(persistedConfig);
      return persistedConfig;
    });

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
          updateConfig: updateConfig as never,
          applySetup: vi.fn(async () => ({
            configPath: "/tmp/openclaw.json",
            lines: ["ok"],
          })) as never,
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
      expect(persistedConfig.gateway?.port).toBe(19000);
      expect(persistedConfig.agents?.defaults?.model).toEqual({ primary: existingModel });
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
          updateConfig: vi.fn() as never,
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

  it("installs the codex runtime independently of a custom OpenAI route", async () => {
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
            enabled: false,
            config: { appServer: { command: "codex", mode: "yolo" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const applySetup = vi.fn(async () => {
      events.push("persist-setup");
      return { configPath: "/tmp/openclaw.json", lines: ["ok"] };
    });
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
    let persistedConfig: OpenClawConfig = {
      ...initialConfig,
      gateway: { port: 19000 },
    };
    const pendingCodexInstalls: unknown[] = [];
    const transformConfig = vi.fn(
      async (params: { transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig } }) => {
        const transformed = params.transform(persistedConfig).nextConfig;
        const configuredRuntime =
          transformed.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.id ??
          transformed.agents?.list?.find((agent) => agent.id === "ops")?.models?.["openai/gpt-5.5"]
            ?.agentRuntime?.id;
        events.push(
          configuredRuntime === "codex" ? "persist-plugin-config" : "persist-plugin-install",
        );
        pendingCodexInstalls.push(transformed.plugins?.installs?.codex);
        persistedConfig = withoutPluginInstallRecords(transformed);
        return { nextConfig: persistedConfig };
      },
    );
    const refreshPluginRegistry = vi.fn(async () => {
      events.push("refresh-plugin-registry");
    });
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
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    expect(ensureCodex).toHaveBeenCalledOnce();
    expect(ensureCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: {
            defaults: { model: { primary: "openai/gpt-5.4" } },
            list: [
              expect.objectContaining({
                id: "ops",
                model: {
                  primary: "openai/gpt-5.5",
                  fallbacks: ["google/gemini-3.1-pro-preview"],
                },
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              }),
            ],
          },
          models: {
            providers: {
              openai: { baseUrl: "https://proxy.example.test/v1", models: [] },
            },
          },
        }),
        model: "openai/gpt-5.5",
        agentId: "ops",
      }),
    );
    expect(events).toEqual([
      "install-plugin",
      "persist-plugin-install",
      "live-test",
      "persist-plugin-config",
      "refresh-plugin-registry",
      "persist-setup",
    ]);
    expect(transformConfig).toHaveBeenCalledTimes(2);
    expect(transformConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        afterWrite: {
          mode: "none",
          reason: "Crestodian setup finalizes config after refresh",
        },
      }),
    );
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: persistedConfig,
      reason: "source-changed",
      workspaceDir: "/tmp/openclaw-workspace",
      logger: { warn: expect.any(Function) },
    });
    // Harness selection: codex tests run embedded with the codex harness.
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentId: "ops",
      agentDir: expect.stringContaining("setup-inference-test-"),
      provider: "openai",
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
          list: [
            expect.objectContaining({
              id: "ops",
              model: {
                primary: "openai/gpt-5.5",
                fallbacks: ["google/gemini-3.1-pro-preview"],
              },
              models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
            }),
          ],
        },
        plugins: {
          entries: { codex: { enabled: true } },
        },
        tools: { exec: { mode: "full" } },
      },
    });
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).not.toHaveProperty("agentHarnessRuntimeOverride");
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
              primary: "openai/gpt-5.5",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          }),
        ],
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { command: "codex", mode: "yolo" } },
          },
        },
      },
    });
    expect(persistedConfig.plugins?.installs).toBeUndefined();
    expect(pendingCodexInstalls[0]).toMatchObject({
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    });
    expect(pendingCodexInstalls[1]).toBeUndefined();
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
      async (params: { transform: (config: OpenClawConfig) => { nextConfig: OpenClawConfig } }) => {
        const transformed = params.transform(persistedConfig).nextConfig;
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
        refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
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
    expect(pendingInstallRecords).toStrictEqual([{ codex: refreshedCodexRecord }, undefined]);
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
    const refreshPluginRegistry = vi.fn();
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
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unavailable" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("does not install codex when plugin policy blocks it", async () => {
    const ensureCodex = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const applySetup = vi.fn();
    const transformConfig = vi.fn();
    const refreshPluginRegistry = vi.fn();
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
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
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
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
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
        return { nextConfig: withoutPluginInstallRecords(transformed) };
      },
    );
    const refreshPluginRegistry = vi.fn();
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
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
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
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
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
    const updateConfig = vi.fn();
    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => ({
          meta: { finalAssistantVisibleText: "OK" },
        })) as never,
        applySetup: applySetup as never,
        updateConfig: updateConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(applySetup).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("redacts live-check failures without writing config or auth", async () => {
    const applySetup = vi.fn();
    const updateConfig = vi.fn();
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
        updateConfig: updateConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    if (!result.ok) {
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain("OPENAI_API_KEY=");
    }
    expect(applySetup).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
