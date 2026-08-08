// OpenClaw gateway tests cover activation serialization and chat sessions.

import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSafeGatewayRestartPreflight } from "../../infra/restart-coordinator.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { getActiveGatewayRootWorkCount } from "../../process/gateway-work-admission.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  readLastSystemAgentAuditEntry,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import type {
  SystemAgentVerifiedInferenceBinding,
  SystemAgentVerifiedInferenceDeps,
} from "../../system-agent/verified-inference.js";
import { createDeferred } from "../../test-utils/deferred.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  systemAgentHandlers,
  runExclusiveSystemAgentSetupActivation,
  type SystemAgentChatSession,
} from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({
  activateSetupInference: vi.fn(),
  resolvePersistentApplyInference: vi.fn(),
  verifySetupInference: vi.fn(),
}));
const inferenceFallbackMocks = vi.hoisted(() => ({ verify: vi.fn() }));
const setupInferenceDetectionMocks = vi.hoisted(() => ({
  detectSetupInferenceIsolated: vi.fn(),
}));
const providerAuthChoiceMocks = vi.hoisted(() => ({
  applyAuthChoiceLoadedPluginProvider: vi.fn(),
}));
const setupSharedMocks = vi.hoisted(() => ({
  readSetupConfigFileSnapshot: vi.fn(),
  writeWizardConfigFile: vi.fn(),
}));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn<
    (limit: number) => Array<{ role: "user" | "assistant"; text: string; at: number }>
  >(() => []),
}));
const greetingMocks = vi.hoisted(() => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  loadSystemAgentGreetingFacts: vi.fn(),
  resolveSystemAgentGreeting: vi.fn(),
}));
const onboardingWelcomeMocks = vi.hoisted(() => ({
  buildOnboardingWelcome: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
  resolvePersistentApplyInference: setupInferenceMocks.resolvePersistentApplyInference,
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback: inferenceFallbackMocks.verify,
}));
vi.mock("../../system-agent/setup-inference-detection.js", () => ({
  detectSetupInferenceIsolated: setupInferenceDetectionMocks.detectSetupInferenceIsolated,
}));
vi.mock("../../plugins/provider-auth-choice.js", () => ({
  applyAuthChoiceLoadedPluginProvider: providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider,
}));
vi.mock("../../wizard/setup.shared.js", () => ({
  readSetupConfigFileSnapshot: setupSharedMocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: setupSharedMocks.writeWizardConfigFile,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptReset: transcriptStoreMocks.appendTranscriptReset,
  appendTranscriptTurn: transcriptStoreMocks.appendTranscriptTurn,
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));
vi.mock("../../system-agent/greeting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../system-agent/greeting.js")>();
  return {
    ...actual,
    acknowledgeSystemAgentGreetingDelivery: greetingMocks.acknowledgeSystemAgentGreetingDelivery,
    loadSystemAgentGreetingFacts: greetingMocks.loadSystemAgentGreetingFacts,
    resolveSystemAgentGreeting: greetingMocks.resolveSystemAgentGreeting,
  };
});
vi.mock("../../system-agent/onboarding-welcome.js", () => ({
  buildOnboardingWelcome: onboardingWelcomeMocks.buildOnboardingWelcome,
}));

type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

function makeWizardContext() {
  const wizardSessions = new Map();
  return {
    wizardSessions,
    context: {
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext,
  };
}

function systemAgentHandler(method: keyof typeof systemAgentHandlers) {
  return expectDefined(systemAgentHandlers[method], `systemAgentHandlers["${method}"] invariant`);
}

function systemAgentLane() {
  return getCommandLaneSnapshot(CommandLane.SystemAgent);
}

const waitOneTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

const verifiedConfig: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
  auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
};
let verifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let verifiedInferenceDeps: SystemAgentVerifiedInferenceDeps | undefined;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;
const systemAgentTempDirs = useAutoCleanupTempDirTracker(afterEach);

