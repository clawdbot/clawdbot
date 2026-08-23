// Chat engine tests: proposals, approvals, and the chat-hosted channel wizard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import {
  fingerprintAuthProfileCredential,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { runSetupMemoryImportStep } from "../wizard/setup.memory-import.js";
import {
  SystemAgentChatEngine as RuntimeSystemAgentChatEngine,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.js";
import type { ChatWizardHostDependencies } from "./chat-wizard-host.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
  readSetupConfigFileSnapshot: vi.fn(),
  setupChannels: vi.fn(),
  setupSkills: vi.fn(),
  runSearchSetupFlow: vi.fn(),
  runSetupMemoryImportStep: vi.fn(),
  writeWizardConfigFile: vi.fn(),
  runCollectedChannelOnboardingPostWriteHooks: vi.fn(async () => {}),
  sharedVerifiedInference: undefined as SystemAgentVerifiedInferenceBinding | undefined,
}));

export type MemoryImportStepParams = Parameters<typeof runSetupMemoryImportStep>[0];

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));

vi.mock("../commands/onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-channels.js")>()),
  setupChannels: mocks.setupChannels,
  runCollectedChannelOnboardingPostWriteHooks: mocks.runCollectedChannelOnboardingPostWriteHooks,
}));

vi.mock("../commands/onboard-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-skills.js")>()),
  setupSkills: mocks.setupSkills,
}));

vi.mock("../flows/search-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/search-setup.js")>()),
  runSearchSetupFlow: mocks.runSearchSetupFlow,
}));

vi.mock("../wizard/setup.memory-import.js", () => ({
  runSetupMemoryImportStep: mocks.runSetupMemoryImportStep,
}));

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("./verified-inference.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./verified-inference.js")>();
  return {
    ...actual,
    resolveSystemAgentVerifiedInferenceRoute: (
      ...args: Parameters<typeof actual.resolveSystemAgentVerifiedInferenceRoute>
    ) => {
      // Most cases own chat state, not inference ownership. Explicit bindings
      // still run the real resolver so every drift and apply-boundary test stays end-to-end.
      if (args[0] === mocks.sharedVerifiedInference) {
        return Promise.resolve(args[0].execution);
      }
      return actual.resolveSystemAgentVerifiedInferenceRoute(...args);
    },
  };
});

const tempDirs: string[] = [];

export const sharedVerifiedInferenceConfig = {
  agents: {
    list: [
      {
        id: "main",
        default: true,
        agentDir: "/tmp/openclaw-openclaw-chat-engine-agent",
        model: "openai/gpt-5.5",
      },
    ],
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

export let sharedVerifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let sharedVerifiedInferenceDeps: SystemAgentVerifiedInferenceDeps | undefined;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

export function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-engine-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  pluginMetadataSnapshot?.rebindForCurrentEnv();
  return dir;
}

export function configSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    raw: null,
    parsed: config,
    config,
    runtimeConfig: config,
    sourceConfig: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function testHarnessBinding(route: SystemAgentConfiguredRoute) {
  if (route.runner !== "embedded") {
    return { auth: {}, deps: {} };
  }
  const agentHarnessId =
    route.agentHarnessRuntimeOverride === "auto"
      ? "openclaw"
      : (route.agentHarnessRuntimeOverride ?? "codex");
  if (agentHarnessId === "openclaw") {
    return { auth: { agentHarnessId }, deps: {} };
  }
  return {
    auth: {
      agentHarnessId,
      runtimeOwnerKind: "plugin-harness" as const,
      runtimeOwnerId: agentHarnessId,
      runtimeArtifactId: `${agentHarnessId}-test-artifact`,
      runtimeArtifactFingerprint: `${agentHarnessId}-test-fingerprint`,
    },
    deps: {
      validateAgentHarnessRuntimeArtifact: vi.fn(async () => true),
    },
  };
}

export async function createAmbientVerifiedBinding(config: OpenClawConfig) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route) {
    throw new Error("missing test route");
  }
  const authFingerprint = fingerprintResolvedProviderAuth({
    apiKey: "test-key",
    source: "models.json",
    mode: "api-key",
  });
  if (!authFingerprint) {
    throw new Error("missing test ambient auth fingerprint");
  }
  const harnessBinding = testHarnessBinding(route);
  return await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      authFingerprint,
      modelId: route.model,
      modelApi: route.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      ...harnessBinding.auth,
    },
    deps: harnessBinding.deps,
  });
}

