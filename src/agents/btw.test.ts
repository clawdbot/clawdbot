/** Tests BTW side-question execution, session context, auth, and harness routing. */

import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-scope.js";
import {
  looksLikeSecretSentinel,
  mintSecretSentinel,
  resolveSecretSentinel,
} from "../secrets/sentinel.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { guardModelFixtureWorkspace } from "./embedded-agent-runner/model.fixture.test-support.js";
import {
  createModelGenerationFixture,
  publishCurrentModelGeneration,
  resetModelGenerationFixtureState,
} from "./embedded-agent-runner/model.generation-scope.test-support.js";
import type { AgentHarnessHostCapabilities } from "./harness/host-capability-types.js";
import type { AgentHarness } from "./harness/types.js";
import type { AgentRuntimeAuthPlan } from "./runtime-plan/types.js";

let state: OpenClawTestState;
let workspaceGuard: ReturnType<typeof guardModelFixtureWorkspace>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "btw-model" });
});
beforeEach(() => {
  workspaceGuard = guardModelFixtureWorkspace(state.root);
});
afterEach(() => {
  try {
    workspaceGuard.verify();
  } finally {
    workspaceGuard.spy.mockRestore();
  }
});
afterAll(async () => {
  defaultPluginMetadataSnapshot = undefined;
  await state.cleanup();
});

const streamSimpleMock = vi.fn();
const readFileMock = vi.fn();
const parseSessionEntriesMock = vi.fn();
const migrateSessionEntriesMock = vi.fn();
const buildSessionContextMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn();
const loadPreparedModelRuntimeSnapshotMock = vi.fn();
const discoverAuthStorageMock = vi.fn();
const discoverModelsMock = vi.fn();
const getModelRegistryRuntimeMock = vi.fn();
const resolveModelWithRegistryMock = vi.fn();
const ensureAuthProfileStoreMock = vi.fn();
const ensureAuthProfileStoreWithoutExternalProfilesMock = vi.fn();
const resolveModelAsyncMock = vi.fn();
const getApiKeyForModelMock = vi.fn();
const requireApiKeyMock = vi.fn();
const resolveSessionAuthSelectionMock = vi.fn();
const getActiveEmbeddedRunSnapshotMock = vi.fn();
const resolveSessionAgentIdMock = vi.fn();
const resolveSessionAgentIdsMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const listAgentEntriesMock = vi.fn();
const prepareProviderRuntimeAuthMock = vi.fn();
const registerProviderStreamForModelMock = vi.fn();
const resolveEmbeddedAgentStreamMock = vi.fn();
const prepareCliRunContextMock = vi.fn();
const executePreparedCliRunMock = vi.fn();
const diagDebugMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();
const createAgentHarnessHostCapabilitiesMock = vi.fn();
const closeAgentHarnessHostCapabilitiesMock = vi.fn();
const agentHarnessHostCapabilitiesMock: AgentHarnessHostCapabilities = Object.freeze({
  kind: "agent-harness-host-capability",
  version: 1,
  assertActive: vi.fn(),
  bindToolSurface: vi.fn((tools) => tools),
  runBeforeToolCall: vi.fn(),
  requestApproval: vi.fn(),
  waitForApproval: vi.fn(),
});
const listSessionEntriesCoreMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const loadTranscriptEventsMock = vi.fn();
const builtInOpenClawHarnesses = new WeakSet<object>();
const shouldPreferExplicitConfigApiKeyAuthMock = vi.fn((..._args: unknown[]) => false);
const hasUsableCustomProviderApiKeyMock = vi.fn((..._args: unknown[]) => false);
const resolveProviderEntryApiKeyProfileReferenceMock = vi.fn((_params?: unknown): unknown => ({
  kind: "none",
}));
const preparedRuntimeSnapshotState = vi.hoisted(() => ({
  snapshot: undefined as unknown,
  useSnapshotPluginRegistry: false,
}));

vi.mock("../llm/stream.js", async () => {
  const original = await vi.importActual<typeof import("../llm/stream.js")>("../llm/stream.js");
  return {
    ...original,
    streamSimple: (...args: unknown[]) => streamSimpleMock(...args),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    default: {
      ...actual,
      readFile: (...args: unknown[]) => readFileMock(...args),
    },
    readFile: (...args: unknown[]) => readFileMock(...args),
  };
});

vi.mock("./sessions/session-manager.js", () => ({
  buildSessionContext: (...args: unknown[]) => buildSessionContextMock(...args),
  generateSummary: vi.fn(async () => "summary"),
  migrateSessionEntries: (...args: unknown[]) => migrateSessionEntriesMock(...args),
  parseSessionEntries: (...args: unknown[]) => parseSessionEntriesMock(...args),
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => ensureOpenClawModelsJsonMock(...args),
}));

vi.mock("./agent-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => discoverAuthStorageMock(...args),
  discoverModels: (...args: unknown[]) => discoverModelsMock(...args),
}));

vi.mock("./sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: (...args: unknown[]) => getModelRegistryRuntimeMock(...args),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  preparedModelRuntimeConfigsMatch: (left: unknown, right: unknown) => left === right,
  loadPreparedModelRuntimeSnapshot: async (params: {
    agentId?: string;
    agentDir: string;
    config: unknown;
    inheritedAuthDir?: string;
    workspaceDir?: string;
    allowGatewaySubagentBinding?: boolean;
  }) => {
    loadPreparedModelRuntimeSnapshotMock(params);
    const workspaceOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : {};
    await ensureOpenClawModelsJsonMock(params.config, params.agentDir, workspaceOptions);
    const authStorage = discoverAuthStorageMock(params.agentDir, {
      config: params.config,
      ...(params.inheritedAuthDir ? { inheritedAuthDir: params.inheritedAuthDir } : {}),
      ...workspaceOptions,
    });
    const modelRegistry = discoverModelsMock(authStorage, params.agentDir, {
      config: params.config,
      ...workspaceOptions,
    });
    return {
      ...(preparedRuntimeSnapshotState.snapshot as object),
      ...(preparedRuntimeSnapshotState.useSnapshotPluginRegistry
        ? {}
        : { pluginRegistry: getActivePluginRegistry() }),
      agentId: params.agentId,
      agentDir: params.agentDir,
      config: params.config,
      workspaceDir: params.workspaceDir,
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => ({ authStorage, modelRegistry }),
    };
  },
}));

vi.mock("./model-discovery-context.js", () => ({
  resolveModelPluginMetadataSnapshot: () => undefined,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: (...args: unknown[]) => resolveModelAsyncMock(...args),
  resolveModelWithRegistry: (...args: unknown[]) => resolveModelWithRegistryMock(...args),
}));

vi.mock("./model-auth.js", () => ({
  applySecretRefHeaderSentinels: (model: unknown) => model,
  ensureAuthProfileStore: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
  ensureAuthProfileStoreWithoutExternalProfiles: (...args: unknown[]) =>
    ensureAuthProfileStoreWithoutExternalProfilesMock(...args),
  getApiKeyForModelCore: (...args: unknown[]) => getApiKeyForModelMock(...args),
  hasUsableCustomProviderApiKey: (...args: unknown[]) => hasUsableCustomProviderApiKeyMock(...args),
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
  resolveProviderEntryApiKeyProfileReference: (params: unknown) =>
    resolveProviderEntryApiKeyProfileReferenceMock(params),
  shouldPreferExplicitConfigApiKeyAuth: (...args: unknown[]) =>
    shouldPreferExplicitConfigApiKeyAuthMock(...args),
}));

vi.mock("./model-runtime-aliases.js", () => ({
  isCliRuntimeAliasForProvider: ({ runtime, provider }: { runtime?: string; provider?: string }) =>
    runtime === "claude-cli" && provider === "anthropic",
  resolveCliRuntimeExecutionProvider: ({
    provider,
    cfg,
    modelId,
    authProfileId,
  }: {
    provider?: string;
    cfg?: {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { id?: string } }>;
        };
      };
      auth?: {
        order?: Record<string, string[]>;
        profiles?: Record<string, { provider?: string }>;
      };
    };
    modelId?: string;
    authProfileId?: string;
  }) => {
    const key = provider && modelId ? `${provider}/${modelId}` : undefined;
    const runtime = key
      ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
      : undefined;
    if ((!runtime || runtime === "auto") && authProfileId?.trim()) {
      return cfg?.auth?.profiles?.[authProfileId]?.provider === "claude-cli"
        ? "claude-cli"
        : undefined;
    }
    if (!runtime || runtime === "auto") {
      for (const profileId of cfg?.auth?.order?.[provider ?? ""] ?? []) {
        if (cfg?.auth?.profiles?.[profileId]?.provider === "claude-cli") {
          return "claude-cli";
        }
      }
    }
    return runtime === "claude-cli" ? runtime : undefined;
  },
}));

vi.mock("./cli-runner/prepare.runtime.js", () => ({
  prepareCliRunContext: (...args: unknown[]) => prepareCliRunContextMock(...args),
}));

vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: (...args: unknown[]) => executePreparedCliRunMock(...args),
}));

vi.mock("./harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: (...args: unknown[]) =>
    ensureSelectedAgentHarnessPluginMock(...args),
}));

// Selection and host-capability owner suites execute the embedded runner and capability surface.
// BTW only needs their identities while it verifies side-question orchestration.
vi.mock("./harness/builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: (): AgentHarness => {
    const harness: AgentHarness = {
      id: "openclaw",
      label: "OpenClaw embedded agent",
      supports: () => ({ supported: true, priority: 0 }),
      runAttempt: vi.fn(),
    };
    builtInOpenClawHarnesses.add(harness);
    return harness;
  },
  isBuiltInOpenClawAgentHarness: (harness: AgentHarness) => builtInOpenClawHarnesses.has(harness),
}));

vi.mock("./harness/host-capability.js", () => {
  return {
    createAgentHarnessHostCapabilities: (params: unknown) => {
      createAgentHarnessHostCapabilitiesMock(params);
      return {
        capabilities: agentHarnessHostCapabilitiesMock,
        close: closeAgentHarnessHostCapabilitiesMock,
      };
    },
  };
});