function requireVerifiedInferenceFixture(): SystemAgentVerifiedInferenceBinding {
  return expectDefined(verifiedInference, "verified inference fixture was not initialized");
}

function requireVerifiedInferenceDeps(): SystemAgentVerifiedInferenceDeps {
  return {
    ...expectDefined(verifiedInferenceDeps, "verified inference dependencies were not initialized"),
    readConfigFileSnapshot: async () =>
      ({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: "verified-config",
        config: verifiedConfig,
        runtimeConfig: verifiedConfig,
        sourceConfig: verifiedConfig,
        issues: [],
      }) as never,
  };
}

function makeVerifiedEngine(): SystemAgentChatEngine {
  return new SystemAgentChatEngine({
    verifiedInference: requireVerifiedInferenceFixture(),
    deps: requireVerifiedInferenceDeps(),
  });
}

function stubEngineOverview() {
  return vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockResolvedValue({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { available: false },
      claude: { available: false },
      gemini: { available: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  } as never);
}

function seededSession(overrides?: Partial<SystemAgentChatSession>): SystemAgentChatSession {
  return {
    engine: makeVerifiedEngine(),
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: "device:device-test",
    ...overrides,
  };
}

beforeAll(async () => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot(verifiedConfig);
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
  verifiedInference = fixture.binding;
  verifiedInferenceDeps = fixture.deps;
});

afterAll(() => {
  pluginMetadataSnapshot?.restore();
  verifiedInference = undefined;
  verifiedInferenceDeps = undefined;
});

beforeEach(() => {
  setupInferenceMocks.verifySetupInference.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: verifiedInference,
  });
  inferenceFallbackMocks.verify.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: verifiedInference,
  });
  setupInferenceMocks.resolvePersistentApplyInference.mockResolvedValue(
    requireVerifiedInferenceFixture().configuredRoute,
  );
  setupSharedMocks.readSetupConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "prepare-base-hash",
    sourceConfig: verifiedConfig,
    config: verifiedConfig,
    issues: [],
  });
  setupSharedMocks.writeWizardConfigFile.mockImplementation(async (config) => config);
  transcriptStoreMocks.appendTranscriptTurn.mockReset();
  transcriptStoreMocks.appendTranscriptReset.mockReset();
  transcriptStoreMocks.readTranscriptTail.mockReset().mockReturnValue([]);
  greetingMocks.acknowledgeSystemAgentGreetingDelivery.mockReset();
  greetingMocks.loadSystemAgentGreetingFacts.mockReset().mockReturnValue({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  });
  greetingMocks.resolveSystemAgentGreeting.mockReset().mockResolvedValue({
    text: "I'm OpenClaw. All systems nominal.",
    source: "model",
  });
  onboardingWelcomeMocks.buildOnboardingWelcome.mockReset().mockResolvedValue({
    text: "Inference is ready. Let's finish setup.",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  resetPluginStateStoreForTests();
  resetCommandQueueStateForTest();
  vi.unstubAllEnvs();
  pluginMetadataSnapshot?.rebindForCurrentEnv();
});

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = defaultClient,
): Promise<RespondCall> {
  const { calls, respond } = makeRespond();
  await systemAgentHandler("openclaw.chat")({
    params,
    respond,
    context,
    client,
  } as never);
  const call = calls[0];
  if (!call) {
    throw new Error("expected a respond call");
  }
  return call;
}

