// Exercises CLI run preparation: auth boundaries, prompt hooks, context
// injection, MCP loopback setup, and reusable session decisions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGroupChatContext, buildGroupIntro } from "../../auto-reply/reply/groups.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerLegacyContextEngine } from "../../context-engine/legacy.registration.js";
import { registerContextEngineForOwner } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  clearMemoryPluginState,
  registerTestMemoryPromptBuilder,
} from "../../plugins/memory-state.test-fixtures.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { resolveApiKeyForProfile as resolveApiKeyForProfileImpl } from "../auth-profiles/oauth.js";
import { saveAuthProfileStore } from "../auth-profiles/store.js";
import {
  resetCliAuthEpochTestDeps,
  setCliAuthEpochTestDeps,
} from "../cli-auth-epoch.test-support.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
  createWeatherSkillFixture,
  wrappedPluginSystemContext,
  type TestCliBackendParams,
} from "../cli-runner.test-helpers.js";
import { hashCliSessionText } from "../cli-session.js";
import { resetContextWindowCacheForTest } from "../context.js";
import { buildActiveImageGenerationTaskPromptContextForSession } from "../image-generation-task-status.js";
import { buildActiveMusicGenerationTaskPromptContextForSession } from "../music-generation-task-status.js";
import type { SandboxWorkspaceInfo } from "../sandbox/types.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import { buildActiveVideoGenerationTaskPromptContextForSession } from "../video-generation-task-status.js";
import { prepareCliRunContext } from "./prepare.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";
import type { RunCliAgentParams } from "./types.js";

function registerTestContextEngine(
  id: string,
  factory: Parameters<typeof registerContextEngineForOwner>[1],
) {
  return registerContextEngineForOwner(id, factory, `test:${id}`, {
    allowSameOwnerRefresh: true,
  });
}

const getRuntimeConfigMock = vi.hoisted(() => vi.fn(() => ({})));
const ensureSandboxWorkspaceForSessionMock = vi.hoisted(() =>
  vi.fn<() => Promise<SandboxWorkspaceInfo | null>>(async () => null),
);
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../sandbox.js", () => ({
  ensureSandboxWorkspaceForSession: ensureSandboxWorkspaceForSessionMock,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../tts/tts-settings.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

vi.mock("../video-generation-task-status.js", () => ({
  VIDEO_GENERATION_TASK_KIND: "video_generation",
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => ""),
  findActiveVideoGenerationTaskForSession: vi.fn(() => undefined),
}));

vi.mock("../image-generation-task-status.js", () => ({
  IMAGE_GENERATION_TASK_KIND: "image_generation",
  buildActiveImageGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildImageGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildImageGenerationTaskStatusText: vi.fn(() => ""),
  findActiveImageGenerationTaskForSession: vi.fn(() => undefined),
}));

vi.mock("../music-generation-task-status.js", () => ({
  MUSIC_GENERATION_TASK_KIND: "music_generation",
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(() => undefined),
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => ""),
  findActiveMusicGenerationTaskForSession: vi.fn(() => undefined),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const mockBuildActiveVideoGenerationTaskPromptContextForSession = vi.mocked(
  buildActiveVideoGenerationTaskPromptContextForSession,
);
const mockBuildActiveImageGenerationTaskPromptContextForSession = vi.mocked(
  buildActiveImageGenerationTaskPromptContextForSession,
);
const mockBuildActiveMusicGenerationTaskPromptContextForSession = vi.mocked(
  buildActiveMusicGenerationTaskPromptContextForSession,
);

let defaultTestCliBackend = buildDefaultTestCliBackend();

function createCliBackendConfig(params: TestCliBackendParams = {}): OpenClawConfig {
  defaultTestCliBackend = buildDefaultTestCliBackend(params);
  return {};
}

function setCliBackendForPrepareTest(
  params: {
    authEpochMode?: CliBackendPlugin["authEpochMode"];
    autoSelectAuthProfile?: boolean;
    bundleMcp?: boolean;
    command?: string;
    id?: string;
    liveSession?: boolean;
    modelAliases?: Record<string, string>;
    modelProvider?: string;
    pluginId?: string;
    prepareExecution?: CliBackendPlugin["prepareExecution"];
    sessionMode?: "always" | "existing" | "none";
    reseedFromRawTranscriptWhenUncompacted?: boolean;
  } = {},
) {
  const id = params.id ?? "claude-cli";
  // Keep preparation behind the same runtime resolver seam that production
  // uses; direct backend constants would bypass provider ownership.
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [
      {
        id,
        pluginId: params.pluginId ?? "anthropic",
        modelProvider: params.modelProvider ?? "anthropic",
        bundleMcp: params.bundleMcp ?? false,
        ...(params.authEpochMode ? { authEpochMode: params.authEpochMode } : {}),
        ...(params.bundleMcp ? { bundleMcpMode: "claude-config-file" as const } : {}),
        ...(params.autoSelectAuthProfile !== undefined
          ? { autoSelectAuthProfile: params.autoSelectAuthProfile }
          : {}),
        ...(params.authEpochMode ? { authEpochMode: params.authEpochMode } : {}),
        ...(params.prepareExecution ? { prepareExecution: params.prepareExecution } : {}),
        config: {
          command: params.command ?? "claude",
          args: ["--print"],
          resumeArgs: ["--resume", "{sessionId}"],
          output: "jsonl",
          input: "stdin",
          sessionMode: params.sessionMode ?? "existing",
          ...(params.modelAliases ? { modelAliases: params.modelAliases } : {}),
          ...(params.liveSession ? { liveSession: "claude-stdio" as const } : {}),
          ...(params.reseedFromRawTranscriptWhenUncompacted
            ? { reseedFromRawTranscriptWhenUncompacted: true }
            : {}),
        },
      },
    ],
  });
}

function setRawCliBackendForPrepareTest(backend: CliBackendPlugin & { pluginId: string }) {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
}

type CliContextBudgetTestCase = {
  name: string;
  provider: string;
  agentContextTokens?: number;
  expectedContextTokens: number;
  model: string;
  modelAliases?: Record<string, string>;
};

