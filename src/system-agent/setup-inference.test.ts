import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedProviderAuth,
  type AgentExecutionAuthBinding,
} from "../agents/execution-auth-binding.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withoutPluginInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { hasRetainedManagedNpmInstallMarker } from "../plugins/managed-npm-retention.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryWorkspaceDir,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { ensurePluginRegistryLoaded } from "../plugins/runtime/runtime-registry-loader.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { disposeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { cleanupSystemAgentSession, createSystemAgentSession } from "./agent-turn.js";
import { runSystemAgentTurnWithDeps } from "./agent-turn.test-support.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { applySystemAgentModelSelection } from "./setup-apply.js";
import { resolveSetupInferenceProbeStreamParams } from "./setup-inference-probe.js";
import {
  SetupInferenceActivationIndeterminateError,
  activateSetupInference as activateSetupInferenceImpl,
  type BoundVerifySetupInferenceResult,
  detectSetupInference,
  listSetupInferenceAuthOptions,
  listSetupInferenceManualProviders,
  resolvePersistentApplyInference,
  type VerifySetupInferenceResult,
  verifySetupInference as verifySetupInferenceImpl,
  verifySetupInferenceConfig as verifySetupInferenceConfigImpl,
} from "./setup-inference.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
} from "./verified-inference.js";

const mocks = vi.hoisted(() => ({
  appendAudit: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(),
}));

vi.mock("./audit.js", () => ({
  appendSystemAgentAuditEntry: mocks.appendAudit,
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
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
        detail: "installed, not logged in — run `codex login`, then check again",
        credentials: false,
      },
    ]),
  };
});

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;
const testCliRuntimeArtifactFingerprint = "test-cli-runtime-artifact";
const testCodexRuntimeArtifact = {
  id: "codex-app-server",
  fingerprint: "codex-runtime-v1",
} as const;
const suiteTempRootTracker = createSuiteTempRootTracker({
  prefix: "setup-inference-test-",
});

beforeAll(async () => {
  await suiteTempRootTracker.setup();
});

afterAll(async () => {
  await suiteTempRootTracker.cleanup();
});

async function makeTempDir(): Promise<string> {
  return await suiteTempRootTracker.make("case");
}

const deferSuiteTempDirCleanup = async () => {};

function canonicalizeAgentEntriesForTest(config: OpenClawConfig): OpenClawConfig {
  const next = structuredClone(config);
  const list = next.agents?.list;
  if (!list) {
    return next;
  }
  next.agents = {
    ...next.agents,
    entries: Object.fromEntries(list.map(({ id, ...entry }) => [id, entry])),
  };
  delete next.agents.list;
  return next;
}

function materializeRuntimeAgentListForTest(config: OpenClawConfig): OpenClawConfig {
  const next = canonicalizeAgentEntriesForTest(config);
  if (!next.agents?.entries) {
    return next;
  }
  next.agents.list = Object.entries(next.agents.entries).map(([id, entry]) =>
    Object.assign({ id }, entry),
  );
  return next;
}

function withSuiteTempDirs<
  T extends NonNullable<Parameters<typeof activateSetupInferenceImpl>[0]["deps"]>,
>(input: T | undefined): T {
  // Keep operation dirs real and unique; only their routine cleanup moves to suite teardown.
  const deps = Object.create(
    Object.getPrototypeOf(input ?? {}),
    Object.getOwnPropertyDescriptors(input ?? {}),
  ) as T;
  if (!deps.createTempDir) {
    deps.createTempDir = makeTempDir;
  }
  if (deps.createTempDir === makeTempDir && !deps.removeTempDir) {
    deps.removeTempDir = deferSuiteTempDirCleanup;
  }
  return deps;
}

async function activateSetupInference(
  params: Parameters<typeof activateSetupInferenceImpl>[0],
): ReturnType<typeof activateSetupInferenceImpl> {
  const deps = withSuiteTempDirs(params.deps);
  const ownerPluginArtifacts = { ownerPluginIds: [], ownerPluginArtifacts: [] } as const;
  const usesRealOwnerBinding =
    params.deps?.createSystemAgentVerifiedInferenceBinding ===
    createSystemAgentVerifiedInferenceBinding;
  if (!deps.captureSystemAgentOwnerPluginArtifacts && !usesRealOwnerBinding) {
    deps.captureSystemAgentOwnerPluginArtifacts = () => ownerPluginArtifacts;
  }
  if (!deps.createSystemAgentVerifiedInferenceBinding) {
    deps.createSystemAgentVerifiedInferenceBinding = async () => ownerPluginArtifacts as never;
  }
  if (!deps.ensurePluginRegistryLoaded) {
    deps.ensurePluginRegistryLoaded = () => {};
  }
  if (!deps.resolveCliRuntimeArtifactFingerprint) {
    deps.resolveCliRuntimeArtifactFingerprint = vi.fn(
      async () => testCliRuntimeArtifactFingerprint,
    );
  }
  if (deps.readConfigFileSnapshot) {
    const readConfigFileSnapshot = deps.readConfigFileSnapshot;
    deps.readConfigFileSnapshot = (async (...args: Parameters<typeof readConfigFileSnapshot>) => {
      const snapshot = await readConfigFileSnapshot(...args);
      const sourceConfig = snapshot.sourceConfig ?? snapshot.config;
      const runtimeConfig = snapshot.runtimeConfig ?? snapshot.config;
      return {
        ...snapshot,
        ...(snapshot.config ? { config: materializeRuntimeAgentListForTest(snapshot.config) } : {}),
        ...(sourceConfig ? { sourceConfig: canonicalizeAgentEntriesForTest(sourceConfig) } : {}),
        ...(runtimeConfig
          ? { runtimeConfig: materializeRuntimeAgentListForTest(runtimeConfig) }
          : {}),
      };
    }) as typeof deps.readConfigFileSnapshot;
  }
  if (deps.transformConfigWithPendingPluginInstalls) {
    const transformConfigWithPendingPluginInstalls = deps.transformConfigWithPendingPluginInstalls;
    deps.transformConfigWithPendingPluginInstalls = (async (
      transformParams: Parameters<typeof transformConfigWithPendingPluginInstalls>[0],
    ) => {
      const transform = transformParams.transform;
      const wrappedTransform: typeof transform = async (config, context) =>
        await transform(canonicalizeAgentEntriesForTest(config), {
          ...context,
          snapshot: {
            ...context.snapshot,
            config: materializeRuntimeAgentListForTest(context.snapshot.config),
            sourceConfig: canonicalizeAgentEntriesForTest(
              context.snapshot.sourceConfig ?? context.snapshot.config,
            ),
            runtimeConfig: materializeRuntimeAgentListForTest(
              context.snapshot.runtimeConfig ?? context.snapshot.config,
            ),
          },
        });
      return await transformConfigWithPendingPluginInstalls({
        ...transformParams,
        transform: wrappedTransform,
      } as never);
    }) as typeof deps.transformConfigWithPendingPluginInstalls;
  }
  return activateSetupInferenceImpl({
    ...params,
    // Most activation tests isolate commit mechanics from the verified-owner
    // implementation. Owner-CAS regressions opt back into the real helper.
    deps,
  });
}

type TestVerifySetupInferenceParams = Omit<
  Parameters<typeof verifySetupInferenceImpl>[0],
  "bindSession"
>;

function verifySetupInference(
  params: TestVerifySetupInferenceParams & { bindSession: true },
): Promise<BoundVerifySetupInferenceResult>;
function verifySetupInference(
  params: TestVerifySetupInferenceParams & { bindSession?: false },
): Promise<VerifySetupInferenceResult>;
function verifySetupInference(
  params: TestVerifySetupInferenceParams & { bindSession?: boolean },
): Promise<VerifySetupInferenceResult | BoundVerifySetupInferenceResult> {
  return verifySetupInferenceImpl({
    ...params,
    deps: withSuiteTempDirs(params.deps),
  } as never);
}

async function verifySetupInferenceConfig(
  params: Parameters<typeof verifySetupInferenceConfigImpl>[0],
): ReturnType<typeof verifySetupInferenceConfigImpl> {
  return verifySetupInferenceConfigImpl({ ...params, deps: withSuiteTempDirs(params.deps) });
}

type SuccessfulRunParams = {
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
  authProfileId?: string;
  agentHarnessRuntimeOverride?: string;
  config?: OpenClawConfig;
};

function successfulAgentHarnessBinding(params?: SuccessfulRunParams): AgentExecutionAuthBinding {
  const requestedHarnessId = params?.agentHarnessRuntimeOverride?.trim();
  const agentHarnessId =
    !requestedHarnessId || requestedHarnessId === "auto" ? "openclaw" : requestedHarnessId;
  return {
    agentHarnessId,
    ...(agentHarnessId === "codex"
      ? {
          runtimeOwnerKind: "plugin-harness",
          runtimeOwnerId: agentHarnessId,
          runtimeArtifactId: testCodexRuntimeArtifact.id,
          runtimeArtifactFingerprint: testCodexRuntimeArtifact.fingerprint,
        }
      : {}),
  };
}

function successfulRun(provider: string, model: string, params?: SuccessfulRunParams) {
  params?.onSuccessfulAuthBinding?.(
    provider.endsWith("-cli")
      ? {
          runtimeOwnerFingerprint: "test-runtime-owner",
          runtimeOwnerKind: "cli-runtime",
          runtimeOwnerId: provider,
          runtimeArtifactFingerprint: testCliRuntimeArtifactFingerprint,
          runtimeArtifactId: provider,
          ...(params?.authProfileId ? { authProfileId: params.authProfileId } : {}),
        }
      : {
          ...successfulAgentHarnessBinding(params),
          authFingerprint: "test-credential-owner",
          modelId: model,
          modelApi:
            provider === "anthropic"
              ? "anthropic-messages"
              : provider === "groq"
                ? "openai-completions"
                : "openai-responses",
          ...(params?.authProfileId ? { authProfileId: params.authProfileId } : {}),
        },
  );
  return {
    meta: {
      finalAssistantVisibleText: "OK",
      executionTrace: { winnerProvider: provider, winnerModel: model },
    },
  };
}

function successfulRunner(provider: string, model: string) {
  return async (params: SuccessfulRunParams) => successfulRun(provider, model, params);
}