describe("openclaw.setup", () => {
  it("rejects a concurrent activation instead of queueing stale work", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];

    const first = runExclusiveSystemAgentSetupActivation(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstStarted.promise;

    const secondTask = vi.fn(async () => events.push("second:start", "second:end"));
    expect(events).toEqual(["first:start"]);
    await expect(runExclusiveSystemAgentSetupActivation(secondTask)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    expect(events).toEqual(["first:start", "first:end"]);

    await runExclusiveSystemAgentSetupActivation(async () => events.push("third:start"));
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("returns a retryable busy error while another activation is running", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    try {
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.setup.activate")({
        params: { kind: "claude-cli" },
        respond,
      } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "OpenClaw setup is already in progress; try again when it finishes.",
            retryable: true,
          },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      await first;
    }
  });

  it("releases the activation slot when the owning task fails", async () => {
    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    const nextTask = vi.fn(async () => "ok");
    await expect(runExclusiveSystemAgentSetupActivation(nextTask)).resolves.toBe("ok");
    expect(nextTask).toHaveBeenCalledOnce();
  });
  it("starts provider auth as an interactive wizard session", async () => {
    const { wizardSessions, context } = makeWizardContext();
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
      await params.prompter.note("Open the browser and enter ABCD", "Pair GitHub");
      return { ok: true, modelRef: "github-copilot/test", latencyMs: 10, lines: ["ready"] };
    });
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.auth.start")({
      params: { sessionId: "auth-session-1", authChoice: "github-copilot" },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { sessionId: "auth-session-1", done: false, status: "running" },
    });
    const session = wizardSessions.get("auth-session-1");
    const first = await session.next();
    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "provider-auth", authChoice: "github-copilot" }),
    );
    expect(setupInferenceMocks.activateSetupInference.mock.calls[0]?.[0].signal).toBe(
      session.signal,
    );
    expect(first).toMatchObject({
      done: false,
      status: "running",
      step: { type: "note", title: "Pair GitHub", message: "Open the browser and enter ABCD" },
    });
    await session.answer(first.step.id, null);
    await expect(session.next()).resolves.toMatchObject({ done: true, status: "done" });
  });
  it("runs the selected provider method in a shared wizard session and commits its config", async () => {
    const preparedConfig: OpenClawConfig = {
      ...verifiedConfig,
      models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
    };
    providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider.mockImplementationOnce(
      async (params) => {
        await params.prompter.note("Model ready", "Ollama");
        await params.beforePersistentEffect();
        return { config: preparedConfig, agentModelOverride: "ollama/qwen3:0.6b" };
      },
    );
    const { wizardSessions, context } = makeWizardContext();
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.prepare.start")({
      params: {
        sessionId: "prepare-session-1",
        authChoice: "ollama",
        workspace: "/tmp/models-workspace",
      },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { sessionId: "prepare-session-1", done: false, status: "running" },
    });
    const session = wizardSessions.get("prepare-session-1");
    const note = await session.next();
    expect(note).toMatchObject({
      done: false,
      step: { type: "note", title: "Ollama", message: "Model ready" },
    });
    expect(providerAuthChoiceMocks.applyAuthChoiceLoadedPluginProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        authChoice: "ollama",
        config: verifiedConfig,
        workspaceDir: "/tmp/models-workspace",
        setDefaultModel: false,
        preserveExistingDefaultModel: true,
        signal: session.signal,
        isRemote: true,
      }),
    );
    await session.answer(note.step.id, null);
    await expect(session.next()).resolves.toMatchObject({
      done: true,
      status: "done",
      preparedModelRef: "ollama/qwen3:0.6b",
    });
    expect(setupSharedMocks.writeWizardConfigFile).toHaveBeenCalledWith(preparedConfig, {
      allowConfigSizeDrop: false,
      baseSnapshot: expect.objectContaining({ hash: "prepare-base-hash" }),
      baseHash: "prepare-base-hash",
      migrationBaseConfig: verifiedConfig,
    });
  });
});