vi.mock("./embedded-agent-runner/runs.js", () => ({
  getActiveEmbeddedRunSnapshot: (...args: unknown[]) => getActiveEmbeddedRunSnapshotMock(...args),
}));

vi.mock("./agent-scope.js", () => ({
  listAgentEntries: (...args: unknown[]) => listAgentEntriesMock(...args),
  resolveAgentConfig: (cfg: { agents?: { list?: Array<{ id?: string }> } }, agentId: string) =>
    cfg.agents?.list?.find((entry) => entry.id === agentId),
  resolveSessionAgentIds: (...args: unknown[]) => resolveSessionAgentIdsMock(...args),
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveDefaultAgentDir: () => "/tmp/agent",
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: (...args: unknown[]) => prepareProviderRuntimeAuthMock(...args),
}));

// Provider ownership and public-surface loading have dedicated owner suites. BTW stubs those
// boundaries so its orchestration tests do not rediscover every plugin.
vi.mock("../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" as const }),
}));

vi.mock("../plugins/provider-policy-surface.js", () => ({
  // Provider route policy has dedicated adapter and OpenAI owner suites. BTW needs only a
  // deterministic route fixture so orchestration tests do not load plugin public surfaces.
  resolveDirectBundledProviderPolicySurface: (provider: string) => {
    if (provider.trim().toLowerCase() !== "openai") {
      return null;
    }
    return {
      normalizeModelCatalogId: ({ modelId }: { modelId: string }) => modelId,
      resolveModelRoutes: ({
        requestTransportOverrides = "none",
      }: ProviderResolveModelRoutesContext) => {
        const compatibleIds =
          requestTransportOverrides === "none" ? ["openclaw", "codex"] : ["openclaw"];
        return {
          kind: "routes" as const,
          defaultRuntimeId: requestTransportOverrides === "none" ? "codex" : "openclaw",
          routes: [
            {
              api: "openai-responses" as const,
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key" as const,
              requestTransportOverrides,
              runtimePolicy: { compatibleIds },
            },
            {
              api: "openai-chatgpt-responses" as const,
              baseUrl: "https://chatgpt.com/backend-api/codex",
              authRequirement: "subscription" as const,
              requestTransportOverrides,
              runtimePolicy: { compatibleIds },
            },
          ],
        };
      },
    };
  },
  resolveTrustedExternalProviderPolicySurface: () => null,
}));

vi.mock("./provider-stream.js", () => ({
  registerProviderStreamForModel: (...args: unknown[]) =>
    registerProviderStreamForModelMock(...args),
}));

vi.mock("./embedded-agent-runner/stream-resolution.js", () => ({
  resolveEmbeddedAgentStream: (...args: unknown[]) => resolveEmbeddedAgentStreamMock(...args),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  resolveSessionAuthSelection: (...args: unknown[]) => resolveSessionAuthSelectionMock(...args),
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    debug: (...args: unknown[]) => diagDebugMock(...args),
  },
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntriesCore: (...args: unknown[]) => listSessionEntriesCoreMock(...args),
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  loadTranscriptEvents: (...args: unknown[]) => loadTranscriptEventsMock(...args),
}));

const { runBtwSideQuestion } = await import("./btw.js");
const { clearAgentHarnesses, registerAgentHarness } = await import("./harness/registry.js");
type RunBtwSideQuestionParams = Parameters<typeof runBtwSideQuestion>[0];

const DEFAULT_AGENT_DIR = "/tmp/agent";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_REASONING_LEVEL = "off";
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_STORE_PATH = "/tmp/sessions.json";
const DEFAULT_QUESTION = "What changed?";
const MATH_QUESTION = "What is 17 * 19?";
const MATH_ANSWER = "323";
let defaultPluginMetadataSnapshot: ReturnType<typeof resolvePluginMetadataSnapshot> | undefined;

const DEFAULT_USAGE = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAsyncEvents(events: unknown[]) {
  // Minimal async iterable that matches provider stream shape without loading
  // real model/runtime infrastructure.
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    sessionFile: "session-1.jsonl",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createAssistantDoneEvent(content: unknown[]) {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content,
      provider: DEFAULT_PROVIDER,
      api: "anthropic-messages",
      model: DEFAULT_MODEL,
      stopReason: "stop",
      usage: DEFAULT_USAGE,
      timestamp: Date.now(),
    },
  };
}

function createDoneEvent(text: string) {
  return createAssistantDoneEvent([{ type: "text", text }]);
}

function createThinkingOnlyDoneEvent(thinking: string) {
  return createAssistantDoneEvent([{ type: "thinking", thinking }]);
}

function mockDoneAnswer(text: string) {
  streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent(text)]));
}

function mockCliOutput(output: { text: string; rawText?: string }) {
  const cleanup = vi.fn(async () => undefined);
  const prepared = { prepared: true, preparedBackend: { cleanup } };
  prepareCliRunContextMock.mockResolvedValueOnce(prepared);
  executePreparedCliRunMock.mockResolvedValueOnce(output);
  return { cleanup, prepared };
}

function registerCodexSideQuestionHarness(
  overrides: Partial<Pick<AgentHarness, "authBootstrap" | "supports">> = {},
) {
  const runHarnessSideQuestion = vi.fn().mockResolvedValue({ text: "Codex side answer." });
  registerAgentHarness({
    id: "codex",
    label: "Codex test harness",
    supports: () => ({ supported: true, priority: 100 }),
    runAttempt: vi.fn(),
    runSideQuestion: runHarnessSideQuestion,
    ...overrides,
  });
  return runHarnessSideQuestion;
}

function supportsPreparedOpenAIAuth(ctx: Parameters<AgentHarness["supports"]>[0]) {
  if (ctx.provider !== "openai") {
    return { supported: false as const, reason: "Codex only supports OpenAI providers" };
  }
  const preparedAuth = ctx.modelProvider?.preparedAuth;
  if (preparedAuth?.requirement === "subscription") {
    return preparedAuth.source === "profile" &&
      (preparedAuth.mode === "oauth" || preparedAuth.mode === "token")
      ? { supported: true as const, priority: 100 }
      : { supported: false as const, reason: "subscription auth is not reproducible" };
  }
  if (preparedAuth?.requirement === "api-key") {
    return preparedAuth.source !== "none" &&
      preparedAuth.source !== "harness" &&
      (preparedAuth.mode === "api-key" || preparedAuth.mode === "api_key")
      ? { supported: true as const, priority: 100 }
      : { supported: false as const, reason: "Platform auth is not reproducible" };
  }
  return { supported: true as const, priority: 100 };
}

function createSideQuestionParams(
  overrides: Partial<RunBtwSideQuestionParams> = {},
): RunBtwSideQuestionParams {
  return {
    cfg: { agents: { entries: { main: { default: true } } } } as never,
    agentId: "main",
    agentDir: DEFAULT_AGENT_DIR,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    question: DEFAULT_QUESTION,
    sessionEntry: createSessionEntry(),
    sessionKey: DEFAULT_SESSION_KEY,
    storePath: DEFAULT_STORE_PATH,
    resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
    opts: {},
    isNewSession: false,
    ...overrides,
  };
}

function runSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runBtwSideQuestion(createSideQuestionParams(overrides));
}

function runMathSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runSideQuestion({
    question: MATH_QUESTION,
    ...overrides,
  });
}

function clearBuiltSessionMessages() {
  buildSessionContextMock.mockReturnValue({ messages: [] });
}

function createUserTranscriptMessage(content: unknown[] = [{ type: "text", text: "seed" }]) {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
}

function createAssistantTranscriptMessage(
  content: unknown,
  overrides: {
    stopReason?: string;
    output?: number;
    timestamp?: number;
  } = {},
) {
  return {
    role: "assistant",
    content,
    provider: DEFAULT_PROVIDER,
    api: "anthropic-messages",
    model: DEFAULT_MODEL,
    stopReason: overrides.stopReason ?? "stop",
    usage: {
      ...DEFAULT_USAGE,
      output: overrides.output ?? DEFAULT_USAGE.output,
      totalTokens: 1 + (overrides.output ?? DEFAULT_USAGE.output),
    },
    timestamp: overrides.timestamp ?? 2,
  };
}

function createTranscriptEntry(params: { id: string; parentId?: string | null; message: unknown }) {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId ?? null,
    message: params.message,
  };
}

function mockTranscriptEntries(entries: unknown[]) {
  parseSessionEntriesMock.mockReturnValue(entries);
  loadTranscriptEventsMock.mockResolvedValue(entries);
}

function mockActiveTranscript(messages: unknown[]) {
  getActiveEmbeddedRunSnapshotMock.mockReturnValue({
    transcriptLeafId: "assistant-1",
    messages,
  });
}

function mockCall(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
): ReadonlyArray<unknown> {
  const call = mockFn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex + 1}`);
  }
  return call;
}

function mockArg(
  mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex: number,
  argIndex: number,
): unknown {
  return mockCall(mockFn, callIndex)[argIndex];
}

async function runMathSideQuestionAndCaptureContext() {
  mockDoneAnswer(MATH_ANSWER);
  await runMathSideQuestion();
  const context = mockArg(streamSimpleMock, 0, 1);
  return context;
}

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function streamContext(callIndex = 0): {
  messages?: Array<Record<string, unknown>>;
  systemPrompt?: unknown;
} {
  const call = streamSimpleMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected streamSimple call at index ${callIndex}`);
  }
  return (call[1] ?? {}) as {
    messages?: Array<Record<string, unknown>>;
    systemPrompt?: unknown;
  };
}

function contextMessages(context: unknown): Array<Record<string, unknown>> {
  const messages = (context as { messages?: Array<Record<string, unknown>> }).messages;
  if (!messages) {
    throw new Error("Expected BTW context messages");
  }
  return messages;
}

function expectTextBlockContains(block: unknown, text: string): void {
  const record = expectRecordFields(block, { type: "text" });
  expect(typeof record.text).toBe("string");
  expect(record.text).toContain(text);
}

function firstTextBlockIncludes(message: Record<string, unknown>, text: string): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  const [block] = message.content;
  const blockText = (block as { text?: unknown } | undefined)?.text;
  return typeof blockText === "string" && blockText.includes(text);
}

