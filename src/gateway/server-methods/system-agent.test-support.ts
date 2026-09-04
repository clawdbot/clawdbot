import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  getRuntimeConfigAppliedHash,
  setRuntimeConfigAppliedHash,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import type {
  SystemAgentVerifiedInferenceBinding,
  SystemAgentVerifiedInferenceDeps,
} from "../../system-agent/verified-inference.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import {
  greetingMocks,
  inferenceFallbackMocks,
  onboardingWelcomeMocks,
  setupInferenceMocks,
  transcriptStoreMocks,
} from "./system-agent.mocks.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export {
  inferenceFallbackMocks,
  setupInferenceDetectionMocks,
  setupInferenceMocks,
  transcriptStoreMocks,
} from "./system-agent.mocks.test-support.js";

export type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

export function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

export function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

export function systemAgentHandler(method: keyof typeof systemAgentHandlers) {
  return expectDefined(systemAgentHandlers[method], `systemAgentHandlers["${method}"] invariant`);
}

export function systemAgentLane() {
  return getCommandLaneSnapshot(CommandLane.SystemAgent);
}

export const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

export const verifiedConfig: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
  auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
};
export function useSystemAgentGatewayTestFixture() {
  let verifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
  let verifiedInferenceDeps: SystemAgentVerifiedInferenceDeps | undefined;
  let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;
  const systemAgentTempDirs = useAutoCleanupTempDirTracker(afterEach);
  let previousAppliedHash: string | null = null;

  function requireVerifiedInferenceFixture(): SystemAgentVerifiedInferenceBinding {
    return expectDefined(verifiedInference, "verified inference fixture was not initialized");
  }

  function requireVerifiedInferenceDeps(): SystemAgentVerifiedInferenceDeps {
    return {
      ...expectDefined(
        verifiedInferenceDeps,
        "verified inference dependencies were not initialized",
      ),
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
    previousAppliedHash = getRuntimeConfigAppliedHash();
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
    resetAgentRunRegistryForTest();
    setRuntimeConfigAppliedHash(previousAppliedHash);
    vi.restoreAllMocks();
    vi.resetAllMocks();
    resetPluginStateStoreForTests();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();
    pluginMetadataSnapshot?.rebindForCurrentEnv();
  });

  return {
    systemAgentTempDirs,
    requireVerifiedInferenceFixture,
    requireVerifiedInferenceDeps,
    makeVerifiedEngine,
    seededSession,
  };
}

export async function callChat(
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
