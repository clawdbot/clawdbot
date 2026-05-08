import { vi } from "vitest";

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

export function installEmbeddedRunnerFastRunE2eMocks(
  options: EmbeddedRunnerFastRunMockOptions,
): void {
  vi.doMock("../harness/selection.js", () => ({
    selectAgentHarness: vi.fn((params: { provider?: string }) => ({
      id: params.provider === "codex-cli" ? "codex" : "pi",
      label: "Mock agent harness",
      supports: vi.fn(() => ({ supported: false })),
      runAttempt: vi.fn(),
    })),
    resolveAgentHarnessPolicy: vi.fn(() => ({ runtime: "pi" })),
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
            sanitizeThinkingSignatures: true,
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
  vi.doMock("../pi-embedded-runner/run/attempt.js", () => ({
    runEmbeddedAttempt: (params: unknown) => options.runEmbeddedAttempt(params),
  }));
  vi.doMock("../../plugins/provider-runtime.js", () => ({
    applyProviderResolvedModelCompatWithPlugins: vi.fn(() => undefined),
    applyProviderResolvedTransportWithPlugin: vi.fn(() => undefined),
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