function expectNoAssistantMessages(context: unknown) {
  expect(
    (context as { messages?: Array<{ role?: string }> }).messages?.filter(
      (message) => message.role === "assistant",
    ),
  ).toHaveLength(0);
}

function expectSanitizedAssistantContext(context: unknown, text: string) {
  const messages = contextMessages(context);
  expect(messages).toHaveLength(3);
  expectRecordFields(messages[0], { role: "user" });
  expectRecordFields(messages[1], {
    role: "assistant",
    content: [{ type: "text", text }],
  });
  expectRecordFields(messages[2], { role: "user" });
}

function expectSeedOnlyUserContext(context: unknown) {
  const messages = contextMessages(context);
  expect(messages).toHaveLength(2);
  expectRecordFields(messages[0], {
    role: "user",
    content: [{ type: "text", text: "seed" }],
  });
  expectRecordFields(messages[1], { role: "user" });
}

function mockOpenAIPlatformProfile(): void {
  ensureAuthProfileStoreMock.mockReturnValue({
    version: 1,
    profiles: {
      "profile-1": {
        type: "api_key",
        provider: "openai",
        key: "platform-key",
      },
    },
    order: { openai: ["profile-1"] },
  });
}

describe("runBtwSideQuestion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetModelGenerationFixtureState();
  });

  beforeEach(() => {
    streamSimpleMock.mockReset();
    readFileMock.mockReset();
    parseSessionEntriesMock.mockReset();
    migrateSessionEntriesMock.mockReset();
    buildSessionContextMock.mockReset();
    ensureOpenClawModelsJsonMock.mockReset();
    loadPreparedModelRuntimeSnapshotMock.mockReset();
    discoverAuthStorageMock.mockReset();
    discoverModelsMock.mockReset();
    getModelRegistryRuntimeMock.mockReset();
    getModelRegistryRuntimeMock.mockReturnValue({
      apiRegistry: {},
      llmRuntime: { streamSimple: streamSimpleMock },
    });
    resolveModelAsyncMock.mockReset();
    resolveModelWithRegistryMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReset();
    getApiKeyForModelMock.mockReset();
    requireApiKeyMock.mockReset();
    resolveSessionAuthSelectionMock.mockReset();
    getActiveEmbeddedRunSnapshotMock.mockReset();
    resolveSessionAgentIdMock.mockReset();
    resolveSessionAgentIdsMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    listAgentEntriesMock.mockReset();
    prepareProviderRuntimeAuthMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
    resolveEmbeddedAgentStreamMock.mockReset();
    prepareCliRunContextMock.mockReset();
    executePreparedCliRunMock.mockReset();
    diagDebugMock.mockReset();
    ensureSelectedAgentHarnessPluginMock.mockReset();
    createAgentHarnessHostCapabilitiesMock.mockReset();
    closeAgentHarnessHostCapabilitiesMock.mockReset();
    listSessionEntriesCoreMock.mockReset();
    listSessionEntriesCoreMock.mockReturnValue([]);
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockReturnValue(undefined);
    loadTranscriptEventsMock.mockReset();
    shouldPreferExplicitConfigApiKeyAuthMock.mockReset();
    shouldPreferExplicitConfigApiKeyAuthMock.mockReturnValue(false);
    hasUsableCustomProviderApiKeyMock.mockReset();
    hasUsableCustomProviderApiKeyMock.mockReturnValue(false);
    resolveProviderEntryApiKeyProfileReferenceMock.mockReset();
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "none" });
    clearAgentHarnesses();
    if (!defaultPluginMetadataSnapshot) {
      defaultPluginMetadataSnapshot = resolvePluginMetadataSnapshot({
        config: {},
        workspaceDir: state.workspaceDir,
        allowCurrent: false,
      });
      expect(workspaceGuard.spy).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: state.workspaceDir }),
      );
    }
    preparedRuntimeSnapshotState.snapshot = {
      metadataSnapshot: defaultPluginMetadataSnapshot,
    };
    preparedRuntimeSnapshotState.useSnapshotPluginRegistry = false;

    readFileMock.mockResolvedValue("mock transcript");
    loadTranscriptEventsMock.mockResolvedValue([]);
    mockTranscriptEntries([
      createTranscriptEntry({
        id: "user-1",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      }),
      createTranscriptEntry({
        id: "assistant-1",
        parentId: "user-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          timestamp: 2,
        },
      }),
    ]);
    buildSessionContextMock.mockImplementation((entries: Array<{ message?: unknown }> = []) => {
      return { messages: entries.flatMap((entry) => (entry.message ? [entry.message] : [])) };
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      api: "anthropic-messages",
    });
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue({ version: 1, profiles: {} });
    getApiKeyForModelMock.mockImplementation(async (params: { profileId?: string } = {}) => ({
      apiKey: "secret",
      mode: "api-key",
      source: params.profileId ? `profile:${params.profileId}` : "test",
      ...(params.profileId ? { profileId: params.profileId } : {}),
    }));
    requireApiKeyMock.mockReturnValue("secret");
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "profile-1",
      source: "auto",
      routeRequirement: undefined,
    });
    getActiveEmbeddedRunSnapshotMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("main");
    resolveSessionAgentIdsMock.mockReturnValue({ defaultAgentId: "main", sessionAgentId: "main" });
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    listAgentEntriesMock.mockReturnValue([]);
    prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
    registerProviderStreamForModelMock.mockReturnValue(undefined);
    resolveEmbeddedAgentStreamMock.mockImplementation(
      (params: { currentStreamFn: unknown; providerStreamFn?: unknown }) => {
        return {
          streamFn: params.providerStreamFn ?? params.currentStreamFn,
          strategy: "session-custom",
        };
      },
    );
  });

  it("streams blocks without persisting BTW data to disk", async () => {
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          type: "text_delta",
          delta: "Side answer.",
          partial: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        {
          type: "text_end",
          content: "Side answer.",
          contentIndex: 0,
          partial: {
            role: "assistant",
            content: [],
            provider: "anthropic",
            model: "claude-sonnet-4-6",
          },
        },
        {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Side answer." }],
            provider: "anthropic",
            api: "anthropic-messages",
            model: "claude-sonnet-4-6",
            stopReason: "stop",
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      cfg: { agents: { entries: { main: { default: true } } } } as never,
      agentId: "main",
      agentDir: DEFAULT_AGENT_DIR,
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      question: DEFAULT_QUESTION,
      sessionEntry: createSessionEntry(),
      sessionStore: {},
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: DEFAULT_STORE_PATH,
      resolvedThinkLevel: "low",
      resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      opts: { onBlockReply },
      isNewSession: false,
    });

    expect(result).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledWith({
      text: "Side answer.",
      btw: { question: DEFAULT_QUESTION },
    });
  });

  it.each([false, true])(
    "returns only final text when block streaming is unavailable (thinking: %s)",
    async (withThinking) => {
      const onReasoningStream = vi.fn();
      const onReasoningEnd = vi.fn();
      streamSimpleMock.mockReturnValue(
        makeAsyncEvents([
          createAssistantDoneEvent([
            ...(withThinking ? [{ type: "thinking", thinking: "Hidden reasoning." }] : []),
            { type: "text", text: "Final answer." },
          ]),
        ]),
      );

      const result = await runSideQuestion({ opts: { onReasoningStream, onReasoningEnd } });

      expect(result).toEqual({ text: "Final answer." });
      expect(onReasoningStream).not.toHaveBeenCalled();
      expect(onReasoningEnd).not.toHaveBeenCalled();
      const ensureArgs = mockCall(ensureOpenClawModelsJsonMock);
      expect(ensureArgs?.[1]).toBe(DEFAULT_AGENT_DIR);
      expect(ensureArgs?.[2]).toEqual({ workspaceDir: "/tmp/workspace" });
      expect(discoverModelsMock).toHaveBeenCalledWith(undefined, DEFAULT_AGENT_DIR, {
        config: ensureArgs?.[0],
        workspaceDir: "/tmp/workspace",
      });
    },
  );

  it.each(["off", "on", "stream"] as const)(
    "keeps admitted %s reasoning visibility when caller input changes",
    async (mode) => {
      const onReasoningStream = vi.fn();
      const onReasoningEnd = vi.fn();
      const input = createSideQuestionParams({
        resolvedReasoningLevel: mode,
        opts: {
          onAssistantMessageStart: async () => {
            input.resolvedReasoningLevel = mode === "off" ? "on" : "off";
          },
          onReasoningStream,
          onReasoningEnd,
        },
      });
      const done = createDoneEvent("Final answer.");
      streamSimpleMock.mockReturnValue(
        makeAsyncEvents([
          { type: "start", partial: done.message },
          { type: "thinking_delta", delta: "One " },
          { type: "thinking_delta", delta: "two" },
          { type: "thinking_end" },
          done,
        ]),
      );

      await expect(runBtwSideQuestion(input)).resolves.toEqual({ text: "Final answer." });
      expect(onReasoningStream.mock.calls).toEqual(
        mode === "off"
          ? []
          : [[{ text: "One ", isReasoning: true }], [{ text: "One two", isReasoning: true }]],
      );
      expect(onReasoningEnd).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    },
  );

  it.each([
    { harness: "openclaw", sandboxSessionKey: undefined },
    { harness: "codex", sandboxSessionKey: undefined },
    { harness: "codex", sandboxSessionKey: "agent:main:policy" },
  ])(
    "retains the selected global agent for $harness with policy $sandboxSessionKey",
    async ({ harness, sandboxSessionKey }) => {
      // Gateway startup publishes configured owners with allowGatewaySubagentBinding
      // (server-startup-post-attach.ts), and that flag is part of the owner key
      // (prepared-model-runtime.owner.ts). A gateway-hosted BTW request that omits
      // it matches no owner, and standalone activation is refused while the gateway
      // lifecycle is active, so the side question fails with "owner was not published".
      mockDoneAnswer("Final answer.");
      resolveSessionAgentIdMock.mockImplementation(
        (await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js"))
          .resolveSessionAgentId,
      );
      const sideQuestion = harness === "codex" ? registerCodexSideQuestionHarness() : undefined;

      await runSideQuestion({
        agentId: "work",
        cfg: {
          agents: { ownership: "explicit", entries: { main: {}, work: {} } },
          session: { scope: "global" },
        },
        sessionKey: "global",
        sandboxSessionKey,
        allowGatewaySubagentBinding: true,
      });

      expect(mockCall(loadPreparedModelRuntimeSnapshotMock)?.[0]).toMatchObject({
        agentDir: DEFAULT_AGENT_DIR,
        agentId: "work",
        allowGatewaySubagentBinding: true,
      });
      if (sideQuestion) {
        expect(sideQuestion).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "work", sessionKey: "global" }),
        );
      }
    },
  );

  it("keeps gateway subagent binding off for local callers such as the embedded TUI", async () => {
    // The embedded TUI calls runBtwSideQuestion directly and must not borrow the
    // active registry's subagent and node capabilities, so the flag stays unset
    // unless a gateway-hosted caller opts in.
    mockDoneAnswer("Final answer.");

    await runSideQuestion();

    expect(mockCall(loadPreparedModelRuntimeSnapshotMock)?.[0]).not.toHaveProperty(
      "allowGatewaySubagentBinding",
    );
  });

  it("keeps model, runtime auth, and stream selection on prepared A after current advances to B", async () => {
    const cfg = { agents: { entries: { main: { default: true } } } } as never;
    const generationA = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      label: "btw-a",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "side-model",
    });
    const generationB = createModelGenerationFixture({
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      config: cfg,
      label: "btw-b",
      provider: "local-proxy",
      requestProvider: "local-proxy",
      modelId: "side-model",
    });
    preparedRuntimeSnapshotState.snapshot = generationA.preparedModelRuntime;
    preparedRuntimeSnapshotState.useSnapshotPluginRegistry = true;
    resolveAgentWorkspaceDirMock.mockReturnValue(state.workspaceDir);
    publishCurrentModelGeneration(generationB);
    const runtimeAuthA = vi.fn(async () => ({ apiKey: "runtime-auth-a" }));
    const runtimeAuthB = vi.fn(async () => ({ apiKey: "runtime-auth-b" }));
    const streamA = vi.fn(
      (model: { name?: string }, _context: unknown, options?: { apiKey?: string }) => {
        const apiKey = options?.apiKey;
        const resolvedApiKey =
          apiKey && looksLikeSecretSentinel(apiKey) ? resolveSecretSentinel(apiKey) : apiKey;
        return makeAsyncEvents([
          createDoneEvent(`${model.name ?? "missing model"} / ${resolvedApiKey} / Stream A`),
        ]);
      },
    );
    const streamB = vi.fn(() =>
      makeAsyncEvents([createDoneEvent("Generation B / runtime-auth-b / Stream B")]),
    );
    const activeGenerationRegistry = () =>
      getPluginRuntimeGenerationRegistry() ?? getActivePluginRegistry();
    resolveModelWithRegistryMock.mockImplementation(() => {
      const snapshot = getCurrentPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: state.workspaceDir,
      });
      const label = snapshot === generationA.metadataSnapshot ? "A" : "B";
      return {
        provider: "local-proxy",
        id: "side-model",
        name: `Generation ${label}`,
        api: "openai-responses",
        baseUrl: `https://generation-${label.toLowerCase()}.example.test/v1`,
      };
    });
    prepareProviderRuntimeAuthMock.mockImplementation(async () =>
      activeGenerationRegistry() === generationA.pluginRegistry
        ? await runtimeAuthA()
        : await runtimeAuthB(),
    );
    registerProviderStreamForModelMock.mockImplementation(() =>
      activeGenerationRegistry() === generationA.pluginRegistry ? streamA : streamB,
    );

    await expect(
      runSideQuestion({ cfg, provider: "local-proxy", model: "side-model" }),
    ).resolves.toEqual({ text: "Generation A / runtime-auth-a / Stream A" });
    expect(runtimeAuthA).toHaveBeenCalledOnce();
    expect(runtimeAuthB).not.toHaveBeenCalled();
    expect(streamA).toHaveBeenCalledOnce();
    expect(streamA).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Generation A" }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(streamB).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("routes Codex-selected BTW questions through the harness side-question hook", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports,
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai:work",
      source: "auto",
      routeRequirement: "subscription",
    });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:work": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:work"] },
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "profile:openai:work",
      profileId: "openai:work",
    });

    const result = await runSideQuestion({
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: DEFAULT_SESSION_KEY,
      authorityRunId: "btw-side-authority",
      opts: { runId: "parent-correlation" },
      sandboxSessionKey: "agent:main:runtime-policy",
      agentAccountId: "account-1",
      groupId: "group-1",
      groupChannel: "#ops",
      groupSpace: "workspace-1",
      spawnedBy: "agent:main:parent",
      senderId: "sender-1",
      senderName: "Rosita",
      senderUsername: "rosita",
      senderE164: "+15550001",
    });

    expect(result).toEqual({ text: "Codex side answer." });
    expect(codexSideQuestionMock).toHaveBeenCalledTimes(1);
    expect(codexSideQuestionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        question: DEFAULT_QUESTION,
        sessionId: "session-1",
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        authProfileId: "openai:work",
        agentAccountId: "account-1",
        sandboxSessionKey: "agent:main:runtime-policy",
        groupId: "group-1",
        groupChannel: "#ops",
        groupSpace: "workspace-1",
        spawnedBy: "agent:main:parent",
        senderId: "sender-1",
        senderName: "Rosita",
        senderUsername: "rosita",
        senderE164: "+15550001",
        opts: { runId: "btw-side-authority" },
        runtimeModel: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      }),
    );
    expect(mockArg(codexSideQuestionMock, 0, 0)).toHaveProperty(
      "hostCapabilities",
      agentHarnessHostCapabilitiesMock,
    );
    expect(createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: expect.objectContaining({
          admittedRunContext: expect.objectContaining({
            operationalRunInstance: expect.objectContaining({ runId: "btw-side-authority" }),
          }),
          runId: "btw-side-authority",
        }),
      }),
    );
    expect(closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "openai",
      "gpt-5.5",
      DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({
        authProfileMode: "token",
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: [],
          inlineProviderModels: [],
        }),
      }),
    );
    const preparedModelRuntime = (
      mockArg(resolveModelAsyncMock, 0, 4) as { preparedModelRuntime?: unknown }
    ).preparedModelRuntime;
    expect(mockArg(codexSideQuestionMock, 0, 0)).toHaveProperty(
      "preparedModelRuntime",
      preparedModelRuntime,
    );
    expect(
      (mockArg(codexSideQuestionMock, 0, 0) as { sessionFile?: string }).sessionFile,
    ).toContain("session-1.jsonl");
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "profile",
            mode: "token",
            requirement: "subscription",
          },
        }),
      }),
    );
  });

  it("keeps an unprofiled subscription token on the OpenClaw BTW path", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({ supports });
    const subscriptionModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    resolveModelWithRegistryMock.mockReturnValue(subscriptionModel);
    resolveModelAsyncMock.mockResolvedValue({ model: subscriptionModel });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "token",
      source: "models.json",
    });
    requireApiKeyMock.mockReturnValue("subscription-token");
    mockDoneAnswer("OpenClaw side answer.");

    await expect(
      runSideQuestion({
        cfg: {
          models: {
            providers: {
              openai: { auth: "token", apiKey: "subscription-token" },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "OpenClaw side answer." });

    expect(codexSideQuestionMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).toHaveBeenCalled();
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "direct",
            mode: "token",
            requirement: "subscription",
          },
        }),
      }),
    );
  });

  it("lets Codex reproduce an unprofiled Platform API key", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({ supports });
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockResolvedValue({ model: platformModel });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "platform-key",
      mode: "api-key",
      source: "models.json",
    });

    await expect(
      runSideQuestion({
        cfg: {
          models: { providers: { openai: { apiKey: "platform-key" } } },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(
      (
        mockArg(codexSideQuestionMock, 0, 0) as {
          preparedRuntimeAuth?: { resolvedApiKey?: string };
        }
      ).preparedRuntimeAuth?.resolvedApiKey,
    ).toBe("platform-key");
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "direct",
            mode: "api-key",
            requirement: "api-key",
          },
        }),
      }),
    );
  });

  it("lets native Codex bootstrap auth without a host profile", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const supports = vi.fn((ctx: Parameters<AgentHarness["supports"]>[0]) => {
      if (ctx.modelProvider?.preparedAuth?.source !== "harness") {
        return supportsPreparedOpenAIAuth(ctx);
      }
      return ctx.modelProvider.requestTransportOverrides === "none" &&
        ctx.modelProvider.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true as const, priority: 100 }
        : { supported: false as const, reason: "deferred route support is missing" };
    });
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      authBootstrap: "harness",
      supports,
    });
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "api-key",
      source: "none",
    });

    await expect(runSideQuestion({ provider: "openai", model: "gpt-5.5" })).resolves.toEqual({
      text: "Codex side answer.",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    const preparedRuntimeAuth = (
      mockArg(codexSideQuestionMock, 0, 0) as {
        preparedRuntimeAuth?: {
          plan?: AgentRuntimeAuthPlan;
          authProfileStore?: { profiles?: Record<string, unknown> };
          resolvedApiKey?: string;
        };
      }
    ).preparedRuntimeAuth;
    expect(preparedRuntimeAuth?.plan).toMatchObject({
      harnessAuthProvider: "openai",
    });
    expect(preparedRuntimeAuth?.plan?.forwardedAuthProfileId).toBeUndefined();
    expect(preparedRuntimeAuth?.resolvedApiKey).toBeUndefined();
    expect(Object.keys(preparedRuntimeAuth?.authProfileStore?.profiles ?? {})).toEqual([]);
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: { source: "harness" },
        }),
      }),
    );
  });

  it("hands a Codex side question the resolved Platform backup after subscription failure", async () => {
    const supports = vi.fn(supportsPreparedOpenAIAuth);
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports,
    });
    const subscriptionModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:subscription": {
          type: "token",
          provider: "openai",
          token: "unresolved-token",
          expires: Date.now() + 60_000,
        },
        "openai:platform": {
          type: "api_key",
          provider: "openai",
          key: "platform-key",
        },
      },
      order: { openai: ["openai:subscription", "openai:platform"] },
    });
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileId?: string },
      ) => ({
        model: options?.authProfileId === "openai:subscription" ? subscriptionModel : platformModel,
      }),
    );
    getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string }) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      return {
        apiKey: "platform-key",
        mode: "api-key",
        source: "profile:openai:platform",
        profileId: "openai:platform",
      };
    });

    await expect(
      runSideQuestion({
        cfg: {
          auth: {
            order: { openai: ["openai:subscription", "openai:platform"] },
          },
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).resolves.toEqual({ text: "Codex side answer." });

    const sideQuestionParams = mockArg(codexSideQuestionMock, 0, 0) as {
      authProfileId?: string;
      runtimeModel?: { api?: string; baseUrl?: string };
      preparedRuntimeAuth?: {
        resolvedApiKey?: string;
        plan?: { modelRoute?: { authRequirement?: string } };
        authProfileStore?: { profiles?: Record<string, unknown> };
      };
    };
    expect(sideQuestionParams.runtimeModel).toMatchObject(platformModel);
    expect(sideQuestionParams.authProfileId).toBeUndefined();
    expect(sideQuestionParams.preparedRuntimeAuth).toMatchObject({
      resolvedApiKey: "platform-key",
      plan: { modelRoute: { authRequirement: "api-key" } },
    });
    expect(
      Object.keys(sideQuestionParams.preparedRuntimeAuth?.authProfileStore?.profiles ?? {}),
    ).toEqual([]);
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(supports).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: expect.objectContaining({
          preparedAuth: {
            source: "profile",
            mode: "api-key",
            requirement: "api-key",
          },
        }),
      }),
    );
  });

  it("uses registry ownership and closes host capabilities when a BTW hook rejects", async () => {
    registerAgentHarness(
      {
        id: "spoofed",
        label: "Spoofed BTW harness",
        pluginId: "codex",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: vi.fn(),
        runSideQuestion: vi.fn().mockRejectedValue(new Error("side question failed")),
      },
      { ownerPluginId: "actual-owner" },
    );

    await expect(runSideQuestion()).rejects.toThrow("side question failed");

    expect(createAgentHarnessHostCapabilitiesMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "actual-owner" }),
    );
    expect(closeAgentHarnessHostCapabilitiesMock).toHaveBeenCalledOnce();
  });

  it("reselects the Codex hook after resolving legacy openai-codex route state", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness({
      supports: (ctx) =>
        ctx.provider === "openai"
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "openai only" },
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    resolveSessionAuthSelectionMock.mockResolvedValue({
      profileId: "openai-codex:user@example.test",
      source: "auto",
      routeRequirement: "subscription",
    });
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:user@example.test": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai-codex:user@example.test"] },
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "subscription-token",
      mode: "oauth",
      source: "profile:openai-codex:user@example.test",
      profileId: "openai-codex:user@example.test",
    });

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: {
            openai: ["openai-codex:user@example.test"],
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      } as never,
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Codex side answer." });
    expect(codexSideQuestionMock).toHaveBeenCalledTimes(1);
    const sideQuestionParams = mockArg(codexSideQuestionMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      runtimeModel?: { api?: string; baseUrl?: string };
      preparedRuntimeAuth?: {
        plan?: { modelRoute?: { api?: string; baseUrl?: string; authRequirement?: string } };
        authProfileStore?: { profiles?: Record<string, unknown> };
      };
    };
    expect(sideQuestionParams.provider).toBe("openai");
    expect(sideQuestionParams.authProfileId).toBe("openai-codex:user@example.test");
    expect(sideQuestionParams.runtimeModel).toMatchObject({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(sideQuestionParams.preparedRuntimeAuth?.plan?.modelRoute).toMatchObject({
      api: sideQuestionParams.runtimeModel?.api,
      baseUrl: sideQuestionParams.runtimeModel?.baseUrl,
      authRequirement: "subscription",
    });
    expect(
      Object.keys(sideQuestionParams.preparedRuntimeAuth?.authProfileStore?.profiles ?? {}),
    ).toEqual(["openai-codex:user@example.test"]);
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("prepares deny-all sender policy before calling a plugin side-question hook", async () => {
    const codexSideQuestionMock = registerCodexSideQuestionHarness();
    mockOpenAIPlatformProfile();
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "openai",
        id: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    });
    await runSideQuestion({
      cfg: {
        channels: {
          telegram: {
            groups: {
              "deny-room": {
                toolsBySender: {
                  "id:restricted-sender": { deny: ["*"] },
                },
              },
            },
          },
        },
      } as never,
      provider: "openai",
      model: "gpt-5.5",
      sessionKey: "agent:main:telegram:group:deny-room",
      messageProvider: "telegram",
      groupId: "deny-room",
      senderId: "restricted-sender",
    });

    expect(codexSideQuestionMock).toHaveBeenCalledOnce();
    expect(mockArg(codexSideQuestionMock, 0, 0)).toMatchObject({ toolsAllow: [] });
  });

  it("does not fall back to the direct provider call when Codex lacks BTW support", async () => {
    registerAgentHarness({
      id: "codex",
      label: "Codex test harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });

    await expect(
      runSideQuestion({
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).rejects.toThrow('Selected agent harness "codex" does not support /btw side questions.');
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("keeps the direct provider fallback for non-Codex harnesses without side-question hooks", async () => {
    registerAgentHarness({
      id: "custom",
      label: "Custom test harness",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: vi.fn(),
    });
    mockDoneAnswer("Direct fallback answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Direct fallback answer." });
    expect(streamSimpleMock).toHaveBeenCalledTimes(1);
  });

  it("loads a cold Copilot harness before selecting the /btw provider fallback", async () => {
    let loaded = false;
    ensureSelectedAgentHarnessPluginMock.mockImplementation(async () => {
      if (loaded) {
        return;
      }
      loaded = true;
      registerAgentHarness({
        id: "copilot",
        label: "Copilot test harness",
        supports: () => ({ supported: true, priority: 100 }),
        runAttempt: vi.fn(),
      });
    });
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "github-copilot",
      id: "gpt-4o",
      api: "openai-completions",
    });
    mockDoneAnswer("Copilot fallback answer.");

    const result = await runSideQuestion({
      cfg: {
        agents: {
          defaults: {
            models: {
              "github-copilot/gpt-4o": { agentRuntime: { id: "copilot" } },
            },
          },
        },
      } as never,
      provider: "github-copilot",
      model: "gpt-4o",
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Copilot fallback answer." });
    expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledOnce();
    expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        modelId: "gpt-4o",
        config: expect.any(Object),
        agentId: "main",
        sessionKey: DEFAULT_SESSION_KEY,
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(streamSimpleMock).toHaveBeenCalledOnce();
  });

  it("runs CLI-runtime alias BTW as an ephemeral CLI side question", async () => {
    const { cleanup, prepared } = mockCliOutput({ text: "CLI side answer." });

    const result = await runSideQuestion({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as never,
      model: "claude-opus-4-7",
      sessionKey: DEFAULT_SESSION_KEY,
      authorityRunId: "btw-cli-authority",
      opts: { runId: "parent-correlation" },
    });

    expect(result).toEqual({ text: "CLI side answer." });
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      executionMode?: string;
      provider?: string;
      model?: string;
      disableTools?: boolean;
      cliSessionId?: string;
      extraSystemPrompt?: string;
      prompt?: string;
    };
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.model).toBe("claude-opus-4-7");
    expect(prepareParams.disableTools).toBe(true);
    expect(prepareParams).toMatchObject({ runId: "btw-cli-authority" });
    expect(prepareParams.cliSessionId).toBeUndefined();
    expect(prepareParams.extraSystemPrompt).toContain("Answer only the side question");
    expect(prepareParams.prompt).toContain("<conversation_history>");
    expect(prepareParams.prompt).toContain("<btw_side_question>");
    expect(executePreparedCliRunMock).toHaveBeenCalledWith(prepared);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
    expect(registerProviderStreamForModelMock).not.toHaveBeenCalled();
  });

  it("preserves the explicit no-timeout override for CLI-runtime BTW", async () => {
    mockCliOutput({ text: "CLI side answer." });

    await runSideQuestion({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      } as never,
      model: "claude-opus-4-7",
      opts: { timeoutOverrideSeconds: 0 },
      sessionKey: DEFAULT_SESSION_KEY,
    });

    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      timeoutMs?: unknown;
      runTimeoutOverrideMs?: unknown;
    };
    expect(prepareParams.timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(prepareParams.runTimeoutOverrideMs).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("runs auth-order-selected CLI BTW through the CLI side-question path", async () => {
    const { cleanup } = mockCliOutput({ text: "CLI auth-order side answer." });

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli" },
          },
        },
      } as never,
      model: "claude-opus-4-7",
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "CLI auth-order side answer." });
    expect(prepareCliRunContextMock).toHaveBeenCalledTimes(1);
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      executionMode?: string;
      provider?: string;
      disableTools?: boolean;
    };
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.disableTools).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("does not expose raw CLI BTW output when transformed text is empty", async () => {
    const { cleanup } = mockCliOutput({
      text: "   ",
      rawText: "raw untransformed answer",
    });

    await expect(
      runSideQuestion({
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        } as never,
        model: "claude-opus-4-7",
        sessionKey: DEFAULT_SESSION_KEY,
      }),
    ).rejects.toThrow("/btw side question via claude-cli produced no answer");

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("does not let an auto-selected stale direct profile suppress auth-order CLI BTW", async () => {
    const { cleanup } = mockCliOutput({ text: "Claude CLI answer." });

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry: createSessionEntry({
        authProfileOverride: "anthropic:api",
        authProfileOverrideSource: "auto",
      }),
    });

    expect(result).toEqual({ text: "Claude CLI answer." });
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      executionMode?: string;
    };
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.authProfileId).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("preserves auto-selected session CLI BTW routing before resolving runtime auth", async () => {
    const { cleanup } = mockCliOutput({ text: "Session Claude CLI answer." });
    const sessionEntry = createSessionEntry({
      authProfileOverride: "anthropic:auto-cli",
      authProfileOverrideSource: "auto",
    });
    const sessionStore = { [DEFAULT_SESSION_KEY]: sessionEntry };
    resolveSessionAuthSelectionMock.mockImplementation(
      async (params: { sessionEntry?: SessionEntry }) => {
        if (params.sessionEntry) {
          params.sessionEntry.authProfileOverride = "anthropic:api";
          params.sessionEntry.authProfileOverrideSource = "auto";
        }
        return {
          profileId: "anthropic:api",
          source: "auto",
          routeRequirement: "api-key",
        };
      },
    );
    mockDoneAnswer("Generic fallback answer.");

    const result = await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:auto-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry,
      sessionStore,
      sessionKey: DEFAULT_SESSION_KEY,
    });

    expect(result).toEqual({ text: "Session Claude CLI answer." });
    const prepareParams = mockArg(prepareCliRunContextMock, 0, 0) as {
      provider?: string;
      authProfileId?: string;
      executionMode?: string;
    };
    expect(prepareParams.provider).toBe("claude-cli");
    expect(prepareParams.executionMode).toBe("side-question");
    expect(prepareParams.authProfileId).toBe("anthropic:auto-cli");
    expect(resolveSessionAuthSelectionMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getApiKeyForModelMock).not.toHaveBeenCalled();
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("loads Claude CLI auth for BTW from persisted auth-store order", async () => {
    const staticAuthStore = {
      version: 1 as const,
      profiles: {},
      order: { anthropic: ["anthropic:claude-cli"] },
    };
    const claudeAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth" as const,
          provider: "claude-cli",
          access: "claude-cli-access",
          refresh: "claude-cli-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValueOnce(staticAuthStore);
    ensureAuthProfileStoreMock.mockReturnValueOnce(claudeAuthStore);
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "claude-cli-access",
      mode: "oauth",
      source: "profile:anthropic:claude-cli",
      profileId: "anthropic:claude-cli",
    });
    requireApiKeyMock.mockReturnValueOnce("claude-cli-access");
    resolveSessionAuthSelectionMock.mockResolvedValueOnce(undefined);
    resolveModelAsyncMock.mockResolvedValueOnce({
      model: {
        provider: DEFAULT_PROVIDER,
        id: DEFAULT_MODEL,
        api: "anthropic-messages",
      },
    });
    mockDoneAnswer("Claude CLI answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Claude CLI answer." });
    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).toHaveBeenCalledWith(
      DEFAULT_AGENT_DIR,
      { allowKeychainPrompt: false },
    );
    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(DEFAULT_AGENT_DIR, {
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expect(getApiKeyForModelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "anthropic:claude-cli",
        store: claudeAuthStore,
      }),
    );
  });

  it("rematerializes the direct model when automatic auth rotates to a SecretRef backup", async () => {
    const authStorage = { id: "btw-auth-storage" };
    const modelRegistry = { id: "btw-model-registry" };
    const authStore = {
      version: 1 as const,
      profiles: {
        "anthropic:primary": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "primary-key",
        },
        "anthropic:backup": {
          type: "api_key" as const,
          provider: "anthropic",
          keyRef: {
            source: "file" as const,
            provider: "vault",
            id: "/anthropic/backup",
          },
        },
      },
      order: { anthropic: ["anthropic:primary", "anthropic:backup"] },
    };
    const rotatedModel = {
      provider: "anthropic",
      id: DEFAULT_MODEL,
      api: "anthropic-messages" as const,
      baseUrl: "https://backup.example.test",
      name: "Backup profile model",
    };
    discoverAuthStorageMock.mockReturnValue(authStorage);
    discoverModelsMock.mockReturnValue(modelRegistry);
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "anthropic",
      id: DEFAULT_MODEL,
      api: "anthropic-messages",
      baseUrl: "https://primary.example.test",
      name: "Primary profile model",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: rotatedModel,
      authStorage,
      modelRegistry,
    });
    ensureAuthProfileStoreWithoutExternalProfilesMock.mockReturnValue(authStore);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string } = {}) => {
      if (authParams.profileId === "anthropic:primary") {
        throw new Error("primary credential resolution failed");
      }
      if (authParams.profileId === "anthropic:backup") {
        return {
          apiKey: mintSecretSentinel("backup-secret", { label: "btw-backup" }),
          mode: "api-key",
          source: "profile:anthropic:backup",
          profileId: "anthropic:backup",
        };
      }
      throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
    });
    requireApiKeyMock.mockReturnValue("backup-secret");
    mockDoneAnswer("Backup answer.");

    await expect(
      runSideQuestion({
        cfg: {
          secrets: {
            providers: {
              vault: { source: "file", path: "/tmp/btw-secrets.json", mode: "json" },
            },
          },
        } as never,
      }),
    ).resolves.toEqual({ text: "Backup answer." });

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["anthropic:primary", "anthropic:backup"]);
    expect(resolveModelAsyncMock).toHaveBeenCalledWith(
      "anthropic",
      DEFAULT_MODEL,
      DEFAULT_AGENT_DIR,
      expect.any(Object),
      expect.objectContaining({
        authStorage,
        modelRegistry,
        authProfileId: "anthropic:backup",
        authProfileMode: "api_key",
        preparedModelRuntime: expect.objectContaining({
          configuredRuntimeModels: [],
          inlineProviderModels: [],
        }),
        skipAgentDiscovery: true,
      }),
    );
    const preparedAuthContext = expectRecordFields(
      (mockArg(prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        provider: "anthropic",
        modelId: DEFAULT_MODEL,
        model: rotatedModel,
        profileId: "anthropic:backup",
      },
    );
    expect(preparedAuthContext.apiKey).toBe("backup-secret");
    expectRecordFields(mockArg(streamSimpleMock, 0, 0), {
      name: "Backup profile model",
      baseUrl: "https://backup.example.test",
    });
  });

  it("falls through an unresolved subscription route to the ordered Platform route", async () => {
    const authStorage = { id: "btw-openai-auth-storage" };
    const modelRegistry = { id: "btw-openai-model-registry" };
    const subscriptionModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      name: "Subscription model",
    };
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      name: "Platform model",
    };
    const authStore = {
      version: 1 as const,
      profiles: {
        "openai:subscription": {
          type: "token" as const,
          provider: "openai",
          token: "unresolved-subscription-token",
          expires: Date.now() + 60_000,
        },
        "openai:platform": {
          type: "api_key" as const,
          provider: "openai",
          key: "platform-key",
        },
      },
      order: { openai: ["openai:subscription", "openai:platform"] },
    };
    discoverAuthStorageMock.mockReturnValue(authStorage);
    discoverModelsMock.mockReturnValue(modelRegistry);
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockImplementation(
      async (
        _provider: string,
        _modelId: string,
        _agentDir: string,
        _config: unknown,
        options?: { authProfileId?: string },
      ) => ({
        model: options?.authProfileId === "openai:subscription" ? subscriptionModel : platformModel,
        authStorage,
        modelRegistry,
      }),
    );
    ensureAuthProfileStoreMock.mockReturnValue(authStore);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    getApiKeyForModelMock.mockImplementation(async (authParams: { profileId?: string } = {}) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      if (authParams.profileId === "openai:platform") {
        return {
          apiKey: "platform-key",
          mode: "api-key",
          source: "profile:openai:platform",
          profileId: "openai:platform",
        };
      }
      throw new Error(`unexpected profile: ${authParams.profileId ?? "none"}`);
    });
    requireApiKeyMock.mockReturnValue("platform-key");
    mockDoneAnswer("Platform fallback answer.");

    await expect(
      runSideQuestion({
        cfg: {
          auth: {
            order: { openai: ["openai:subscription", "openai:platform"] },
          },
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Platform fallback answer." });

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([authParams]) => (authParams as { profileId?: string }).profileId,
      ),
    ).toEqual(["openai:subscription", "openai:platform"]);
    expect(
      resolveModelAsyncMock.mock.calls.map(
        (call) => (call[4] as { authProfileId?: string }).authProfileId,
      ),
    ).toEqual(["openai:subscription", "openai:platform"]);
    expectRecordFields(mockArg(streamSimpleMock, 0, 0), {
      name: "Platform model",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it("uses a same-route literal fallback only after its prepared profile tier fails", async () => {
    const platformModel = {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      name: "Platform model",
    };
    const authStore = {
      version: 1 as const,
      profiles: {
        "openai:broken": {
          type: "api_key" as const,
          provider: "openai",
          key: "broken-profile-key",
        },
      },
      order: { openai: ["openai:broken"] },
    };
    resolveModelWithRegistryMock.mockReturnValue(platformModel);
    resolveModelAsyncMock.mockResolvedValue({ model: platformModel });
    ensureAuthProfileStoreMock.mockReturnValue(authStore);
    resolveSessionAuthSelectionMock.mockResolvedValue(undefined);
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    getApiKeyForModelMock.mockImplementation(
      async (authParams: { profileId?: string; allowAuthProfileFallback?: boolean }) => {
        if (authParams.profileId === "openai:broken") {
          throw new Error("profile key could not be resolved");
        }
        if (authParams.profileId === undefined && authParams.allowAuthProfileFallback === false) {
          return {
            apiKey: "literal-key",
            mode: "api-key",
            source: "models.json",
          };
        }
        throw new Error("unexpected auth lookup");
      },
    );
    requireApiKeyMock.mockReturnValue("literal-key");
    mockDoneAnswer("Literal fallback answer.");

    await expect(
      runSideQuestion({
        cfg: {
          auth: { order: { openai: ["openai:broken"] } },
          models: {
            providers: {
              openai: { apiKey: "literal-key" },
            },
          },
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).resolves.toEqual({ text: "Literal fallback answer." });

    expect(
      getApiKeyForModelMock.mock.calls.map(([authParams]) => {
        const lookup = authParams as {
          profileId?: string;
          allowAuthProfileFallback?: boolean;
        };
        return {
          profileId: lookup.profileId,
          allowAuthProfileFallback: lookup.allowAuthProfileFallback,
        };
      }),
    ).toEqual([
      { profileId: "openai:broken", allowAuthProfileFallback: undefined },
      { profileId: undefined, allowAuthProfileFallback: false },
    ]);
    expectRecordFields(mockArg(streamSimpleMock, 0, 0), {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
  });

  it.each([
    { label: "explicit", source: "user" as const },
    { label: "legacy source-less", source: undefined },
  ])("keeps $label user-pinned static Anthropic auth first for BTW", async ({ source }) => {
    const staticAuthStore = {
      version: 1 as const,
      profiles: {
        "anthropic:api": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "static-key",
        },
      },
    };
    ensureAuthProfileStoreMock.mockReturnValueOnce(staticAuthStore);
    getApiKeyForModelMock.mockResolvedValueOnce({
      apiKey: "static-key",
      mode: "api-key",
      source: "profile:anthropic:api",
      profileId: "anthropic:api",
    });
    requireApiKeyMock.mockReturnValueOnce("static-key");
    resolveSessionAuthSelectionMock.mockResolvedValueOnce({
      profileId: "anthropic:api",
      source: "user",
      routeRequirement: "api-key",
    });
    mockDoneAnswer("Static answer.");

    await runSideQuestion({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      } as never,
      sessionEntry: createSessionEntry({
        authProfileOverride: "anthropic:api",
        authProfileOverrideSource: source,
      }),
    });

    expect(ensureAuthProfileStoreWithoutExternalProfilesMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).toHaveBeenCalledWith(DEFAULT_AGENT_DIR, {
      profileId: "anthropic:api",
      externalCliProviderIds: ["claude-cli"],
      allowKeychainPrompt: false,
    });
    expectRecordFields(mockArg(getApiKeyForModelMock, 0, 0), {
      profileId: "anthropic:api",
      store: staticAuthStore,
    });
    expectRecordFields(
      (mockArg(prepareProviderRuntimeAuthMock, 0, 0) as { context?: unknown }).context,
      {
        profileId: "anthropic:api",
        authMode: "api-key",
      },
    );
  });

  it("applies provider runtime auth before streaming github-copilot BTW questions", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "github-copilot",
      id: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    resolveModelAsyncMock.mockResolvedValue({
      model: {
        provider: "github-copilot",
        id: "gpt-5.4",
        api: "openai-responses",
        baseUrl: "https://api.individual.githubcopilot.com",
      },
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "github-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:github",
    });
    requireApiKeyMock.mockReturnValue("github-token");
    prepareProviderRuntimeAuthMock.mockResolvedValue({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    mockDoneAnswer("Copilot answer.");

    const result = await runSideQuestion({
      provider: "github-copilot",
      model: "gpt-5.4",
    });

    expect(result).toEqual({ text: "Copilot answer." });
    const runtimeAuthParams = expectRecordFields(mockArg(prepareProviderRuntimeAuthMock, 0, 0), {
      provider: "github-copilot",
      workspaceDir: "/tmp/workspace",
    });
    expectRecordFields(runtimeAuthParams.context, {
      provider: "github-copilot",
      modelId: "gpt-5.4",
      workspaceDir: "/tmp/workspace",
      apiKey: "github-token",
      authMode: "token",
      profileId: "github-copilot:github",
    });
    const [streamModel, , streamOptions] = mockCall(streamSimpleMock);
    expectRecordFields(streamModel, {
      provider: "github-copilot",
      id: "gpt-5.4",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    const streamKey = (streamOptions as { apiKey?: string }).apiKey ?? "";
    expect(looksLikeSecretSentinel(streamKey)).toBe(true);
    expect(streamKey).not.toBe("copilot-runtime-token");
    expect(resolveSecretSentinel(streamKey)).toBe("copilot-runtime-token");
  });

  it("uses the provider's stream fn when registered so provider URL construction runs (#68336)", async () => {
    // Regression: before this fix, /btw called streamSimple directly and
    // bypassed the provider's createStreamFn/wrapStreamFn hooks. That caused
    // Ollama Cloud (api: "openai-completions", baseUrl: "https://ollama.com/")
    // to hit the marketing site instead of /v1/chat/completions.
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "ollama",
      id: "glm-5.1",
      api: "openai-completions",
      baseUrl: "https://ollama.com/",
    });
    const providerStreamFn = vi
      .fn()
      .mockReturnValue(makeAsyncEvents([createDoneEvent("Ollama Cloud answer.")]));
    registerProviderStreamForModelMock.mockReturnValue(providerStreamFn);

    const result = await runSideQuestion({ provider: "ollama", model: "glm-5.1" });

    expect(result).toEqual({ text: "Ollama Cloud answer." });
    const registerParams = expectRecordFields(mockArg(registerProviderStreamForModelMock, 0, 0), {
      workspaceDir: "/tmp/workspace",
    });
    expectRecordFields(registerParams.model, {
      provider: "ollama",
      api: "openai-completions",
      baseUrl: "https://ollama.com/",
    });
    expect(providerStreamFn).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("routes MiniMax Anthropic fallback streams through the embedded resolver", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "minimax-portal",
      id: "MiniMax-M2.7",
      api: "anthropic-messages",
      baseUrl: "https://api.minimax.io/anthropic",
      maxTokens: 196_608,
    });
    registerProviderStreamForModelMock.mockReturnValue(undefined);
    const resolvedStreamFn = vi
      .fn()
      .mockReturnValue(makeAsyncEvents([createDoneEvent("MiniMax answer.")]));
    resolveEmbeddedAgentStreamMock.mockReturnValueOnce({
      streamFn: resolvedStreamFn,
      strategy: "boundary-aware:anthropic-messages",
    });

    const result = await runSideQuestion({
      provider: "minimax-portal",
      model: "MiniMax-M2.7",
    });

    expect(result).toEqual({ text: "MiniMax answer." });
    const resolverParams = expectRecordFields(mockArg(resolveEmbeddedAgentStreamMock, 0, 0), {
      sessionId: "session-1",
      resolvedApiKey: "secret",
      authProfileId: undefined,
    });
    expect(resolverParams.providerStreamFn).toBeUndefined();
    expectRecordFields(resolverParams.model, {
      provider: "minimax-portal",
      id: "MiniMax-M2.7",
      api: "anthropic-messages",
      maxTokens: 196_608,
    });
    expect(resolvedStreamFn).toHaveBeenCalledTimes(1);
    expect(streamSimpleMock).not.toHaveBeenCalled();
  });

  it("uses the embedded resolver fallback when no provider stream fn is registered", async () => {
    registerProviderStreamForModelMock.mockReturnValue(undefined);
    mockDoneAnswer("Fallback answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Fallback answer." });
    expect(resolveEmbeddedAgentStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentStreamFn: expect.any(Function),
        providerStreamFn: undefined,
        sessionId: "session-1",
        resolvedApiKey: "secret",
        authProfileId: undefined,
      }),
    );
    expect(streamSimpleMock).toHaveBeenCalledTimes(1);
  });

  it("strips injected empty tools arrays from BTW payloads before sending", async () => {
    mockDoneAnswer("Final answer.");

    await runSideQuestion();

    const options = mockArg(streamSimpleMock, 0, 2);
    const onPayload = (options as { onPayload?: (payload: unknown) => void })?.onPayload;
    const payloadWithEmptyTools = { messages: [], tools: [] as unknown[] };

    const result = onPayload?.(payloadWithEmptyTools);

    expect(payloadWithEmptyTools).not.toHaveProperty("tools");
    expect(result).toBeUndefined();
  });

  it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      provider: "amazon-bedrock",
      id: "us.anthropic.claude-sonnet-4-5-v1:0",
      api: "anthropic-messages",
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent("Bedrock answer.")]));

    const result = await runBtwSideQuestion({
      cfg: {} as never,
      agentId: "main",
      agentDir: DEFAULT_AGENT_DIR,
      provider: "amazon-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-v1:0",
      question: DEFAULT_QUESTION,
      sessionEntry: createSessionEntry(),
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: DEFAULT_STORE_PATH,
      resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
      opts: {},
      isNewSession: false,
    });

    expect(result).toEqual({ text: "Bedrock answer." });
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    const options = streamSimpleMock.mock.calls.at(-1)?.[2];
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("forces provider reasoning off even when the session think level is adaptive", async () => {
    streamSimpleMock.mockImplementation((_model, _input, options?: { reasoning?: unknown }) => {
      return options?.reasoning === undefined
        ? makeAsyncEvents([createDoneEvent("Final answer.")])
        : makeAsyncEvents([createThinkingOnlyDoneEvent("thinking only")]);
    });

    const result = await runSideQuestion({ resolvedThinkLevel: "adaptive" });

    expect(result).toEqual({ text: "Final answer." });
    const options = mockArg(streamSimpleMock, 0, 2);
    expect((options as { reasoning?: unknown } | undefined)?.reasoning).toBeUndefined();
  });

  it("fails when the current branch has no messages", async () => {
    clearBuiltSessionMessages();
    streamSimpleMock.mockReturnValue(makeAsyncEvents([]));

    await expect(runSideQuestion()).rejects.toThrow("No active session context.");
  });

  it("uses active-run snapshot messages for BTW context while the main run is in flight", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-1",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "write some things then wait 30 seconds and write more" },
          ],
          timestamp: 1,
        },
      ],
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    const context = streamContext();
    expect(String(context.systemPrompt)).toContain("ephemeral /btw side question");
    const messages = contextMessages(context);
    expect(messages.some((message) => message.role === "user")).toBe(true);
    const sideQuestionMessage = messages.find(
      (message) =>
        message.role === "user" &&
        firstTextBlockIncludes(
          message,
          `<btw_side_question>\n${MATH_QUESTION}\n</btw_side_question>`,
        ),
    );
    if (!sideQuestionMessage) {
      throw new Error("Expected BTW side question message");
    }
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
      messages: [],
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
    });
    mockDoneAnswer("You're building a tic-tac-toe game in Brainfuck.");

    const result = await runSideQuestion({ question: "what are we doing?" });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    const [message] = contextMessages(streamContext());
    expectRecordFields(message, { role: "user" });
    expectTextBlockContains(
      expectDefined(
        (expectDefined(message, "message test invariant").content as Array<unknown>)[0],
        "(message.content as Array<unknown>)[0] test invariant",
      ),
      "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
    );
  });

  it("wraps the side question so the model does not treat it as a main-task continuation", async () => {
    mockDoneAnswer("About 93 million miles.");

    await runSideQuestion({ question: "what is the distance to the sun?" });

    const context = streamContext();
    expect(String(context.systemPrompt)).toContain(
      "Do not continue, resume, or complete any unfinished task",
    );
    const sideQuestionMessage = contextMessages(context).find(
      (message) =>
        message.role === "user" &&
        firstTextBlockIncludes(
          message,
          "Ignore any unfinished task in the conversation while answering it.",
        ),
    );
    if (!sideQuestionMessage) {
      throw new Error("Expected isolated side question message");
    }
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    const assistantEntry = createTranscriptEntry({
      id: "assistant-1",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    const trailingUserEntry = createTranscriptEntry({
      id: "user-2",
      parentId: "assistant-1",
      message: createUserTranscriptMessage([{ type: "text", text: "unfinished task" }]),
    });
    mockTranscriptEntries([assistantEntry, trailingUserEntry]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("branches to the active run snapshot leaf when the session is busy", async () => {
    const userEntry = createTranscriptEntry({
      id: "user-seed",
      message: createUserTranscriptMessage(),
    });
    const assistantEntry = createTranscriptEntry({
      id: "assistant-seed",
      parentId: "user-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    const newerEntry = createTranscriptEntry({
      id: "newer-user",
      parentId: "assistant-seed",
      message: createUserTranscriptMessage([{ type: "text", text: "newer unfinished task" }]),
    });
    mockTranscriptEntries([userEntry, assistantEntry, newerEntry]);
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-seed",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("reads SQLite marker transcripts through the accessor when no active snapshot exists", async () => {
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp",
    };
    const userEntry = createTranscriptEntry({
      id: "user-seed",
      message: createUserTranscriptMessage(),
    });
    const assistantEntry = createTranscriptEntry({
      id: "assistant-seed",
      parentId: "user-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    loadTranscriptEventsMock.mockResolvedValue([header, userEntry, assistantEntry]);
    readFileMock.mockRejectedValue(new Error("sqlite marker must not be read as a file"));
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion({
      sessionKey: DEFAULT_SESSION_KEY,
      sessionEntry: createSessionEntry(),
      storePath: DEFAULT_STORE_PATH,
    });

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(loadTranscriptEventsMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: DEFAULT_STORE_PATH,
    });
    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
  });

  it("rejects a supplied session key that disagrees with an incomplete SQLite marker target", async () => {
    const markerStorePath = "/tmp/marker-sessions.sqlite";
    listSessionEntriesCoreMock.mockReturnValue([
      {
        sessionKey: "agent:main:matching",
        entry: createSessionEntry(),
      },
    ]);
    loadSessionEntryMock.mockReturnValue(createSessionEntry({ sessionId: "different-session" }));

    await expect(
      runMathSideQuestion({
        sessionEntry: createSessionEntry({
          sessionFile: `sqlite:main:session-1:${markerStorePath}`,
        }),
        storePath: undefined,
      }),
    ).rejects.toThrow("No active session context.");

    expect(listSessionEntriesCoreMock).toHaveBeenCalledWith({
      agentId: "main",
      storePath: markerStorePath,
    });
    expect(loadSessionEntryMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: DEFAULT_SESSION_KEY,
      storePath: markerStorePath,
    });
    expect(loadTranscriptEventsMock).not.toHaveBeenCalled();
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    const userEntry = createTranscriptEntry({
      id: "user-seed",
      message: createUserTranscriptMessage(),
    });
    const assistantEntry = createTranscriptEntry({
      id: "assistant-seed",
      parentId: "user-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    mockTranscriptEntries([userEntry, assistantEntry]);
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
    expect(diagDebugMock).toHaveBeenCalledWith(
      "btw snapshot leaf unavailable: sessionId=session-1 leaf=assistant-gone",
    );
  });

  it("honors an explicitly empty active run snapshot", async () => {
    const userEntry = createTranscriptEntry({
      id: "user-seed",
      message: createUserTranscriptMessage(),
    });
    const assistantEntry = createTranscriptEntry({
      id: "assistant-seed",
      parentId: "user-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    mockTranscriptEntries([userEntry, assistantEntry]);
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: null,
    });

    await expect(runMathSideQuestion()).rejects.toThrow("No active session context.");

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([]);
  });

  it("uses the branch selected by a terminal transcript leaf control", async () => {
    const userEntry = createTranscriptEntry({
      id: "user-seed",
      message: createUserTranscriptMessage(),
    });
    const assistantEntry = createTranscriptEntry({
      id: "assistant-seed",
      parentId: "user-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    const sideEntry = createTranscriptEntry({
      id: "side-delivery",
      parentId: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "side delivery" }]),
    });
    const leafEntry = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-delivery",
      targetId: "assistant-seed",
    };
    mockTranscriptEntries([userEntry, assistantEntry, sideEntry, leafEntry]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(buildSessionContextMock).toHaveBeenCalledWith([userEntry, assistantEntry]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("keeps parentless history addressed by a terminal leaf control", async () => {
    const userEntry = {
      type: "message",
      id: "user-seed",
      message: createUserTranscriptMessage(),
    };
    const assistantEntry = {
      type: "message",
      id: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    };
    const sideEntry = createTranscriptEntry({
      id: "side-delivery",
      parentId: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "side delivery" }]),
    });
    const leafEntry = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-delivery",
      targetId: "assistant-seed",
    };
    mockTranscriptEntries([userEntry, assistantEntry, sideEntry, leafEntry]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledWith([
      { ...userEntry, parentId: null },
      { ...assistantEntry, parentId: "user-seed" },
    ]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("keeps visible history after continuing from a disjoint opaque append cursor", async () => {
    const userEntry = createTranscriptEntry({
      id: "user-seed",
      message: createUserTranscriptMessage(),
    });
    const assistantEntry = createTranscriptEntry({
      id: "assistant-seed",
      parentId: "user-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "seed answer" }]),
    });
    const sideEntry = createTranscriptEntry({
      id: "side-delivery",
      parentId: "assistant-seed",
      message: createAssistantTranscriptMessage([{ type: "text", text: "side delivery" }]),
    });
    const metadataEntry = {
      type: "metadata",
      id: "plugin-metadata",
      parentId: "side-delivery",
    };
    const leafEntry = {
      type: "leaf",
      id: "active-leaf",
      parentId: "side-delivery",
      targetId: "assistant-seed",
      appendParentId: "plugin-metadata",
    };
    const continuationEntry = createTranscriptEntry({
      id: "assistant-continuation",
      parentId: "plugin-metadata",
      message: createAssistantTranscriptMessage([{ type: "text", text: "continued answer" }]),
    });
    mockTranscriptEntries([
      userEntry,
      assistantEntry,
      sideEntry,
      metadataEntry,
      leafEntry,
      continuationEntry,
    ]);
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(buildSessionContextMock).toHaveBeenCalledWith([
      userEntry,
      assistantEntry,
      { ...continuationEntry, parentId: "assistant-seed" },
    ]);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("returns the BTW answer without transcript writes or persistence warnings", async () => {
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(diagDebugMock).not.toHaveBeenCalled();
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      {
        role: "toolResult",
        content: [{ type: "text", text: "sensitive tool output" }],
        details: { raw: "secret" },
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        timestamp: 3,
      },
    ]);
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const messages = contextMessages(streamContext());
    expect(messages).toHaveLength(3);
    expectRecordFields(messages[0], { role: "user" });
    expectRecordFields(messages[1], { role: "assistant" });
    expectRecordFields(messages[2], { role: "user" });
    expect(messages.some((message) => message.role === "toolResult")).toBe(false);
  });

  it("strips assistant tool calls from fallback BTW context so stale calls are not replayed", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [
          { type: "text", text: "Let me check." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
          { type: "toolUse", id: "call_legacy", name: "read", input: { path: "README.md" } },
          { type: "tool_call", id: "call_snake", name: "read", arguments: { path: "README.md" } },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const context = streamContext();
    expectSanitizedAssistantContext(context, "Let me check.");
    const assistantMessages = contextMessages(context).filter(
      (message) => message.role === "assistant",
    );
    const assistantContentTypes = assistantMessages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.map((block) => (block as { type?: unknown }).type)
        : [],
    );
    expect(assistantContentTypes).not.toContain("toolCall");
    expect(assistantContentTypes).not.toContain("toolUse");
    expect(assistantContentTypes).not.toContain("tool_call");
  });

  it("drops assistant messages that contain only tool calls", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });

  it("strips embedded user tool results from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage([
        { type: "text", text: "seed" },
        {
          type: "toolResult",
          toolUseId: "call_1",
          content: [{ type: "text", text: "secret" }],
        },
        {
          type: "tool_result",
          toolUseId: "call_2",
          content: [{ type: "text", text: "secret-2" }],
        },
      ]),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();
    expectSeedOnlyUserContext(context);
  });

  it("drops assistant thinking blocks from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [
          { type: "text", text: "Visible answer" },
          { type: "thinking", thinking: "Hidden chain of thought" },
        ],
        { output: 1 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectSanitizedAssistantContext(context, "Visible answer");
    const assistantContentTypes = contextMessages(context)
      .filter((message) => message.role === "assistant")
      .flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.map((block) => (block as { type?: unknown }).type)
          : [],
      );
    expect(assistantContentTypes).not.toContain("thinking");
  });

  it("drops thinking-only assistant messages from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        [{ type: "thinking", thinking: "Hidden chain of thought" }],
        { output: 1 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });

  it("drops malformed user image blocks from BTW context", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage([
        { type: "text", text: "seed" },
        { type: "image", mimeType: "image/png" },
      ]),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();
    expectSeedOnlyUserContext(context);
  });

  it("normalizes malformed assistant content before stripping tool blocks", async () => {
    mockActiveTranscript([
      createUserTranscriptMessage(),
      createAssistantTranscriptMessage(
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { stopReason: "toolUse", output: 0 },
      ),
    ]);

    const context = await runMathSideQuestionAndCaptureContext();

    expectNoAssistantMessages(context);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
