import { vi } from "vitest";
import type { AssistantMessage } from "../llm/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PreparedAgentRunAdmission } from "./admitted-run-context.js";
import type { AgentHarness } from "./harness/types.js";
import { createEmptyPluginMetadataSnapshot } from "./test-helpers/embedded-agent-runner-e2e-mocks.js";

export type IsolatedCliRunParams = {
  preparedRunAdmission: PreparedAgentRunAdmission;
  prompt: string;
  runId: string;
  sessionId: string;
};

// Vitest can hoist a local declaration, but rejects an exported declaration.
const isolatedCompletionMocks = vi.hoisted(() => ({
  acquireAgentRunPreparedModelRuntime: vi.fn(),
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => {}),
  getRegisteredAgentHarness: vi.fn(),
  ensureAuthProfileStore: vi.fn(),
  isCliRuntimeAliasForProvider: vi.fn<(params: { runtime?: string; provider?: string }) => boolean>(
    () => false,
  ),
  prepareSimpleCompletionModel: vi.fn(),
  prepareAgentRuntimeAuth: vi.fn(),
  resolveModelAsync: vi.fn(),
  resolveCliRuntimeCanonicalProvider: vi.fn<() => string | undefined>(() => undefined),
  resolveCliBackendConfig: vi.fn<
    () => { config: { command: string; modelAliases?: Record<string, string> } } | undefined
  >(() => ({ config: { command: "test-cli" } })),
  resolveCliRuntimeExecutionProvider: vi.fn<() => string | undefined>(() => undefined),
  resolveEmbeddedCliBackendDispatchEligibility: vi.fn(() => undefined),
  resolveEffectiveAgentRuntime: vi.fn(() => "codex"),
  runCliAgent: vi.fn<(params: IsolatedCliRunParams) => Promise<unknown>>(),
}));

export { isolatedCompletionMocks };

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "main",
}));
vi.mock("./cli-backends.js", () => ({
  resolveCliBackendConfig: isolatedCompletionMocks.resolveCliBackendConfig,
  resolveCliRuntimeCanonicalProvider: isolatedCompletionMocks.resolveCliRuntimeCanonicalProvider,
}));
vi.mock("./embedded-agent-runner/cli-backend-dispatch-eligibility.js", () => ({
  resolveEmbeddedCliBackendDispatchEligibility:
    isolatedCompletionMocks.resolveEmbeddedCliBackendDispatchEligibility,
}));
vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: isolatedCompletionMocks.resolveModelAsync,
}));
vi.mock("./harness/registry.js", () => ({
  getRegisteredAgentHarness: isolatedCompletionMocks.getRegisteredAgentHarness,
}));
vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: isolatedCompletionMocks.ensureSelectedAgentHarnessPlugin,
}));
vi.mock("./model-runtime-aliases.js", () => ({
  isCliRuntimeAliasForProvider: isolatedCompletionMocks.isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider: isolatedCompletionMocks.resolveCliRuntimeExecutionProvider,
}));
vi.mock("./model-auth.js", () => ({
  ensureAuthProfileStore: isolatedCompletionMocks.ensureAuthProfileStore,
}));
vi.mock("./prepared-model-runtime.js", () => ({
  acquireAgentRunPreparedModelRuntime: isolatedCompletionMocks.acquireAgentRunPreparedModelRuntime,
}));
vi.mock("./simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModel: isolatedCompletionMocks.prepareSimpleCompletionModel,
}));
vi.mock("./runtime-plan/prepare-auth.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-plan/prepare-auth.js")>(
    "./runtime-plan/prepare-auth.js",
  );
  return { ...actual, prepareAgentRuntimeAuth: isolatedCompletionMocks.prepareAgentRuntimeAuth };
});
vi.mock("./runtime-plan/resolve-auth.js", () => ({
  scopeAuthProfileStoreToPreparedPlan: (
    store: { version: number; profiles: Record<string, unknown> },
    plan: { forwardedAuthProfileCandidateIds?: string[] },
  ) => ({
    ...store,
    profiles: Object.fromEntries(
      (plan.forwardedAuthProfileCandidateIds ?? []).flatMap((profileId) => {
        const profile = store.profiles[profileId];
        return profile ? [[profileId, profile]] : [];
      }),
    ),
  }),
}));
vi.mock("./thinking-runtime.js", () => ({
  resolveEffectiveAgentRuntime: isolatedCompletionMocks.resolveEffectiveAgentRuntime,
}));
vi.mock("./cli-runner.runtime.js", () => ({ runCliAgent: isolatedCompletionMocks.runCliAgent }));
vi.mock("../infra/private-temp-workspace.js", () => ({
  withTempWorkspace: async (_options: unknown, run: (value: { dir: string }) => unknown) =>
    await run({ dir: "/tmp/isolated" }),
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => "/tmp",
}));