describe("openclaw.chat", () => {
  it("refuses to create a session before inference is available", async () => {
    inferenceFallbackMocks.verify.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, SystemAgentChatSession>();

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "OpenClaw requires working inference: no configured model",
        details: {
          code: "system_agent_inference_unavailable",
        },
      },
    });
    expect(sessions.size).toBe(0);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
  });

  it("coalesces concurrent initialization for the same session", async () => {
    stubEngineOverview();
    const started = createDeferred();
    const release = createDeferred();
    inferenceFallbackMocks.verify.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);

    const first = callChat(context, { sessionId: "shared" });
    await started.promise;
    const second = callChat(context, { sessionId: "shared" });
    await waitOneTask();
    release.resolve();
    const [firstCall, secondCall] = await Promise.all([first, second]);

    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(1);
    expect([firstCall.ok, secondCall.ok]).toEqual([true, true]);
  });

  it("keeps read-only setup detection outside the serialized system-agent lane", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceDetectionMocks.detectSetupInferenceIsolated.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        candidates: [],
        unavailableCandidates: [],
        manualProviders: [],
        authOptions: [],
        prepareOptions: [],
        recommendedInstalls: [],
        workspace: "/tmp/work",
        setupComplete: false,
      };
    });
    const activeAtResponse: number[] = [];

    const pending = systemAgentHandler("openclaw.setup.detect")({
      params: {},
      respond: () => {
        activeAtResponse.push(systemAgentLane().activeCount);
      },
    } as never);

    await started.promise;
    expect(systemAgentLane().activeCount).toBe(0);
    release.resolve();
    await pending;

    expect(activeAtResponse).toEqual([0]);
    expect(systemAgentLane().activeCount).toBe(0);
  });

  it.each([
    {
      name: "working",
      result: { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 25 },
    },
    {
      name: "unavailable",
      result: {
        ok: false as const,
        status: "unavailable" as const,
        error: "no configured model",
      },
    },
  ])("returns the structured $name inference verification result", async ({ result }) => {
    setupInferenceMocks.verifySetupInference.mockResolvedValueOnce(result);
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.verify")({ params: {}, respond } as never);

    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
    expect(calls).toEqual([{ ok: true, payload: result, error: undefined }]);
  });

  it("rejects unknown setup verification params without running inference", async () => {
    const { calls, respond } = makeRespond();

    await systemAgentHandler("openclaw.setup.verify")({
      params: { modelRef: "openai/gpt-5.5" },
      respond,
    } as never);

    expect(setupInferenceMocks.verifySetupInference).not.toHaveBeenCalled();
    expect(calls[0]?.ok).toBe(false);
  });

  it("forwards setup activation on the gateway lane until its response is sent", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const activationResult = {
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
      lines: ["Default model: openai/gpt-5.5"],
    };
    setupInferenceMocks.activateSetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return activationResult;
    });
    const { calls, respond } = makeRespond();
    const activeAtResponse: number[] = [];

    const pending = systemAgentHandler("openclaw.setup.activate")({
      params: {
        kind: "api-key",
        modelRef: "openai/gpt-5.5",
        authChoice: "openai-api-key",
        apiKey: "test-key",
        workspace: "/tmp/work",
      },
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        activeAtResponse.push(systemAgentLane().activeCount);
        respond(ok, payload, error);
      },
    } as never);

    await started.promise;
    expect(systemAgentLane().activeCount).toBe(1);
    release.resolve();
    await pending;

    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith({
      kind: "api-key",
      modelRef: "openai/gpt-5.5",
      authChoice: "openai-api-key",
      apiKey: "test-key",
      workspace: "/tmp/work",
      surface: "gateway",
      runtime: expect.objectContaining({ exit: expect.any(Function) }),
    });
    expect(calls).toEqual([{ ok: true, payload: activationResult, error: undefined }]);
    expect(activeAtResponse).toEqual([1]);
    expect(systemAgentLane().activeCount).toBe(0);
  });

  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("trims, canonicalizes, and forwards valid UI context for a user turn", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Everything is healthy.", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "What about this page?",
      context: { page: "  /settings/channels  ", source: "client" },
    });

    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("What about this page?", {
      uiContext: { page: "/settings/channels" },
    });
  });

  it.each([
    { name: "unsafe characters", page: "channels?tab=all" },
    { name: "an overlong id", page: "a".repeat(65) },
    { name: "a Unicode case-folding character", page: "\u212A" },
  ])("drops UI context with $name without rejecting the turn", async ({ page }) => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Everything is healthy.", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "Status please.",
      context: { page },
    });

    expect(call.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("Status please.");
  });

  it("does not pass UI context to welcome-only turns", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      context: { page: "custodian" },
    });

    expect(call.ok).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it("persists completed turns from the engine's sanitized history", async () => {
    const engine = new SystemAgentChatEngine({
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
      runAgentTurn: async () => ({ text: "Everything is healthy." }),
      planWithAssistant: async () => null,
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "How is this machine doing?",
      context: { page: "dashboard" },
    });

    expect(call.payload).toMatchObject({ reply: "Everything is healthy." });
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledTimes(2);
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ role: "user", text: "How is this machine doing?" }),
    );
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ role: "assistant", text: "Everything is healthy." }),
    );
    expect(JSON.stringify(transcriptStoreMocks.appendTranscriptTurn.mock.calls)).not.toContain(
      "ui-context",
    );
  });

  it("seeds a new engine with the persisted tail before recording its welcome", async () => {
    stubEngineOverview();
    transcriptStoreMocks.readTranscriptTail.mockReturnValue([
      { role: "user", text: "Earlier question", at: 1 },
      { role: "assistant", text: "Earlier answer", at: 2 },
    ]);
    const seedHistory = vi.spyOn(SystemAgentChatEngine.prototype, "seedHistory");

    const call = await callChat(makeContext(new Map()), { sessionId: "fresh" });

    expect(call.ok).toBe(true);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenCalledWith(30, {
      afterLastReset: true,
    });
    expect(seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "Earlier question" },
      { role: "assistant", text: "Earlier answer" },
    ]);
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", text: expect.any(String) }),
    );
  });

  it("persists only the mask marker for a sensitive hosted-wizard answer", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: requireVerifiedInferenceDeps(),
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const prompt = await callChat(context, { sessionId: "s1", message: "connect telegram" });
    expect(prompt.payload).toMatchObject({ sensitive: true, wizardInputPending: true });
    transcriptStoreMocks.appendTranscriptTurn.mockClear();

    await callChat(context, { sessionId: "s1", message: "raw-secret-value" });

    const persisted = transcriptStoreMocks.appendTranscriptTurn.mock.calls.map(([turn]) => turn);
    expect(persisted).toContainEqual(
      expect.objectContaining({ role: "user", text: "<redacted secret>" }),
    );
    expect(JSON.stringify(persisted)).not.toContain("raw-secret-value");
  });

  it("returns history oldest-first with default and explicit bounded limits", async () => {
    const turns = [
      { role: "user" as const, text: "one", at: 1 },
      { role: "assistant" as const, text: "two", at: 2 },
    ];
    transcriptStoreMocks.readTranscriptTail.mockImplementation((limit: number) =>
      turns.slice(-limit),
    );
    const invoke = async (params: Record<string, unknown>) => {
      const { calls, respond } = makeRespond();
      await systemAgentHandler("openclaw.chat.history")({ params, respond } as never);
      return calls[0];
    };

    expect(await invoke({})).toEqual({ ok: true, payload: { turns }, error: undefined });
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(100);
    expect(await invoke({ limit: 1 })).toEqual({
      ok: true,
      payload: { turns: [turns[1]] },
      error: undefined,
    });
    expect((await invoke({ limit: 501 }))?.ok).toBe(false);
  });

  it("tracks approved delegated Gateway restarts until their completion drains", async () => {
    const approvalStarted = createDeferred();
    const releaseApproval = createDeferred();
    const stateDir = systemAgentTempDirs.make("openclaw-approved-gateway-restart-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));
    const runGatewayRestart = vi.fn(async () => {
      approvalStarted.resolve();
      await releaseApproval.promise;
      return true;
    });
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      surface: "gateway",
      verifiedInference: requireVerifiedInferenceFixture(),
      deps: { ...requireVerifiedInferenceDeps(), runGatewayRestart },
    });
    engine.propose({ kind: "gateway-restart" });
    const proposalHash = expectDefined(
      engine.getPendingOperatorProposal(),
      "restart proposal",
    ).hash;
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "Approval pending.", action: "none" });
    const resolveOperatorApproval = vi.spyOn(engine, "resolveOperatorApproval");
    const delegatedSession = seededSession({
      engine,
      ownerKey: JSON.stringify(["main", "agent:main:main"]),
    });
    const sessions = new Map<string, SystemAgentChatSession>([["delegate-1", delegatedSession]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
    });
    const broadcast = vi.fn();
    const context = {
      ...makeContext(sessions),
      systemAgentApprovalManager: manager,
      broadcast,
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;

    const requestResponses = makeRespond();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "delegated-gateway-restart",
        method: "openclaw.chat",
        params: {
          sessionId: "delegate-1",
          message: "Restart Gateway.",
          context: { page: "channels" },
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
        },
      },
      respond: requestResponses.respond,
      client: {
        ...defaultClient,
        connect: { ...defaultClient.connect, role: "operator", scopes: ["operator.admin"] },
      } as GatewayClient,
      isWebchatConnect: () => false,
      context,
      extraHandlers: { "openclaw.chat": systemAgentHandlers["openclaw.chat"]! },
    });
    const first = expectDefined(requestResponses.calls[0], "delegated Gateway response invariant");
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    const proposalId = (first.payload as { proposalId?: string }).proposalId;

    expect(first.payload).toMatchObject({
      reply: "Approval pending.",
      needsApproval: true,
      proposalId: expect.stringMatching(/^system-agent:/),
    });
    expect(proposalId).toBeTruthy();
    expect(manager.getSnapshot(proposalId!)).toMatchObject({
      request: { proposalHash, agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(manager.getSnapshot(proposalId!)?.decision).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith(
      "openclaw.approval.requested",
      expect.objectContaining({ id: proposalId }),
      { dropIfSlow: true },
    );
    expect(resolveOperatorApproval).not.toHaveBeenCalled();
    expect(handle).toHaveBeenNthCalledWith(1, "Restart Gateway.");

    await callChat(context, {
      sessionId: "delegate-1",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(resolveOperatorApproval).not.toHaveBeenCalled();

    manager.resolve(proposalId!, "allow-once", "operator-ui");
    await approvalStarted.promise;
    try {
      expect(systemAgentLane()).toMatchObject({ activeCount: 1, queuedCount: 0 });
      const restartPreflight = createSafeGatewayRestartPreflight();
      expect(restartPreflight.safe).toBe(false);
      expect(restartPreflight.counts.queueSize).toBe(1);
      expect(restartPreflight.blockers).toContainEqual(
        expect.objectContaining({ kind: "queue", count: 1 }),
      );
    } finally {
      releaseApproval.resolve();
    }
    await vi.waitFor(() => {
      expect(resolveOperatorApproval).toHaveBeenCalledWith("allow-once", proposalHash);
      expect(runGatewayRestart).toHaveBeenCalledOnce();
      expect(systemAgentLane().activeCount).toBe(0);
    });
    await expect(resolveOperatorApproval.mock.results[0]?.value).resolves.toMatchObject({
      text: expect.stringContaining("[openclaw] done: gateway.restart"),
    });
    expect(readLastSystemAgentAuditEntry()).toMatchObject({
      operation: "gateway.restart",
      summary: "Scheduled Gateway restart",
    });
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(createSafeGatewayRestartPreflight().counts.queueSize).toBe(0);
  });

  it("reuses a live session, then requires fresh fallback verification after failure", async () => {
    stubEngineOverview();
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(
      new SystemAgentInferenceUnavailableError("conversation"),
    );
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const failed = await callChat(context, { sessionId: "s1", message: "status please" });

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("working inference"),
        details: { code: "system_agent_session_invalidated" },
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(false);
    expect(inferenceFallbackMocks.verify).not.toHaveBeenCalled();

    const retried = await callChat(context, { sessionId: "s1" });

    expect(retried.ok).toBe(true);
    expect(inferenceFallbackMocks.verify).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(true);
  });

  it("does not relabel unrelated session failures as inference errors", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(new Error("wizard bug"));
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    await expect(
      callChat(makeContext(sessions), { sessionId: "s1", message: "status please" }),
    ).rejects.toThrow("wizard bug");
    expect(sessions.has("s1")).toBe(true);
  });

  it("tracks every accepted request as active while serializing expensive execution", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const firstEngine = makeVerifiedEngine();
    vi.spyOn(firstEngine, "handle").mockImplementation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { text: "first setup complete", action: "none" };
    });
    const secondEngine = makeVerifiedEngine();
    const secondHandle = vi.spyOn(secondEngine, "handle").mockImplementation(async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
      return { text: "second setup complete", action: "none" };
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["s1", seededSession({ engine: firstEngine })],
      ["s2", seededSession({ engine: secondEngine })],
    ]);
    const activeAtResponse: number[] = [];

    const trackChat = (sessionId: string) =>
      systemAgentHandler("openclaw.chat")({
        params: { sessionId, message: "yes" },
        client: defaultClient,
        context: makeContext(sessions),
        respond: () => activeAtResponse.push(systemAgentLane().activeCount),
      } as never);
    const first = trackChat("s1");
    const second = trackChat("s2");

    await firstStarted.promise;
    await waitOneTask();
    expect(systemAgentLane()).toMatchObject({ activeCount: 2, queuedCount: 0 });
    expect(secondHandle).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await secondStarted.promise;
    expect(systemAgentLane().activeCount).toBe(1);
    releaseSecond.resolve();
    await second;

    expect(activeAtResponse).toEqual([2, 1]);
    expect(systemAgentLane().activeCount).toBe(0);
  });

  it("keeps the session map bounded during concurrent unique initialization", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose").mockImplementation(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();

    const context = makeContext(sessions);
    const first = callChat(context, { sessionId: "new-1" });
    const second = callChat(context, { sessionId: "new-2" });
    await evictionStarted.promise;
    await waitOneTask();
    releaseEviction.resolve();
    await Promise.all([first, second]);

    expect(disposeOldest).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect([sessions.has("new-1"), sessions.has("new-2")]).toEqual([true, true]);
  });

  it("resets a session on request", async () => {
    stubEngineOverview();
    transcriptStoreMocks.readTranscriptTail.mockReturnValue([]);
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const seedHistory = vi.spyOn(SystemAgentChatEngine.prototype, "seedHistory");
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    // Reset drops the stored session; loading a fresh welcome would hit real
    // discovery, so stub the overview loader on the replacement engine path by
    // asserting the old engine is gone instead.
    const { calls, respond } = makeRespond();
    const context = makeContext(sessions);
    const pending = systemAgentHandler("openclaw.chat")({
      params: { sessionId: "s1", reset: true },
      client: defaultClient,
      respond,
      context,
    } as never);
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(calls[0]?.ok).toBe(true);
    expect(seedHistory).not.toHaveBeenCalled();
    expect(transcriptStoreMocks.appendTranscriptReset).toHaveBeenCalledOnce();

    transcriptStoreMocks.readTranscriptTail.mockReturnValue([
      { role: "user", text: "After reset", at: 3 },
      { role: "assistant", text: "Fresh answer", at: 4 },
    ]);
    const fresh = await callChat(context, { sessionId: "fresh-after-reset" });
    expect(fresh.ok).toBe(true);
    expect(seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "After reset" },
      { role: "assistant", text: "Fresh answer" },
    ]);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(30, {
      afterLastReset: true,
    });
  });
});