function createConfigTransformHarness(
  sourceConfig: OpenClawConfig = {},
  runtimeConfig: OpenClawConfig = sourceConfig,
) {
  const state = {
    sourceConfig: canonicalizeAgentEntriesForTest(sourceConfig),
    runtimeConfig: materializeRuntimeAgentListForTest(runtimeConfig),
  };
  const transform = vi.fn(
    async (params: {
      transform: (
        config: OpenClawConfig,
        context: {
          snapshot: {
            exists: true;
            valid: true;
            path: string;
            config: OpenClawConfig;
            sourceConfig: OpenClawConfig;
            runtimeConfig: OpenClawConfig;
          };
          previousHash: string | null;
          attempt: number;
        },
      ) => Promise<{ nextConfig: OpenClawConfig }> | { nextConfig: OpenClawConfig };
    }) => {
      const transformed = await params.transform(state.sourceConfig, {
        snapshot: {
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          config: state.runtimeConfig,
          sourceConfig: state.sourceConfig,
          runtimeConfig: state.runtimeConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      state.sourceConfig = withoutPluginInstallRecords(transformed.nextConfig);
      state.runtimeConfig = materializeRuntimeAgentListForTest(state.sourceConfig);
      return { nextConfig: state.sourceConfig };
    },
  );
  return {
    transform,
    current: () => structuredClone(state.sourceConfig),
  };
}

describe("applySystemAgentModelSelection", () => {
  it("pins a verified credential without putting the profile suffix in model metadata", async () => {
    const result = await applySystemAgentModelSelection({
      config: {},
      model: "openai/gpt-5.5",
      authProfileId: "openai:setup-123",
    });

    expect(result.agents?.defaults?.model).toBe("openai/gpt-5.5@openai:setup-123");
    expect(result.agents?.defaults?.models).toBeUndefined();
  });

  it("overrides higher-priority runtime metadata on an inheriting default agent", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: {
          ops: {
            default: true,
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });

    expect(result.agents?.defaults?.model).toMatchObject({ primary: "openai/gpt-5.5" });
    expect(result.agents?.entries?.ops).toMatchObject({
      models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
    });
    expect(config.agents.entries.ops?.models?.["openai/gpt-5.5"]?.agentRuntime?.id).toBe(
      "openclaw",
    );
  });
});

describe("detectSetupInference", () => {
  it("preserves the shared inference candidate order", async () => {
    const resolveManifestProviderAuthChoices = vi.fn(() => [
      {
        pluginId: "anthropic",
        providerId: "anthropic",
        methodId: "cli",
        choiceId: "anthropic-cli",
        choiceLabel: "Anthropic Claude CLI",
        deprecatedChoiceIds: ["claude-cli"],
        icon: "https://cdn.example.com/claude.svg",
        website: "https://claude.example.com/download",
      },
    ]);
    const detection = await detectSetupInference({
      resolveManifestProviderAuthChoices,
      enablePluginInConfig: ((config: OpenClawConfig) => ({ enabled: true, config })) as never,
      probeLocalCommand: vi.fn(async (command) => ({ command, found: false })),
    });
    expect(detection.candidates).toHaveLength(2);
    expect(detection.candidates[0]).toMatchObject({
      kind: "claude-cli",
      recommended: false,
      icon: "https://cdn.example.com/claude.svg",
      website: "https://claude.example.com/download",
    });
    expect(detection.candidates[1]).toMatchObject({ kind: "codex-cli", recommended: false });
    expect(detection.setupComplete).toBe(false);
    expect(detection.recommendedInstalls).toHaveLength(9);
    expect(detection.workspace.length).toBeGreaterThan(0);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ includeWorkspacePlugins: false }),
    );
  });

  it("discovers provider-owned local inference and reports unsafe CLIs without running them", async () => {
    const prepare = vi.fn();
    const detect = vi.fn(async () => ({
      modelRef: "local/qwen-tool",
      detail: "qwen-tool at http://127.0.0.1:9999",
    }));
    const provider: ProviderPlugin = {
      id: "local",
      label: "Local Server",
      pluginId: "local-plugin",
      auth: [
        {
          id: "ambient",
          label: "Local Server",
          kind: "custom",
          appGuidedSetup: { detect, prepare },
          run: async () => ({ profiles: [] }),
        },
      ],
    };
    const detection = await detectSetupInference({
      detectInferenceBackends: async () => [
        {
          kind: "claude-cli",
          modelRef: "claude-cli/claude-opus-4-8",
          label: "Claude Code",
          detail: "logged in",
          credentials: true,
        },
        {
          kind: "gemini-cli",
          modelRef: "google-gemini-cli/gemini-3.1-pro-preview",
          label: "Gemini CLI",
          detail: "installed",
          credentials: false,
        },
      ],
      probeLocalCommand: vi.fn(async (command) => ({
        command,
        found: command === "agy" || command === "pi" || command === "opencode",
      })),
      resolveManifestProviderAuthChoices: () => [
        {
          pluginId: "local-plugin",
          providerId: "local",
          methodId: "ambient",
          choiceId: "local-model",
          choiceLabel: "Local Server",
          appGuidedDiscovery: true,
          icon: "https://cdn.example.com/local.svg",
          website: "https://local.example.com/download",
        },
      ],
      enablePluginInConfig: ((config: OpenClawConfig) => ({ enabled: true, config })) as never,
      resolvePluginProviders: () => [provider],
    });

    expect(detection.candidates).toEqual([
      expect.objectContaining({ kind: "claude-cli" }),
      {
        kind: "provider-auto:local-model",
        label: "Local Server",
        detail: "qwen-tool at http://127.0.0.1:9999",
        modelRef: "local/qwen-tool",
        recommended: false,
        credentials: true,
        icon: "https://cdn.example.com/local.svg",
        website: "https://local.example.com/download",
      },
    ]);
    expect(detection.unavailableCandidates).toEqual([
      expect.objectContaining({ id: "gemini-cli" }),
      expect.objectContaining({ id: "antigravity-cli" }),
      expect.objectContaining({ id: "pi-cli" }),
      expect.objectContaining({ id: "opencode-cli" }),
    ]);
    expect(detect).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
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
        icon: "https://cdn.example.com/zeta.svg",
        website: "https://zeta.example.com/keys",
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
        icon: "https://cdn.example.com/zeta.svg",
        website: "https://zeta.example.com/keys",
      },
    ]);
  });

  it("lists provider-owned sign-ins in CLI order without compatibility aliases", () => {
    const choices: ProviderAuthChoiceMetadata[] = [
      {
        pluginId: "google",
        providerId: "google-gemini-cli",
        methodId: "oauth",
        choiceId: "google-gemini-cli",
        choiceLabel: "Gemini CLI OAuth",
        groupId: "google",
        groupLabel: "Google",
        onboardingFeatured: true,
        appGuidedAuth: "oauth",
      },
      {
        pluginId: "openrouter",
        providerId: "openrouter",
        methodId: "oauth",
        choiceId: "openrouter-oauth",
        choiceLabel: "OpenRouter OAuth",
        groupId: "openrouter",
        groupLabel: "OpenRouter",
        onboardingFeatured: true,
        appGuidedAuth: "oauth",
      },
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "oauth",
        choiceId: "openai",
        choiceLabel: "ChatGPT Login",
        choiceHint: "Browser sign-in",
        icon: "https://cdn.example.com/openai.svg",
        website: "https://openai.example.com/login",
        groupLabel: "OpenAI",
        onboardingFeatured: true,
        appGuidedAuth: "oauth",
      },
      {
        pluginId: "xai",
        providerId: "xai",
        methodId: "oauth",
        choiceId: "xai-oauth",
        choiceLabel: "xAI OAuth",
        groupId: "xai",
        groupLabel: "xAI (Grok)",
        onboardingFeatured: true,
        appGuidedAuth: "device-code",
      },
      {
        pluginId: "github-copilot",
        providerId: "github-copilot",
        methodId: "device",
        choiceId: "github-copilot",
        choiceLabel: "GitHub Copilot",
        appGuidedAuth: "device-code",
      },
      {
        pluginId: "xai",
        providerId: "xai",
        methodId: "device-code",
        choiceId: "xai-device-code",
        choiceLabel: "xAI device code",
        assistantVisibility: "manual-only",
        appGuidedAuth: "device-code",
      },
    ];

    expect(listSetupInferenceAuthOptions(choices)).toEqual([
      {
        id: "openai",
        label: "ChatGPT Login",
        hint: "Browser sign-in",
        groupLabel: "OpenAI",
        icon: "https://cdn.example.com/openai.svg",
        website: "https://openai.example.com/login",
        kind: "oauth",
        featured: true,
      },
      {
        id: "openrouter-oauth",
        label: "OpenRouter OAuth",
        groupLabel: "OpenRouter",
        kind: "oauth",
        featured: true,
      },
      {
        id: "xai-oauth",
        label: "xAI OAuth",
        groupLabel: "xAI (Grok)",
        kind: "device-code",
        featured: true,
      },
      {
        id: "google-gemini-cli",
        label: "Gemini CLI OAuth",
        groupLabel: "Google",
        kind: "oauth",
        featured: true,
      },
      {
        id: "github-copilot",
        label: "GitHub Copilot",
        kind: "device-code",
        featured: false,
      },
    ]);
  });

  it("marks a configured default-agent model as complete setup", async () => {
    vi.mocked(detectInferenceBackends).mockResolvedValueOnce([
      {
        kind: "existing-model",
        modelRef: "openai/gpt-5.5",
        label: "Current model",
        detail: "openai/gpt-5.5 — already configured",
        credentials: true,
      },
    ]);

    const detection = await detectSetupInference({
      resolveManifestProviderAuthChoices: () => [],
      probeLocalCommand: vi.fn(async (command) => ({ command, found: false })),
    });

    expect(detection).toMatchObject({
      configuredModel: "openai/gpt-5.5",
      setupComplete: true,
    });
  });

  it("omits Gemini CLI because setup verification cannot hard-disable its tools", async () => {
    vi.mocked(detectInferenceBackends).mockResolvedValueOnce([
      {
        kind: "gemini-cli",
        modelRef: "google-gemini-cli/gemini-3.1-pro-preview",
        label: "Gemini CLI",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "claude-cli",
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
    ]);

    const detection = await detectSetupInference({
      resolveManifestProviderAuthChoices: () => [],
      probeLocalCommand: vi.fn(async (command) => ({ command, found: false })),
    });

    expect(detection.candidates).toEqual([
      expect.objectContaining({ kind: "claude-cli", recommended: false }),
    ]);
    expect(detection.unavailableCandidates).toEqual([
      expect.objectContaining({ id: "gemini-cli" }),
    ]);
  });

  it("reports installed Pi and OpenCode without offering them as setup inference routes", async () => {
    vi.mocked(detectInferenceBackends).mockResolvedValueOnce([]);
    const probeLocalCommand = vi.fn(async (command: string) => ({
      command,
      found: command === "pi" || command === "opencode",
    }));

    const detection = await detectSetupInference({
      resolveManifestProviderAuthChoices: () => [],
      probeLocalCommand,
    });

    expect(detection.candidates).toEqual([]);
    expect(detection.unavailableCandidates).toEqual([
      {
        id: "pi-cli",
        label: "Pi CLI",
        detail: "installed",
        reason:
          "Pi CLI is installed, but its whole-agent sessions require separate setup and are not a reusable guided-setup inference route.",
      },
      {
        id: "opencode-cli",
        label: "OpenCode CLI",
        detail: "installed",
        reason:
          "OpenCode CLI is installed, but its ACP harness requires separate setup and is not a reusable guided-setup inference route.",
      },
    ]);
    expect(probeLocalCommand).toHaveBeenCalledWith("pi");
    expect(probeLocalCommand).toHaveBeenCalledWith("opencode");
  });
});

async function runCodexSetupWithFinalConfig(params: {
  initialConfig?: OpenClawConfig;
  currentConfig: OpenClawConfig;
  currentRuntimeConfig?: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}) {
  const initialConfig = params.initialConfig ?? params.sourceConfig;
  let persistedConfig = structuredClone(params.currentConfig);
  let committed = false;
  const refreshPluginRegistry = vi.fn(async () => {});
  const transformConfig = vi.fn(
    async (input: {
      transform: (
        config: OpenClawConfig,
        context: {
          snapshot: {
            exists: true;
            valid: true;
            path: string;
            config: OpenClawConfig;
            sourceConfig: OpenClawConfig;
            runtimeConfig: OpenClawConfig;
          };
          previousHash: string | null;
          attempt: number;
        },
      ) => Promise<{ nextConfig: OpenClawConfig }> | { nextConfig: OpenClawConfig };
    }) => {
      const runtimeConfig = params.currentRuntimeConfig ?? params.sourceConfig;
      const transformed = await input.transform(persistedConfig, {
        snapshot: {
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          config: runtimeConfig,
          sourceConfig: persistedConfig,
          runtimeConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      persistedConfig = withoutPluginInstallRecords(transformed.nextConfig);
      committed = true;
      return { nextConfig: persistedConfig };
    },
  );
  const readConfigFileSnapshot = vi.fn(async () => {
    const runtimeConfig = committed ? persistedConfig : initialConfig;
    const sourceConfig = committed ? persistedConfig : params.sourceConfig;
    return {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: committed ? "after-setup" : "before-setup",
      issues: [],
      config: runtimeConfig,
      sourceConfig,
      runtimeConfig,
    };
  });
  const result = await activateSetupInference({
    kind: "codex-cli",
    workspace: "/tmp/openclaw-workspace",
    surface: "gateway",
    runtime,
    deps: {
      readConfigFileSnapshot: readConfigFileSnapshot as never,
      runEmbeddedAgent: vi.fn(successfulRunner("openai", "gpt-5.6-sol")) as never,
      ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        required: true,
        installed: true,
        status: "installed" as const,
      })) as never,
      transformConfigWithPendingPluginInstalls: transformConfig as never,
      refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
      createTempDir: makeTempDir,
    },
  });
  return { result, persistedConfig, refreshPluginRegistry, transformConfig };
}

