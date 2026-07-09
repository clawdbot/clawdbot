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
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../plugins/types.js";
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
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: [] }));
    const runCliAgent = vi.fn(async () => {
      throw new Error("401 invalid_api_key");
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
            throw new Error("401 invalid_api_key");
          }) as never,
          applySetup: vi.fn() as never,
          updateConfig: vi.fn() as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: false, status: "auth" });
      expect(readAuthProfileStoreForTest(agentDir).profiles["groq:default"]).toBeUndefined();
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("runs the codex plugin ensure step only after a passing test", async () => {
    const applySetup = vi.fn(async () => ({ configPath: "/tmp/openclaw.json", lines: ["ok"] }));
    const ensureCodex = vi.fn(async () => ({
      cfg: {},
      required: false,
      installed: false,
    }));
    const runEmbeddedAgent = vi.fn(async (_params: unknown) => ({
      meta: { finalAssistantVisibleText: "OK" },
    }));
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        applySetup: applySetup as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    expect(ensureCodex).toHaveBeenCalledOnce();
    // Harness selection: codex tests run embedded with the codex harness.
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentHarnessId: "codex",
      provider: "openai",
    });
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

  it("maps live-check failures without writing config or auth", async () => {
    const applySetup = vi.fn();
    const updateConfig = vi.fn();
    const result = await verifySetupInference({
      runtime,
      timeoutMs: 50,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error("401 invalid_api_key");
        }) as never,
        applySetup: applySetup as never,
        updateConfig: updateConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(applySetup).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
