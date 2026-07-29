/**
 * Fast embedded-runner E2E mocks.
 *
 * Installs targeted Vitest module mocks for tests that do not need live plugin/runtime boot.
 */
import { vi } from "vitest";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

type EmbeddedRunnerFastRunMockOptions = {
  runEmbeddedAttempt: (params: unknown) => unknown;
  prepareProviderRuntimeAuth?: (params: {
    provider: string;
    context: { apiKey: string };
  }) => unknown;
};

type EmbeddedRunnerBackoffMockOptions = {
  computeBackoff: (
    policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
    attempt: number,
  ) => number;
  sleepWithAbort: (ms: number, abortSignal?: AbortSignal) => unknown;
};

/** Installs baseline mocks for hook runner, context engine, and runtime plugin loading. */
export function installEmbeddedRunnerBaseE2eMocks(options?: {
  hookRunner?: "minimal" | "full";
}): void {
  vi.doMock("../../plugins/hook-runner-global.js", () =>
    options?.hookRunner === "full"
      ? {
          getGlobalHookRunner: vi.fn(() => undefined),
          getGlobalPluginRegistry: vi.fn(() => null),
          hasGlobalHooks: vi.fn(() => false),
          initializeGlobalHookRunner: vi.fn(),
          resetGlobalHookRunner: vi.fn(),
        }
      : {
          getGlobalHookRunner: vi.fn(() => undefined),
          initializeGlobalHookRunner: vi.fn(),
        },
  );
  vi.doMock("../../context-engine/init.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
  }));
  vi.doMock("../../context-engine/registry.js", () => ({
    resolveContextEngine: vi.fn(async () => ({
      dispose: async () => undefined,
    })),
    resolveContextEngineOwnerPluginId: vi.fn(() => undefined),
  }));
  vi.doMock("../runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded: vi.fn(),
  }));
  vi.doMock("../harness/runtime-plugin.js", () => ({
    ensureSelectedAgentHarnessPlugin: vi.fn(async () => {}),
  }));
}