describe("activateSetupInference", () => {
  it("omits the token cap when harness selection is automatic", () => {
    expect(resolveSetupInferenceProbeStreamParams("auto")).toEqual({});
    expect(resolveSetupInferenceProbeStreamParams("openclaw")).toEqual({
      streamParams: { maxTokens: 32 },
    });
  });

  beforeEach(() => {
    mocks.appendAudit.mockReset();
    mocks.ensureSelectedAgentHarnessPlugin.mockReset().mockResolvedValue(undefined);
    mocks.refreshPluginRegistryAfterConfigMutation.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createGroqSetupProvider(configPatch?: Partial<OpenClawConfig>): ProviderPlugin {
    return {
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
                credential: {
                  type: "api_key" as const,
                  provider: "groq",
                  key: ctx.opts?.token,
                },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
            ...(configPatch !== undefined ? { configPatch } : {}),
          }),
        },
      ],
    };
  }

  function groqSetupChoice(): ProviderAuthChoiceMetadata {
    return {
      pluginId: "groq",
      providerId: "groq",
      methodId: "api-key",
      choiceId: "groq-api-key",
      choiceLabel: "Groq API key",
      appGuidedSecret: true,
    };
  }

  it("surfaces an invalid existing config without probing or persisting", async () => {
    const runEmbeddedAgent = vi.fn();
    const transformConfig = vi.fn();

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
          transformConfigWithPendingPluginInstalls: transformConfig as never,
        },
      }),
    ).rejects.toThrow(
      "OpenClaw config /tmp/openclaw.json is invalid (gateway.port: Expected a number). Fix it before running setup.",
    );
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it("reports an audit warning without turning a committed setup into a failure", async () => {
    mocks.appendAudit.mockRejectedValueOnce(new Error("audit directory is read-only"));
    const error = vi.fn();
    const configHarness = createConfigTransformHarness();

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime: { log: () => {}, error, exit: () => {} } as never,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          hash: "setup-config-hash",
          config: {},
          sourceConfig: {},
          runtimeConfig: {},
        })) as never,
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      lines: [
        "Inference verified: claude-cli/claude-opus-4-8",
        "Inference setup completed, but OpenClaw could not record its audit entry: audit directory is read-only",
      ],
    });
    expect(error).toHaveBeenCalledWith(
      "Inference setup completed, but OpenClaw could not record its audit entry: audit directory is read-only",
    );
  });

  it("lets an enclosing persistent operation own the setup audit", async () => {
    const configHarness = createConfigTransformHarness();

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      recordSetupAudit: false,
      runtime,
      deps: {
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      lines: ["Inference verified: claude-cli/claude-opus-4-8"],
    });
    expect(mocks.appendAudit).not.toHaveBeenCalled();
  });

  it("persists inference only after the live test succeeds", async () => {
    const initialConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            agentDir: "/tmp/openclaw-ops-agent",
            params: { temperature: 0.2 },
            tools: { allow: ["read"], deny: ["exec"] },
          },
          {
            id: "openclaw",
            params: { temperature: 1.7 },
            tools: { allow: ["exec"] },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness(initialConfig);
    const runCliAgent = vi.fn(successfulRunner("claude-cli", "claude-opus-4-8"));
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: initialConfig,
          sourceConfig: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runCliAgent: runCliAgent as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelRef).toBe("claude-cli/claude-opus-4-8");
      expect(result.lines).toEqual(["Inference verified: claude-cli/claude-opus-4-8"]);
    }
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "openclaw",
        agentDir: "/tmp/openclaw-ops-agent",
        executionMode: "side-question",
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    const probeConfig = runCliAgent.mock.calls[0]?.[0].config;
    expect(probeConfig?.agents?.list?.find((agent) => agent.id === "openclaw")).toEqual({
      id: "openclaw",
      params: { temperature: 0.2 },
      tools: { allow: ["read"], deny: ["exec"] },
    });
    expect(configHarness.current().agents?.entries?.openclaw).toEqual({
      params: { temperature: 1.7 },
      tools: { allow: ["exec"] },
    });
    expect(configHarness.transform).toHaveBeenCalledOnce();
  });

  it("rejects an unattested successful candidate before persisting its model", async () => {
    const configHarness = createConfigTransformHarness();
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      error: expect.stringContaining("did not report an owner"),
    });
    expect(configHarness.transform).not.toHaveBeenCalled();
    expect(configHarness.current()).toEqual({});
  });

  it("rejects an unattested existing route before handing off to OpenClaw", async () => {
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness();
    const result = await activateSetupInference({
      kind: "existing-model",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({ exists: true, valid: true, config })) as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      error: expect.stringContaining("did not report an owner"),
    });
    expect(configHarness.transform).not.toHaveBeenCalled();
  });

  it("keeps a committed success when temporary cleanup fails", async () => {
    const configHarness = createConfigTransformHarness();
    const runtimeLog = vi.fn();
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime: { log: runtimeLog, error: () => {}, exit: () => {} } as never,
      deps: {
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: async () => "/tmp/openclaw-setup-cleanup-fixture",
        removeTempDir: async () => {
          throw new Error("simulated cleanup failure");
        },
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "claude-cli/claude-opus-4-8" });
    expect(runtimeLog).not.toHaveBeenCalled();
  });

  it("disposes the temporary auth database before Windows-style removal", async () => {
    const tempDir = await makeTempDir();
    const databasePath = path.join(tempDir, "agent", "openclaw-agent.sqlite");
    let disposed = false;
    const disposeDatabase = vi.fn((pathname: string) => {
      expect(pathname).toBe(databasePath);
      disposed = disposeOpenClawAgentDatabaseByPath(pathname);
      return disposed;
    });
    const removeTempDir = vi.fn(async (dir: string) => {
      if (!disposed) {
        const error = new Error("file is in use") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      await fs.rm(dir, { recursive: true, force: true });
    });

    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: "groq-api-key",
      apiKey: "temporary-plaintext-key",
      surface: "gateway",
      runtime,
      deps: {
        resolvePluginProviders: () => [createGroqSetupProvider()],
        resolveManifestProviderAuthChoice: groqSetupChoice,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error("401 invalid_api_key");
        }) as never,
        disposeOpenClawAgentDatabaseByPath: disposeDatabase,
        createTempDir: async () => tempDir,
        removeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(disposeDatabase).toHaveBeenCalledOnce();
    expect(removeTempDir).toHaveBeenCalledWith(tempDir);
    await expect(fs.stat(tempDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a config write that committed before its writer threw", async () => {
    let committedConfig: OpenClawConfig | undefined;
    const readConfigFileSnapshot = vi.fn(async () => ({
      exists: true,
      valid: true,
      config: committedConfig ?? {},
      runtimeConfig: committedConfig ?? {},
    }));
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        committedConfig = (
          await params.transform({}, { snapshot: { config: {}, runtimeConfig: {} } })
        ).nextConfig;
        throw new Error("simulated post-write failure");
      },
    );

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "claude-cli/claude-opus-4-8" });
    expect(committedConfig?.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
  });

  it("persists only the verified model before OpenClaw configures the rest", async () => {
    const configHarness = createConfigTransformHarness();

    const result = await activateSetupInference({
      kind: "claude-cli",
      workspace: "/tmp/not-persisted-yet",
      surface: "cli",
      runtime,
      deps: {
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelRef: "claude-cli/claude-opus-4-8",
      lines: ["Inference verified: claude-cli/claude-opus-4-8"],
    });
    const persistedConfig = configHarness.current();
    expect(persistedConfig.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
    expect(persistedConfig.agents?.defaults?.workspace).toBeUndefined();
    expect(persistedConfig.gateway).toBeUndefined();
  });

  it.each([
    {
      name: "auto-enables the lean surface for a verified local model",
      initialConfig: {} satisfies OpenClawConfig,
      expectedLean: true,
      expectedAnnouncement: true,
    },
    {
      name: "preserves an explicit localModelLean=false",
      initialConfig: {
        agents: { defaults: { experimental: { localModelLean: false } } },
      } satisfies OpenClawConfig,
      expectedLean: false,
      expectedAnnouncement: false,
    },
  ])("$name", async ({ initialConfig, expectedLean, expectedAnnouncement }) => {
    const modelRef = "lmstudio/qwen-local";
    const detect = vi.fn(async () => ({ modelRef, detail: "qwen-local at localhost" }));
    const prepare = vi.fn(async () => ({
      profiles: [],
      defaultModel: modelRef,
      configPatch: {
        models: {
          mode: "merge" as const,
          providers: {
            lmstudio: {
              baseUrl: "http://127.0.0.1:1234/v1",
              api: "openai-completions" as const,
              models: [
                {
                  id: "qwen-local",
                  name: "Qwen Local",
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      },
    }));
    const provider: ProviderPlugin = {
      id: "lmstudio",
      label: "LM Studio",
      pluginId: "lmstudio",
      auth: [
        {
          id: "custom",
          label: "LM Studio",
          kind: "custom",
          appGuidedSetup: { detect, prepare },
          run: async () => ({ profiles: [] }),
        },
      ],
    };
    const configHarness = createConfigTransformHarness(initialConfig);
    const updateAuthStore = vi.fn();

    const result = await activateSetupInference({
      kind: "provider-auto:lmstudio",
      modelRef,
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          sourceConfig: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        resolveManifestProviderAuthChoice: () => ({
          pluginId: "lmstudio",
          providerId: "lmstudio",
          methodId: "custom",
          choiceId: "lmstudio",
          choiceLabel: "LM Studio",
          appGuidedDiscovery: true,
        }),
        resolvePluginProviders: () => [provider],
        runEmbeddedAgent: vi.fn(successfulRunner("lmstudio", "qwen-local")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        updateAuthProfileStoreWithLock: updateAuthStore as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.lines).toEqual([
      `Inference verified: ${modelRef}`,
      ...(expectedAnnouncement
        ? [
            "This model is small, so I set up the lean surface — switching to a bigger model later lifts it.",
          ]
        : []),
    ]);
    expect(detect).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledOnce();
    expect(updateAuthStore).not.toHaveBeenCalled();
    expect(configHarness.current()).toMatchObject({
      ...(expectedAnnouncement ? { wizard: { localModelLeanAutoModel: modelRef } } : {}),
      agents: { defaults: { model: modelRef, experimental: { localModelLean: expectedLean } } },
      models: {
        providers: {
          lmstudio: {
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [expect.objectContaining({ id: "qwen-local" })],
          },
        },
      },
      plugins: { entries: { lmstudio: { enabled: true } } },
    });
  });

  it("rebases model persistence on concurrent default-agent edits", async () => {
    const probedConfig: OpenClawConfig = {
      agents: { list: [{ id: "work", default: true, model: "openai/broken" }] },
    };
    const concurrentConfig: OpenClawConfig = {
      agents: {
        list: [
          { id: "work", default: true, model: "openai/broken", name: "edited during probe" },
          { id: "new-agent", model: "anthropic/claude-opus-4-8" },
        ],
      },
    };
    const configHarness = createConfigTransformHarness(concurrentConfig);

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "cli",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: probedConfig,
        })) as never,
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    const persistedConfig = configHarness.current();
    expect(persistedConfig.agents?.entries).toEqual({
      work: {
        default: true,
        model: "claude-cli/claude-opus-4-8",
        name: "edited during probe",
        models: { "claude-cli/claude-opus-4-8": {} },
      },
      "new-agent": { model: "anthropic/claude-opus-4-8" },
    });
  });

  it.each([
    {
      name: "default model",
      concurrent: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              agentDir: "/tmp/ops",
              model: "anthropic/claude-opus-4-8",
            },
            { id: "other", agentDir: "/tmp/other", model: "openai/broken" },
          ],
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "default agent",
      concurrent: {
        agents: {
          list: [
            { id: "ops", agentDir: "/tmp/ops", model: "openai/broken" },
            { id: "other", default: true, agentDir: "/tmp/other", model: "openai/broken" },
          ],
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "default agent directory",
      concurrent: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              agentDir: "/tmp/ops-moved",
              model: "openai/broken",
            },
          ],
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "default agent execution settings",
      concurrent: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              agentDir: "/tmp/ops",
              model: "openai/broken",
              params: { temperature: 0.9 },
              tools: { deny: ["exec"] },
            },
            { id: "other", agentDir: "/tmp/other", model: "openai/broken" },
          ],
        },
      } satisfies OpenClawConfig,
    },
  ])("rejects a changed $name after the live probe", async ({ concurrent }) => {
    const probedConfig = {
      agents: {
        list: [
          { id: "ops", default: true, agentDir: "/tmp/ops", model: "openai/broken" },
          { id: "other", agentDir: "/tmp/other", model: "openai/broken" },
        ],
      },
    } satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness(concurrent);

    await expect(
      activateSetupInference({
        kind: "claude-cli",
        surface: "cli",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config: probedConfig,
            runtimeConfig: probedConfig,
          })) as never,
          runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow("route changed during its live test");

    expect(configHarness.current()).toEqual(canonicalizeAgentEntriesForTest(concurrent));
  });

  it("rejects a concurrent edit to inactive target-model metadata", async () => {
    const initialConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
          models: {
            "anthropic/claude-opus-4-8": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const concurrentConfig = structuredClone(initialConfig);
    concurrentConfig.agents!.defaults!.models!["anthropic/claude-opus-4-8"] = {
      agentRuntime: { id: "codex" },
    };
    const configHarness = createConfigTransformHarness(concurrentConfig);

    await expect(
      activateSetupInference({
        kind: "anthropic-api-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            config: initialConfig,
            sourceConfig: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          runEmbeddedAgent: vi.fn(successfulRunner("anthropic", "claude-opus-4-8")) as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow("target model metadata changed");

    expect(configHarness.current()).toEqual(canonicalizeAgentEntriesForTest(concurrentConfig));
  });

  it("preserves authored provider rows and lifts an onboarding-owned lean setting", async () => {
    const sourceConfig = {
      wizard: { localModelLeanAutoModel: "lmstudio/qwen-local" },
      agents: {
        defaults: {
          model: "lmstudio/qwen-local",
          experimental: { localModelLean: true },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.6",
                name: "GPT-5.6 authored",
                reasoning: false,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
                contextWindow: 200_000,
                maxTokens: 64_000,
              },
            ],
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig: OpenClawConfig = structuredClone(sourceConfig);
    runtimeConfig.models!.providers!.openai!.models = [
      {
        id: "gpt-5.6",
        name: "GPT-5.6",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272_000,
        maxTokens: 128_000,
      },
    ];
    const configHarness = createConfigTransformHarness(sourceConfig, runtimeConfig);

    const result = await activateSetupInference({
      kind: "openai-api-key",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: sourceConfig,
          sourceConfig,
          runtimeConfig,
        })) as never,
        runEmbeddedAgent: vi.fn(successfulRunner("openai", "gpt-5.6")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.6" });
    expect(configHarness.current().models?.providers?.openai?.models).toEqual(
      sourceConfig.models.providers.openai.models,
    );
    expect(configHarness.current().agents?.defaults?.experimental?.localModelLean).toBeUndefined();
    expect(configHarness.current().wizard?.localModelLeanAutoModel).toBeUndefined();
  });

  it("rejects an existing route that changes after its live probe", async () => {
    const initialConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ exists: true, valid: true, config: initialConfig })
      .mockResolvedValueOnce({ exists: true, valid: true, config: changedConfig });

    const result = await activateSetupInference({
      kind: "existing-model",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        runEmbeddedAgent: vi.fn(successfulRunner("openai", "gpt-5.5")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      error: expect.stringContaining("route changed during its live test"),
    });
  });

  it("returns an auth failure when the verified owner drifts during persistence", async () => {
    const configHarness = createConfigTransformHarness();
    const result = await activateSetupInference({
      kind: "openai-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: vi.fn(successfulRunner("openai", "gpt-5.6")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        // The real revalidation throws when the current route owner no longer
        // matches the probe credential (e.g. a Codex-imported OAuth profile
        // outranking the probed env key). The ladder needs a failure result.
        createSystemAgentVerifiedInferenceBinding: vi.fn(async () => {
          throw new Error(
            "The successful inference credential is no longer the active route owner.",
          );
        }) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "auth",
      error: expect.stringContaining("verified inference owner changed"),
    });
    expect(configHarness.current()).toEqual({});
  });

  it("revalidates a stable CLI runtime owner at the config commit boundary", async () => {
    const configHarness = createConfigTransformHarness();
    const resolveCliRuntimeOwnerFingerprint = vi.fn(async () => "test-runtime-owner");

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        resolveCliRuntimeOwnerFingerprint: resolveCliRuntimeOwnerFingerprint as never,
        fingerprintPluginRuntimeArtifact: ({ pluginId }) => `${pluginId}-runtime-v1`,
        createSystemAgentVerifiedInferenceBinding,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(resolveCliRuntimeOwnerFingerprint).toHaveBeenCalledOnce();
    expect(configHarness.current().agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
  });

  it("rejects a CLI owner drift on an existing route before handoff", async () => {
    const config = {
      agents: {
        defaults: {
          model: "claude-cli/claude-opus-4-8",
        },
      },
    } satisfies OpenClawConfig;
    const result = await activateSetupInference({
      kind: "existing-model",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config,
          runtimeConfig: config,
        })) as never,
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        resolveCliRuntimeOwnerFingerprint: vi.fn(async () => "changed-runtime-owner") as never,
        createSystemAgentVerifiedInferenceBinding,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "auth",
      error: expect.stringContaining("owner changed"),
    });
  });

  it("rejects ambient credential drift before persisting a model", async () => {
    const initialAuthFingerprint = fingerprintResolvedProviderAuth({
      apiKey: "initial-env-key",
      source: "env:ANTHROPIC_API_KEY",
      mode: "api-key",
    });
    if (!initialAuthFingerprint) {
      throw new Error("expected auth fingerprint");
    }
    const configHarness = createConfigTransformHarness();
    const runEmbeddedAgent = vi.fn(async (params: SuccessfulRunParams) => {
      params.onSuccessfulAuthBinding?.({
        ...successfulAgentHarnessBinding(params),
        authFingerprint: initialAuthFingerprint,
        modelId: "claude-opus-4-8",
        modelApi: "anthropic-messages",
      });
      return successfulRun("anthropic", "claude-opus-4-8");
    });

    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        resolveApiKeyForProvider: vi.fn(async () => ({
          apiKey: "rotated-env-key",
          source: "env:ANTHROPIC_API_KEY",
          mode: "api-key",
        })) as never,
        createSystemAgentVerifiedInferenceBinding,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    // Owner drift is a failure result, not a throw: the guided-onboarding
    // ladder must be able to continue to its next candidate.
    expect(result).toMatchObject({
      ok: false,
      status: "auth",
      error: expect.stringContaining("active route owner"),
    });
    expect(configHarness.transform).toHaveBeenCalledOnce();
    expect(configHarness.current()).toEqual({});
  });

  it("does not configure Codex while selecting Claude as the primary backend", async () => {
    const sourceConfig = {} satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness(sourceConfig);
    const ensureCodexRuntimePlugin = vi.fn();
    const runCliAgent = vi.fn(async (params: SuccessfulRunParams) => {
      expect(configHarness.transform).not.toHaveBeenCalled();
      return successfulRun("claude-cli", "claude-opus-4-8", params);
    });
    const refreshPluginRegistry = vi.fn(async () => {});

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
        ensureCodexRuntimePlugin: ensureCodexRuntimePlugin as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        runCliAgent: runCliAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude-cli", model: "claude-opus-4-8" }),
    );
    expect(ensureCodexRuntimePlugin).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
    expect(configHarness.transform).toHaveBeenCalledOnce();
    expect(configHarness.current()).toMatchObject({
      agents: { defaults: { model: "claude-cli/claude-opus-4-8" } },
    });
    expect(configHarness.current().plugins?.entries?.codex).toBeUndefined();
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
    const ensureCodexRuntimePlugin = vi.fn();
    const configHarness = createConfigTransformHarness(config);

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
        ensureCodexRuntimePlugin: ensureCodexRuntimePlugin as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        runCliAgent: vi.fn(successfulRunner("claude-cli", "claude-opus-4-8")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(ensureCodexRuntimePlugin).not.toHaveBeenCalled();
    expect(configHarness.transform).toHaveBeenCalledOnce();
    expect(configHarness.current()).toMatchObject(config);
    expect(configHarness.current()).toMatchObject({
      agents: { defaults: { model: "claude-cli/claude-opus-4-8" } },
    });
  });

  it("does not touch config when the live test fails", async () => {
    const providerSecret = "gsk_abcdefghijklmnop";
    const transformConfig = vi.fn();
    const runCliAgent = vi.fn(async () => {
      throw new Error(`401 invalid_api_key ${providerSecret}`);
    });
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid_api_key");
      expect(result.error).not.toContain(providerSecret);
    }
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it("treats an empty model reply as a failure with bounded probe identifiers", async () => {
    const transformConfig = vi.fn();
    const runEmbeddedAgent = vi.fn(async (_params: { runId?: string; sessionId?: string }) => ({
      payloads: [],
    }));
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result).toMatchObject({ ok: false, status: "format" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^probe-setup-inference-/),
        sessionId: expect.stringMatching(/^probe-setup-inference-/),
        sessionKey: expect.stringMatching(/^temp:setup-inference:probe-setup-inference-/),
        lane: "session:probe-setup-inference:anthropic",
      }),
    );
    const probeCall = runEmbeddedAgent.mock.calls[0]?.[0];
    expect(probeCall).toBeDefined();
    expect(probeCall?.sessionId).toBe(probeCall?.runId);
    expect(probeCall?.sessionId).toHaveLength(58);
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "error payload",
      result: {
        payloads: [{ text: "Blocked by before-run policy.", isError: true }],
        meta: { finalAssistantVisibleText: "Blocked by before-run policy." },
      },
    },
    {
      name: "terminal metadata error",
      result: {
        payloads: [{ text: "Agent could not complete the turn." }],
        meta: {
          finalAssistantVisibleText: "Agent could not complete the turn.",
          error: { kind: "incomplete_turn", message: "Agent could not complete the turn." },
        },
      },
    },
    {
      name: "blocked liveness state",
      result: {
        payloads: [{ text: "Run stopped before completion." }],
        meta: {
          finalAssistantVisibleText: "Run stopped before completion.",
          livenessState: "blocked",
        },
      },
    },
  ])("does not persist inference for a non-throwing $name", async ({ result: runResult }) => {
    const transformConfig = vi.fn();
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: vi.fn(async () => runResult) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unknown" });
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing winner metadata",
      runResult: { meta: { finalAssistantVisibleText: "OK" } },
      error: "did not report which provider and model",
    },
    {
      name: "model-routing override",
      runResult: successfulRun("openai", "gpt-5.5"),
      error: "instead of the requested anthropic/claude-opus-4-8",
    },
  ])("does not persist inference after a $name", async ({ runResult, error }) => {
    const transformConfig = vi.fn();
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: vi.fn(async () => runResult) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "format",
      error: expect.stringContaining(error),
    });
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "provider-level CLI runtime",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [],
        agentRuntime: { id: "claude-cli" as const },
      },
    },
    {
      name: "model-definition CLI runtime",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [
          {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            reasoning: true,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
            agentRuntime: { id: "claude-cli" as const },
          },
        ],
      },
    },
  ])("pins a built-in API candidate over a stale $name", async ({ providerConfig }) => {
    const initialConfig = {
      models: { providers: { anthropic: providerConfig } },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            model: { primary: "openai/gpt-5.4" },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const runEmbeddedAgent = vi.fn(successfulRunner("anthropic", "claude-opus-4-8"));
    const configHarness = createConfigTransformHarness(initialConfig);

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
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "anthropic/claude-opus-4-8" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "openclaw",
        provider: "anthropic",
        model: "claude-opus-4-8",
        agentHarnessRuntimeOverride: "openclaw",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            entries: expect.objectContaining({
              ops: expect.objectContaining({
                model: { primary: "anthropic/claude-opus-4-8" },
                models: {
                  "anthropic/claude-opus-4-8": {
                    agentRuntime: { id: "openclaw" },
                  },
                },
              }),
            }),
          }),
        }),
      }),
    );
    expect(configHarness.transform).toHaveBeenCalledOnce();
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

  it("persists provider OAuth when runtime defaults are absent from source config", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      agents: {
        ...initialConfig.agents,
        defaults: { models: { "openai/gpt-5.4": {} } },
      },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const runAuth = vi.fn(async () => ({
      profiles: [
        {
          profileId: "openai:default",
          credential: {
            type: "oauth" as const,
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      ],
      defaultModel: "openai/gpt-5.5",
      configPatch: {
        agents: { defaults: { models: { "openai/gpt-5.5": {} } } },
      },
    }));
    const provider: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      pluginId: "openai",
      auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run: runAuth }],
    };
    const runEmbeddedAgent = vi.fn(
      async (params: SuccessfulRunParams & { authProfileId?: string }) =>
        successfulRun("openai", "gpt-5.5", params),
    );
    const configHarness = createConfigTransformHarness(initialConfig, runtimeConfig);

    try {
      const result = await activateSetupInference({
        kind: "provider-auth",
        authChoice: "openai",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        prompter: { note: vi.fn(async () => {}) } as never,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config: initialConfig,
            sourceConfig: initialConfig,
            runtimeConfig,
          })) as never,
          resolvePluginProviders: () => [provider],
          resolveManifestProviderAuthChoice: () => ({
            pluginId: "openai",
            providerId: "openai",
            methodId: "oauth",
            choiceId: "openai",
            choiceLabel: "ChatGPT Login",
            appGuidedAuth: "oauth",
          }),
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
      expect(runAuth).toHaveBeenCalledOnce();
      const activatedProfileId = runEmbeddedAgent.mock.calls[0]?.[0].authProfileId;
      if (!activatedProfileId) {
        throw new Error("expected setup auth profile");
      }
      expect(activatedProfileId).toMatch(/^openai:setup-/);
      expect(readAuthProfileStoreForTest(agentDir).profiles[activatedProfileId]).toMatchObject({
        type: "oauth",
        provider: "openai",
        access: "access-token",
      });
      expect(configHarness.current()).toMatchObject({
        agents: { defaults: { model: `openai/gpt-5.5@${activatedProfileId}` } },
      });
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("does not probe or persist an interactive login after session cancellation", async () => {
    const runAuth = vi.fn(async () => ({ profiles: [], defaultModel: "openai/gpt-5.5" }));
    const runEmbeddedAgent = vi.fn();
    const provider: ProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      pluginId: "openai",
      auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run: runAuth }],
    };

    const result = await activateSetupInference({
      kind: "provider-auth",
      authChoice: "openai",
      surface: "gateway",
      runtime,
      prompter: {} as never,
      isCancelled: () => true,
      deps: {
        resolvePluginProviders: () => [provider],
        resolveManifestProviderAuthChoice: () => ({
          pluginId: "openai",
          providerId: "openai",
          methodId: "oauth",
          choiceId: "openai",
          choiceLabel: "ChatGPT Login",
          appGuidedAuth: "oauth",
        }),
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, error: "Provider login was cancelled." });
    expect(runAuth).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([
    { name: "API-key", authKind: "api_key" as const, credentialType: "api_key" as const },
    { name: "token", authKind: "token" as const, credentialType: "token" as const },
  ])(
    "uses a provider-owned $name method and persists it after a passing test",
    async ({ authKind, credentialType }) => {
      const stateDir = await makeTempDir();
      const agentDir = path.join(stateDir, "agent");
      const initialConfig = {
        agents: { list: [{ id: "main", default: true, agentDir }] },
        auth: {
          profiles: {
            "groq:legacy": { provider: "groq", mode: credentialType },
          },
        },
      } satisfies OpenClawConfig;
      // Custom agent directories must be bound to their configured owner before
      // the shared per-agent database is created.
      resolveAgentDir(initialConfig, "main");
      await upsertAuthProfileWithLock({
        profileId: "groq:legacy",
        credential:
          credentialType === "api_key"
            ? { type: "api_key", provider: "groq", key: "legacy-key" }
            : { type: "token", provider: "groq", token: "legacy-key" },
        agentDir,
      });
      await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.order = { groq: ["groq:legacy"] };
          return true;
        },
      });
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
      const runEmbeddedAgent = vi.fn(
        async (params: SuccessfulRunParams & { authProfileId?: string }) =>
          successfulRun("groq", "llama-3.3-70b-versatile", params),
      );
      const configHarness = createConfigTransformHarness(initialConfig);

      try {
        const result = await activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "test-groq-key",
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
            runEmbeddedAgent: runEmbeddedAgent as never,
            transformConfigWithPendingPluginInstalls: configHarness.transform as never,
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
        const activatedProfileId = runEmbeddedAgent.mock.calls[0]?.[0].authProfileId;
        if (!activatedProfileId) {
          throw new Error("expected setup auth profile");
        }
        expect(activatedProfileId).toMatch(/^groq:setup-/);
        expect(runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "openclaw",
            provider: "groq",
            model: "llama-3.3-70b-versatile",
            authProfileId: activatedProfileId,
            agentDir: expect.stringContaining("setup-inference-test-"),
            authProfileStateMode: "read-only",
            preparedModelRuntimeMode: "isolated-read-only",
          }),
        );
        expect(configHarness.current()).toMatchObject({
          plugins: { entries: { groq: { enabled: true } } },
          agents: {
            defaults: {
              model: `groq/llama-3.3-70b-versatile@${activatedProfileId}`,
            },
          },
          auth: {
            profiles: {
              [activatedProfileId]: { provider: "groq", mode: credentialType },
            },
          },
        });
        expect(readAuthProfileStoreForTest(agentDir).profiles[activatedProfileId]).toMatchObject(
          credentialType === "api_key"
            ? { type: "api_key", provider: "groq", key: "test-groq-key" }
            : { type: "token", provider: "groq", token: "test-groq-key" },
        );
        expect(readAuthProfileStoreForTest(agentDir).order?.groq).toEqual(["groq:legacy"]);
        expect(
          (await resolveSystemAgentConfiguredRouteFromConfig(configHarness.current()))
            ?.authProfileId,
        ).toBe(activatedProfileId);
      } finally {
        await removeOAuthTestTempRoot(stateDir);
      }
    },
  );

  it("rejects a manual probe that reports a different credential owner", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const transformConfig = vi.fn();
    const runEmbeddedAgent = vi.fn(
      async (params: SuccessfulRunParams & { authProfileId?: string }) => {
        params.onSuccessfulAuthBinding?.({
          authProfileId: "groq:fallback",
          ...successfulAgentHarnessBinding(params),
          authFingerprint: "fallback-owner",
          modelId: "llama-3.3-70b-versatile",
          modelApi: "openai-completions",
        });
        return successfulRun("groq", "llama-3.3-70b-versatile");
      },
    );

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "groq-api-key",
        apiKey: "candidate-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            config: initialConfig,
            sourceConfig: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          resolvePluginProviders: () => [createGroqSetupProvider()],
          resolveManifestProviderAuthChoice: groqSetupChoice,
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: transformConfig as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        status: "auth",
        error: expect.stringContaining('used profile "groq:fallback"'),
      });
      expect(transformConfig).not.toHaveBeenCalled();
      expect(readAuthProfileStoreForTest(agentDir).profiles).toEqual({});
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("scopes provider setup to the selected inference route and one credential", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      gateway: { port: 18_789 },
      channels: { discord: { enabled: false } },
      agents: {
        defaults: { workspace: "/operator/workspace" },
        list: [{ id: "main", default: true, agentDir }],
      },
      auth: {
        profiles: { "operator:existing": { provider: "operator", mode: "api_key" } },
        order: { operator: ["operator:existing"] },
      },
      models: {
        providers: {
          aux: { baseUrl: "https://aux.example.test/v1", models: [] },
        },
      },
      plugins: {
        entries: { operator: { enabled: true, config: { revision: "initial" } } },
      },
    } satisfies OpenClawConfig;
    const concurrentConfig = structuredClone(initialConfig);
    concurrentConfig.gateway = { port: 19_000 };
    concurrentConfig.agents!.defaults!.workspace = "/operator/concurrent";
    concurrentConfig.models!.providers!.aux!.baseUrl = "https://concurrent.example.test/v1";
    resolveAgentDir(initialConfig, "main");
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
                profileId: "groq:selected",
                credential: {
                  type: "api_key" as const,
                  provider: "groq",
                  key: ctx.opts?.token,
                },
              },
              {
                profileId: "other:unselected",
                credential: {
                  type: "api_key" as const,
                  provider: "other",
                  key: "must-not-persist",
                },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
            configPatch: {
              gateway: { port: 99_999 },
              channels: { discord: { enabled: true, token: "must-not-persist" } },
              agents: {
                defaults: {
                  workspace: "/provider/workspace",
                  models: {
                    "groq/llama-3.3-70b-versatile": { alias: "selected-groq" },
                    "other/unrelated": { alias: "must-not-persist" },
                  },
                },
              },
              auth: { order: { other: ["other:unselected"] } },
              models: {
                providers: {
                  groq: {
                    baseUrl: "https://selected.groq.example.test/v1",
                    models: [],
                  },
                  aux: { baseUrl: "https://provider-overwrite.example.test/v1", models: [] },
                },
              },
              plugins: {
                entries: {
                  groq: { enabled: true, config: { endpoint: "selected" } },
                  operator: { enabled: false, config: { revision: "provider-overwrite" } },
                },
              },
            },
          }),
        },
      ],
    };
    const enablePluginInConfig = (config: OpenClawConfig, pluginId: string) => ({
      enabled: true as const,
      config: {
        ...config,
        plugins: {
          ...config.plugins,
          entries: {
            ...config.plugins?.entries,
            [pluginId]: { ...config.plugins?.entries?.[pluginId], enabled: true },
          },
        },
      },
    });
    const runEmbeddedAgent = vi.fn(
      async (params: SuccessfulRunParams & { config: OpenClawConfig }) =>
        successfulRun("groq", "llama-3.3-70b-versatile", params),
    );
    const configHarness = createConfigTransformHarness(concurrentConfig);

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "groq-api-key",
        apiKey: "selected-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            config: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          resolvePluginProviders: () => [provider],
          resolveManifestProviderAuthChoice: groqSetupChoice,
          enablePluginInConfig: enablePluginInConfig as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: true });
      const probeConfig = runEmbeddedAgent.mock.calls[0]![0].config;
      expect(probeConfig.gateway?.port).toBe(18_789);
      expect(probeConfig.agents?.defaults?.workspace).toBe("/operator/workspace");
      expect(probeConfig.channels?.discord).toEqual({ enabled: false });
      expect(probeConfig.models?.providers?.groq?.baseUrl).toBe(
        "https://selected.groq.example.test/v1",
      );
      expect(probeConfig.models?.providers?.aux?.baseUrl).toBe("https://aux.example.test/v1");
      expect(probeConfig.agents?.defaults?.models).toEqual({
        "groq/llama-3.3-70b-versatile": {
          alias: "selected-groq",
        },
      });
      expect(probeConfig.agents?.entries?.main?.models).toMatchObject({
        "groq/llama-3.3-70b-versatile": { agentRuntime: { id: "openclaw" } },
      });
      expect(probeConfig.plugins?.entries?.groq).toEqual({
        enabled: true,
        config: { endpoint: "selected" },
      });
      expect(probeConfig.plugins?.entries?.operator).toEqual(
        initialConfig.plugins.entries.operator,
      );
      expect(Object.keys(probeConfig.auth?.profiles ?? {})).toEqual(
        expect.arrayContaining(["operator:existing"]),
      );
      expect(Object.keys(probeConfig.auth?.profiles ?? {})).not.toContain("other:unselected");
      expect(probeConfig.auth?.order).toEqual(initialConfig.auth.order);

      const persisted = configHarness.current();
      expect(persisted.gateway?.port).toBe(19_000);
      expect(persisted.agents?.defaults?.workspace).toBe("/operator/concurrent");
      expect(persisted.channels?.discord).toEqual({ enabled: false });
      expect(persisted.models?.providers?.aux?.baseUrl).toBe("https://concurrent.example.test/v1");
      expect(persisted.models?.providers?.groq?.baseUrl).toBe(
        "https://selected.groq.example.test/v1",
      );
      expect(persisted.plugins?.entries?.operator).toEqual(initialConfig.plugins.entries.operator);
      expect(persisted.plugins?.entries?.groq).toEqual({
        enabled: true,
        config: { endpoint: "selected" },
      });
      const setupProfileIds = Object.keys(persisted.auth?.profiles ?? {}).filter((id) =>
        id.includes(":setup-"),
      );
      expect(setupProfileIds).toHaveLength(1);
      expect(setupProfileIds[0]).toMatch(/^groq:setup-/);
      expect(Object.keys(readAuthProfileStoreForTest(agentDir).profiles)).toEqual(setupProfileIds);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("rolls back manual auth when the real-store owner differs at commit", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const configHarness = createConfigTransformHarness(initialConfig);
    const runEmbeddedAgent = vi.fn(
      async (
        params: SuccessfulRunParams & {
          authProfileId?: string;
        },
      ) => {
        const profileId = params.authProfileId;
        if (!profileId) {
          throw new Error("expected setup profile");
        }
        const authFingerprint = fingerprintResolvedProviderAuth({
          apiKey: "submitted-key",
          profileId,
          source: `profile:${profileId}`,
          mode: "api-key",
        });
        if (!authFingerprint) {
          throw new Error("expected setup fingerprint");
        }
        params.onSuccessfulAuthBinding?.({
          authProfileId: profileId,
          ...successfulAgentHarnessBinding(params),
          authFingerprint,
          modelId: "llama-3.3-70b-versatile",
          modelApi: "openai-completions",
        });
        return successfulRun("groq", "llama-3.3-70b-versatile");
      },
    );

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "groq-api-key",
        apiKey: "submitted-key",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            config: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          resolvePluginProviders: () => [createGroqSetupProvider()],
          resolveManifestProviderAuthChoice: groqSetupChoice,
          runEmbeddedAgent: runEmbeddedAgent as never,
          resolveApiKeyForProvider: vi.fn(async (params: { profileId?: string }) => ({
            apiKey: "different-real-store-key",
            profileId: params.profileId,
            source: `profile:${params.profileId}`,
            mode: "api-key",
          })) as never,
          createSystemAgentVerifiedInferenceBinding,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      });

      // Owner drift resolves to an auth failure after rolling back the staged
      // credential; a throw here used to crash the onboarding wizard.
      expect(result).toMatchObject({
        ok: false,
        status: "auth",
        error: expect.stringContaining("active route owner"),
      });
      expect(configHarness.current()).toEqual(canonicalizeAgentEntriesForTest(initialConfig));
      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("rolls back a staged key when the config commit fails", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
      auth: { profiles: { "groq:default": { provider: "groq", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
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
                credential: {
                  type: "api_key" as const,
                  provider: "groq",
                  key: ctx.opts?.token,
                },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
          }),
        },
      ],
    };
    await upsertAuthProfileWithLock({
      profileId: "groq:default",
      credential: { type: "api_key", provider: "groq", key: "existing-key" },
      agentDir,
    });
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      await params.transform(initialConfig, {
        snapshot: { config: initialConfig, runtimeConfig: initialConfig },
        previousHash: null,
        attempt: 0,
      });
      throw new Error("simulated config commit failure");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "replacement-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [provider],
            resolveManifestProviderAuthChoice: () => ({
              pluginId: "groq",
              providerId: "groq",
              methodId: "api-key",
              choiceId: "groq-api-key",
              choiceLabel: "Groq API key",
              appGuidedSecret: true,
            }),
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("simulated config commit failure");

      const store = readAuthProfileStoreForTest(agentDir);
      expect(store.profiles["groq:default"]).toMatchObject({ key: "existing-key" });
      expect(Object.keys(store.profiles).filter((id) => id.startsWith("groq:setup-"))).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("does not delete an identical credential that existed before activation", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const credential = {
      type: "api_key" as const,
      provider: "groq",
      key: "submitted-key",
    };
    let existingProfileId: string | undefined;
    let preexistingCredentialDeleted = false;
    let realStoreUpdates = 0;
    const profiles = new Proxy<Record<string, typeof credential>>(
      {},
      {
        get: (target, property) => {
          if (typeof property === "string" && property.startsWith("groq:setup-")) {
            existingProfileId ??= property;
            return credential;
          }
          return Reflect.get(target, property);
        },
        deleteProperty: (target, property) => {
          if (property === existingProfileId) {
            preexistingCredentialDeleted = true;
          }
          return Reflect.deleteProperty(target, property);
        },
      },
    );
    const preexistingStore = { version: 1, profiles };
    const updateAuthProfileStore = vi.fn(
      async (params: Parameters<typeof updateAuthProfileStoreWithLock>[0]) => {
        if (params.agentDir !== agentDir) {
          return await updateAuthProfileStoreWithLock(params);
        }
        realStoreUpdates += 1;
        params.updater(preexistingStore);
        return preexistingStore;
      },
    );
    const transformConfig = vi.fn(async () => {
      throw new Error("simulated config commit failure");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "submitted-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            updateAuthProfileStoreWithLock: updateAuthProfileStore as never,
            loadPersistedAuthProfileStore: vi.fn((candidateAgentDir?: string) => {
              const resolvedAgentDir = candidateAgentDir ?? resolveAgentDir(initialConfig, "main");
              return resolvedAgentDir === agentDir
                ? preexistingStore
                : readAuthProfileStoreForTest(resolvedAgentDir);
            }) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("simulated config commit failure");

      expect(existingProfileId).toMatch(/^groq:setup-/);
      expect(realStoreUpdates).toBe(1);
      expect(preexistingCredentialDeleted).toBe(false);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("rolls back before reconciliation when the config transform rejects the candidate", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    const concurrentConfig = {
      ...initialConfig,
      agents: {
        ...initialConfig.agents,
        defaults: { model: "openai/gpt-5.5" },
      },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        config: initialConfig,
        sourceConfig: initialConfig,
        runtimeConfig: initialConfig,
      })
      .mockRejectedValue(new Error("simulated reconciliation read failure"));
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      await params.transform(concurrentConfig, {
        snapshot: {
          config: concurrentConfig,
          sourceConfig: concurrentConfig,
          runtimeConfig: concurrentConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      throw new Error("unreachable config commit");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          workspace: "/tmp/openclaw-workspace",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: readConfigFileSnapshot as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("default-agent inference route changed during its live test");

      expect(readConfigFileSnapshot).toHaveBeenCalledOnce();
      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("retains a credential when a post-write concurrent edit still references it", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    let currentConfig: OpenClawConfig = initialConfig;
    const readConfigFileSnapshot = vi.fn(async () => ({
      exists: true,
      valid: true,
      config: currentConfig,
      sourceConfig: currentConfig,
      runtimeConfig: currentConfig,
    }));
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      const transformed = await params.transform(initialConfig, {
        snapshot: {
          config: initialConfig,
          sourceConfig: initialConfig,
          runtimeConfig: initialConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      currentConfig = {
        ...transformed.nextConfig,
        agents: {
          ...transformed.nextConfig.agents,
          defaults: {
            ...transformed.nextConfig.agents?.defaults,
            params: { temperature: 0.25 },
          },
        },
      };
      throw new Error("simulated post-write failure after concurrent edit");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: readConfigFileSnapshot as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("credential was retained because the current config may reference it");

      const profileId = Object.keys(readAuthProfileStoreForTest(agentDir).profiles).find((id) =>
        id.startsWith("groq:setup-"),
      );
      expect(profileId).toBeDefined();
      expect(currentConfig.auth?.profiles?.[profileId!]).toMatchObject({ provider: "groq" });
      expect(currentConfig.agents?.defaults?.model).toContain(`@${profileId}`);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("confirms rollback from the locked update when independent readback fails", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      await params.transform(initialConfig, {
        snapshot: { config: initialConfig, runtimeConfig: initialConfig },
        previousHash: null,
        attempt: 0,
      });
      throw new Error("simulated config commit failure");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "replacement-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            loadPersistedAuthProfileStore: vi.fn(() => {
              throw new Error("simulated auth read failure");
            }),
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("simulated config commit failure");

      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it.each([
    { name: "returns no store", failure: "null" as const },
    { name: "throws", failure: "throw" as const },
  ])("reports an indeterminate activation when rollback $name", async ({ failure }) => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const concurrentConfig = {
      ...initialConfig,
      agents: {
        ...initialConfig.agents,
        defaults: { model: "openai/gpt-5.5" },
      },
    } satisfies OpenClawConfig;
    let realStoreWrites = 0;
    const updateAuthProfileStore = vi.fn(async (params) => {
      if (params.agentDir === agentDir) {
        realStoreWrites += 1;
        if (realStoreWrites > 1) {
          if (failure === "throw") {
            throw new Error("simulated rollback write failure");
          }
          return null;
        }
      }
      return await updateAuthProfileStoreWithLock(params);
    });
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      await params.transform(concurrentConfig, {
        snapshot: {
          config: concurrentConfig,
          sourceConfig: concurrentConfig,
          runtimeConfig: concurrentConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      throw new Error("unreachable config commit");
    });

    try {
      const error = await activateSetupInference({
        kind: "api-key",
        authChoice: "groq-api-key",
        apiKey: "candidate-key",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            config: initialConfig,
            sourceConfig: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          resolvePluginProviders: () => [createGroqSetupProvider()],
          resolveManifestProviderAuthChoice: groqSetupChoice,
          runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
          transformConfigWithPendingPluginInstalls: transformConfig as never,
          updateAuthProfileStoreWithLock: updateAuthProfileStore as never,
          loadPersistedAuthProfileStore: vi.fn(() => {
            throw new Error("simulated auth read failure");
          }),
          createTempDir: makeTempDir,
        },
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(SetupInferenceActivationIndeterminateError);
      expect(error).toMatchObject({
        message: expect.stringContaining("could not confirm removal"),
      });
      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toHaveLength(1);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("rolls back an uncertain auth write without accumulating profiles on retry", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const transformConfig = vi.fn();
    let realStoreUpdates = 0;
    const updateAuthProfileStore = vi.fn(async (params) => {
      const updated = await updateAuthProfileStoreWithLock(params);
      if (params.agentDir !== agentDir) {
        return updated;
      }
      realStoreUpdates += 1;
      return realStoreUpdates % 2 === 1 ? null : updated;
    });

    try {
      const activate = () =>
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          workspace: "/tmp/openclaw-workspace",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              sourceConfig: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            updateAuthProfileStoreWithLock: updateAuthProfileStore as never,
            loadPersistedAuthProfileStore: vi.fn(() => {
              throw new Error("simulated auth read failure");
            }),
            createTempDir: makeTempDir,
          },
        });

      await expect(activate()).resolves.toMatchObject({
        ok: false,
        status: "unknown",
        error: expect.stringContaining("rolled back"),
      });
      await expect(activate()).resolves.toMatchObject({
        ok: false,
        status: "unknown",
        error: expect.stringContaining("rolled back"),
      });
      expect(transformConfig).not.toHaveBeenCalled();
      expect(realStoreUpdates).toBe(4);
      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toHaveLength(0);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("ignores an unrelated provider patch and preserves a concurrent operator edit", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const auxProvider = {
      baseUrl: "https://aux.example.test/v1",
      apiKey: "base-key",
      models: [],
    };
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
      models: { providers: { aux: auxProvider } },
    } satisfies OpenClawConfig;
    const concurrentConfig: OpenClawConfig = {
      ...initialConfig,
      models: {
        providers: {
          aux: { ...auxProvider, apiKey: "operator-key" },
        },
      },
    };
    resolveAgentDir(initialConfig, "main");
    const configHarness = createConfigTransformHarness(concurrentConfig);
    const provider = createGroqSetupProvider({
      models: {
        providers: {
          aux: {
            baseUrl: "https://aux.example.test/v1",
            apiKey: { source: "env", provider: "default", id: "AUX_API_KEY" },
            models: [],
          },
        },
      },
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [provider],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
            transformConfigWithPendingPluginInstalls: configHarness.transform as never,
            createTempDir: makeTempDir,
          },
        }),
      ).resolves.toMatchObject({ ok: true });

      const persisted = configHarness.current();
      expect(persisted.models?.providers?.aux).toEqual(concurrentConfig.models?.providers?.aux);
      expect(persisted.agents?.defaults?.model).toMatch(
        /^groq\/llama-3\.3-70b-versatile@groq:setup-/,
      );
      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toHaveLength(1);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("resolves the config transformer before persisting a verified credential", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const authWriteDirs: string[] = [];
    const deps = {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: initialConfig,
        runtimeConfig: initialConfig,
      })) as never,
      resolvePluginProviders: () => [createGroqSetupProvider()],
      resolveManifestProviderAuthChoice: groqSetupChoice,
      runEmbeddedAgent: vi.fn(successfulRunner("groq", "llama-3.3-70b-versatile")) as never,
      updateAuthProfileStoreWithLock: vi.fn(async (params) => {
        authWriteDirs.push(params.agentDir ?? "");
        return await updateAuthProfileStoreWithLock(params);
      }),
      createTempDir: makeTempDir,
    };
    Object.defineProperty(deps, "transformConfigWithPendingPluginInstalls", {
      get: () => {
        throw new Error("simulated transformer resolution failure");
      },
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          surface: "gateway",
          runtime,
          deps: deps as never,
        }),
      ).rejects.toThrow("simulated transformer resolution failure");

      expect(authWriteDirs).not.toContain(agentDir);
      expect(readAuthProfileStoreForTest(agentDir).profiles).toEqual({});
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

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
    const runEmbeddedAgent = vi.fn(
      async (params: SuccessfulRunParams & { authProfileId?: string }) =>
        successfulRun("github-copilot", "claude-sonnet-4.5", params),
    );
    const initialConfig = {
      gateway: { port: 18789 },
      agents: {
        defaults: { model: { primary: existingModel } },
        list: [{ id: "main", default: true, agentDir }],
      },
    } satisfies OpenClawConfig;
    const concurrentConfig: OpenClawConfig = {
      gateway: { port: 19000 },
      agents: {
        defaults: { model: { primary: existingModel } },
        list: [{ id: "main", default: true, agentDir }],
      },
    } satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness(concurrentConfig);

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
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
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
      const activatedProfileId = runEmbeddedAgent.mock.calls[0]?.[0].authProfileId;
      if (!activatedProfileId) {
        throw new Error("expected setup auth profile");
      }
      expect(activatedProfileId).toMatch(/^github-copilot:setup-/);
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "openclaw",
          agentDir: expect.stringContaining("setup-inference-test-"),
          authProfileId: activatedProfileId,
          provider: "github-copilot",
          model: "claude-sonnet-4.5",
        }),
      );
      expect(readAuthProfileStoreForTest(agentDir).profiles[activatedProfileId]).toMatchObject({
        type: "token",
        provider: "github-copilot",
        token: "github-token",
      });
      const persistedConfig = configHarness.current();
      expect(persistedConfig.gateway?.port).toBe(19000);
      expect(persistedConfig.agents?.defaults?.model).toEqual({
        primary: `github-copilot/claude-sonnet-4.5@${activatedProfileId}`,
      });
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
          runEmbeddedAgent: vi.fn(async () => {
            throw new Error("401 rejected credential bad-groq-key");
          }) as never,
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
    const runtimeLog = vi.fn();
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
    const runEmbeddedAgent = vi.fn(async (params: SuccessfulRunParams) => {
      events.push("live-test");
      return successfulRun("openai", "gpt-5.6-sol", params);
    });
    let persistedConfig: OpenClawConfig = {
      ...initialConfig,
      gateway: { port: 19000 },
    };
    let activationCommitted = false;
    const pendingCodexInstalls: unknown[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: {
            snapshot: {
              config: OpenClawConfig;
              sourceConfig: OpenClawConfig;
              runtimeConfig: OpenClawConfig;
            };
          },
        ) => Promise<{ nextConfig: OpenClawConfig }> | { nextConfig: OpenClawConfig };
      }) => {
        const transformed = (
          await params.transform(persistedConfig, {
            snapshot: {
              config: persistedConfig,
              sourceConfig: persistedConfig,
              runtimeConfig: persistedConfig,
            },
          })
        ).nextConfig;
        const configuredRuntime =
          transformed.agents?.defaults?.models?.["openai/gpt-5.6-sol"]?.agentRuntime?.id ??
          transformed.agents?.entries?.ops?.models?.["openai/gpt-5.6-sol"]?.agentRuntime?.id;
        events.push(configuredRuntime === "codex" ? "persist-plugin-config" : "unexpected-write");
        pendingCodexInstalls.push(transformed.plugins?.installs?.codex);
        persistedConfig = withoutPluginInstallRecords(transformed);
        activationCommitted = true;
        return { nextConfig: persistedConfig };
      },
    );
    const refreshPluginRegistry = vi.fn(async () => {
      events.push("refresh-plugin-registry");
      if (refreshPluginRegistry.mock.calls.length > 1) {
        throw new Error("simulated registry refresh failure");
      }
    });
    const markRetainedInstall = vi.fn(async () => {
      events.push("retain-plugin-install");
      return true;
    });
    const ensureRegistryLoaded = vi.fn(() => {
      events.push("reload-active-registry");
    });
    const result = await activateSetupInference({
      kind: "codex-cli",
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime: { log: runtimeLog, error: () => {}, exit: () => {} } as never,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => {
          const config = activationCommitted ? persistedConfig : initialConfig;
          return {
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config,
            sourceConfig: config,
            runtimeConfig: config,
          };
        }) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        markRetainedManagedNpmInstall: markRetainedInstall,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        ensurePluginRegistryLoaded: ensureRegistryLoaded,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    expect(runtimeLog).not.toHaveBeenCalled();
    expect(ensureCodex).toHaveBeenCalledOnce();
    expect(ensureCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: { model: { primary: "openai/gpt-5.4" } },
            entries: expect.objectContaining({
              ops: expect.objectContaining({
                model: {
                  primary: "openai/gpt-5.6-sol",
                  fallbacks: ["google/gemini-3.1-pro-preview"],
                },
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
                  "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
                },
              }),
            }),
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
    expect(mocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentHarnessRuntimeOverride: "codex",
      }),
    );
    expect(refreshPluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "source-changed",
        policyPluginIds: ["codex"],
        traceCommand: "openclaw-setup-probe",
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "install-plugin",
      "retain-plugin-install",
      "refresh-plugin-registry",
      "live-test",
      "persist-plugin-config",
      "refresh-plugin-registry",
      "reload-active-registry",
    ]);
    expect(transformConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        afterWrite: { mode: "auto" },
      }),
    );
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: persistedConfig,
      reason: "source-changed",
      workspaceDir: "/tmp/openclaw-workspace",
      logger: expect.objectContaining({ warn: expect.any(Function) }),
    });
    expect(ensureRegistryLoaded).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "all",
        config: expect.objectContaining({
          agents: expect.objectContaining({ entries: persistedConfig.agents?.entries }),
          gateway: { port: 19_000 },
        }),
        activationSourceConfig: expect.objectContaining({
          agents: expect.objectContaining({ entries: persistedConfig.agents?.entries }),
          gateway: { port: 19_000 },
        }),
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
    // Harness selection: codex tests run embedded with the codex harness.
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentId: "openclaw",
      agentDir: resolveAgentDir(initialConfig, "ops"),
      provider: "openai",
      authProfileStateMode: "read-only",
      config: {
        agents: expect.objectContaining({
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
          entries: expect.objectContaining({
            ops: expect.objectContaining({
              model: {
                primary: "openai/gpt-5.6-sol",
                fallbacks: ["google/gemini-3.1-pro-preview"],
              },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
                "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
              },
            }),
          }),
        }),
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  command: "codex",
                  mode: "yolo",
                  transport: "stdio",
                  homeScope: "agent",
                },
              },
            },
          },
          installs: {
            codex: expect.objectContaining({ installPath: "/tmp/plugins/codex" }),
          },
        },
      },
    });
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentHarnessRuntimeOverride: "codex",
    });
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).not.toHaveProperty("streamParams");
    expect(persistedConfig).toMatchObject({
      gateway: { port: 19000 },
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1" },
        },
      },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: {
          ops: expect.objectContaining({
            model: {
              primary: "openai/gpt-5.6-sol",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            },
          }),
        },
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
                homeScope: "agent",
              },
            },
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
    expect(pendingCodexInstalls).toHaveLength(1);
  });

  it("probes and persists an exact non-default model through the Codex route", async () => {
    const initialConfig: OpenClawConfig = {};
    const configHarness = createConfigTransformHarness(initialConfig);
    const ensureCodex = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            codex: { ...cfg.plugins?.entries?.codex, enabled: true },
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
    const runEmbeddedAgent = vi.fn(async (params: SuccessfulRunParams) => {
      expect(refreshPluginRegistryAfterConfigMutation).toHaveBeenCalledOnce();
      expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledOnce();
      return successfulRun("openai", "gpt-5.4", params);
    });
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
          sourceConfig: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPlugin as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistryAfterConfigMutation as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
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
        traceCommand: "openclaw-setup-probe",
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
            entries: expect.objectContaining({
              main: expect.objectContaining({
                models: {
                  "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
                },
              }),
            }),
          }),
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              codex: expect.objectContaining({
                enabled: true,
                config: expect.objectContaining({
                  appServer: expect.objectContaining({
                    transport: "stdio",
                    homeScope: "agent",
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(configHarness.current()).toMatchObject({
      agents: expect.objectContaining({
        defaults: expect.objectContaining({ model: "openai/gpt-5.4" }),
        entries: expect.objectContaining({
          main: expect.objectContaining({
            models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          }),
        }),
      }),
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { transport: "stdio", homeScope: "agent" } },
          },
        },
      },
    });
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
          context: {
            snapshot: {
              config: OpenClawConfig;
              sourceConfig: OpenClawConfig;
              runtimeConfig: OpenClawConfig;
            };
          },
        ) => Promise<{ nextConfig: OpenClawConfig }> | { nextConfig: OpenClawConfig };
      }) => {
        const transformed = (
          await params.transform(persistedConfig, {
            snapshot: { config: runtimeConfig, sourceConfig, runtimeConfig },
          })
        ).nextConfig;
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
        markRetainedManagedNpmInstall: vi.fn(async () => true),
        runEmbeddedAgent: vi.fn(successfulRunner("openai", "gpt-5.6-sol")) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
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
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unavailable" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
  });

  it("fails closed before inference when the staged Codex package cannot be retained", async () => {
    const installRecord: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex-unretained",
    };
    const runEmbeddedAgent = vi.fn();
    const transformConfig = vi.fn();
    const markRetainedInstall = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const clearInstallRecords = vi.fn();
    const clearMetadata = vi.fn();
    const clearDiscovery = vi.fn(async () => {});
    const refreshPluginRegistry = vi.fn(async () => {});
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
          config: {},
          runtimeConfig: {},
        })) as never,
        ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
          cfg: {
            ...cfg,
            plugins: { ...cfg.plugins, installs: { codex: installRecord } },
          },
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        markRetainedManagedNpmInstall: markRetainedInstall,
        clearLoadInstalledPluginIndexInstallRecordsCache: clearInstallRecords,
        clearPluginMetadataLifecycleCaches: clearMetadata,
        invalidatePluginRuntimeDiscoveryAfterConfigMutation: clearDiscovery as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error: expect.stringContaining("retain the staged Codex runtime safely"),
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(markRetainedInstall).toHaveBeenCalledTimes(2);
    expect(clearInstallRecords).toHaveBeenCalledTimes(2);
    expect(clearMetadata).toHaveBeenCalledTimes(2);
    expect(clearDiscovery).toHaveBeenCalledTimes(2);
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: {},
      reason: "source-changed",
      workspaceDir: "/tmp/openclaw-workspace",
      logger: expect.objectContaining({ warn: expect.any(Function) }),
    });
  });

  it("reports an indeterminate activation when final Codex retention fails", async () => {
    const installRecord: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex-final-retention-failure",
    };
    const markRetainedInstall = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const refreshPluginRegistry = vi.fn(async () => {});
    let tempDir: string | undefined;
    const activation = activateSetupInference({
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
          config: {},
          runtimeConfig: {},
        })) as never,
        ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
          cfg: {
            ...cfg,
            plugins: { ...cfg.plugins, installs: { codex: installRecord } },
          },
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error("401 invalid_api_key");
        }) as never,
        transformConfigWithPendingPluginInstalls: vi.fn() as never,
        markRetainedManagedNpmInstall: markRetainedInstall,
        clearLoadInstalledPluginIndexInstallRecordsCache: vi.fn(),
        clearPluginMetadataLifecycleCaches: vi.fn(),
        invalidatePluginRuntimeDiscoveryAfterConfigMutation: vi.fn(async () => {}) as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: async () => {
          tempDir = await makeTempDir();
          return tempDir;
        },
      },
    });

    await expect(activation).rejects.toThrow(
      "stopped before its Codex runtime package could be retained safely",
    );
    expect(markRetainedInstall).toHaveBeenCalledTimes(2);
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(2);
    expect(tempDir).toBeDefined();
    await expect(fs.stat(tempDir!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the active registry from persisted config after a failed Codex probe", async () => {
    resetPluginRuntimeStateForTest();
    const installRecord: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex-staged-registry",
    };
    const persistedConfig = { plugins: { enabled: false } } satisfies OpenClawConfig;
    const stagedRegistry = createEmptyPluginRegistry();
    stagedRegistry.plugins.push({
      id: "codex",
      name: "Codex",
      status: "loaded",
      format: "bundle",
      imported: true,
    } as never);
    let snapshotRead = 0;
    const ensureRegistryLoaded = vi.fn(
      (options: Parameters<typeof ensurePluginRegistryLoaded>[0]) =>
        ensurePluginRegistryLoaded(options),
    );

    try {
      const result = await activateSetupInference({
        kind: "codex-cli",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => {
            const config = snapshotRead++ === 0 ? {} : persistedConfig;
            return {
              exists: true,
              valid: true,
              path: "/tmp/openclaw.json",
              issues: [],
              config,
              sourceConfig: config,
              runtimeConfig: config,
            };
          }) as never,
          ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
            cfg: {
              ...cfg,
              plugins: { ...cfg.plugins, installs: { codex: installRecord } },
            },
            required: true,
            installed: true,
            status: "installed" as const,
          })) as never,
          runEmbeddedAgent: vi.fn(async () => {
            setActivePluginRegistry(
              stagedRegistry,
              "staged-codex-registry",
              "default",
              "/tmp/setup-probe",
            );
            throw new Error("401 invalid_api_key");
          }) as never,
          transformConfigWithPendingPluginInstalls: vi.fn() as never,
          markRetainedManagedNpmInstall: vi.fn(async () => true),
          clearLoadInstalledPluginIndexInstallRecordsCache: vi.fn(),
          clearPluginMetadataLifecycleCaches: vi.fn(),
          invalidatePluginRuntimeDiscoveryAfterConfigMutation: vi.fn(async () => {}) as never,
          refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
          ensurePluginRegistryLoaded: ensureRegistryLoaded,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: false, status: "auth" });
      expect(ensureRegistryLoaded).toHaveBeenCalledWith({
        scope: "all",
        config: persistedConfig,
        activationSourceConfig: persistedConfig,
        workspaceDir: "/tmp/openclaw-workspace",
      });
      expect(getActivePluginRegistry()).not.toBe(stagedRegistry);
      expect(getActivePluginRegistry()?.plugins.some((plugin) => plugin.id === "codex")).toBe(
        false,
      );
      expect(getActivePluginRegistryKey()).not.toBe("staged-codex-registry");
      expect(getActivePluginRegistryWorkspaceDir()).toBe("/tmp/openclaw-workspace");
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("does not install codex when plugin policy blocks it", async () => {
    const ensureCodex = vi.fn();
    const runEmbeddedAgent = vi.fn();
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
  });

  it("marks an unowned Codex package generation retained when the live test fails", async () => {
    const installProjectDir = await makeTempDir();
    const packageDir = path.join(installProjectDir, "node_modules", "@openclaw", "codex");
    await fs.mkdir(packageDir, { recursive: true });
    const transformConfig = vi.fn();
    const refreshPluginRegistry = vi.fn();
    const runEmbeddedAgent = vi.fn(async () => {
      throw new Error("401 invalid_api_key");
    });
    try {
      const result = await activateSetupInference({
        kind: "codex-cli",
        surface: "gateway",
        runtime,
        deps: {
          ensureCodexRuntimePlugin: vi.fn(async (params: { cfg: OpenClawConfig }) => ({
            cfg: {
              ...params.cfg,
              plugins: {
                ...params.cfg.plugins,
                installs: {
                  ...params.cfg.plugins?.installs,
                  codex: {
                    source: "npm" as const,
                    spec: "@openclaw/codex",
                    installPath: packageDir,
                  },
                },
              },
            },
            required: true,
            installed: true,
            status: "installed" as const,
          })) as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: transformConfig as never,
          readPersistedInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
          refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: false, status: "auth" });
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            plugins: expect.objectContaining({
              installs: {
                codex: expect.objectContaining({ installPath: packageDir }),
              },
            }),
          }),
        }),
      );
      await expect(fs.stat(packageDir)).resolves.toBeDefined();
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
      expect(transformConfig).not.toHaveBeenCalled();
      expect(refreshPluginRegistry).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(installProjectDir, { recursive: true, force: true });
    }
  });

  it("clears transient Codex install caches before and after a failed probe", async () => {
    const installRecords = [
      {
        source: "npm" as const,
        spec: "@openclaw/codex@generation-1",
        installPath: "/tmp/plugins/codex-generation-1",
      },
      {
        source: "npm" as const,
        spec: "@openclaw/codex@generation-2",
        installPath: "/tmp/plugins/codex-generation-2",
      },
    ];
    const createdRecords: PluginInstallRecord[] = [];
    let installedRecordCache: PluginInstallRecord | undefined;
    let metadataCache: PluginInstallRecord | undefined;
    let discoveryCache: PluginInstallRecord | undefined;
    const ensureCodex = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => {
      const cachedRecord = installedRecordCache ?? metadataCache ?? discoveryCache;
      if (cachedRecord) {
        return {
          cfg,
          required: true,
          installed: true,
          status: "installed" as const,
        };
      }
      const record = installRecords[createdRecords.length];
      if (!record) {
        throw new Error("unexpected Codex install generation");
      }
      createdRecords.push(record);
      installedRecordCache = record;
      metadataCache = record;
      discoveryCache = record;
      return {
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            installs: { ...cfg.plugins?.installs, codex: record },
          },
        },
        required: true,
        installed: true,
        status: "installed" as const,
      };
    });
    const runEmbeddedAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("401 invalid_api_key"))
      .mockImplementationOnce(successfulRunner("openai", "gpt-5.6-sol"));
    const clearInstallRecords = vi.fn(() => {
      installedRecordCache = undefined;
    });
    const clearMetadata = vi.fn(() => {
      metadataCache = undefined;
    });
    const clearDiscovery = vi.fn(async () => {
      discoveryCache = undefined;
    });
    const markRetained = vi.fn(async () => true);
    const committedInstallRecords: PluginInstallRecord[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        const transformed = await params.transform(
          {},
          { snapshot: { config: {}, runtimeConfig: {} } },
        );
        const record = transformed.nextConfig.plugins?.installs?.codex;
        if (record) {
          committedInstallRecords.push(record);
        }
        return { nextConfig: withoutPluginInstallRecords(transformed.nextConfig) };
      },
    );
    const deps = {
      ensureCodexRuntimePlugin: ensureCodex as never,
      runEmbeddedAgent: runEmbeddedAgent as never,
      transformConfigWithPendingPluginInstalls: transformConfig as never,
      refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
      readPersistedInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
      markRetainedManagedNpmInstall: markRetained,
      clearLoadInstalledPluginIndexInstallRecordsCache: clearInstallRecords,
      clearPluginMetadataLifecycleCaches: clearMetadata,
      invalidatePluginRuntimeDiscoveryAfterConfigMutation: clearDiscovery as never,
      createTempDir: makeTempDir,
    };

    const first = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps,
    });
    const second = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps,
    });

    expect(first).toMatchObject({ ok: false, status: "auth" });
    expect(second).toMatchObject({ ok: true, modelRef: "openai/gpt-5.6-sol" });
    expect(createdRecords).toStrictEqual(installRecords);
    expect(markRetained).toHaveBeenNthCalledWith(1, {
      packageDir: expectDefined(installRecords[0], "installRecords[0] test invariant").installPath,
      pluginId: "codex",
      reason: "openclaw-inference-activation-not-committed",
    });
    expect(markRetained).toHaveBeenNthCalledWith(2, {
      packageDir: expectDefined(installRecords[0], "installRecords[0] test invariant").installPath,
      pluginId: "codex",
      reason: "openclaw-inference-activation-not-committed",
    });
    expect(markRetained).toHaveBeenNthCalledWith(3, {
      packageDir: expectDefined(installRecords[1], "installRecords[1] test invariant").installPath,
      pluginId: "codex",
      reason: "openclaw-inference-activation-not-committed",
    });
    expect(clearInstallRecords).toHaveBeenCalledTimes(3);
    expect(clearMetadata).toHaveBeenCalledTimes(3);
    expect(clearDiscovery).toHaveBeenCalledTimes(3);
    expect(transformConfig).toHaveBeenCalledOnce();
    expect(committedInstallRecords).toStrictEqual([installRecords[1]]);
  });

  it.each([
    { name: "missing", installRecords: {} as Record<string, PluginInstallRecord>, succeeds: false },
    {
      name: "mismatched",
      installRecords: {
        codex: {
          source: "npm" as const,
          spec: "@openclaw/codex@other",
          installPath: "/tmp/plugins/codex-other",
        },
      },
      succeeds: false,
    },
    {
      name: "exact",
      installRecords: undefined as Record<string, PluginInstallRecord> | undefined,
      succeeds: true,
    },
  ])("reconciles a post-write Codex error only with an $name install record", async (testCase) => {
    const installRecord: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    };
    const installRecords = testCase.installRecords ?? { codex: installRecord };
    let committedConfig: OpenClawConfig | undefined;
    const readConfigFileSnapshot = vi.fn(async () => {
      const sourceConfig = committedConfig ?? {};
      return {
        exists: true,
        valid: true,
        config: sourceConfig,
        sourceConfig,
        runtimeConfig: sourceConfig,
      };
    });
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        const transformed = await params.transform(
          {},
          { snapshot: { config: {}, runtimeConfig: {} } },
        );
        committedConfig = withoutPluginInstallRecords(transformed.nextConfig);
        throw new Error("simulated post-write failure");
      },
    );
    const readInstallRecords = vi.fn(async () => installRecords);
    const markRetainedInstall = vi.fn(async () => true);

    const activation = activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
          cfg: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              installs: { ...cfg.plugins?.installs, codex: installRecord },
            },
          },
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        runEmbeddedAgent: vi.fn(successfulRunner("openai", "gpt-5.6-sol")) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        readPersistedInstalledPluginIndexInstallRecords: readInstallRecords,
        markRetainedManagedNpmInstall: markRetainedInstall,
        refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
        createTempDir: makeTempDir,
      },
    });

    if (testCase.succeeds) {
      await expect(activation).resolves.toMatchObject({
        ok: true,
        modelRef: "openai/gpt-5.6-sol",
      });
    } else {
      await expect(activation).rejects.toThrow("simulated post-write failure");
    }
    expect(readInstallRecords).toHaveBeenCalledOnce();
    expect(markRetainedInstall).toHaveBeenCalledTimes(testCase.succeeds ? 1 : 2);
  });
});