export async function createOAuthVerifiedBinding(
  config: OpenClawConfig,
  credential: Parameters<typeof fingerprintAuthProfileCredential>[0]["credential"],
) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route) {
    throw new Error("missing test OAuth route");
  }
  const profileId = "anthropic:oauth";
  const authFingerprint = fingerprintAuthProfileCredential({ profileId, credential });
  if (!authFingerprint) {
    throw new Error("missing test OAuth fingerprint");
  }
  const harnessBinding = testHarnessBinding(route);
  return await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: { authProfileId: profileId, authFingerprint, ...harnessBinding.auth },
    deps: {
      ...harnessBinding.deps,
      ensureAuthProfileStore: vi.fn(() => ({
        version: 1,
        profiles: { [profileId]: credential },
      })) as never,
    },
  });
}

export async function createCliVerifiedBinding(config: OpenClawConfig) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route || route.runner !== "cli") {
    throw new Error("missing test CLI route");
  }
  const runtimeArtifactId = route.provider;
  const runtimeArtifactFingerprint = `${runtimeArtifactId}-test-artifact`;
  const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
    kind: "cli-runtime",
    runner: "cli",
    provider: route.provider,
    backendId: runtimeArtifactId,
    runtimeArtifactFingerprint,
  });
  if (!runtimeOwnerFingerprint) {
    throw new Error("missing test CLI runtime-owner fingerprint");
  }
  const deps: SystemAgentVerifiedInferenceDeps = {
    resolveCliRuntimeArtifactFingerprint: vi.fn(async () => runtimeArtifactFingerprint),
    resolveCliRuntimeOwnerFingerprint: vi.fn(async () => runtimeOwnerFingerprint),
  };
  const binding = await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      runtimeOwnerFingerprint,
      runtimeOwnerKind: "cli-runtime",
      runtimeOwnerId: runtimeArtifactId,
      runtimeArtifactId,
      runtimeArtifactFingerprint,
    },
    deps,
  });
  return { binding, deps };
}

type TestSystemAgentChatEngineOptions = Omit<SystemAgentChatEngineOptions, "verifiedInference"> &
  ChatWizardHostDependencies & {
    executeOperation?: typeof import("./operations.js").executeSystemAgentOperation;
    verifiedInference?: SystemAgentVerifiedInferenceBinding;
  };

/** Every ordinary engine test starts from a real, live-gate-shaped authority grant. */
export class SystemAgentChatEngine extends RuntimeSystemAgentChatEngine {
  constructor(opts: TestSystemAgentChatEngineOptions = {}) {
    const {
      runChannelSetupWizard,
      runSkillsSetupWizard,
      runSearchSetupWizard,
      runGatewaySetupWizard,
      runMemoryImportWizard,
      appendAuditEntry,
      executeOperation,
      ...engineOptions
    } = opts;
    const explicitBinding = engineOptions.verifiedInference;
    const verifiedInference = explicitBinding ?? sharedVerifiedInference;
    if (!verifiedInference) {
      throw new Error("shared verified inference fixture was not initialized");
    }
    if (!sharedVerifiedInferenceDeps) {
      throw new Error("shared verified inference dependencies were not initialized");
    }
    super(
      {
        ...engineOptions,
        verifiedInference,
        deps: {
          ...(explicitBinding
            ? { validateAgentHarnessRuntimeArtifact: async () => true }
            : sharedVerifiedInferenceDeps),
          readConfigFileSnapshot: async () =>
            configSnapshot(structuredClone(sharedVerifiedInferenceConfig)),
          ...engineOptions.deps,
        },
      },
      {
        wizardDependencies: {
          ...(runChannelSetupWizard ? { runChannelSetupWizard } : {}),
          ...(runSkillsSetupWizard ? { runSkillsSetupWizard } : {}),
          ...(runSearchSetupWizard ? { runSearchSetupWizard } : {}),
          ...(runGatewaySetupWizard ? { runGatewaySetupWizard } : {}),
          ...(runMemoryImportWizard ? { runMemoryImportWizard } : {}),
          ...(appendAuditEntry ? { appendAuditEntry } : {}),
        },
        ...(executeOperation ? { executeOperation } : {}),
      },
    );
  }
}