describe("prepareCliRunContext", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;

  it.each<CliContextBudgetTestCase>([
    {
      name: "Claude CLI with a selected-agent cap",
      provider: "claude-cli",
      agentContextTokens: 80_000,
      expectedContextTokens: 80_000,
      model: "claude-opus-4-7",
    },
    {
      name: "a Claude CLI user alias",
      provider: "claude-cli",
      agentContextTokens: undefined,
      expectedContextTokens: 100_000,
      model: "large",
      modelAliases: { large: "claude-opus-4-7" },
    },
    {
      name: "a Claude CLI-native alias",
      provider: "claude-cli",
      agentContextTokens: undefined,
      expectedContextTokens: 100_000,
      model: "claude-opus-4-7",
      modelAliases: { "claude-opus-4-7": "deployment-large" },
    },
    {
      name: "a generic CLI backend alias",
      provider: "fixture-cli",
      agentContextTokens: undefined,
      expectedContextTokens: 100_000,
      model: "claude-opus-4-7",
    },
  ])("resolves canonical model budgets for $name", async (testCase) => {
    const prepareExecution = vi.fn(async () => undefined);
    const baseConfig = createCliBackendConfig();
    setCliBackendForPrepareTest({
      id: testCase.provider,
      command: testCase.provider === "claude-cli" ? "claude" : testCase.provider,
      modelProvider: "fixture-anthropic",
      pluginId: "fixture-plugin",
      prepareExecution,
      modelAliases: testCase.modelAliases,
    });
    const context = await fixture.prepare({
      provider: testCase.provider,
      model: testCase.model,
      config: {
        ...baseConfig,
        agents: {
          ...baseConfig.agents,
          ...(testCase.agentContextTokens
            ? { list: [{ id: "main", contextTokens: testCase.agentContextTokens }] }
            : {}),
        },
        models: {
          providers: {
            "fixture-anthropic": {
              baseUrl: "https://api.anthropic.com",
              contextTokens: 200_000,
              models: [
                {
                  id: "claude-opus-4-7",
                  name: "Claude Opus 4.7",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                  contextTokens: 100_000,
                },
              ],
            },
            "collision-provider": {
              baseUrl: "https://collision.invalid",
              models: [
                {
                  id: "large",
                  name: "Unrelated Large",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 4_096,
                  contextTokens: 32_000,
                },
              ],
            },
            "claude-cli": {
              baseUrl: "https://runtime.invalid",
              models: [
                {
                  id: "large",
                  name: "Configured Alias Source",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                  contextTokens: 200_000,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(context.backendResolved.modelProvider).toBe("fixture-anthropic");
    expect(context.contextWindowInfo?.tokens).toBe(testCase.expectedContextTokens);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ contextTokenBudget: testCase.expectedContextTokens }),
    );
  });

  beforeEach(() => {
    // Install narrow test doubles for external runtime seams so preparation
    // remains about data flow, not bundled plugin or loopback startup cost.
    defaultTestCliBackend = buildDefaultTestCliBackend();
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [defaultTestCliBackend],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => false),
      makeBootstrapWarn: vi.fn(() => () => undefined),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      revokeMcpLoopbackClientGrant: vi.fn(() => true),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: null, sourcePath: null })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: [],
        cleanup: vi.fn(async () => undefined),
      })),
      getClaudeLiveSessionGenerationForOwner: vi.fn(() => undefined),
      resolveApiKeyForProfile: resolveApiKeyForProfileImpl,
    });
    mockGetGlobalHookRunner.mockReturnValue(null);
    getRuntimeConfigMock.mockReturnValue({});
    mockBuildActiveImageGenerationTaskPromptContextForSession.mockReturnValue(undefined);
    mockBuildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(undefined);
    mockBuildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(undefined);
    ensureSandboxWorkspaceForSessionMock.mockReset();
    ensureSandboxWorkspaceForSessionMock.mockResolvedValue(null);
    fixture = createCliRunnerPrepareFixture(prepareCliRunContext);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    resetCliAuthEpochTestDeps();
    getRuntimeConfigMock.mockReset();
    mockGetGlobalHookRunner.mockReset();
    mockBuildActiveImageGenerationTaskPromptContextForSession.mockReset();
    mockBuildActiveVideoGenerationTaskPromptContextForSession.mockReset();
    mockBuildActiveMusicGenerationTaskPromptContextForSession.mockReset();
    ensureSandboxWorkspaceForSessionMock.mockReset();
    resetContextWindowCacheForTest();
    clearMemoryPluginState();
    setActivePluginRegistry(createTestRegistry());
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  it("honors an explicit auth agent directory independently of session identity", async () => {
    const { dir } = fixture.session;
    const modelOwnerAgentDir = path.join(dir, "ops-agent");
    const systemAgentDir = path.join(dir, "openclaw-agent");
    const prepareExecution = vi.fn(async () => undefined);
    fs.mkdirSync(modelOwnerAgentDir, { recursive: true });
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test-plugin",
      bundleMcp: false,
      prepareExecution,
      config: {
        command: "test-cli",
        args: ["--print"],
        output: "text",
        input: "arg",
        sessionMode: "existing",
      },
    });

    const context = await fixture.prepare({
      sessionKey: "agent:openclaw:main",
      agentId: "openclaw",
      agentDir: modelOwnerAgentDir,
      authProfileId: "test-cli:ops",
      config: {
        agents: {
          list: [
            { id: "ops", default: true, agentDir: modelOwnerAgentDir },
            { id: "openclaw", agentDir: systemAgentDir },
          ],
        },
      },
    });

    expect(context.effectiveAuthProfileId).toBe("test-cli:ops");
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: modelOwnerAgentDir,
        authProfileId: "test-cli:ops",
      }),
    );
  });

  it("passes raw refreshed OAuth profile fields to profile-owned CLI preparation", async () => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "google-gemini-cli:user@example.test";
    const prepareExecution = vi.fn(async () => ({
      env: { GEMINI_CLI_HOME: path.join(agentDir, "gemini-home") },
    }));
    const resolveApiKeyForProfile = vi.fn(async () => ({
      apiKey: JSON.stringify({ token: "provider-formatted-access", projectId: "project-1" }),
      profileId: authProfileId,
      profileType: "oauth" as const,
      provider: "google-gemini-cli",
      email: "user@example.test",
    }));
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "raw-access-token",
            refresh: "raw-refresh-token",
            expires: 1_800_000_000_000,
            projectId: "project-1",
            email: "user@example.test",
          },
        },
      },
      agentDir,
    );
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: false,
      authEpochMode: "profile-only",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveApiKeyForProfile,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:main",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      authProfileId,
      onSuccessfulAuthBinding: () => {},
      config: {},
    });

    expect(resolveApiKeyForProfile).toHaveBeenCalledOnce();
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId,
        authCredential: expect.objectContaining({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "raw-access-token",
          refresh: "raw-refresh-token",
          expires: 1_800_000_000_000,
        }),
      }),
    );
    expect(context.authBindingFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(context.authBindingSkipsLocalCredential).toBe(true);
  });

  it("stages the resolved OAuth fallback profile for Gemini CLI preparation", async () => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const legacyProfileId = "google-gemini-cli:default";
    const resolvedProfileId = "google-gemini-cli:user@example.test";
    const prepareExecution = vi.fn(async () => ({
      env: { GEMINI_CLI_HOME: path.join(agentDir, "gemini-home") },
    }));
    const resolveApiKeyForProfile = vi.fn(async () => ({
      apiKey: JSON.stringify({ token: "provider-formatted-access", projectId: "project-1" }),
      profileId: resolvedProfileId,
      profileType: "oauth" as const,
      provider: "google-gemini-cli",
      email: "user@example.test",
    }));
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [legacyProfileId]: {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "stale-access-token",
            refresh: "stale-refresh-token",
            expires: 1_700_000_000_000,
            email: "legacy@example.test",
          },
          [resolvedProfileId]: {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "resolved-access-token",
            refresh: "resolved-refresh-token",
            expires: 1_800_000_000_000,
            projectId: "project-1",
            email: "user@example.test",
          },
        },
      },
      agentDir,
    );
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: false,
      authEpochMode: "profile-only",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveApiKeyForProfile,
    });

    await fixture.prepare({
      sessionKey: "agent:main:main",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      authProfileId: legacyProfileId,
      config: {},
    });

    expect(resolveApiKeyForProfile).toHaveBeenCalledOnce();
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: resolvedProfileId,
        authCredential: expect.objectContaining({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "resolved-access-token",
          refresh: "resolved-refresh-token",
          expires: 1_800_000_000_000,
        }),
      }),
    );
  });

  it("selects the configured Gemini CLI OAuth profile when no explicit profile is passed", async () => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "google-gemini-cli:user@example.test";
    const prepareExecution = vi.fn(async () => ({
      env: { GEMINI_CLI_HOME: path.join(agentDir, "gemini-home") },
    }));
    const resolveApiKeyForProfile = vi.fn(async () => ({
      apiKey: JSON.stringify({ token: "provider-formatted-access", projectId: "project-1" }),
      profileId: authProfileId,
      profileType: "oauth" as const,
      provider: "google-gemini-cli",
      email: "user@example.test",
    }));
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "raw-access-token",
            refresh: "raw-refresh-token",
            expires: 1_800_000_000_000,
            projectId: "project-1",
            email: "user@example.test",
          },
        },
      },
      agentDir,
    );
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: false,
      authEpochMode: "profile-only",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveApiKeyForProfile,
    });

    await fixture.prepare({
      sessionKey: "agent:main:main",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      config: {
        auth: {
          profiles: {
            [authProfileId]: {
              provider: "google-gemini-cli",
              mode: "oauth",
              email: "user@example.test",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: authProfileId,
        agentDir,
      }),
    );
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId,
        authCredential: expect.objectContaining({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "raw-access-token",
          refresh: "raw-refresh-token",
          expires: 1_800_000_000_000,
        }),
      }),
    );
  });

  it("stages adopted OAuth credentials for Gemini CLI preparation", async () => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "google-gemini-cli:user@example.test";
    const prepareExecution = vi.fn(async () => ({
      env: { GEMINI_CLI_HOME: path.join(agentDir, "gemini-home") },
    }));
    const resolveApiKeyForProfile = vi.fn(async () => ({
      apiKey: JSON.stringify({ token: "provider-formatted-access", projectId: "project-1" }),
      profileId: authProfileId,
      profileType: "oauth" as const,
      provider: "google-gemini-cli",
      email: "user@example.test",
      credential: {
        type: "oauth" as const,
        provider: "google-gemini-cli",
        access: "adopted-access-token",
        refresh: "adopted-refresh-token",
        expires: 1_900_000_000_000,
        projectId: "project-1",
        email: "user@example.test",
      },
    }));
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "oauth",
            provider: "google-gemini-cli",
            access: "stale-access-token",
            refresh: "stale-refresh-token",
            expires: 1_700_000_000_000,
            projectId: "project-1",
            email: "user@example.test",
          },
        },
      },
      agentDir,
    );
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: false,
      authEpochMode: "profile-only",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveApiKeyForProfile,
    });

    await fixture.prepare({
      sessionKey: "agent:main:main",
      provider: "google-gemini-cli",
      model: "gemini-3.1-pro-preview",
      authProfileId,
      config: {},
    });

    expect(resolveApiKeyForProfile).toHaveBeenCalledOnce();
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId,
        authCredential: expect.objectContaining({
          type: "oauth",
          provider: "google-gemini-cli",
          access: "adopted-access-token",
          refresh: "adopted-refresh-token",
          expires: 1_900_000_000_000,
        }),
      }),
    );
  });

  it("does not expose auth profile credentials to non-bundled prepare hooks", async () => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "test-cli:secret";
    const prepareExecution = vi.fn(async (_ctx: unknown) => undefined);
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "api_key",
            provider: "test-cli",
            key: "secret-key",
          },
        },
      },
      agentDir,
    );
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test-plugin",
      bundleMcp: false,
      prepareExecution,
      config: {
        command: "test-cli",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });

    await fixture.prepare({
      sessionKey: "agent:main:main",
      authProfileId,
      config: {},
    });

    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId,
      }),
    );
    expect(prepareExecution.mock.calls[0]?.[0]).not.toHaveProperty("authCredential");
  });

  it("refreshes and forwards a selected Claude CLI OAuth profile", async () => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "anthropic:claude-cli";
    const prepareExecution = vi.fn(async () => undefined);
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "oauth",
            provider: "claude-cli",
            access: "stored-access-token",
            refresh: "stored-refresh-token",
            expires: Date.now() + 60 * 60_000,
          },
        },
      },
      agentDir,
    );
    setCliBackendForPrepareTest({ prepareExecution, authEpochMode: "profile-only" });
    setCliRunnerPrepareTestDeps({
      resolveApiKeyForProfile: vi.fn(async () => ({
        apiKey: "stored-access-token",
        provider: "claude-cli",
        profileId: authProfileId,
        profileType: "oauth",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "stored-access-token",
          refresh: "stored-refresh-token",
          expires: Date.now() + 60 * 60_000,
        },
      })),
    });

    await fixture.prepare({
      sessionKey: "agent:main:main",
      agentDir,
      provider: "claude-cli",
      model: "sonnet",
      authProfileId,
      config: {},
    });

    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId,
        authCredential: expect.objectContaining({
          type: "oauth",
          provider: "claude-cli",
          access: "stored-access-token",
        }),
      }),
    );
  });

  it.each([
    {
      name: "keeps implicit profile selection for auth bridges",
      autoSelectAuthProfile: undefined,
      expectedAuthProfileId: "claude-cli:stored",
    },
    {
      name: "lets environment-only hooks opt out of profile selection",
      autoSelectAuthProfile: false,
      expectedAuthProfileId: undefined,
    },
  ])("$name", async (testCase) => {
    const { dir } = fixture.session;
    const agentDir = path.join(dir, "agents", "main", "agent");
    const authProfileId = "claude-cli:stored";
    const prepareExecution = vi.fn(async () => ({ env: { TEST_PREPARED_ENV: "1" } }));
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [authProfileId]: {
            type: "api_key",
            provider: "claude-cli",
            key: "stored-key",
          },
        },
      },
      agentDir,
    );

    setCliBackendForPrepareTest({
      prepareExecution,
      autoSelectAuthProfile: testCase.autoSelectAuthProfile,
    });
    const context = await fixture.prepare({
      sessionKey: "agent:main:main",
      agentDir,
      provider: "claude-cli",
      model: "sonnet",
      config: {
        auth: {
          profiles: {
            [authProfileId]: { provider: "claude-cli", mode: "api_key" },
          },
        },
      },
    });

    expect(context.effectiveAuthProfileId).toBe(testCase.expectedAuthProfileId);
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: testCase.expectedAuthProfileId }),
    );
  });

  it("keeps bundled Claude secret input on the private prepared runner context", async () => {
    const secretInput = {
      fd: 3,
      fingerprint: "credential-a",
      createData: () => Buffer.from("secret"),
    };
    const prepareExecution = vi.fn(async () => ({
      env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      secretInput,
    }));

    setCliBackendForPrepareTest({
      prepareExecution: prepareExecution as CliBackendPlugin["prepareExecution"],
    });
    const context = await fixture.prepare({
      provider: "claude-cli",
      model: "sonnet",
      config: {},
    });

    expect(context.preparedBackend.secretInput).toBe(secretInput);
    expect(context.preparedBackend.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    });
  });

  it("lets Gemini CLI preparation override generated MCP system settings auth", async () => {
    const { dir } = fixture.session;
    const profileSystemSettingsPath = path.join(dir, "profile-system-settings.json");
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const prepareExecution = vi.fn(async (_ctx: unknown) => ({
      env: {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: profileSystemSettingsPath,
      },
    }));
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
    });

    let cleanup: (() => Promise<void>) | undefined;
    try {
      const context = await fixture.prepare({
        sessionKey: "agent:main:main",
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
        config: {},
      });
      cleanup = context.preparedBackend.cleanup;

      const prepareExecutionArg = prepareExecution.mock.calls[0]?.[0] as
        | { env?: Record<string, string> }
        | undefined;
      const generatedSystemSettingsPath = prepareExecutionArg?.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      expect(typeof generatedSystemSettingsPath).toBe("string");
      expect(generatedSystemSettingsPath).not.toBe(profileSystemSettingsPath);
      const generatedSettings = JSON.parse(
        fs.readFileSync(generatedSystemSettingsPath ?? "", "utf8"),
      ) as {
        mcp?: { allowed?: string[] };
        mcpServers?: Record<string, { url?: string }>;
      };
      expect(generatedSettings.mcp?.allowed).toEqual(["openclaw"]);
      expect(generatedSettings.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:31783/mcp");
      expect(context.preparedBackend.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
        profileSystemSettingsPath,
      );
    } finally {
      await cleanup?.();
    }
  });

  it("preserves backend staging for queued execution without running it during prepare", async () => {
    const beforeExecution = vi.fn(async () => {});
    const prepareExecution = vi.fn(async () => ({ beforeExecution }));
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test-plugin",
      bundleMcp: false,
      prepareExecution,
      config: {
        command: "test-cli",
        args: ["--print"],
        sessionMode: "existing",
        output: "text",
        input: "arg",
      },
    });

    const context = await fixture.prepare({});

    expect(prepareExecution).toHaveBeenCalledOnce();
    expect(beforeExecution).not.toHaveBeenCalled();
    await context.preparedBackend.beforeExecution?.();
    expect(beforeExecution).toHaveBeenCalledOnce();
  });

  it("cleans generated Gemini MCP settings when auth preparation fails", async () => {
    let generatedSystemSettingsPath: string | undefined;
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const prepareExecution = vi.fn(async (ctx: unknown) => {
      generatedSystemSettingsPath = (ctx as { env?: Record<string, string> }).env
        ?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      throw new Error("Gemini auth profile was selected but no credential material was found");
    });
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    setRawCliBackendForPrepareTest({
      id: "google-gemini-cli",
      pluginId: "google",
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      prepareExecution,
      config: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
        output: "json",
        input: "arg",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      revokeMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
    });

    await expect(
      fixture.prepare({
        sessionKey: "agent:main:main",
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
        config: {},
      }),
    ).rejects.toThrow(/no credential material/);

    expect(generatedSystemSettingsPath).toBeTruthy();
    expect(fs.existsSync(generatedSystemSettingsPath ?? "")).toBe(false);
    expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith("loopback-token");
  });

  it("cleans prepared execution resources when auth epoch resolution fails", async () => {
    const preparedExecutionCleanup = vi.fn(async () => undefined);
    const prepareExecution = vi.fn(async () => ({ cleanup: preparedExecutionCleanup }));
    setCliAuthEpochTestDeps({
      loadAuthProfileStoreForRuntime: () => {
        throw new Error("auth epoch read failed");
      },
    });
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test",
      bundleMcp: false,
      authEpochMode: "profile-only",
      prepareExecution,
      config: {
        command: "test-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
        output: "text",
        input: "arg",
        sessionMode: "existing",
      },
    });

    await expect(
      fixture.prepare({
        sessionKey: "agent:main:main",
        authProfileId: "test-cli:profile",
        config: {},
      }),
    ).rejects.toThrow("auth epoch read failed");

    expect(prepareExecution).toHaveBeenCalledOnce();
    expect(preparedExecutionCleanup).toHaveBeenCalledOnce();
  });

  it("cleans prepared MCP and skills plugin dirs when mid-prepare reference lookup fails", async () => {
    const { dir } = fixture.session;
    const tempEnvSnapshot = captureEnv(["TMPDIR", "TMP", "TEMP"]);
    const tempRoot = path.join(dir, "tmp");
    const skillsPluginDir = path.join(dir, "claude-skills-plugin");
    const skillsCleanup = vi.fn(async () => {
      fs.rmSync(skillsPluginDir, { recursive: true, force: true });
    });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(skillsPluginDir, { recursive: true });
    setTestEnvValue("TMPDIR", tempRoot);
    setTestEnvValue("TMP", tempRoot);
    setTestEnvValue("TEMP", tempRoot);
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
        args: ["--plugin-dir", skillsPluginDir],
        cleanup: skillsCleanup,
      })),
      resolveOpenClawReferencePaths: vi.fn(async () => {
        throw new Error("reference path lookup failed");
      }),
    });

    try {
      await expect(
        fixture.prepare({
          sessionKey: "agent:main:main",
          config: createCliBackendConfig({ bundleMcp: true }),
        }),
      ).rejects.toThrow("reference path lookup failed");

      expect(skillsCleanup).toHaveBeenCalledOnce();
      expect(fs.existsSync(skillsPluginDir)).toBe(false);
      expect(
        fs.readdirSync(tempRoot).filter((entry) => entry.startsWith("openclaw-cli-mcp-")),
      ).toEqual([]);
    } finally {
      tempEnvSnapshot.restore();
    }
  });

  it("prepares side questions without agent-turn context, tools, hooks, or reusable sessions", async () => {
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "prior user text", timestamp: 1 },
    });
    const resolveBootstrapContextForRun = vi.fn(async () => ({
      bootstrapFiles: [
        { name: "AGENTS.md" as const, path: "AGENTS.md", content: "bootstrap", missing: false },
      ],
      contextFiles: [{ path: "context.md", content: "context" }],
    }));
    const ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
    const prepareClaudeCliSkillsPlugin = vi.fn(async () => ({
      args: ["--plugin-dir", "/tmp/claude-skills"],
      cleanup: vi.fn(async () => undefined),
    }));
    const prepareExecution = vi.fn(async () => undefined);
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "always-on",
      sideQuestionToolMode: "disabled",
      prepareExecution,
      config: {
        command: "test-cli",
        args: ["--print"],
        liveSession: "claude-stdio",
        sessionMode: "always",
        output: "jsonl",
        input: "stdin",
      },
    });
    setCliRunnerPrepareTestDeps({
      resolveBootstrapContextForRun,
      ensureMcpLoopbackServer,
      prepareClaudeCliSkillsPlugin,
      makeBootstrapWarn: vi.fn(() => () => undefined),
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({
        agentId: "main",
        tools: [
          {
            name: "exec",
            label: "exec",
            description: "test exec tool",
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
          },
        ],
      })),
      resolveOpenClawReferencePaths: vi.fn(async () => ({ docsPath: "docs", sourcePath: "src" })),
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:main",
      config: createCliBackendConfig({ bundleMcp: true }),
      prompt: "side question prompt",
      executionMode: "side-question",
      timeoutMs: 120_000,
      extraSystemPrompt: "BTW system prompt",
      disableTools: true,
      cliSessionId: "existing-cli-session",
    });

    expect(resolveBootstrapContextForRun).not.toHaveBeenCalled();
    expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();
    expect(prepareClaudeCliSkillsPlugin).not.toHaveBeenCalled();
    expect(mockGetGlobalHookRunner).not.toHaveBeenCalled();
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "side-question" }),
    );
    expect(context.systemPrompt).toBe("BTW system prompt");
    expect(context.params.prompt).toBe("side question prompt");
    expect(context.openClawHistoryPrompt).toBeUndefined();
    expect(context.contextEngine).toBeUndefined();
    expect(context.contextEngineTurnPrompt).toBeUndefined();
    expect(context.hadSessionFile).toBe(false);
    expect(context.claudeSkillsPluginArgs).toEqual([]);
    expect(context.preparedBackend.backend.sessionMode).toBe("none");
    expect(context.preparedBackend.backend.liveSession).toBeUndefined();
    expect(context.bootstrapPromptWarningLines).toEqual([]);
    expect(context.systemPromptReport.injectedWorkspaceFiles).toEqual([]);
    expect(context.systemPromptReport.tools.entries).toEqual([]);
  });

  it.each([
    {
      name: "full guidance for a backend with native file tools",
      nativeToolMode: "always-on" as const,
      transportsSystemPrompt: true,
      expectedText: "BOOTSTRAP.md below; follow before normal reply.",
    },
    {
      name: "limited guidance for a backend without native file tools",
      nativeToolMode: undefined,
      transportsSystemPrompt: true,
      expectedText: "this run cannot safely finish full BOOTSTRAP.md",
    },
    {
      name: "no guidance for a backend without system-prompt transport",
      nativeToolMode: "always-on" as const,
      transportsSystemPrompt: false,
      expectedText: undefined,
    },
  ])("renders $name", async ({ nativeToolMode, transportsSystemPrompt, expectedText }) => {
    const { dir } = fixture.session;
    const bootstrapPath = path.join(dir, "BOOTSTRAP.md");
    const config = {
      agents: { defaults: { workspace: dir } },
    } satisfies OpenClawConfig;
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test",
      bundleMcp: false,
      nativeToolMode,
      config: {
        command: "test-cli",
        args: ["--print"],
        ...(transportsSystemPrompt ? { systemPromptArg: "--system-prompt" } : {}),
        systemPromptWhen: "first",
        sessionMode: "existing",
        output: "text",
        input: "arg",
      },
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: vi.fn(async () => true),
      resolveBootstrapContextForRun: vi.fn(async () => ({
        bootstrapFiles: [
          {
            name: "BOOTSTRAP.md" as const,
            path: bootstrapPath,
            content: "Complete the first-run ritual, then delete this file.",
            missing: false,
          },
        ],
        contextFiles: [
          {
            path: bootstrapPath,
            content: "Complete the first-run ritual, then delete this file.",
          },
        ],
      })),
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:main",
      config,
      prompt: "Hello",
      runId: `run-bootstrap-${nativeToolMode ?? "limited"}`,
      trigger: "user",
      extraSystemPrompt: "stable prompt",
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: hashCliSessionText("stable prompt"),
        cwdHash: hashCliSessionText(dir),
      },
    });

    if (expectedText) {
      expect(context.systemPrompt).toContain("## Bootstrap Pending");
      expect(context.systemPrompt).toContain(expectedText);
      if (nativeToolMode === "always-on") {
        expect(context.systemPrompt).toContain("## " + bootstrapPath);
        expect(context.systemPrompt).toContain("Complete the first-run ritual");
        expect(context.systemPromptReport.injectedWorkspaceFiles).toEqual([
          expect.objectContaining({
            name: "BOOTSTRAP.md",
            injectedChars: expect.any(Number),
            truncated: false,
          }),
        ]);
      } else {
        expect(context.systemPrompt).not.toContain("## " + bootstrapPath);
        expect(context.systemPrompt).not.toContain("Complete the first-run ritual");
        expect(context.systemPromptReport.injectedWorkspaceFiles).toEqual([]);
      }
      expect(context.reusableCliSession).toEqual({
        mode: "reuse-with-drift",
        sessionId: "cli-session",
        drift: { reasons: ["system-prompt"] },
      });
    } else {
      expect(context.systemPrompt).not.toContain("## Bootstrap Pending");
      expect(context.reusableCliSession).toEqual({
        mode: "reuse",
        sessionId: "cli-session",
      });
    }
  });

  it("applies prompt-build hook context to Claude-style CLI preparation", async () => {
    const { dir } = fixture.session;
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "earlier context", timestamp: 1 },
    });
    fixture.appendTranscript({
      id: "msg-2",
      parentId: "msg-1",
      timestamp: new Date(2).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
        api: "responses",
        provider: "test-cli",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    });
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async ({ messages }: { messages: unknown[] }) => ({
        prependContext: `history:${messages.length}`,
        systemPrompt: "hook system",
        prependSystemContext: "prepend system",
        appendSystemContext: "append system",
      })),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    // The hook receives historical messages, while the final prompt receives
    // only the hook-approved prepend context plus the latest user prompt.
    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      runId: "run-test",
      messageChannel: "telegram",
      messageProvider: "acp",
      config: {
        ...createCliBackendConfig(),
      },
    });

    expect(context.params.prompt).toBe("history:2\n\nlatest ask");
    expect(context.contextEngineTurnPrompt).toBe("latest ask");
    expect(context.systemPrompt).toBe(
      `${wrappedPluginSystemContext("prepend system")}\n\nhook system\n\n${wrappedPluginSystemContext("append system")}${SYSTEM_PROMPT_CACHE_BOUNDARY}\nCurrent model identity: test-cli/test-model. Model question: answer this current-run value.`,
    );
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledTimes(1);
    const beforePromptBuildCalls = hookRunner.runBeforePromptBuild.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    expect(beforePromptBuildCalls[0]?.[0]).toEqual({
      prompt: "latest ask",
      messages: [
        { role: "user", content: "earlier context", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "earlier reply" }],
          api: "responses",
          provider: "test-cli",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    });
    const hookContext = beforePromptBuildCalls[0]?.[1] as
      | {
          runId?: string;
          agentId?: string;
          sessionKey?: string;
          sessionId?: string;
          workspaceDir?: string;
          modelProviderId?: string;
          modelId?: string;
          messageProvider?: string;
          trigger?: string;
          channelId?: string;
        }
      | undefined;
    expect(hookContext?.runId).toBe("run-test");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionKey).toBe("agent:main:test");
    expect(hookContext?.sessionId).toBe("session-test");
    expect(hookContext?.workspaceDir).toBe(dir);
    expect(hookContext?.modelProviderId).toBe("test-cli");
    expect(hookContext?.modelId).toBe("test-model");
    expect(hookContext?.messageProvider).toBe("acp");
    expect(hookContext?.trigger).toBe("user");
    expect(hookContext?.channelId).toBe("telegram");
  });

  it("prepends current-turn context after prompt-build hooks without changing hook or transcript prompt", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "trusted hook context",
        appendContext: "trusted hook tail",
      })),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    // Current inbound metadata is untrusted channel context. It should shape
    // the CLI prompt without contaminating transcript or hook inputs.
    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      transcriptPrompt: "latest ask",
      currentInboundContext: {
        text: "Sender (untrusted metadata):\nsender_id=U123",
        promptJoiner: " ",
      },
      runId: "run-test-context",
    });

    expect(context.params.prompt).toBe(
      "Sender (untrusted metadata):\nsender_id=U123 trusted hook context\n\nlatest ask\n\ntrusted hook tail",
    );
    expect(context.params.transcriptPrompt).toBe("latest ask");
    expect(context.contextEngineTurnPrompt).toBe("latest ask");
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledTimes(1);
    const beforePromptBuildCalls = hookRunner.runBeforePromptBuild.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    const promptBuildParams = beforePromptBuildCalls[0]?.[0] as { prompt?: string } | undefined;
    expect(promptBuildParams?.prompt).toBe("latest ask");
  });

  it("uses compact current-turn context when a room event resumes a CLI session", async () => {
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: {
        role: "user",
        content: "prior room event",
        timestamp: 1,
      },
    });
    // Room resumes carry compact event text into the CLI prompt but keep the
    // richer room context in OpenClaw history for reseed and audits.
    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      prompt: "[OpenClaw room event]",
      currentInboundEventKind: "room_event",
      currentInboundContext: {
        text: "Room context:\nAlice: lunch?\n\nCurrent event:\nBob: yes",
        resumableText: "Current event:\nBob: yes",
      },
      cliSessionBinding: {
        sessionId: "cli-session",
      },
      config: createCliBackendConfig({
        reseedFromRawTranscriptWhenUncompacted: true,
      }),
    });

    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
    expect(context.params.prompt).toBe("Current event:\nBob: yes\n\n[OpenClaw room event]");
    expect(context.openClawHistoryPrompt).toContain("Room context:\nAlice: lunch?");
    expect(context.openClawHistoryPrompt).toContain("Current event:\nBob: yes");
  });

  it("marks inter-session prompts after CLI prompt-build hook context is applied", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "trusted hook context",
      })),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      prompt: "foreign reply text",
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:main:slack:dm:U123",
        sourceChannel: "slack",
        sourceTool: "sessions_send",
      },
      runId: "run-test",
    });

    expect(context.params.prompt).toMatch(/^\[Inter-session message/);
    expect(context.params.prompt).toContain("sourceSession=agent:main:slack:dm:U123");
    expect(context.params.prompt).toContain("isUser=false");
    expect(context.params.prompt).toContain("trusted hook context");
    expect(context.params.prompt).toContain("foreign reply text");
  });

  it("applies agent_turn_prepare-only context on the CLI path", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "agent_turn_prepare"),
      runAgentTurnPrepare: vi.fn(async () => ({
        prependContext: "turn prepend",
        appendContext: "turn append",
      })),
      runBeforePromptBuild: vi.fn(),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      agentId: "main",
      trigger: "user",
      runId: "run-test-turn-prepare",
      messageChannel: "telegram",
      currentChannelId: "chat-1",
      senderId: "user-456",
    });

    expect(context.params.prompt).toBe("turn prepend\n\nlatest ask\n\nturn append");
    expect(hookRunner.runAgentTurnPrepare).toHaveBeenCalledTimes(1);
    const agentTurnPrepareCalls = hookRunner.runAgentTurnPrepare.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    expect(agentTurnPrepareCalls[0]?.[0]).toEqual({
      prompt: "latest ask",
      messages: [],
      queuedInjections: [],
    });
    const turnPrepareContext = agentTurnPrepareCalls[0]?.[1] as
      | {
          channel?: string;
          chatId?: string;
          runId?: string;
          senderId?: string;
          sessionKey?: string;
        }
      | undefined;
    expect(turnPrepareContext?.runId).toBe("run-test-turn-prepare");
    expect(turnPrepareContext?.sessionKey).toBe("agent:main:test");
    expect(turnPrepareContext?.channel).toBe("telegram");
    expect(turnPrepareContext?.chatId).toBe("chat-1");
    expect(turnPrepareContext?.senderId).toBe("user-456");
    expect(hookRunner.runBeforePromptBuild).not.toHaveBeenCalled();
  });

  it("applies before_prompt_build hook context for CLI preparation", async () => {
    const hookRunner = {
      hasHooks: vi.fn((_hookName: string) => true),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "prompt prepend",
        systemPrompt: "prompt system",
        prependSystemContext: "prompt prepend system",
        appendSystemContext: "prompt append system",
      })),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({
      messageChannel: "discord",
      currentChannelId: "channel:room-1",
      senderId: "user-789",
    });

    expect(context.params.prompt).toBe("prompt prepend\n\nlatest ask");
    expect(context.systemPrompt).toBe(
      `${wrappedPluginSystemContext("prompt prepend system")}\n\nprompt system\n\n${wrappedPluginSystemContext("prompt append system")}${SYSTEM_PROMPT_CACHE_BOUNDARY}\nCurrent model identity: test-cli/test-model. Model question: answer this current-run value.`,
    );
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledOnce();
    const beforePromptBuildCalls = hookRunner.runBeforePromptBuild.mock.calls as unknown as Array<
      [unknown, unknown]
    >;
    const promptContext = beforePromptBuildCalls[0]?.[1] as
      | { channel?: string; chatId?: string; senderId?: string }
      | undefined;
    expect(promptContext?.channel).toBe("discord");
    expect(promptContext?.chatId).toBe("room-1");
    expect(promptContext?.senderId).toBe("user-789");
  });

  it("preserves the base prompt when prompt-build hooks fail", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => {
        throw new Error("hook exploded");
      }),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({});

    expect(context.params.prompt).toBe("latest ask");
    expect(context.systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
    expect(context.systemPrompt).toContain("Current model identity: test-cli/test-model.");
    expect(context.systemPrompt).not.toContain("hook exploded");
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledOnce();
  });

  it("does not allocate a non-legacy context engine before fallible CLI preparation finishes", async () => {
    const engineId = `cli-prepare-late-engine-${Date.now().toString(36)}`;
    const dispose = vi.fn(async () => {});
    const factory = vi.fn((): ContextEngine => {
      return {
        info: { id: engineId, name: "CLI prepare late engine" },
        ingest: vi.fn(async () => ({ ingested: true })),
        assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
        compact: vi.fn(async () => ({ ok: true, compacted: false })),
        dispose,
      };
    });
    registerTestContextEngine(engineId, factory);
    setCliRunnerPrepareTestDeps({
      resolveOpenClawReferencePaths: vi.fn(async () => {
        throw new Error("reference path lookup failed");
      }),
    });

    await expect(
      fixture.prepare({
        config: {
          ...createCliBackendConfig(),
          plugins: { slots: { contextEngine: engineId } },
        },
      }),
    ).rejects.toThrow("reference path lookup failed");

    expect(factory).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("cleans up prepared CLI backend when context-engine resolution fails", async () => {
    const cleanup = vi.fn(async () => {});
    const prepareExecution = vi.fn(async () => ({ cleanup }));
    registerContextEngineForOwner(
      "legacy",
      () => {
        throw new Error("context engine failed");
      },
      "core",
      { allowSameOwnerRefresh: true },
    );
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test-plugin",
      bundleMcp: false,
      prepareExecution,
      config: {
        command: "test-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
        sessionMode: "existing",
        output: "text",
        input: "arg",
      },
    });

    try {
      await expect(fixture.prepare({})).rejects.toThrow("context engine failed");

      expect(prepareExecution).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      registerLegacyContextEngine();
    }
  });

  it("rejects CLI runs for context engines that require pre-prompt assembly", async () => {
    const engineId = `cli-unsupported-engine-${Date.now().toString(36)}`;
    registerTestContextEngine(engineId, (): ContextEngine => {
      return {
        info: {
          id: engineId,
          name: "CLI unsupported engine",
          hostRequirements: {
            "agent-run": {
              requiredCapabilities: ["assemble-before-prompt"],
              unsupportedMessage: "Use the native Codex or OpenClaw embedded runtime.",
            },
          },
        },
        ingest: vi.fn(async () => ({ ingested: true })),
        assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
        compact: vi.fn(async () => ({ ok: true, compacted: false })),
      };
    });

    await expect(
      fixture.prepare({
        config: {
          ...createCliBackendConfig(),
          plugins: { slots: { contextEngine: engineId } },
        },
      }),
    ).rejects.toThrow(
      `Context engine "${engineId}" cannot run operation "agent-run" on CLI backend "test-cli".`,
    );
  });

  it("uses runtime config when resolving the CLI context engine", async () => {
    const { dir } = fixture.session;
    const engineId = `cli-runtime-config-engine-${Date.now().toString(36)}`;
    const runtimeAgentDir = path.join(dir, "runtime-agent");
    const runtimeConfig = {
      agents: {
        list: [{ id: "main", default: true, agentDir: runtimeAgentDir }],
      },
      plugins: { slots: { contextEngine: engineId } },
    } satisfies OpenClawConfig;
    const factory = vi.fn((_ctx: unknown): ContextEngine => {
      return {
        info: { id: engineId, name: "CLI runtime config engine" },
        ingest: vi.fn(async () => ({ ingested: true })),
        assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
        compact: vi.fn(async () => ({ ok: true, compacted: false })),
      };
    });
    registerTestContextEngine(engineId, factory);
    getRuntimeConfigMock.mockReturnValue(runtimeConfig);
    setRawCliBackendForPrepareTest({
      id: "test-cli",
      pluginId: "test-plugin",
      bundleMcp: false,
      config: {
        command: "test-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
        sessionMode: "existing",
        output: "text",
        input: "arg",
      },
    });

    const context = await fixture.prepare({
      config: undefined,
    });

    expect(context.contextEngine?.info.id).toBe(engineId);
    expect(context.contextEngineConfig).toBe(runtimeConfig);
    expect(context.params.config).toBe(runtimeConfig);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: runtimeAgentDir,
        config: runtimeConfig,
        workspaceDir: dir,
      }),
    );
  });

  it("uses explicit static prompt text for CLI session reuse hashing", async () => {
    const { dir } = fixture.session;
    const context = await fixture.prepare({
      extraSystemPrompt: "## Inbound Context\nchannel=telegram",
      extraSystemPromptStatic: "",
      cliSessionBinding: {
        sessionId: "cli-session",
        cwdHash: hashCliSessionText(dir),
      },
    });

    expect(context.systemPrompt).toContain("## Inbound Context\nchannel=telegram");
    expect(context.extraSystemPromptHash).toBeUndefined();
    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
  });

  it("invalidates CLI session reuse when explicit message-target policy changes", async () => {
    const context = await fixture.prepare({
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
      cliSessionBinding: {
        sessionId: "cli-session",
        messageToolPolicyHash: hashCliSessionText(
          JSON.stringify({
            sourceReplyDeliveryMode: "message_tool_only",
            requireExplicitMessageTarget: false,
          }),
        ),
      },
    });

    expect(context.messageToolPolicyHash).toBeDefined();
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "message-policy",
    });
  });

  it("requires explicit message targets by default for CLI subagents", async () => {
    const context = await fixture.prepare({
      sessionKey: "agent:main:subagent:child",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(context.params.requireExplicitMessageTarget).toBe(true);
    expect(context.messageToolPolicyHash).toBe(
      hashCliSessionText(
        JSON.stringify({
          sourceReplyDeliveryMode: "message_tool_only",
          requireExplicitMessageTarget: true,
        }),
      ),
    );
  });

  it("uses cwd for CLI system prompt workspace guidance", async () => {
    const { dir } = fixture.session;
    const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-task-"));
    try {
      const context = await fixture.prepare({
        cwd: taskDir,
      });

      expect(context.cwd).toBe(taskDir);
      expect(context.systemPrompt).toContain(`Working directory: ${taskDir}`);
      expect(context.systemPrompt).not.toContain(`Working directory: ${dir}`);
    } finally {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  });

  it("passes Telegram channel context into CLI system prompts without core rich guidance", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            agentPrompt: {
              messageToolCapabilities: () => ["inlineButtons"],
            },
          } satisfies ChannelPlugin,
        },
      ]),
    );

    const context = await fixture.prepare({
      messageChannel: "telegram",
    });

    expect(context.systemPrompt).toContain("channel=telegram");
    expect(context.systemPrompt).not.toContain("Telegram rich ON");
    expect(context.systemPrompt).not.toContain("Telegram rich OFF");
  });

  it("ignores volatile prompt text when static prompt text matches", async () => {
    const { dir } = fixture.session;
    const staticPrompt = "## Direct Context\nYou are in a Telegram direct conversation.";
    const context = await fixture.prepare({
      extraSystemPrompt: `## Inbound Context\nchannel=heartbeat\n\n${staticPrompt}`,
      extraSystemPromptStatic: staticPrompt,
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: hashCliSessionText(staticPrompt),
        cwdHash: hashCliSessionText(dir),
      },
    });

    expect(context.extraSystemPromptHash).toBe(hashCliSessionText(staticPrompt));
    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
  });

  it("soft-resumes content drift and surfaces a per-turn drift note", async () => {
    const { dir } = fixture.session;
    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      currentInboundContext: {
        text: "Conversation info (untrusted metadata):\nchannel=telegram",
      },
      extraSystemPrompt: "new stable prompt",
      extraSystemPromptStatic: "new stable prompt",
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: hashCliSessionText("old stable prompt"),
        cwdHash: hashCliSessionText(dir),
      },
    });

    expect(context.reusableCliSession).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session",
      drift: { reasons: ["system-prompt"] },
    });
    expect(context.openClawHistoryPrompt).toBeUndefined();
    expect(context.params.prompt).toContain(
      "OpenClaw resumed this CLI session after prompt content changed.",
    );
    expect(context.params.prompt).toContain("changed=system-prompt");
    expect(context.params.prompt).toContain("latest ask");
  });

  it("invalidates content drift when the backend cannot receive a resumed system prompt", async () => {
    const { dir } = fixture.session;
    const context = await fixture.prepare({
      extraSystemPrompt: "new stable prompt",
      extraSystemPromptStatic: "new stable prompt",
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: hashCliSessionText("old stable prompt"),
        cwdHash: hashCliSessionText(dir),
      },
      config: createCliBackendConfig({ systemPromptWhen: "never" }),
    });

    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "system-prompt",
    });
    expect(context.params.prompt).not.toContain(
      "OpenClaw resumed this CLI session after prompt content changed.",
    );
  });

  it.each([
    {
      name: "automatic config",
      stableMode: "automatic",
      staticPrompt: "group:telegram:group:automatic",
      expectedStrongPrompt: false,
    },
    {
      name: "message-tool config",
      stableMode: "message_tool_only",
      staticPrompt: "group:telegram:group:message_tool_only",
      expectedStrongPrompt: true,
    },
  ] as const)(
    "reuses CLI session bindings across new inbound messages with stable binding facts for $name",
    async ({ stableMode, staticPrompt, expectedStrongPrompt }) => {
      const { dir } = fixture.session;
      try {
        const getActiveMcpLoopbackRuntime = vi.fn(() => ({
          port: 31783,
          ownerToken: "loopback-owner-token",
          nonOwnerToken: "loopback-non-owner-token",
        }));
        const resolveMcpLoopbackScopedTools = vi.fn(() => ({
          agentId: "main",
          tools: [
            {
              name: "message",
              label: "Message",
              description: "Send a message",
              parameters: { type: "object", properties: {} },
              execute: vi.fn(),
            },
          ],
        }));
        setCliRunnerPrepareTestDeps({
          getActiveMcpLoopbackRuntime,
          resolveMcpLoopbackScopedTools,
        });
        const cliSessionBindingFacts = {
          extraSystemPromptStatic: staticPrompt,
          sourceReplyDeliveryMode: stableMode,
        };
        const first = await fixture.prepare({
          sessionKey: "main",
          prompt: "first ask",
          extraSystemPrompt: `volatile msg-1\n\n${staticPrompt}`,
          sourceReplyDeliveryMode: "message_tool_only",
          currentMessageId: "msg-1",
          cliSessionBindingFacts,
        });
        const second = await fixture.prepare({
          sessionKey: "main",
          prompt: "second ask",
          extraSystemPrompt: `volatile msg-2\n\n${staticPrompt}`,
          sourceReplyDeliveryMode: stableMode,
          currentMessageId: "msg-2",
          cliSessionBindingFacts,
          cliSessionBinding: {
            sessionId: "cli-session",
            extraSystemPromptHash: first.extraSystemPromptHash,
            messageToolPolicyHash: first.messageToolPolicyHash,
            promptToolNamesHash: first.promptToolNamesHash,
            cwdHash: hashCliSessionText(dir),
          },
        });

        expect(first.extraSystemPromptHash).toBe(hashCliSessionText(staticPrompt));
        expect(first.messageToolPolicyHash).toBeDefined();
        expect(second.extraSystemPromptHash).toBe(first.extraSystemPromptHash);
        expect(second.messageToolPolicyHash).toBe(first.messageToolPolicyHash);
        expect(second.promptToolNamesHash).toBe(first.promptToolNamesHash);
        if (expectedStrongPrompt) {
          expect(first.systemPrompt).toContain(
            "Current source visible reply MUST use `message(action=send)`",
          );
        } else {
          expect(first.systemPrompt).toContain(
            "Current-session final text normally routes to source",
          );
          expect(first.systemPrompt).toContain(
            "If turn says final private, visible output uses `message(action=send)`",
          );
        }
        expect(second.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("reuses CLI session bindings across explicit mention toggles with stable group prompt facts", async () => {
    const { dir } = fixture.session;
    const baseGroupCtx = {
      ChatType: "group",
      Provider: "telegram",
      BotUsername: "SirPinchALotBot",
    } as const;
    const mentionedStaticPrompt = [
      buildGroupChatContext({
        sessionCtx: {
          ...baseGroupCtx,
          ExplicitlyMentionedBot: true,
        },
        sourceReplyDeliveryMode: "automatic",
        silentReplyPolicy: "allow",
        silentToken: "NO_REPLY",
      }),
      buildGroupIntro({
        defaultActivation: "mention",
      }),
    ].join("\n\n");
    const unmentionedStaticPrompt = [
      buildGroupChatContext({
        sessionCtx: {
          ...baseGroupCtx,
          ExplicitlyMentionedBot: false,
        },
        sourceReplyDeliveryMode: "automatic",
        silentReplyPolicy: "allow",
        silentToken: "NO_REPLY",
      }),
      buildGroupIntro({
        defaultActivation: "mention",
      }),
    ].join("\n\n");
    expect(unmentionedStaticPrompt).toBe(mentionedStaticPrompt);

    const first = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      prompt: "first ask",
      extraSystemPrompt: [
        "The incoming message explicitly mentions your channel identity @SirPinchALotBot.",
        mentionedStaticPrompt,
      ].join("\n\n"),
      sourceReplyDeliveryMode: "automatic",
      cliSessionBindingFacts: {
        extraSystemPromptStatic: mentionedStaticPrompt,
        sourceReplyDeliveryMode: "automatic",
      },
    });
    const second = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      prompt: "second ask",
      extraSystemPrompt: unmentionedStaticPrompt,
      sourceReplyDeliveryMode: "automatic",
      cliSessionBindingFacts: {
        extraSystemPromptStatic: unmentionedStaticPrompt,
        sourceReplyDeliveryMode: "automatic",
      },
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: first.extraSystemPromptHash,
        messageToolPolicyHash: first.messageToolPolicyHash,
        cwdHash: hashCliSessionText(dir),
      },
    });

    expect(second.extraSystemPromptHash).toBe(first.extraSystemPromptHash);
    expect(second.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
  });

  it("invalidates CLI session bindings when owner policy changes prompt tool scope", async () => {
    const { dir } = fixture.session;
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const resolveMcpLoopbackScopedTools = vi.fn((scope: { senderIsOwner?: boolean }) => ({
      agentId: "main",
      tools: [
        {
          name: "message",
          label: "Message",
          description: "Send a message",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
        ...(scope.senderIsOwner === false
          ? []
          : [
              {
                name: "gateway",
                label: "Gateway",
                description: "Manage the gateway",
                parameters: { type: "object", properties: {} },
                execute: vi.fn(),
              },
            ]),
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      config: {
        command: "native-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
        output: "text",
        input: "arg",
        sessionMode: "existing",
      },
    });
    const cliSessionBindingFacts = {
      extraSystemPromptStatic: "group:telegram:group:message_tool_only",
      sourceReplyDeliveryMode: "message_tool_only" as const,
    };
    const first = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      prompt: "first ask",
      provider: "native-cli",
      extraSystemPrompt: "volatile owner turn",
      currentMessageId: "owner-message",
      senderIsOwner: true,
      cliSessionBindingFacts,
      config: createCliBackendConfig({ bundleMcp: true }),
    });
    const second = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      prompt: "second ask",
      provider: "native-cli",
      extraSystemPrompt: "volatile non-owner turn",
      currentMessageId: "non-owner-message",
      senderIsOwner: false,
      cliSessionBindingFacts,
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: first.extraSystemPromptHash,
        messageToolPolicyHash: first.messageToolPolicyHash,
        promptToolNamesHash: first.promptToolNamesHash,
        cwdHash: hashCliSessionText(dir),
        mcpConfigHash: first.preparedBackend.mcpConfigHash,
        mcpResumeHash: first.preparedBackend.mcpResumeHash,
      },
      config: createCliBackendConfig({ bundleMcp: true }),
    });

    expect(resolveMcpLoopbackScopedTools).toHaveBeenCalledTimes(2);
    expect(resolveMcpLoopbackScopedTools).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        senderIsOwner: true,
        currentMessageId: "owner-message",
        sourceReplyDeliveryMode: undefined,
      }),
    );
    expect(resolveMcpLoopbackScopedTools).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        senderIsOwner: false,
        currentMessageId: "non-owner-message",
        sourceReplyDeliveryMode: undefined,
      }),
    );
    expect(second.promptToolNamesHash).not.toBe(first.promptToolNamesHash);
    expect(second.reusableCliSession).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session",
      drift: { reasons: ["prompt-tools"] },
    });
  });

  it("prepares raw-tail history for safe invalidations only when the backend opts in", async () => {
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: {
        role: "user",
        content: "prior no-compaction ask",
        timestamp: 1,
      },
    });

    const context = await fixture.prepare({
      extraSystemPrompt: "changed stable prompt",
      extraSystemPromptStatic: "changed stable prompt",
      cliSessionBinding: {
        sessionId: "cli-session",
        extraSystemPromptHash: hashCliSessionText("old stable prompt"),
      },
      config: createCliBackendConfig({
        reseedFromRawTranscriptWhenUncompacted: true,
      }),
    });

    expect(context.reusableCliSession).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session",
      drift: { reasons: ["system-prompt"] },
    });
    expect(context.openClawHistoryPrompt).toContain("prior no-compaction ask");
    expect(context.openClawHistoryPrompt).toContain("latest ask");
  });

  it("prepares opted-in raw-tail history for session-expired retry without disabling native resume", async () => {
    const { dir } = fixture.session;
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: {
        role: "user",
        content: "prior resumable ask",
        timestamp: 1,
      },
    });

    const context = await fixture.prepare({
      cliSessionBinding: {
        sessionId: "cli-session",
        cwdHash: hashCliSessionText(dir),
      },
      config: createCliBackendConfig({
        reseedFromRawTranscriptWhenUncompacted: true,
      }),
    });

    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
    expect(context.openClawHistoryPrompt).toContain("prior resumable ask");
    expect(context.openClawHistoryPrompt).toContain("latest ask");
  });

  it("applies direct-run prepend system context helpers on the CLI path", async () => {
    mockBuildActiveImageGenerationTaskPromptContextForSession.mockReturnValue("active image task");
    mockBuildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue("active video task");
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => ({
        systemPrompt: "hook system",
        prependSystemContext: "hook prepend system",
      })),
    };
    mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);

    const context = await fixture.prepare({
      sessionKey: "agent:main:test",
      trigger: "user",
    });

    expect(context.systemPrompt).toBe(
      `${wrappedPluginSystemContext("hook prepend system")}\n\nhook system${SYSTEM_PROMPT_CACHE_BOUNDARY}active image task\n\nactive video task\n\nCurrent model identity: test-cli/test-model. Model question: answer this current-run value.`,
    );
    expect(mockBuildActiveImageGenerationTaskPromptContextForSession).toHaveBeenCalledWith(
      "agent:main:test",
    );
    expect(mockBuildActiveVideoGenerationTaskPromptContextForSession).toHaveBeenCalledWith(
      "agent:main:test",
    );
  });

  it("skips bundle MCP preparation when tools are disabled", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
    const createMcpLoopbackServerConfig = vi.fn(createTestMcpLoopbackServerConfig);
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer,
      createMcpLoopbackServerConfig,
    });

    const context = await fixture.prepare({
      config: createCliBackendConfig({ bundleMcp: true }),
      disableTools: true,
    });

    expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
    expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();
    expect(createMcpLoopbackServerConfig).not.toHaveBeenCalled();
    expect(context.preparedBackend.mcpConfigHash).toBeUndefined();
    expect(context.preparedBackend.env).toBeUndefined();
    expect(context.preparedBackend.backend.args).toEqual(["--print"]);
  });

  it("uses loopback-scoped tools when building bundled MCP CLI prompts", async () => {
    registerTestMemoryPromptBuilder(({ availableTools }) =>
      availableTools.has("memory_search")
        ? ["## Memory Recall", `tools=${[...availableTools].toSorted().join(",")}`, ""]
        : [],
    );
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
    const createMcpLoopbackServerConfig = vi.fn(createTestMcpLoopbackServerConfig);
    const activateMcpLoopbackClientGrantCapture = vi.fn(() => true);
    const deactivateMcpLoopbackClientGrantCapture = vi.fn(() => true);
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    const resolveMcpLoopbackScopedTools = vi.fn((_scope: Record<string, unknown>) => ({
      agentId: "main",
      tools: [
        {
          name: "memory_search",
          label: "Memory Search",
          description: "Search memory",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer,
      createMcpLoopbackServerConfig,
      activateMcpLoopbackClientGrantCapture,
      deactivateMcpLoopbackClientGrantCapture,
      mintMcpLoopbackClientGrant,
      revokeMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      config: {
        command: "native-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
        output: "text",
        input: "arg",
        sessionMode: "existing",
      },
    });
    const baselineContext = await fixture.prepare({
      sessionKey: "main",
      agentId: "worker",
      provider: "native-cli",
      config: createCliBackendConfig({ bundleMcp: true }),
    });
    const context = await fixture.prepare({
      sessionKey: "main",
      agentId: "worker",
      provider: "native-cli",
      runId: "run-test-loopback-prompt-tools",
      config: createCliBackendConfig({ bundleMcp: true }),
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:worker:discord:group:ops",
        ownerAccountId: "default",
      },
      cliSessionBinding: {
        sessionId: "cli-session",
        promptToolNamesHash: "old-tool-surface",
        ...(baselineContext.preparedBackend.mcpConfigHash
          ? { mcpConfigHash: baselineContext.preparedBackend.mcpConfigHash }
          : {}),
        ...(baselineContext.preparedBackend.mcpResumeHash
          ? { mcpResumeHash: baselineContext.preparedBackend.mcpResumeHash }
          : {}),
      },
    });

    const projected = resolveMcpLoopbackScopedTools.mock.calls.at(-1)?.[0];
    const grantContext = mintMcpLoopbackClientGrant.mock.calls.at(-1)?.[0]?.context;
    expect(projected).toBeDefined();
    expect(grantContext).toBeDefined();
    const { cfg: projectedConfig, ...projectedContext } = projected ?? {};
    expect(projectedConfig).toEqual(expect.any(Object));
    expect(projectedContext).toEqual(grantContext);
    expect(projectedContext).toMatchObject({
      sessionKey: "agent:worker:main",
      sessionId: expect.any(String),
      runId: "run-test-loopback-prompt-tools",
      workspaceDir: expect.any(String),
      modelProvider: "native-cli",
      modelId: "test-model",
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:worker:discord:group:ops",
        ownerAccountId: "default",
      },
    });
    expect(context.systemPrompt).toContain("## Memory Recall");
    expect(context.systemPrompt).toContain("tools=memory_search");
    expect(context.systemPromptReport.tools.entries.map((entry) => entry.name)).toEqual([
      "memory_search",
    ]);
    expect(context.promptToolNamesHash).toBe(hashCliSessionText(JSON.stringify(["memory_search"])));
    expect(context.reusableCliSession).toEqual({
      mode: "reuse-with-drift",
      sessionId: "cli-session",
      drift: { reasons: ["prompt-tools"] },
    });
  });

  it("fails bundled MCP preparation when the loopback runtime is unavailable", async () => {
    registerTestMemoryPromptBuilder(({ availableTools }) =>
      availableTools.has("memory_search")
        ? ["## Memory Recall", `tools=${[...availableTools].toSorted().join(",")}`, ""]
        : [],
    );
    const getActiveMcpLoopbackRuntime = vi.fn(() => undefined);
    const ensureMcpLoopbackServer = vi.fn(async () => {
      throw new Error("loopback unavailable");
    });
    const createMcpLoopbackServerConfig = vi.fn(createTestMcpLoopbackServerConfig);
    const resolveMcpLoopbackScopedTools = vi.fn(() => ({
      agentId: "main",
      tools: [
        {
          name: "memory_search",
          label: "Memory Search",
          description: "Search memory",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer,
      createMcpLoopbackServerConfig,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      config: {
        command: "native-cli",
        args: ["--print"],
        systemPromptArg: "--system-prompt",
        systemPromptWhen: "first",
        output: "text",
        input: "arg",
        sessionMode: "existing",
      },
    });
    await expect(
      fixture.prepare({
        sessionKey: "agent:main:test",
        provider: "native-cli",
        config: createCliBackendConfig({ bundleMcp: true }),
      }),
    ).rejects.toThrow(/loopback unavailable/);

    expect(ensureMcpLoopbackServer).toHaveBeenCalledTimes(1);
    expect(getActiveMcpLoopbackRuntime).toHaveBeenCalledTimes(1);
    expect(createMcpLoopbackServerConfig).not.toHaveBeenCalled();
    expect(resolveMcpLoopbackScopedTools).not.toHaveBeenCalled();
  });

  it("binds current turn context into the bundle MCP client grant", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
    const createMcpLoopbackServerConfig = vi.fn(createTestMcpLoopbackServerConfig);
    const activateMcpLoopbackClientGrantCapture = vi.fn(() => true);
    const deactivateMcpLoopbackClientGrantCapture = vi.fn(() => true);
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const revokeMcpLoopbackClientGrant = vi.fn(() => true);
    const resolveMcpLoopbackScopedTools = vi.fn(() => ({
      agentId: "main",
      tools: [
        {
          name: "message",
          label: "Message",
          description: "Send a message",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      ],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      ensureMcpLoopbackServer,
      createMcpLoopbackServerConfig,
      activateMcpLoopbackClientGrantCapture,
      deactivateMcpLoopbackClientGrantCapture,
      mintMcpLoopbackClientGrant,
      revokeMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools,
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "codex-config-overrides",
      config: {
        command: "native-cli",
        args: ["--print"],
        input: "arg",
        sessionMode: "existing",
      },
    });
    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:group:chat123",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:canonical-sender",
      agentId: "worker",
      provider: "native-cli",
      modelProvider: "anthropic",
      runId: "run-test-room-event-tools",
      sessionEntry: {
        execHost: "node",
        execSecurity: "allowlist",
        execAsk: "on-miss",
        execNode: "mac-a",
      } as never,
      execOverrides: {
        host: "node",
        security: "allowlist",
        ask: "always",
        node: "mac-b",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
      trigger: "user",
      currentInboundEventKind: "room_event",
      messageChannel: "telegram",
      messageProvider: "discord",
      clientCaps: ["tool-events", "inline-widgets"],
      currentChannelId: "telegram:-100123:topic:42",
      currentThreadTs: "42",
      currentMessageId: "reply-message-1",
      currentInboundAudio: true,
      sourceReplyDeliveryMode: "message_tool_only",
      taskSuggestionDeliveryMode: "gateway",
      requireExplicitMessageTarget: true,
      approvalReviewerDeviceId: "reviewer-device",
      senderId: "canonical-sender",
      senderName: "Canonical Name",
      senderUsername: "canonical-user",
      senderE164: "+15551234567",
      groupId: "chat123",
      groupChannel: "ops",
      groupSpace: "workspace-a",
      spawnedBy: "agent:main:telegram:group:parent",
      channelContext: {
        sender: { id: "sender-1", displayName: "not-forwarded" },
        chat: { id: "chat-1", title: "not-forwarded" },
      },
    });

    expect(context.preparedBackend.env).toMatchObject({
      OPENCLAW_MCP_TOKEN: "loopback-token",
      OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
    });
    expect(mintMcpLoopbackClientGrant).toHaveBeenCalledWith({
      context: {
        sessionKey: "agent:main:telegram:group:chat123",
        runtimePolicySessionKey: "agent:worker:discord:default:direct:canonical-sender",
        agentId: "worker",
        sessionId: "session-test",
        runId: "run-test-room-event-tools",
        workspaceDir: context.workspaceDir,
        modelProvider: "anthropic",
        modelId: "test-model",
        messageProvider: "discord",
        clientCaps: ["tool-events", "inline-widgets"],
        currentChannelId: "telegram:-100123:topic:42",
        currentThreadTs: "42",
        currentMessageId: "reply-message-1",
        currentInboundAudio: true,
        accountId: undefined,
        inboundEventKind: "room_event",
        sourceReplyDeliveryMode: "message_tool_only",
        taskSuggestionDeliveryMode: "gateway",
        requireExplicitMessageTarget: true,
        senderIsOwner: false,
        nodeExecAllowed: true,
        execSession: {
          execHost: "node",
          execSecurity: "allowlist",
          execAsk: "on-miss",
          execNode: "mac-a",
        },
        execOverrides: {
          host: "node",
          security: "allowlist",
          ask: "always",
          node: "mac-b",
        },
        bashElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
        trigger: "user",
        approvalReviewerDeviceId: "reviewer-device",
        channelContext: {
          sender: { id: "canonical-sender" },
          chat: { id: "chat-1" },
        },
        senderName: "Canonical Name",
        senderUsername: "canonical-user",
        senderE164: "+15551234567",
        groupId: "chat123",
        groupChannel: "ops",
        groupSpace: "workspace-a",
        spawnedBy: "agent:main:telegram:group:parent",
      },
      runtimeOwnerToken: "loopback-owner-token",
    });
    context.preparedBackend.mcpClientGrantCapture?.activate("capture-test");
    context.preparedBackend.mcpClientGrantCapture?.deactivate("capture-test");
    expect(activateMcpLoopbackClientGrantCapture).toHaveBeenCalledExactlyOnceWith({
      token: "loopback-token",
      runtimeOwnerToken: "loopback-owner-token",
      captureKey: "capture-test",
    });
    expect(deactivateMcpLoopbackClientGrantCapture).toHaveBeenCalledExactlyOnceWith({
      token: "loopback-token",
      runtimeOwnerToken: "loopback-owner-token",
      captureKey: "capture-test",
    });
    expect(context.mcpDeliveryCapture).toBe(true);
    expect(resolveMcpLoopbackScopedTools).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCaps: ["tool-events", "inline-widgets"],
        taskSuggestionDeliveryMode: "gateway",
        requireExplicitMessageTarget: true,
        senderIsOwner: false,
        runtimePolicySessionKey: "agent:worker:discord:default:direct:canonical-sender",
        agentId: "worker",
        modelProvider: "anthropic",
        modelId: "test-model",
        execOverrides: {
          host: "node",
          security: "allowlist",
          ask: "always",
          node: "mac-b",
        },
        bashElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
        channelContext: {
          sender: { id: "canonical-sender" },
          chat: { id: "chat-1" },
        },
        senderName: "Canonical Name",
        senderUsername: "canonical-user",
        senderE164: "+15551234567",
        messageProvider: "discord",
        groupId: "chat123",
        groupChannel: "ops",
        groupSpace: "workspace-a",
        spawnedBy: "agent:main:telegram:group:parent",
      }),
    );
    expect(context.systemPrompt).toContain(
      "`send`: `target` + `message`; target required this turn",
    );
    expect(context.systemPrompt).not.toContain("current source is default target");
    await context.preparedBackend.cleanup?.();
    expect(revokeMcpLoopbackClientGrant).toHaveBeenCalledExactlyOnceWith("loopback-token");
  });

  it("enables gateway delivery capture for Claude-style JSONL bundle MCP", async () => {
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(() => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      })),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
    });
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      config: {
        command: "claude",
        args: ["--print"],
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        input: "stdin",
        sessionMode: "existing",
      },
    });

    const context = await fixture.prepare({
      provider: "claude-cli",
    });

    expect(context.mcpDeliveryCapture).toBe(true);
    expect(context.preparedBackend.env).toMatchObject({
      OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
    });
  });

  it("fails closed with upgrade guidance when a backend cannot enforce a runtime toolsAllow", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
    });

    const run = fixture.prepare({
      config: createCliBackendConfig({ bundleMcp: true }),
      toolsAllow: ["read", "web_search"],
    });
    await expect(run).rejects.toThrow(
      `CLI backend "test-cli" cannot enforce this run's tool cap. Upgrade its plugin and retry; if current, ask its maintainer to add exact-cap support. OpenClaw did not start the run.`,
    );

    expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
  });

  it("materializes runtime toolsAllow for selectable backends without bundle MCP", async () => {
    const resolveExecutionArgs = vi.fn((context: { baseArgs: readonly string[] }) => [
      ...context.baseArgs,
    ]);
    const resolveMcpLoopbackPolicyTools = vi.fn((_scope: Record<string, unknown>) => ({
      agentId: "main",
      tools: ["write", "apply_patch"].map((name) => ({ name })),
    }));
    setRawCliBackendForPrepareTest({
      id: "selectable-cli",
      pluginId: "selectable-plugin",
      bundleMcp: false,
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs,
      config: {
        command: "selectable-cli",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({ resolveMcpLoopbackPolicyTools });

    const context = await fixture.prepare({
      provider: "selectable-cli",
      toolsAllow: ["write"],
    });

    expect(context.params.cliToolAvailability).toEqual({
      native: [],
      openClaw: ["write", "apply_patch"],
    });
    expect(resolveMcpLoopbackPolicyTools).toHaveBeenCalledWith(
      expect.objectContaining({ toolsAllow: ["write"] }),
    );
  });

  it("requires prepared-execution backends to acknowledge exact enforcement and cleans up", async () => {
    const cleanup = vi.fn(async () => {});
    const prepareExecution = vi.fn(async () => ({ cleanup }));
    setRawCliBackendForPrepareTest({
      id: "settings-cli",
      pluginId: "settings-plugin",
      bundleMcp: false,
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: {
        command: "settings-cli",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });

    await expect(
      fixture.prepare({
        provider: "settings-cli",
        cliToolAvailability: { native: [], openClaw: [] },
      }),
    ).rejects.toThrow(
      "did not enforce exact per-run tool availability during execution preparation",
    );
    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({ toolAvailability: { native: [], openClaw: [], mcp: [] } }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("accepts a positive prepared-execution enforcement acknowledgement", async () => {
    const prepareExecution = vi.fn(async () => ({ toolAvailabilityEnforced: true as const }));
    setRawCliBackendForPrepareTest({
      id: "settings-cli",
      pluginId: "settings-plugin",
      bundleMcp: false,
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: {
        command: "settings-cli",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });

    const context = await fixture.prepare({
      provider: "settings-cli",
      cliToolAvailability: { native: [], openClaw: [] },
    });
    expect(context.params.cliToolAvailability).toEqual({ native: [], openClaw: [] });
    await context.preparedBackend.cleanup?.();
  });

  it("projects node-placed Claude availability before prepared-execution enforcement", async () => {
    const prepareExecution = vi.fn(async () => ({ toolAvailabilityEnforced: true as const }));
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: false,
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      prepareExecution,
      config: {
        command: "claude",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });

    const context = await fixture.prepare({
      provider: "claude-cli",
      sessionEntry: { execHost: "node", execNode: "node-a" } as never,
      cliToolAvailability: { native: ["Read"], openClaw: ["message"] },
    });

    expect(prepareExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        toolAvailability: { native: ["Read"], openClaw: [], mcp: [] },
      }),
    );
    expect(context.params.cliToolAvailability).toEqual({ native: ["Read"], openClaw: [] });
    await context.preparedBackend.cleanup?.();
  });

  it("keeps runtime toolsAllow canonical and bounds the backend-independent MCP grant", async () => {
    const resolveExecutionArgs = vi.fn((context: { baseArgs: readonly string[] }) => [
      ...context.baseArgs,
    ]);
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    const resolveMcpLoopbackPolicyTools = vi.fn((_scope: Record<string, unknown>) => ({
      agentId: "main",
      tools: ["write", "apply_patch"].map((name) => ({ name })),
    }));
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs,
      config: {
        command: "claude",
        args: ["--print"],
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(() => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      })),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant,
      resolveMcpLoopbackPolicyTools,
    });

    let cleanup: (() => Promise<void>) | undefined;
    try {
      const context = await fixture.prepare({
        sessionKey: "agent:main:main",
        provider: "claude-cli",
        toolsAllow: ["write"],
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "default",
        },
      });
      cleanup = context.preparedBackend.cleanup;

      expect(context.params.toolsAllow).toBeUndefined();
      expect(context.params.cliToolAvailability).toEqual({
        native: [],
        openClaw: ["write", "apply_patch"],
      });
      expect(mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.toolsAllow).toEqual([
        "write",
        "apply_patch",
      ]);
      expect(mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context.scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:discord:group:ops",
        ownerAccountId: "default",
      });
      expect(resolveMcpLoopbackPolicyTools).toHaveBeenCalledWith(
        expect.objectContaining({
          toolsAllow: ["write"],
          scheduledToolPolicy: {
            version: 1,
            mode: "account",
            ownerSessionKey: "agent:main:discord:group:ops",
            ownerAccountId: "default",
          },
        }),
      );
      const projected = resolveMcpLoopbackPolicyTools.mock.calls[0]?.[0];
      const grantContext = mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context;
      const {
        cfg: _projectedConfig,
        toolsAllow: projectedPolicy,
        ...projectedTrustedContext
      } = projected ?? {};
      const { toolsAllow: grantedTools, ...grantTrustedContext } = grantContext ?? {};
      expect(projectedPolicy).toEqual(["write"]);
      expect(grantedTools).toEqual(["write", "apply_patch"]);
      expect(projectedTrustedContext).toEqual(grantTrustedContext);
    } finally {
      await cleanup?.();
    }
  });

  it("bounds the loopback grant to the selectable MCP tool allowlist", async () => {
    const resolveExecutionArgs = vi.fn((context: { baseArgs: readonly string[] }) => [
      ...context.baseArgs,
    ]);
    const mintMcpLoopbackClientGrant = vi.fn(createTestMcpLoopbackClientGrant);
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs,
      config: {
        command: "claude",
        args: ["--print"],
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime: vi.fn(() => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      })),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant,
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
    });

    let cleanup: (() => Promise<void>) | undefined;
    try {
      const context = await fixture.prepare({
        sessionKey: "agent:main:main",
        provider: "claude-cli",
        config: {
          ...createCliBackendConfig(),
          mcp: {
            servers: {
              userProbe: { command: "node", args: ["user-probe.mjs"] },
            },
          },
        },
        cliToolAvailability: {
          native: [],
          openClaw: ["memory_search", "memory_get"],
        },
      });
      cleanup = context.preparedBackend.cleanup;

      // The grant carries exactly the canonical gateway tool names.
      const grantContext = mintMcpLoopbackClientGrant.mock.calls[0]?.[0]?.context;
      expect(grantContext?.toolsAllow).toEqual(["memory_search", "memory_get"]);

      // Restricted runs must not see user/plugin MCP servers: the generated
      // bundle serves only the grant-scoped loopback server.
      const args = context.preparedBackend.backend.args ?? [];
      const mcpConfigPath = args[args.indexOf("--mcp-config") + 1];
      const rawBundle = JSON.parse(fs.readFileSync(mcpConfigPath ?? "", "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(Object.keys(rawBundle.mcpServers ?? {})).toEqual(["openclaw"]);
    } finally {
      await cleanup?.();
    }
  });

  it("serves only the openclaw MCP server for ring-zero runs", async () => {
    const { dir, sessionFile } = fixture.session;
    const getActiveMcpLoopbackRuntime = vi.fn(() => undefined);
    const resolveExecutionArgs = vi.fn(
      (context: {
        baseArgs: readonly string[];
        toolAvailability?: { native: readonly string[]; openClaw: readonly string[] };
      }) => [
        ...context.baseArgs,
        "--tools",
        context.toolAvailability?.native.join(",") ?? "default",
        "--allowedTools",
        context.toolAvailability?.openClaw.join(",") ?? "",
      ],
    );
    setCliRunnerPrepareTestDeps({ getActiveMcpLoopbackRuntime });
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
      resolveExecutionArgs,
      config: {
        command: "claude",
        args: ["--print"],
        resumeArgs: ["--print", "--resume", "{sessionId}"],
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        input: "stdin",
        sessionMode: "existing",
      },
    });

    const params: RunCliAgentParams & { systemAgentTool: SystemAgentToolOptions } = {
      sessionId: "session-test",
      sessionFile,
      workspaceDir: dir,
      prompt: "latest ask",
      provider: "claude-cli",
      model: "test-model",
      timeoutMs: 1_000,
      runId: "run-test-openclaw-mcp",
      config: createCliBackendConfig(),
      systemAgentTool: { surface: "cli" },
      cliToolAvailability: {
        native: [],
        openClaw: ["openclaw"],
      },
    };
    const context = await prepareCliRunContext(params);

    // Ring-zero runs never touch the loopback surface (no message tools).
    expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
    expect(context.mcpDeliveryCapture).toBeUndefined();
    const args = context.preparedBackend.backend.args ?? [];
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--allowedTools");
    expect(context.preparedBackend.backend.resumeArgs).toEqual(
      expect.arrayContaining(["--strict-mcp-config"]),
    );
    expect(resolveExecutionArgs).not.toHaveBeenCalled();
    expect(context.params.cliToolAvailability).toEqual({
      native: [],
      openClaw: ["openclaw"],
    });
    const mcpConfigPath = expectDefined(
      args[args.indexOf("--mcp-config") + 1],
      'args[args.indexOf("--mcp-config") + 1] test invariant',
    );
    const raw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.env).toMatchObject({
      OPENCLAW_TOOLS_MCP_TOOLS: "openclaw",
      OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_SURFACE: "cli",
    });

    await context.preparedBackend.cleanup?.();
  });

  it("fails closed for native tool-capable CLI backends when tools are disabled", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
    });
    setRawCliBackendForPrepareTest({
      id: "native-cli",
      pluginId: "native-plugin",
      bundleMcp: true,
      bundleMcpMode: "codex-config-overrides",
      nativeToolMode: "always-on",
      config: {
        command: "native-cli",
        args: ["exec", "--sandbox", "workspace-write"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
        output: "jsonl",
        input: "arg",
        sessionMode: "existing",
      },
    });

    await expect(
      fixture.prepare({
        provider: "native-cli",
        disableTools: true,
      }),
    ).rejects.toThrow(
      "CLI backend native-cli cannot run with tools disabled because it exposes native tools",
    );

    expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "drops the claude-cli sessionId when the on-disk transcript is missing (#77011)",
      sessionId: "stale-claude-sid",
      hasContent: false,
      hasOrphan: true,
      withCwdHash: false,
      checksTranscript: true,
      checksOrphan: false,
      expected: { mode: "invalidate", invalidatedReason: "missing-transcript" },
    },
    {
      name: "invalidates orphaned claude-cli transcripts during run preparation",
      sessionId: "orphaned-claude-sid",
      hasContent: true,
      hasOrphan: true,
      withCwdHash: true,
      checksTranscript: true,
      checksOrphan: true,
      expected: { mode: "invalidate", invalidatedReason: "orphaned-tool-use" },
    },
    {
      name: "keeps auth-boundary invalidation ahead of orphaned transcript checks",
      sessionId: "orphaned-claude-sid",
      authProfileId: "anthropic:old-profile",
      hasContent: true,
      hasOrphan: true,
      withCwdHash: true,
      checksTranscript: false,
      checksOrphan: false,
      expected: { mode: "invalidate", invalidatedReason: "auth-profile" },
    },
    {
      name: "keeps the claude-cli sessionId when the on-disk transcript is present",
      sessionId: "live-claude-sid",
      hasContent: true,
      hasOrphan: false,
      withCwdHash: true,
      checksTranscript: true,
      checksOrphan: true,
      expected: { mode: "reuse", sessionId: "live-claude-sid" },
    },
  ])("$name", async (testCase) => {
    const { dir } = fixture.session;
    setCliBackendForPrepareTest();
    const transcriptCheck = vi.fn(async () => testCase.hasContent);
    const orphanCheck = vi.fn(async () => testCase.hasOrphan);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });
    const cliSessionBinding = {
      sessionId: testCase.sessionId,
      ...(testCase.withCwdHash ? { cwdHash: hashCliSessionText(dir) } : {}),
      ...(testCase.authProfileId ? { authProfileId: testCase.authProfileId } : {}),
    };

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: "follow-up",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding,
      cliSessionId: testCase.sessionId,
    });

    const transcriptArgs = { sessionId: testCase.sessionId, workspaceDir: dir };
    if (testCase.checksTranscript) {
      expect(transcriptCheck).toHaveBeenCalledWith(transcriptArgs);
    } else {
      expect(transcriptCheck).not.toHaveBeenCalled();
    }
    if (testCase.checksOrphan) {
      expect(orphanCheck).toHaveBeenCalledWith(transcriptArgs);
    } else {
      expect(orphanCheck).not.toHaveBeenCalled();
    }
    expect(context.reusableCliSession).toEqual(testCase.expected);
  });

  it("arms raw-transcript reseed for a missing claude-cli transcript so prior conversation is redelivered", async () => {
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: {
        role: "user",
        content: "prior claude-cli ask",
        timestamp: 1,
      },
    });
    setCliBackendForPrepareTest({
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const transcriptCheck = vi.fn(async () => false);
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "stale-claude-sid" },
      cliSessionId: "stale-claude-sid",
    });

    // Candidate is invalidated (no native --resume) yet reseed still fires:
    // prepare hands the prior OpenClaw conversation forward as history.
    expect(context.reusableCliSession).toEqual({
      mode: "invalidate",
      invalidatedReason: "missing-transcript",
    });
    expect(context.openClawHistoryPrompt).toContain("prior claude-cli ask");
    expect(context.openClawHistoryPrompt).toContain("latest ask");
  });

  it("prepares node-placed Claude resumes without Gateway MCP, skills, or transcript checks", async () => {
    fixture.appendTranscript({
      id: "msg-node-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: "gateway-only history", timestamp: 1 },
    });
    const prepareExecution = vi.fn(async () => ({
      env: { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" },
      secretInput: {
        fd: 3,
        fingerprint: "selected-node-token-fingerprint",
        createData: () => Buffer.from("selected-node-token"),
      },
      clearEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    }));
    setCliBackendForPrepareTest({
      bundleMcp: true,
      liveSession: true,
      prepareExecution,
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const ensureMcpLoopbackServer = vi.fn(createTestMcpLoopbackServer);
    const prepareClaudeCliSkillsPlugin = vi.fn(async () => ({
      args: ["--plugin-dir", "/tmp/gateway-skills"],
      cleanup: vi.fn(async () => undefined),
    }));
    const transcriptCheck = vi.fn(async () => false);
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      ensureMcpLoopbackServer,
      prepareClaudeCliSkillsPlugin,
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });

    await expect(
      fixture.prepare({
        provider: "claude-cli",
        model: "opus",
        sessionEntry: { execHost: "node" } as never,
      }),
    ).rejects.toThrow("node-placed Claude CLI session is missing execNode");
    expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();

    const context = await fixture.prepare({
      sessionKey: "agent:main:catalog-adopt:claude:node",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: {
        sessionId: "node-source-session",
        forceReuse: true,
        forkNextResume: true,
      },
      cliSessionId: "node-source-session",
      sessionEntry: {
        execHost: "node",
        execNode: "node-a",
        execCwd: "/work/on-node",
      } as never,
      skillsSnapshot: {
        prompt: "GATEWAY_ONLY_SKILL_PATH=/tmp/gateway-skill/SKILL.md",
        skills: [],
        resolvedSkills: [],
      },
    });

    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "node-source-session",
    });
    // The reseed prompt is gateway-built text, so node placement keeps the
    // backend's raw-transcript reseed semantics for fresh-retry paths.
    expect(context.openClawHistoryPrompt).toContain("gateway-only history");
    expect(context.claudeSkillsPluginArgs).toEqual([]);
    expect(context.systemPrompt).not.toContain("GATEWAY_ONLY_SKILL_PATH");
    expect(context.mcpDeliveryCapture).toBeUndefined();
    expect(ensureMcpLoopbackServer).not.toHaveBeenCalled();
    expect(prepareClaudeCliSkillsPlugin).not.toHaveBeenCalled();
    expect(transcriptCheck).not.toHaveBeenCalled();
    expect(orphanCheck).not.toHaveBeenCalled();
    expect(prepareExecution).toHaveBeenCalledOnce();
    expect(context.preparedBackend.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
    });
    expect(context.preparedBackend.secretInput?.fingerprint).toBe(
      "selected-node-token-fingerprint",
    );
    expect(context.preparedBackend.backend.clearEnv).toEqual(
      expect.arrayContaining(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]),
    );
  });

  it("keeps a warm claude-cli binding when its managed stdio child is still live", async () => {
    const { dir } = fixture.session;
    fixture.appendTranscript({
      id: "msg-warm-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: {
        role: "user",
        content: "earlier warm context",
        timestamp: 1,
      },
    });
    setCliBackendForPrepareTest({
      liveSession: true,
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const transcriptCheck = vi.fn(async () => false);
    const orphanCheck = vi.fn(async () => true);
    const getLiveSessionGeneration = vi.fn(() => "warm-live-generation");
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
      getClaudeLiveSessionGenerationForOwner: getLiveSessionGeneration,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: "warm follow-up",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "warm-claude-sid" },
      cliSessionId: "warm-claude-sid",
    });

    expect(getLiveSessionGeneration).toHaveBeenCalledWith({
      backendId: "claude-cli",
      agentAccountId: undefined,
      agentId: undefined,
      authProfileId: undefined,
      sessionId: "session-test",
      sessionKey: "agent:main:telegram:direct:peer",
    });
    expect(transcriptCheck).toHaveBeenCalledWith({
      sessionId: "warm-claude-sid",
      workspaceDir: dir,
    });
    expect(orphanCheck).not.toHaveBeenCalled();
    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "warm-claude-sid",
    });
    expect(context.requiredClaudeLiveSessionGeneration).toBe("warm-live-generation");
    expect(context.openClawHistoryPrompt).toContain("earlier warm context");
    expect(context.openClawHistoryPrompt).toContain("warm follow-up");
  });

  it("disables Claude live transport while preserving native transcript resume", async () => {
    setCliBackendForPrepareTest({ liveSession: true });
    const transcriptCheck = vi.fn(async () => true);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: vi.fn(async () => false),
    });

    const context = await fixture.prepare({
      sessionKey: "agent:openclaw:main",
      prompt: "approve the proposal",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "native-claude-sid" },
      disableCliLiveSession: true,
    });

    expect(context.preparedBackend.backend.liveSession).toBeUndefined();
    expect(context.preparedBackend.backend.sessionMode).toBe("existing");
    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "native-claude-sid",
    });
  });

  it("ignores stored CLI session candidates when the backend disables sessions", async () => {
    setCliBackendForPrepareTest({
      sessionMode: "none",
      reseedFromRawTranscriptWhenUncompacted: true,
    });
    const transcriptCheck = vi.fn(async () => false);
    const orphanCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
      claudeCliSessionTranscriptHasOrphanedToolUse: orphanCheck,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      prompt: "stateless ask",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "stale-claude-sid" },
      cliSessionId: "stale-claude-sid",
    });

    expect(context.reusableCliSession).toEqual({ mode: "none" });
    expect(transcriptCheck).not.toHaveBeenCalled();
    expect(orphanCheck).not.toHaveBeenCalled();
  });

  it("checks claude-cli transcript content under the resolved cwd", async () => {
    const { dir } = fixture.session;
    const taskDir = path.join(dir, "task");
    fs.mkdirSync(taskDir, { recursive: true });
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: false,
      config: {
        command: "claude",
        args: ["--print"],
        resumeArgs: ["--resume", "{sessionId}"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
      },
    });
    const transcriptCheck = vi.fn(async () => true);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:telegram:direct:peer",
      cwd: taskDir,
      prompt: "follow-up",
      provider: "claude-cli",
      model: "opus",
      cliSessionBinding: { sessionId: "live-claude-sid", cwdHash: hashCliSessionText(taskDir) },
      cliSessionId: "live-claude-sid",
    });

    expect(transcriptCheck).toHaveBeenCalledWith({
      sessionId: "live-claude-sid",
      workspaceDir: taskDir,
    });
    expect(context.reusableCliSession).toEqual({
      mode: "reuse",
      sessionId: "live-claude-sid",
    });
  });

  it("renders CLI skills from sandbox-readable paths instead of persisted host snapshots", async () => {
    const { dir } = fixture.session;
    const hostSkillDir = "/home/tzdai/.npm-global/lib/node_modules/openclaw/skills/gog";
    const hostSkillPath = `${hostSkillDir}/SKILL.md`;
    const materializedWorkspace = path.join(dir, "state", "sandbox-skills");
    const materializedSkillDir = path.join(materializedWorkspace, "skills", "gog");
    const materializedSkillPath = path.join(materializedSkillDir, "SKILL.md");
    fs.mkdirSync(materializedSkillDir, { recursive: true });
    fs.writeFileSync(
      materializedSkillPath,
      [
        "---",
        "name: gog",
        "description: Read Gmail safely.",
        "---",
        "",
        "Use the Gmail tools before answering mail questions.",
      ].join("\n"),
      "utf-8",
    );
    ensureSandboxWorkspaceForSessionMock.mockResolvedValue({
      workspaceDir: dir,
      containerWorkdir: "/workspace",
      skillsWorkspaceDir: materializedWorkspace,
      workspaceAccess: "rw",
    });

    const context = await fixture.prepare({
      sessionKey: "agent:main:sandboxed-user",
      agentId: "main",
      prompt: "are there any unread emails",
      skillsSnapshot: {
        prompt: [
          "<available_skills>",
          "  <skill>",
          "    <name>gog</name>",
          "    <description>Read Gmail safely.</description>",
          `    <location>${hostSkillPath}</location>`,
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
        skills: [{ name: "gog" }],
        resolvedSkills: [
          {
            name: "gog",
            description: "Read Gmail safely.",
            filePath: hostSkillPath,
            baseDir: hostSkillDir,
            source: "openclaw-bundled",
            sourceInfo: {
              path: hostSkillPath,
              source: "openclaw-bundled",
              scope: "project",
              origin: "top-level",
              baseDir: hostSkillDir,
            },
            disableModelInvocation: false,
          },
        ],
      },
    });

    expect(ensureSandboxWorkspaceForSessionMock).toHaveBeenCalledWith({
      config: createCliBackendConfig(),
      sessionKey: "agent:main:sandboxed-user",
      workspaceDir: dir,
    });
    expect(context.systemPrompt).toContain(
      "/workspace/.openclaw/sandbox-skills/skills/gog/SKILL.md",
    );
    expect(context.systemPrompt).not.toContain(hostSkillPath);
    expect(context.systemPromptReport.skills.promptChars).toBeGreaterThan(0);
    expect(context.systemPromptReport.skills.entries).toEqual([
      { name: "gog", blockChars: expect.any(Number) },
    ]);
  });

  it.each([
    {
      name: "omits prompt skills when the native skills plugin can carry them",
      materialized: true,
      pluginResult: "args",
      expectsPromptSkills: false,
    },
    {
      name: "keeps prompt skills when the snapshot has no materialized plugin skills",
      materialized: false,
      pluginResult: "default",
      expectsPromptSkills: true,
    },
    {
      name: "keeps prompt skills when plugin materialization produces no args",
      materialized: true,
      pluginResult: "empty",
      expectsPromptSkills: true,
    },
  ])("handles Claude CLI skills: $name", async (testCase) => {
    const { dir } = fixture.session;
    const skill = createWeatherSkillFixture(dir, testCase.materialized);
    setCliBackendForPrepareTest({ id: "claude-cli", pluginId: "anthropic" });
    if (testCase.pluginResult !== "default") {
      const pluginDir = path.join(dir, "openclaw-skills");
      setCliRunnerPrepareTestDeps({
        prepareClaudeCliSkillsPlugin: vi.fn(async () => ({
          args: testCase.pluginResult === "args" ? ["--plugin-dir", pluginDir] : [],
          cleanup: vi.fn(async () => undefined),
          ...(testCase.pluginResult === "args" ? { pluginDir } : {}),
        })),
      });
    }

    const context = await fixture.prepare({
      provider: "claude-cli",
      model: "opus",
      skillsSnapshot: skill.snapshot,
    });

    if (testCase.expectsPromptSkills) {
      expect(context.systemPrompt).toContain("<available_skills>");
      expect(context.systemPrompt).toContain("<name>weather</name>");
      expect(context.systemPromptReport.skills.promptChars).toBeGreaterThan(0);
      expect(context.claudeSkillsPluginArgs).toEqual([]);
    } else {
      expect(context.systemPrompt).not.toContain("<available_skills>");
      expect(context.systemPrompt).not.toContain("<name>weather</name>");
      expect(context.systemPromptReport.skills.promptChars).toBe(0);
      expect(context.claudeSkillsPluginArgs).toEqual([
        "--plugin-dir",
        path.join(dir, "openclaw-skills"),
      ]);
    }
  });

  it("does not probe the transcript for non-claude-cli providers", async () => {
    const { dir } = fixture.session;
    const transcriptCheck = vi.fn(async () => false);
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: transcriptCheck,
    });

    const context = await fixture.prepare({
      cliSessionBinding: { sessionId: "test-cli-sid", cwdHash: hashCliSessionText(dir) },
    });

    expect(transcriptCheck).not.toHaveBeenCalled();
    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "test-cli-sid" });
  });

  it.each([
    {
      name: "uses a larger automatic reseed history cap for Claude CLI",
      provider: "claude-cli",
      model: "claude-haiku-3-5",
      marker: "RESEED_SUMMARY_MARKER_KEEP",
      padding: 40_000,
      expectsTruncation: false,
    },
    {
      name: "uses the plan-safe Claude CLI cap before mapping canonical models to CLI aliases",
      provider: "claude-cli",
      model: "claude-opus-4-8",
      modelAliases: { "claude-opus-4-8": "opus" },
      marker: "RESEED_ALIAS_SUMMARY_MARKER_KEEP",
      padding: 40_000,
      expectsTruncation: false,
    },
    {
      name: "keeps the default reseed history cap for non-Claude CLI backends",
      provider: "test-cli",
      model: "test-model",
      marker: "RESEED_SUMMARY_MARKER_DEFAULT",
      padding: 20_000,
      expectsTruncation: true,
    },
  ])("$name", async (testCase) => {
    const { sessionFile } = fixture.session;
    if (testCase.provider === "claude-cli") {
      setCliBackendForPrepareTest({ modelAliases: testCase.modelAliases });
    }
    fs.appendFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "compaction",
        summary: `${testCase.marker} ${"x".repeat(testCase.padding)}`,
      })}\n`,
      "utf-8",
    );

    const context = await fixture.prepare({
      provider: testCase.provider,
      model: testCase.model,
    });

    expect(context.openClawHistoryPrompt).toBeDefined();
    if (testCase.expectsTruncation) {
      expect(context.openClawHistoryPrompt).toContain("OpenClaw reseed history truncated");
    } else {
      expect(context.openClawHistoryPrompt).toContain(testCase.marker);
      expect(context.openClawHistoryPrompt).not.toContain("OpenClaw reseed history truncated");
    }
  });

  it("uses the automatic Claude CLI cap through the raw-tail reseed path", async () => {
    const { dir } = fixture.session;
    setRawCliBackendForPrepareTest({
      id: "claude-cli",
      pluginId: "anthropic",
      bundleMcp: false,
      config: {
        command: "claude",
        args: ["--print"],
        output: "jsonl",
        input: "stdin",
        sessionMode: "existing",
        reseedFromRawTranscriptWhenUncompacted: true,
      },
    });
    setCliRunnerPrepareTestDeps({
      claudeCliSessionTranscriptHasContent: vi.fn(async () => true),
    });
    const recentMarker = "RAW_RESEED_RECENT_MARKER_KEEP";
    const padding = "x".repeat(8_000);
    fixture.appendTranscript({
      id: "msg-1",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", content: `EARLIEST_USER ${padding}`, timestamp: 1 },
    });
    fixture.appendTranscript({
      id: "msg-2",
      parentId: "msg-1",
      timestamp: new Date(2).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${recentMarker} ${padding}` }],
        api: "responses",
        provider: "test-cli",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    });

    const context = await fixture.prepare({
      provider: "claude-cli",
      model: "claude-haiku-3-5",
      cliSessionBinding: { sessionId: "cli-session", cwdHash: hashCliSessionText(dir) },
    });

    expect(context.reusableCliSession).toEqual({ mode: "reuse", sessionId: "cli-session" });
    expect(context.openClawHistoryPrompt).toBeDefined();
    expect(context.openClawHistoryPrompt).toContain(recentMarker);
    expect(context.openClawHistoryPrompt).toContain("EARLIEST_USER");
    expect(context.openClawHistoryPrompt).not.toContain("OpenClaw reseed history truncated");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