// Static re-exports bypass Vitest's import hoisting and can load runtime before mocks.
const { runIsolatedCompletion } = await import("./isolated-completion.js");
export { runIsolatedCompletion };

export let preparedModelRuntime: object;
export let releaseRuntimeLease: ReturnType<typeof vi.fn>;

export function isolatedAssistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant" as const,
    content,
    api: "openai-responses" as const,
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

export function isolatedRequest() {
  return {
    config: {},
    provider: "openai",
    model: "gpt-test",
    systemPrompt: "Return JSON.",
    prompt: "Do the task.",
    timeoutMs: 1_000,
    agentHarnessRuntimeOverride: "codex",
  };
}

export const nativeAuthPlan = {
  providerForAuth: "openai",
  modelId: "gpt-test",
  harnessAuthProvider: "openai",
  modelRoute: {
    provider: "openai",
    modelId: "gpt-test",
    api: "openai-chatgpt-responses" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authRequirement: "subscription" as const,
    requestTransportOverrides: "none" as const,
  },
};

export function resetIsolatedCompletionTestState(): void {
  vi.clearAllMocks();
  preparedModelRuntime = {
    config: {},
    agentDir: "/tmp/agent",
    metadataSnapshot: createEmptyPluginMetadataSnapshot("/tmp/workspace"),
    pluginRegistry: createEmptyPluginRegistry(),
    workspaceDir: "/tmp/workspace",
    createStores: () => ({ modelRegistry: {} }),
  };
  releaseRuntimeLease = vi.fn();
  isolatedCompletionMocks.acquireAgentRunPreparedModelRuntime.mockResolvedValue({
    snapshot: preparedModelRuntime,
    release: releaseRuntimeLease,
  });
  isolatedCompletionMocks.isCliRuntimeAliasForProvider.mockReturnValue(false);
  isolatedCompletionMocks.resolveCliBackendConfig.mockReturnValue({
    config: { command: "test-cli" },
  });
  isolatedCompletionMocks.resolveCliRuntimeCanonicalProvider.mockReturnValue(undefined);
  isolatedCompletionMocks.resolveEffectiveAgentRuntime.mockReturnValue("codex");
  isolatedCompletionMocks.resolveCliRuntimeExecutionProvider.mockReturnValue(undefined);
  isolatedCompletionMocks.resolveEmbeddedCliBackendDispatchEligibility.mockReturnValue(undefined);
  isolatedCompletionMocks.prepareSimpleCompletionModel.mockResolvedValue({
    model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
    auth: { apiKey: "secret", source: "profile:openai:test", mode: "oauth" },
    sourceAuthFingerprint: "fingerprint",
  });
  const runtimeModel = {
    provider: "openai",
    id: "gpt-test",
    api: "openai-chatgpt-responses",
    baseUrl: nativeAuthPlan.modelRoute.baseUrl,
  };
  isolatedCompletionMocks.resolveModelAsync.mockResolvedValue({ model: runtimeModel });
  isolatedCompletionMocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {} });
  const plan = nativeAuthPlan;
  isolatedCompletionMocks.prepareAgentRuntimeAuth.mockReturnValue({
    plan,
    attempts: [{ kind: "implicit", plan }],
  });
}

export function registerIsolatedHarness(overrides: Partial<AgentHarness>): void {
  isolatedCompletionMocks.getRegisteredAgentHarness.mockReturnValue({
    harness: {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(),
      ...overrides,
    } satisfies AgentHarness,
  });
}