export async function advanceGatewayWizardToToken(engine: SystemAgentChatEngine) {
  const portStep = await engine.handle("configure gateway");
  expect((await engine.handle("19001")).text).toContain("Gateway bind address");
  expect((await engine.handle("2")).text).toContain("Gateway access protection");
  expect((await engine.handle("1")).text).toContain("Tailscale exposure");
  expect((await engine.handle("1")).text).toContain("provide the gateway token");
  const tokenStep = await engine.handle("1");
  return { portStep, tokenStep };
}

beforeAll(async () => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(
    sharedVerifiedInferenceConfig,
  );
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(
    sharedVerifiedInferenceConfig,
  );
  sharedVerifiedInference = fixture.binding;
  mocks.sharedVerifiedInference = fixture.binding;
  sharedVerifiedInferenceDeps = fixture.deps;
  mocks.readConfigFileSnapshot.mockResolvedValue(
    configSnapshot(structuredClone(sharedVerifiedInferenceConfig)) as never,
  );
});

afterAll(() => {
  pluginMetadataSnapshot?.restore();
});

afterEach(() => {
  vi.unstubAllEnvs();
  pluginMetadataSnapshot?.rebindForCurrentEnv();
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue(
    configSnapshot(structuredClone(sharedVerifiedInferenceConfig)) as never,
  );
  mocks.readSetupConfigFileSnapshot.mockReset();
  mocks.setupChannels.mockReset();
  mocks.setupSkills.mockReset();
  mocks.runSearchSetupFlow.mockReset();
  mocks.runSetupMemoryImportStep.mockReset();
  mocks.writeWizardConfigFile.mockReset();
  mocks.runCollectedChannelOnboardingPostWriteHooks.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export const CANCEL_HINT = "Say `cancel` to stop this setup.";
export const countCancelHints = (text: string) => text.split(CANCEL_HINT).length - 1;

export function fakeOverviewLoader(
  overrides: { defaultModel?: string; claudeFound?: boolean; codexFound?: boolean } = {},
) {
  return async () =>
    ({
      config: { path: "/tmp/openclaw.json", exists: false, valid: true, issues: [], hash: null },
      agents: [],
      defaultAgentId: "main",
      defaultModel: overrides.defaultModel,
      tools: {
        codex: { command: "codex", found: overrides.codexFound ?? false },
        claude: { command: "claude", found: overrides.claudeFound ?? false },
        gemini: { command: "gemini", found: false },
        apiKeys: { openai: false, anthropic: false },
      },
      gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
      references: {
        docsUrl: "https://docs.openclaw.ai",
        sourceUrl: "https://github.com/openclaw/openclaw",
      },
    }) as never;
}

export { expectDefined } from "@openclaw/normalization-core";
export { hashSystemAgentOperation } from "../agents/tools/system-agent-tool.js";
export type { OpenClawConfig } from "../config/types.openclaw.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { runSystemAgentTurnWithDeps } from "./agent-turn.test-support.js";
export { classifySystemAgentApprovalText } from "./operator-approval.js";
export { SystemAgentWizardAnswerError } from "./chat-engine.js";
export type { SystemAgentChatEngineOptions } from "./chat-engine.js";
export { SystemAgentInferenceUnavailableError } from "./inference-error.js";
export { verifyConfigAfterSystemAgentWrite } from "./post-write-verification.js";
export type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
export { RuntimeSystemAgentChatEngine };
export { mocks };