/** Installs mocks that route embedded attempts through a caller-provided fast run function. */
export function installEmbeddedRunnerFastRunE2eMocks(
  options: EmbeddedRunnerFastRunMockOptions,
): void {
  const createMockAgentHarness = (params: {
    provider?: string;
    agentHarnessId?: string;
    agentHarnessRuntimeOverride?: string;
  }) => ({
    id: resolveMockHarnessId(params),
    label: "Mock agent harness",
    supports: vi.fn(() => ({ supported: false })),
    runAttempt: vi.fn(),
  });
  vi.doMock("../harness/selection.js", () => ({
    agentHarnessBuildsOpenClawTools: vi.fn(
      (harnessId: string) => harnessId === "codex" || harnessId === "copilot",
    ),
    selectAgentHarness: vi.fn(createMockAgentHarness),
    selectAgentHarnessForPreparedModelProviders: vi.fn(createMockAgentHarness),
    resolveAgentHarnessPolicy: vi.fn(() => ({ runtime: "openclaw" })),
    runAgentHarnessAttempt: (params: unknown) => options.runEmbeddedAttempt(params),
  }));
  vi.doMock("../runtime-plan/build.js", () => ({
    buildAgentRuntimePlan: vi.fn(
      (params: {
        provider: string;
        modelId: string;
        modelApi?: string | null;
        harnessId?: string;
        sessionAuthProfileId?: string;
      }) => ({
        resolvedRef: {
          provider: params.provider,
          modelId: params.modelId,
          ...(params.modelApi ? { modelApi: params.modelApi } : {}),
          ...(params.harnessId ? { harnessId: params.harnessId } : {}),
        },
        auth: {
          providerForAuth: params.provider,
          authProfileProviderForAuth: params.sessionAuthProfileId?.split(":", 1)[0] ?? "",
          forwardedAuthProfileId: params.sessionAuthProfileId,
        },
        prompt: {
          provider: params.provider,
          modelId: params.modelId,
          resolveSystemPromptContribution: vi.fn(() => undefined),
          transformSystemPrompt: vi.fn((context) => context.systemPrompt),
        },
        tools: {
          normalize: vi.fn((tools: unknown[]) => tools),
          logDiagnostics: vi.fn(),
        },
        transcript: {
          policy: {
            sanitizeMode: "full",
            sanitizeToolCallIds: true,
            preserveNativeAnthropicToolUseIds: false,
            repairToolUseResultPairing: true,
            preserveSignatures: false,
            dropThinkingBlocks: false,
            applyGoogleTurnOrdering: false,
            validateGeminiTurns: false,
            validateAnthropicTurns: false,
            allowSyntheticToolResults: true,
          },
          resolvePolicy: vi.fn(() => undefined),
        },
        delivery: {
          isSilentPayload: vi.fn(() => false),
          resolveFollowupRoute: vi.fn(() => undefined),
        },
        outcome: {
          classifyRunResult: vi.fn(() => undefined),
        },
        transport: {
          extraParams: {},
          resolveExtraParams: vi.fn(() => ({})),
        },
        observability: {
          resolvedRef: `${params.provider}/${params.modelId}`,
          provider: params.provider,
          modelId: params.modelId,
          ...(params.modelApi ? { modelApi: params.modelApi } : {}),
          ...(params.harnessId ? { harnessId: params.harnessId } : {}),
          ...(params.sessionAuthProfileId ? { authProfileId: params.sessionAuthProfileId } : {}),
        },
      }),
    ),
  }));
  vi.doMock("../runtime-plan/prepare-auth.js", async () => {
    const actual = await vi.importActual<typeof import("../runtime-plan/prepare-auth.js")>(
      "../runtime-plan/prepare-auth.js",
    );
    return {
      ...actual,
      prepareAgentRuntimeAuth: vi.fn(
        (params: {
          provider: string;
          modelId: string;
          config?: Parameters<typeof resolveAuthProfileOrder>[0]["cfg"];
          authProfileStore?: AuthProfileStore;
          sessionAuthProfileId?: string;
          sessionAuthProfileSource?: "auto" | "user";
          harnessId?: string;
          harnessRuntime?: string;
        }) => {
          const store: AuthProfileStore = params.authProfileStore ?? { version: 1, profiles: {} };
          const authProvider =
            params.harnessId === "codex" || params.harnessRuntime === "codex"
              ? "openai"
              : params.provider;
          const requestedProfileId = params.sessionAuthProfileId?.trim() || undefined;
          const requestedCredential = requestedProfileId
            ? store.profiles[requestedProfileId]
            : undefined;
          const matchingRequestedProfileId =
            requestedCredential?.provider === authProvider ? requestedProfileId : undefined;
          const lockedProfileId =
            params.sessionAuthProfileSource === "user" ? matchingRequestedProfileId : undefined;
          const orderedProfileIds = lockedProfileId
            ? [lockedProfileId]
            : resolveAuthProfileOrder({
                cfg: params.config,
                store,
                provider: authProvider,
                preferredProfile: matchingRequestedProfileId,
                forModel: params.modelId,
              });
          const profileIds = orderedProfileIds.length > 0 ? orderedProfileIds : [undefined];
          const attempts = profileIds.map((profileId, index) => {
            const credential = profileId ? store.profiles[profileId] : undefined;
            const canForwardProfile = credential?.provider === authProvider;
            const plan = {
              providerForAuth: params.provider,
              modelId: params.modelId,
              authProfileProviderForAuth: credential?.provider ?? params.provider,
              ...(canForwardProfile && profileId
                ? {
                    forwardedAuthProfileId: profileId,
                    forwardedAuthProfileSource:
                      lockedProfileId === profileId ? ("user" as const) : ("auto" as const),
                    forwardedAuthProfileCandidateIds: profileIds
                      .slice(index)
                      .filter((candidate): candidate is string => Boolean(candidate)),
                    ...(credential?.type ? { selectedAuthMode: credential.type } : {}),
                  }
                : {}),
            };
            return profileId
              ? { kind: "profile" as const, profileId, plan }
              : { kind: "implicit" as const, plan };
          });
          const firstAttempt = attempts[0];
          if (!firstAttempt) {
            throw new Error("fast embedded runner auth mock produced no attempts");
          }
          return { plan: firstAttempt.plan, attempts };
        },
      ),
    };
  });
  vi.doMock("../runtime-plan/materialize-model.js", () => ({
    materializePreparedRuntimeModel: vi.fn(
      async <Model>(params: { model?: Model }): Promise<Model | undefined> => params.model,
    ),
  }));
  vi.doMock("../embedded-agent-runner/run/attempt.js", () => ({
    runEmbeddedAttempt: (params: unknown) => options.runEmbeddedAttempt(params),
  }));
  vi.doMock("../../plugins/provider-runtime.js", () => ({
    applyProviderResolvedTransportWithPlugin: vi.fn(() => undefined),
    augmentModelCatalogWithProviderPlugins: vi.fn(async () => []),
    buildProviderMissingAuthMessageWithPlugin: vi.fn(() => undefined),
    buildProviderUnknownModelHintWithPlugin: vi.fn(() => undefined),
    normalizeProviderResolvedModelWithPlugin: vi.fn(() => undefined),
    normalizeProviderTransportWithPlugin: vi.fn(() => undefined),
    prepareProviderDynamicModel: vi.fn(async () => undefined),
    prepareProviderRuntimeAuth: options.prepareProviderRuntimeAuth ?? vi.fn(async () => undefined),
    resolveProviderAuthProfileId: vi.fn(() => undefined),
    resolveProviderCapabilitiesWithPlugin: vi.fn(() => undefined),
    resolveExternalAuthProfilesWithPlugins: vi.fn(() => []),
    resolveProviderSyntheticAuthWithPlugin: vi.fn(() => undefined),
    runProviderDynamicModel: vi.fn(() => undefined),
    shouldPreferProviderRuntimeResolvedModel: vi.fn(() => false),
    shouldDeferProviderSyntheticProfileAuthWithPlugin: vi.fn(() => false),
  }));
}

function resolveMockHarnessId(params: {
  provider?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
}): "codex" | "openclaw" {
  return params.provider === "codex-cli" ||
    params.agentHarnessId === "codex" ||
    params.agentHarnessRuntimeOverride === "codex"
    ? "codex"
    : "openclaw";
}

/** Installs deterministic backoff mocks for retry/timeout E2E tests. */
export function installEmbeddedRunnerBackoffE2eMocks(
  options: EmbeddedRunnerBackoffMockOptions,
): void {
  vi.doMock("../../infra/backoff.js", () => ({
    computeBackoff: (
      policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      attempt: number,
    ) => options.computeBackoff(policy, attempt),
    sleepWithAbort: (ms: number, abortSignal?: AbortSignal) =>
      options.sleepWithAbort(ms, abortSignal),
  }));
}