describe("resolvePersistentApplyInference", () => {
  function createBinding(
    proofKind: "runtime-owner" | "credential" = "runtime-owner",
  ): SystemAgentVerifiedInferenceBinding {
    const execution = {
      runner: "embedded" as const,
      runConfig: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      modelLabel: "openai/gpt-5.5",
      provider: "openai",
      model: "gpt-5.5",
      agentDir: "/tmp/openclaw-agent",
      agentId: "main",
      agentHarnessRuntimeOverride: "codex",
    };
    return {
      configuredRoute: {
        runner: "embedded",
        modelLabel: execution.modelLabel,
        provider: execution.provider,
        model: execution.model,
        agentDir: execution.agentDir,
        agentId: execution.agentId,
        agentHarnessRuntimeOverride: execution.agentHarnessRuntimeOverride,
      },
      execution,
      executionFingerprint: {
        route: { provider: "openai", model: "gpt-5.5" },
        defaultSelection: { explicitIds: [] },
        auth: {},
        models: {},
        defaults: {},
        plugins: {},
        ownerPluginRuntimes: [],
      },
      ownerPluginIds: ["codex"],
      ownerPluginArtifacts: [{ pluginId: "codex", fingerprint: "codex-runtime-v1" }],
      auth:
        proofKind === "runtime-owner"
          ? {
              authFingerprint: "runtime-owner-fingerprint",
              proofKind,
              runtimeOwnerKind: "plugin-harness",
              runtimeOwnerId: "codex",
            }
          : { authFingerprint: "strict-credential-fingerprint" },
    };
  }

  function currentOwnerPluginArtifactDeps() {
    return { hasCurrentOwnerPluginArtifacts: vi.fn(async () => true) };
  }

  it("skips a live turn for a strict credential", async () => {
    const binding = createBinding("credential");
    const resolveVerifiedInferenceRoute = vi.fn(async () => binding.execution);
    const verifyBoundInference = vi.fn();

    const route = await resolvePersistentApplyInference({
      binding,
      runtime,
      deps: {
        ...currentOwnerPluginArtifactDeps(),
        resolveVerifiedInferenceRoute,
        verifyBoundInference,
      },
    });

    expect(route).toBe(binding.execution);
    expect(resolveVerifiedInferenceRoute).toHaveBeenCalledOnce();
    expect(verifyBoundInference).not.toHaveBeenCalled();
  });

  it("blocks a strict-credential write when its static owner binding is stale", async () => {
    const binding = createBinding("credential");
    const resolveVerifiedInferenceRoute = vi.fn(async () => null);
    const verifyBoundInference = vi.fn();

    const route = await resolvePersistentApplyInference({
      binding,
      runtime,
      deps: {
        ...currentOwnerPluginArtifactDeps(),
        resolveVerifiedInferenceRoute,
        verifyBoundInference,
      },
    });

    expect(route).toBeNull();
    expect(resolveVerifiedInferenceRoute).toHaveBeenCalledOnce();
    expect(verifyBoundInference).not.toHaveBeenCalled();
  });

  it("rejects an opaque runtime when its liveness turn fails auth", async () => {
    const binding = createBinding();
    const resolveVerifiedInferenceRoute = vi.fn(async () => binding.execution);
    const verifyBoundInference = vi.fn(async () => ({
      ok: false as const,
      status: "auth" as const,
      error: "logged out",
    }));

    await expect(
      resolvePersistentApplyInference({
        binding,
        runtime,
        deps: {
          ...currentOwnerPluginArtifactDeps(),
          resolveVerifiedInferenceRoute,
          verifyBoundInference,
        },
      }),
    ).resolves.toBeNull();
    expect(resolveVerifiedInferenceRoute).toHaveBeenCalledOnce();
  });

  it("rejects a liveness turn that used a different actual harness", async () => {
    const binding = createBinding();
    const changedBinding = structuredClone(binding);
    if (changedBinding.execution.runner !== "embedded") {
      throw new Error("expected embedded fixture");
    }
    changedBinding.execution.agentHarnessRuntimeOverride = "openclaw";
    const resolveVerifiedInferenceRoute = vi.fn(async () => binding.execution);

    await expect(
      resolvePersistentApplyInference({
        binding,
        runtime,
        deps: {
          ...currentOwnerPluginArtifactDeps(),
          resolveVerifiedInferenceRoute,
          verifyBoundInference: vi.fn(async () => ({
            ok: true as const,
            modelRef: changedBinding.execution.modelLabel,
            latencyMs: 1,
            binding: changedBinding,
          })),
        },
      }),
    ).resolves.toBeNull();
    expect(resolveVerifiedInferenceRoute).toHaveBeenCalledOnce();
  });

  it("rejects route drift after an opaque liveness turn", async () => {
    const binding = createBinding();
    const resolveVerifiedInferenceRoute = vi
      .fn()
      .mockResolvedValueOnce(binding.execution)
      .mockResolvedValueOnce(null);

    await expect(
      resolvePersistentApplyInference({
        binding,
        runtime,
        deps: {
          ...currentOwnerPluginArtifactDeps(),
          resolveVerifiedInferenceRoute,
          verifyBoundInference: vi.fn(async () => ({
            ok: true as const,
            modelRef: binding.execution.modelLabel,
            latencyMs: 1,
            binding,
          })),
        },
      }),
    ).resolves.toBeNull();
    expect(resolveVerifiedInferenceRoute).toHaveBeenCalledTimes(2);
  });
});

describe("activateSetupInference Codex configuration", () => {
  it.each([
    {
      name: "omitted",
      config: {} satisfies OpenClawConfig,
      expectedSupervision: undefined,
    },
    {
      name: "an empty object",
      config: {
        plugins: {
          entries: { codex: { config: { supervision: {} } } },
        },
      } satisfies OpenClawConfig,
      expectedSupervision: {},
    },
  ])("does not add Codex supervision when it is $name", async (testCase) => {
    const { result, persistedConfig, refreshPluginRegistry, transformConfig } =
      await runCodexSetupWithFinalConfig({
        currentConfig: testCase.config,
        sourceConfig: testCase.config,
      });

    expect(result.ok).toBe(true);
    expect(persistedConfig.plugins?.entries?.codex).toMatchObject({
      enabled: true,
      config: { appServer: { transport: "stdio", homeScope: "agent" } },
    });
    expect(persistedConfig.plugins?.entries?.codex?.config?.supervision).toEqual(
      testCase.expectedSupervision,
    );
    expect(transformConfig).toHaveBeenCalledOnce();
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(2);
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
        appServer: { transport: "stdio", homeScope: "agent" },
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
          appServer: { transport: "stdio", url: "ws://127.0.0.1:4500", homeScope: "agent" },
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
      currentRuntimeConfig: resolvedSource,
      sourceConfig: {},
    });

    expect(result.ok).toBe(true);
    expect(persistedConfig.plugins?.entries?.codex).toMatchObject({
      enabled: true,
      config: { appServer: { transport: "stdio", homeScope: "agent" } },
    });
  });

  it("fails closed when effective plugin policy changes before the success commit", async () => {
    const denied = { plugins: { deny: ["codex"] } } satisfies OpenClawConfig;
    const { result, refreshPluginRegistry, transformConfig } = await runCodexSetupWithFinalConfig({
      initialConfig: {},
      currentConfig: denied,
      sourceConfig: denied,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error: expect.stringContaining("blocked by denylist"),
    });
    // The Codex probe loads staged policy, then restores the persisted denied
    // policy after the pre-commit rejection.
    expect(refreshPluginRegistry).toHaveBeenCalledTimes(2);
    expect(transformConfig).not.toHaveBeenCalled();
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

  it.each([
    ["missing config", { exists: false, valid: true, config: {} }],
    ["missing default-agent model", { exists: true, valid: true, config: {} }],
  ])("rejects %s before starting a model", async (_label, snapshot) => {
    const runEmbeddedAgent = vi.fn();
    const createTempDir = vi.fn(makeTempDir);

    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => snapshot) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unavailable" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(createTempDir).not.toHaveBeenCalled();
  });

  it("reports invalid config without starting a live check", async () => {
    const runEmbeddedAgent = vi.fn();
    const createTempDir = vi.fn(makeTempDir);
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
        createTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "format",
      error: expect.stringContaining("agents.defaults.model: Expected a model reference"),
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(createTempDir).not.toHaveBeenCalled();
  });

  it("returns a passing live check without persisting setup", async () => {
    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
  });

  it("locks the exact winning profile into a bound OpenClaw session", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      auth: {
        profiles: {
          "openai:p1": { provider: "openai", mode: "api_key" },
          "openai:p2": { provider: "openai", mode: "api_key" },
        },
      },
    } satisfies OpenClawConfig;
    const profiles = {
      "openai:p1": { type: "api_key" as const, provider: "openai", key: "key-1" },
      "openai:p2": { type: "api_key" as const, provider: "openai", key: "key-2" },
    };
    const verifiedAuth = {
      apiKey: "key-2",
      profileId: "openai:p2",
      source: "profile:openai:p2",
      mode: "api-key" as const,
    };
    const verifiedAuthFingerprint = fingerprintResolvedProviderAuth(verifiedAuth);
    if (!verifiedAuthFingerprint) {
      throw new Error("missing test auth fingerprint");
    }
    const runEmbeddedAgent = vi.fn(
      async (params: {
        authProfileId?: string;
        authProfileIdSource?: string;
        onSuccessfulAuthBinding?: (binding: {
          authProfileId?: string;
          agentHarnessId?: string;
          authFingerprint?: string;
          modelId?: string;
          modelApi?: string;
        }) => void;
      }) => {
        params.onSuccessfulAuthBinding?.({
          authProfileId: "openai:p2",
          agentHarnessId: "openclaw",
          authFingerprint: verifiedAuthFingerprint,
          modelId: "gpt-5.5",
          modelApi: "openai-responses",
        });
        return successfulRun("openai", "gpt-5.5");
      },
    );

    const result = await verifySetupInference({
      runtime,
      bindSession: true,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({ exists: true, valid: true, config })) as never,
        loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles })) as never,
        ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles })) as never,
        resolveApiKeyForProvider: vi.fn(async () => verifiedAuth),
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      binding: {
        auth: { authProfileId: "openai:p2", authFingerprint: verifiedAuthFingerprint },
        execution: { authProfileId: "openai:p2", modelLabel: "openai/gpt-5.5" },
      },
    });
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
    expect(runEmbeddedAgent.mock.calls[0]?.[0].authProfileId).toBeUndefined();
    expect(runEmbeddedAgent.mock.calls[1]?.[0]).toMatchObject({
      authProfileId: "openai:p2",
      authProfileIdSource: "user",
    });
  });

  it("rejects an owner plugin replacement during the live inference turn", async () => {
    const profileId = "openai:verified";
    const credential = {
      type: "api_key" as const,
      provider: "openai",
      key: "verified-key",
    };
    const authFingerprint = fingerprintAuthProfileCredential({ profileId, credential });
    if (!authFingerprint) {
      throw new Error("missing test auth fingerprint");
    }
    const config = {
      agents: { defaults: { model: `openai/gpt-5.5@${profileId}` } },
      auth: { profiles: { [profileId]: { provider: "openai", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    const captureSystemAgentOwnerPluginArtifacts = vi.fn(() => ({
      ownerPluginIds: ["openai"],
      ownerPluginArtifacts: [{ pluginId: "openai", fingerprint: "openai-runtime-v1" }],
    }));
    const createChangedVerifiedInferenceBinding = vi.fn(async () => ({
      ownerPluginIds: ["openai"],
      ownerPluginArtifacts: [{ pluginId: "openai", fingerprint: "openai-runtime-v2" }],
    })) as never;
    const runEmbeddedAgent = vi.fn(async (params: SuccessfulRunParams) => {
      params.onSuccessfulAuthBinding?.({
        authProfileId: profileId,
        ...successfulAgentHarnessBinding(params),
        authFingerprint,
        modelId: "gpt-5.5",
        modelApi: "openai-responses",
      });
      return successfulRun("openai", "gpt-5.5");
    });

    const result = await verifySetupInference({
      runtime,
      bindSession: true,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({ exists: true, valid: true, config })) as never,
        loadAuthProfileStoreForRuntime: vi.fn(() => ({
          version: 1,
          profiles: { [profileId]: credential },
        })) as never,
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { [profileId]: credential },
        })) as never,
        resolveApiKeyForProvider: vi.fn(async () => ({
          apiKey: credential.key,
          profileId,
          source: `profile:${profileId}`,
          mode: "api-key" as const,
        })),
        captureSystemAgentOwnerPluginArtifacts,
        createSystemAgentVerifiedInferenceBinding: createChangedVerifiedInferenceBinding,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "auth",
      error: expect.stringContaining("owner changed"),
    });
    expect(captureSystemAgentOwnerPluginArtifacts).toHaveBeenCalledOnce();
    expect(createChangedVerifiedInferenceBinding).toHaveBeenCalledOnce();
  });

  it("binds a runtime-only Codex profile after activation and runs the first OpenClaw turn", async () => {
    const stateDir = await makeTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const profileId = "openai:default";
    const credential = {
      type: "oauth" as const,
      provider: "openai",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 3_600_000,
    };
    const authFingerprint = fingerprintAuthProfileCredential({ profileId, credential });
    if (!authFingerprint) {
      throw new Error("missing external Codex auth fingerprint");
    }
    // This is the authored route produced by a successful Codex activation:
    // model + harness persist, while the CLI-owned credential stays runtime-only.
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
      plugins: { entries: { codex: { enabled: true } } },
    } satisfies OpenClawConfig;
    const externalStore = vi.fn(
      (_agentDir?: string, options?: { externalCliProviderIds?: Iterable<string> }) => {
        const exposeCodexProfile = Array.from(options?.externalCliProviderIds ?? []).includes(
          "openai",
        );
        return {
          version: 1,
          profiles: exposeCodexProfile ? { [profileId]: credential } : {},
          runtimeExternalProfileIds: exposeCodexProfile ? [profileId] : [],
          runtimeExternalProfileIdsAuthoritative: true,
        };
      },
    );
    const runEmbeddedAgent = vi.fn(async (params: SuccessfulRunParams) => {
      params.onSuccessfulAuthBinding?.({
        authProfileId: profileId,
        ...successfulAgentHarnessBinding(params),
        authFingerprint,
        modelId: "gpt-5.6-sol",
        modelApi: "openai-responses",
      });
      return successfulRun("openai", "gpt-5.6-sol");
    });
    const readConfigFileSnapshot = vi.fn(async () => ({
      exists: true,
      valid: true,
      config,
      runtimeConfig: config,
      sourceConfig: config,
    }));
    const validateAgentHarnessRuntimeArtifact = vi.fn(async () => true);
    const createVerifiedInferenceBinding = vi.fn(
      (params: Parameters<typeof createSystemAgentVerifiedInferenceBinding>[0]) =>
        createSystemAgentVerifiedInferenceBinding({
          ...params,
          deps: { ...params.deps, validateAgentHarnessRuntimeArtifact },
        }),
    );

    try {
      const verification = await verifySetupInference({
        runtime,
        bindSession: true,
        deps: {
          readConfigFileSnapshot: readConfigFileSnapshot as never,
          loadAuthProfileStoreForRuntime: externalStore as never,
          ensureAuthProfileStore: externalStore as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          createSystemAgentVerifiedInferenceBinding: createVerifiedInferenceBinding,
          createTempDir: makeTempDir,
        },
      });
      expect(verification).toMatchObject({
        ok: true,
        modelRef: "openai/gpt-5.6-sol",
        binding: {
          auth: { authProfileId: profileId, authFingerprint },
          execution: {
            authProfileId: profileId,
            agentHarnessRuntimeOverride: "codex",
          },
        },
      });
      if (!verification.ok) {
        throw new Error(verification.error);
      }

      const session = createSystemAgentSession(verification.binding);
      try {
        const reply = await runSystemAgentTurnWithDeps(
          {
            input: "continue setup",
            overview: { defaultModel: "openai/gpt-5.6-sol" } as never,
            surface: "gateway",
            approvalArmed: false,
            session,
          },
          {
            readConfigFileSnapshot: readConfigFileSnapshot as never,
            ensureAuthProfileStore: externalStore as never,
            runEmbeddedAgent: runEmbeddedAgent as never,
            validateAgentHarnessRuntimeArtifact,
          },
        );
        expect(reply).toMatchObject({ text: "OK", modelLabel: "openai/gpt-5.6-sol" });
      } finally {
        await cleanupSystemAgentSession(session);
      }

      expect(runEmbeddedAgent).toHaveBeenCalledTimes(3);
      expect(runEmbeddedAgent.mock.calls[0]?.[0].authProfileId).toBeUndefined();
      expect(runEmbeddedAgent.mock.calls[1]?.[0]).toMatchObject({
        authProfileId: profileId,
        authProfileIdSource: "user",
      });
      expect(runEmbeddedAgent.mock.calls[2]?.[0]).toMatchObject({
        authProfileId: profileId,
        authProfileIdSource: "user",
        agentHarnessRuntimeOverride: "codex",
        agentId: "openclaw",
        toolsAllow: ["openclaw"],
      });
      const systemAgentTurnParams = runEmbeddedAgent.mock.calls[2]?.[0];
      expect(systemAgentTurnParams).toBeDefined();
      expect((systemAgentTurnParams as { config?: OpenClawConfig }).config).toBe(
        verification.binding.execution.runConfig,
      );
      expect(validateAgentHarnessRuntimeArtifact).toHaveBeenCalledWith({
        harnessId: "codex",
        artifact: testCodexRuntimeArtifact,
      });
      expect(externalStore).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          readOnly: true,
          allowKeychainPrompt: false,
          config,
          externalCliProviderIds: ["openai"],
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("does not repeat an unbound verification after automatic profile selection", async () => {
    const config = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: {
        profiles: {
          "openai:p1": { provider: "openai", mode: "api_key" },
          "openai:p2": { provider: "openai", mode: "api_key" },
        },
      },
    } satisfies OpenClawConfig;
    const profiles = {
      "openai:p1": { type: "api_key" as const, provider: "openai", key: "key-1" },
      "openai:p2": { type: "api_key" as const, provider: "openai", key: "key-2" },
    };
    const runEmbeddedAgent = vi.fn(
      async (params: {
        onSuccessfulAuthBinding?: (binding: { authProfileId?: string }) => void;
      }) => {
        params.onSuccessfulAuthBinding?.({ authProfileId: "openai:p2" });
        return successfulRun("openai", "gpt-5.5");
      },
    );

    const result = await verifySetupInferenceConfig({
      config,
      runtime,
      deps: {
        loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  });

  it("returns a refreshed staged profile without changing the configured agent store", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "configured-agent");
    const profileId = "openai:default";
    await upsertAuthProfileWithLock({
      profileId,
      credential: {
        type: "oauth",
        provider: "openai",
        access: "dummy",
        refresh: "dummy",
        expires: Date.now() + 3_600_000,
      },
      agentDir,
    });
    const runEmbeddedAgent = vi.fn(
      async (params: {
        agentDir?: string;
        onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
      }) => {
        expect(params.agentDir).toBeDefined();
        expect(params.agentDir).not.toBe(agentDir);
        expect(readAuthProfileStoreForTest(params.agentDir!).profiles[profileId]).toEqual({
          type: "oauth",
          provider: "openai",
          access: "fake",
          refresh: "fake",
          expires: expect.any(Number),
        });
        await updateAuthProfileStoreWithLock({
          agentDir: params.agentDir!,
          updater: ({ profiles }) => {
            profiles[profileId] = {
              type: "oauth",
              provider: "openai",
              access: "sample",
              refresh: "sample",
              expires: Date.now() + 7_200_000,
            };
            return true;
          },
        });
        return successfulRun("openai", "gpt-5.5", {
          authProfileId: profileId,
          onSuccessfulAuthBinding: params.onSuccessfulAuthBinding,
        });
      },
    );

    try {
      const result = await verifySetupInferenceConfig({
        config: {
          auth: {
            profiles: { [profileId]: { provider: "openai", mode: "oauth" } },
            order: { openai: [profileId] },
          },
          agents: {
            list: [
              {
                id: "main",
                default: true,
                agentDir,
                model: { primary: `openai/gpt-5.5@${profileId}` },
              },
            ],
          },
        },
        authProfiles: [
          {
            profileId,
            credential: {
              type: "oauth",
              provider: "openai",
              access: "fake",
              refresh: "fake",
              expires: Date.now() + 3_600_000,
            },
          },
        ],
        runtime,
        deps: {
          runEmbeddedAgent: runEmbeddedAgent as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        modelRef: "openai/gpt-5.5",
        authProfiles: [
          {
            profileId,
            credential: {
              type: "oauth",
              provider: "openai",
              access: "sample",
              refresh: "sample",
              expires: expect.any(Number),
            },
          },
        ],
      });
      expect(readAuthProfileStoreForTest(agentDir).profiles[profileId]).toEqual({
        type: "oauth",
        provider: "openai",
        access: "dummy",
        refresh: "dummy",
        expires: expect.any(Number),
      });
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("returns a refreshed staged profile when the live inference test fails", async () => {
    const profileId = "openai:default";
    const runEmbeddedAgent = vi.fn(async (params: { agentDir?: string }) => {
      expect(params.agentDir).toBeDefined();
      await updateAuthProfileStoreWithLock({
        agentDir: params.agentDir!,
        updater: ({ profiles }) => {
          profiles[profileId] = {
            type: "oauth",
            provider: "openai",
            access: "sample",
            refresh: "sample",
            expires: Date.now() + 7_200_000,
          };
          return true;
        },
      });
      throw new Error("request timed out");
    });

    const result = await verifySetupInferenceConfig({
      config: {
        auth: {
          profiles: { [profileId]: { provider: "openai", mode: "oauth" } },
          order: { openai: [profileId] },
        },
        agents: { defaults: { model: `openai/gpt-5.5@${profileId}` } },
      },
      authProfiles: [
        {
          profileId,
          credential: {
            type: "oauth",
            provider: "openai",
            access: "fake",
            refresh: "fake",
            expires: Date.now() + 3_600_000,
          },
        },
      ],
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "timeout",
      authProfiles: [
        {
          profileId,
          credential: {
            type: "oauth",
            provider: "openai",
            access: "sample",
            refresh: "sample",
            expires: expect.any(Number),
          },
        },
      ],
    });
  });

  it("rejects a staged credential that differs from the configured profile pin", async () => {
    const runEmbeddedAgent = vi.fn();
    const result = await verifySetupInferenceConfig({
      config: {
        auth: {
          profiles: { "openai:old": { provider: "openai", mode: "api_key" } },
          order: { openai: ["openai:old"] },
        },
        agents: { defaults: { model: "openai/gpt-5.5@openai:old" } },
      },
      authProfiles: [
        {
          profileId: "openai:new",
          credential: {
            type: "api_key",
            provider: "openai",
            key: "test-new-key",
          },
        },
      ],
      runtime,
      deps: {
        loadAuthProfileStoreForRuntime: vi.fn(() => ({
          version: 1,
          profiles: {
            "openai:old": {
              type: "api_key",
              provider: "openai",
              key: "test-old-key",
            },
          },
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "auth",
      error: "The staged credential does not match the configured auth profile.",
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("rejects a configured route that changes during its live check", async () => {
    const initialConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ exists: true, valid: true, config: initialConfig })
      .mockResolvedValueOnce({ exists: true, valid: true, config: changedConfig });

    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      error: expect.stringContaining("route changed during its live test"),
    });
    expect(readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it("probes the configured default agent's exact embedded runtime", async () => {
    const runEmbeddedAgent = vi.fn(async () => successfulRun("openai", "gpt-5.5"));

    const result = await verifySetupInferenceConfig({
      config: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          ],
        },
      },
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "openclaw",
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessRuntimeOverride: "codex",
        authProfileStateMode: "read-only",
        preparedModelRuntimeMode: "isolated-read-only",
      }),
    );
  });

  it("probes the configured default agent CLI auth owner", async () => {
    const agentDir = "/configured/ops-agent";
    const runCliAgent = vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8"));

    const result = await verifySetupInferenceConfig({
      config: {
        agents: {
          defaults: {},
          list: [
            {
              id: "ops",
              default: true,
              agentDir,
              model: { primary: "claude-cli/claude-opus-4-8@claude-cli:ops" },
            },
          ],
        },
      },
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        loadAuthProfileStoreForRuntime: vi.fn(() => ({
          version: 1,
          profiles: {
            "claude-cli:ops": {
              type: "oauth",
              provider: "claude-cli",
              access: "test-access",
              refresh: "test-refresh",
              expires: Date.now() + 3_600_000,
            },
          },
        })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelRef: "claude-cli/claude-opus-4-8",
    });
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-8",
        agentDir,
        authProfileId: "claude-cli:ops",
        executionMode: "side-question",
        disableTools: true,
      }),
    );
  });

  it.each([
    { name: "missing", profiles: {} },
    {
      name: "wrong-owner",
      profiles: {
        "openai:locked": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "test-key",
        },
      },
    },
  ])("rejects a $name embedded profile before inference", async ({ profiles }) => {
    const runEmbeddedAgent = vi.fn();
    const result = await verifySetupInferenceConfig({
      config: {
        agents: { defaults: { model: "openai/gpt-5.5@openai:locked" } },
      },
      runtime,
      deps: {
        loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", profiles: {} },
    {
      name: "wrong-owner",
      profiles: {
        "claude-cli:locked": {
          type: "api_key" as const,
          provider: "openai",
          key: "test-key",
        },
      },
    },
  ])("rejects a $name CLI profile before inference", async ({ profiles }) => {
    const runCliAgent = vi.fn();
    const result = await verifySetupInferenceConfig({
      config: {
        agents: {
          defaults: {
            model: "claude-cli/claude-opus-4-8@claude-cli:locked",
          },
        },
      },
      runtime,
      deps: {
        loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles })) as never,
        runCliAgent: runCliAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Gemini CLI OAuth",
      profileId: "google-gemini-cli:user@example.test",
      profileProvider: "google-gemini-cli",
      credential: {
        type: "oauth" as const,
        provider: "google-gemini-cli",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 3_600_000,
        email: "user@example.test",
      },
    },
    {
      name: "canonical Google API key fallback",
      profileId: "google:default",
      profileProvider: "google",
      credential: {
        type: "api_key" as const,
        provider: "google",
        key: "test-google-key",
      },
    },
  ])("resolves $name but rejects Gemini CLI as a setup verifier", async (testCase) => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const runCliAgent = vi.fn(async () =>
      successfulRun("google-gemini-cli", "gemini-3.1-pro-preview"),
    );
    const modelRef = "google/gemini-3.1-pro-preview";
    const config: OpenClawConfig = {
      auth: {
        order: { [testCase.profileProvider]: [testCase.profileId] },
      },
      agents: {
        defaults: {},
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: modelRef },
            models: {
              [modelRef]: { agentRuntime: { id: "google-gemini-cli" } },
            },
          },
        ],
      },
    };
    resolveAgentDir(config, "ops");
    await upsertAuthProfileWithLock({
      profileId: testCase.profileId,
      credential: testCase.credential,
      agentDir,
    });

    try {
      const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
      expect(route).toMatchObject({
        runner: "cli",
        provider: "google-gemini-cli",
        authProfileId: testCase.profileId,
      });

      const result = await verifySetupInferenceConfig({
        config,
        runtime,
        deps: {
          runCliAgent: runCliAgent as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        status: "unavailable",
        error: expect.stringContaining("no hard tool-free mode"),
      });
      expect(runCliAgent).not.toHaveBeenCalled();
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("redacts live-check failures without writing config or auth", async () => {
    const secret = "sk-verifysetupsecret123"; // pragma: allowlist secret
    const result = await verifySetupInference({
      runtime,
      timeoutMs: 50,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error(`401 invalid_api_key OPENAI_API_KEY=${secret}`);
        }) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    if (!result.ok) {
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain("OPENAI_API_KEY=");
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
