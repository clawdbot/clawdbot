// Isolated run test harness builds cron run inputs, mocks, and assertions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { vi, type Mock } from "vitest";
import { resolveFastModeState as resolveFastModeStateImpl } from "../../agents/fast-mode.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";

// Central mock harness for isolated cron agent run orchestration tests.
type CronSessionEntry = {
  sessionId: string;
  updatedAt: number;
  systemSent: boolean;
  skillsSnapshot: unknown;
  model?: string;
  modelProvider?: string;
  [key: string]: unknown;
};

type CronSession = {
  storePath: string;
  store: Record<string, unknown>;
  sessionEntry: CronSessionEntry;
  lifecycleRevision: string;
  systemSent: boolean;
  isNewSession: boolean;
  [key: string]: unknown;
};

type SessionAccessorModule = typeof import("../../config/sessions/session-accessor.js");

let actualReplaceSessionEntry: SessionAccessorModule["replaceSessionEntry"];
let actualLoadSessionEntry: SessionAccessorModule["loadSessionEntry"];

function createMock(): Mock {
  return vi.fn();
}

function normalizeModelSelectionForTest(value: unknown): string | undefined {
  const direct = normalizeOptionalString(value);
  if (direct) {
    return direct;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return normalizeOptionalString((value as { primary?: unknown }).primary);
}

function usesRealAccessorStore(storePath?: string): boolean {
  return Boolean(storePath && storePath !== "/tmp/store.json");
}

export const buildWorkspaceSkillSnapshotMock = createMock();
export const resolveAgentConfigMock = createMock();
const resolveEffectiveModelFallbacksMock = createMock();
const resolveSubagentModelFallbacksOverrideMock = createMock();
export const resolveAgentModelFallbacksOverrideMock = createMock();
export const resolveAgentSkillsFilterMock = createMock();
const getModelRefStatusMock = createMock();
export const isCliProviderMock = createMock();
export const resolveCliRuntimeExecutionProviderMock = createMock();
export const resolveAllowedModelRefMock = createMock();
export const resolveConfiguredModelRefMock = createMock();
const resolveHooksGmailModelMock = createMock();
export const resolveThinkingDefaultMock = createMock();
export const resolveEffectiveAgentRuntimeMock = createMock();
export const runWithModelFallbackMock = createMock();
export const runEmbeddedAgentMock = createMock();
export const runCliAgentMock = createMock();
export const lookupContextTokensMock = createMock();
export const getCliSessionBindingMock = createMock();
const getCliSessionIdMock = createMock();
export const clearCliSessionMock = createMock();
export const setCliSessionBindingMock = createMock();
export const loadSessionEntryMock = createMock();
const replaceSessionEntryMock = createMock();
export const patchSessionEntryMock = createMock();
export const resolveCronSessionMock = createMock();
export const logWarnMock = createMock();
export const countActiveDescendantRunsMock = createMock();
export const listDescendantRunsForRequesterMock = createMock();
export const pickLastNonEmptyTextFromPayloadsMock = createMock();
export const resolveCronPayloadOutcomeMock = createMock();
export const resolveCronDeliveryPlanMock = createMock();
export const resolveDeliveryTargetMock = createMock();
export const dispatchCronDeliveryMock = createMock();
export const queueCronMessageToolDeliveryAwarenessMock = createMock();
export const cleanupDirectCronSessionMock = createMock();
export const preflightCronModelProviderMock = createMock();
export const isHeartbeatOnlyResponseMock = createMock();
const resolveHeartbeatAckMaxCharsMock = createMock();
export const resolveSessionAuthProfileOverrideMock = createMock();
export const resolveFastModeStateMock = createMock();
export const getChannelPluginMock = createMock();
export const retireSessionMcpRuntimeMock = createMock();
export const callGatewayMock = createMock();
export const ensureRuntimePluginsLoadedMock = createMock();
export const hasUsableWebSearchProviderMock = createMock();
export const classifyEmbeddedAgentRunResultForModelFallbackMock = createMock();
export const mergeEmbeddedAgentRunResultForModelFallbackExhaustionMock = createMock();

const resolveBootstrapWarningSignaturesSeenMock = createMock();
const resolveCronStyleNowMock = createMock();
export const resolveCronAgentLaneMock = createMock();
const resolveAgentTimeoutMsMock = createMock();
export const deriveSessionTotalTokensMock = createMock();
const hasNonzeroUsageMock = createMock();
const ensureAgentWorkspaceMock = createMock();
const normalizeThinkLevelMock = createMock();
const normalizeVerboseLevelMock = createMock();
export const isThinkingLevelSupportedMock = createMock();
export const resolveSupportedThinkingLevelMock = createMock();
const supportsXHighThinkingMock = createMock();
const resolveSessionTranscriptPathMock = createMock();
const setSessionRuntimeModelMock = createMock();
const registerAgentRunContextMock = createMock();
export const buildSafeExternalPromptMock = createMock();
const detectSuspiciousPatternsMock = createMock();
const mapHookExternalContentSourceMock = createMock();
const isExternalHookSessionMock = createMock();
const resolveHookExternalContentSourceMock = createMock();
const getSkillsSnapshotVersionMock = createMock();
export const loadModelCatalogMock = createMock();
const getRemoteSkillEligibilityMock = createMock();

vi.mock("./run.runtime.js", async () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveAgentDir: vi.fn().mockReturnValue("/tmp/agent-dir"),
  resolveAgentModelFallbacksOverride: resolveAgentModelFallbacksOverrideMock,
  resolveAgentWorkspaceDir: vi.fn().mockReturnValue("/tmp/workspace"),
  resolveDefaultAgentId: vi.fn().mockReturnValue("default"),
  resolveCronStyleNow: resolveCronStyleNowMock,
  DEFAULT_CONTEXT_TOKENS: 128000,
  isCliProvider: isCliProviderMock,
  resolveThinkingDefault: resolveThinkingDefaultMock,
  resolveEffectiveAgentRuntime: resolveEffectiveAgentRuntimeMock,
  resolveSessionRuntimeOverrideForProvider: (
    await vi.importActual<typeof import("../../agents/session-runtime-compat.js")>(
      "../../agents/session-runtime-compat.js",
    )
  ).resolveSessionRuntimeOverrideForProvider,
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  resolveAgentTimeoutMs: resolveAgentTimeoutMsMock,
  deriveSessionTotalTokens: deriveSessionTotalTokensMock,
  hasNonzeroUsage: hasNonzeroUsageMock,
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  ensureAgentWorkspace: ensureAgentWorkspaceMock,
  normalizeThinkLevel: normalizeThinkLevelMock,
  isThinkingLevelSupported: isThinkingLevelSupportedMock,
  resolveSupportedThinkingLevel: resolveSupportedThinkingLevelMock,
  supportsXHighThinking: supportsXHighThinkingMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  setSessionRuntimeModel: setSessionRuntimeModelMock,
  setCliSessionId: vi.fn(),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  normalizeAgentId: vi.fn((id: string) => id),
  mapHookExternalContentSource: mapHookExternalContentSourceMock,
  isExternalHookSession: isExternalHookSessionMock,
  resolveHookExternalContentSource: resolveHookExternalContentSourceMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../agents/model-runtime-aliases.js", async () => ({
  ...(await vi.importActual<typeof import("../../agents/model-runtime-aliases.js")>(
    "../../agents/model-runtime-aliases.js",
  )),
  resolveCliRuntimeExecutionProvider: resolveCliRuntimeExecutionProviderMock,
}));

vi.mock("./run-external-content.runtime.js", () => ({
  buildSafeExternalPrompt: buildSafeExternalPromptMock,
  detectSuspiciousPatterns: detectSuspiciousPatternsMock,
}));

vi.mock("./run-context.runtime.js", () => ({
  lookupContextTokens: lookupContextTokensMock,
}));

vi.mock("./run-model-catalog.runtime.js", () => ({
  loadModelCatalog: loadModelCatalogMock,
}));

vi.mock("../../plugins/runtime-plugins.runtime.js", () => ({
  ensureRuntimePluginsLoaded: ensureRuntimePluginsLoadedMock,
}));

vi.mock("../../web-search/runtime.js", () => ({
  hasUsableWebSearchProvider: hasUsableWebSearchProviderMock,
}));

vi.mock("../../skills/runtime/cron-snapshot.runtime.js", () => ({
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  resolveEffectiveAgentSkillFilter: resolveAgentSkillsFilterMock,
  resolveReusableWorkspaceSkillSnapshot: (params: {
    workspaceDir: string;
    config?: unknown;
    agentId?: string;
    existingSnapshot?: { version?: number; skillFilter?: string[] };
    skillFilter?: string[];
    eligibility?: unknown;
  }) => {
    const normalize = (skillFilter?: string[]) =>
      Array.from(new Set(skillFilter?.map((entry) => entry.trim()).filter(Boolean))).toSorted();
    const sameFilter =
      JSON.stringify(normalize(params.existingSnapshot?.skillFilter)) ===
      JSON.stringify(normalize(params.skillFilter));
    const snapshotVersion = getSkillsSnapshotVersionMock(params.workspaceDir);
    const shouldRefresh =
      !params.existingSnapshot ||
      params.existingSnapshot.version !== snapshotVersion ||
      !sameFilter;
    return {
      snapshot: shouldRefresh
        ? buildWorkspaceSkillSnapshotMock(params.workspaceDir, {
            config: params.config,
            agentId: params.agentId,
            skillFilter: params.skillFilter,
            eligibility: params.eligibility,
            snapshotVersion,
          })
        : params.existingSnapshot,
      shouldRefresh,
      snapshotVersion,
    };
  },
}));

vi.mock("./run-model-selection.runtime.js", () => ({
  DEFAULT_MODEL: "gpt-5.4",
  DEFAULT_PROVIDER: "openai",
  loadModelCatalog: loadModelCatalogMock,
  getModelRefStatus: getModelRefStatusMock,
  normalizeModelSelection: normalizeModelSelectionForTest,
  resolveAllowedModelRef: resolveAllowedModelRefMock,
  resolveConfiguredModelRef: resolveConfiguredModelRefMock,
  resolveHooksGmailModel: resolveHooksGmailModelMock,
  resolveSubagentModelConfigSelectionResult: ({
    cfg,
    agentConfigOverride,
  }: {
    cfg?: { agents?: { defaults?: { subagents?: { model?: unknown } } } };
    agentConfigOverride?: { model?: unknown; subagents?: { model?: unknown } };
  }) => {
    for (const candidate of [
      { raw: agentConfigOverride?.subagents?.model, source: "subagent" as const },
      { raw: agentConfigOverride?.model, source: "agent" as const },
      { raw: cfg?.agents?.defaults?.subagents?.model, source: "default-subagent" as const },
    ]) {
      if (normalizeModelSelectionForTest(candidate.raw)) {
        return candidate;
      }
    }
    return undefined;
  },
}));

vi.mock("./run-execution.runtime.js", () => ({
  resolveEffectiveModelFallbacks: resolveEffectiveModelFallbacksMock,
  resolveSubagentModelFallbacksOverride: resolveSubagentModelFallbacksOverrideMock,
  resolveBootstrapWarningSignaturesSeen: resolveBootstrapWarningSignaturesSeenMock,
  getCliSessionBinding: getCliSessionBindingMock,
  getCliSessionId: getCliSessionIdMock,
  runCliAgent: runCliAgentMock,
  resolveFastModeState: resolveFastModeStateMock,
  resolveCandidateThinkingLevel: (params: {
    provider: string;
    modelId: string;
    level?: string;
    catalog?: unknown[];
  }) => {
    if (!params.level) {
      return undefined;
    }
    const policy = {
      provider: params.provider,
      model: params.modelId,
      level: params.level,
      catalog: params.catalog,
      agentRuntime: resolveEffectiveAgentRuntimeMock(params),
    };
    return isThinkingLevelSupportedMock(policy)
      ? params.level
      : resolveSupportedThinkingLevelMock(policy);
  },
  resolveCronAgentLane: resolveCronAgentLaneMock,
  LiveSessionModelSwitchError,
  runWithModelFallback: runWithModelFallbackMock,
  isCliProvider: isCliProviderMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
  normalizeVerboseLevel: normalizeVerboseLevelMock,
  resolveSessionTranscriptPath: resolveSessionTranscriptPathMock,
  registerAgentRunContext: registerAgentRunContextMock,
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  classifyEmbeddedAgentRunResultForModelFallback:
    classifyEmbeddedAgentRunResultForModelFallbackMock,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion:
    mergeEmbeddedAgentRunResultForModelFallbackExhaustionMock,
}));

vi.mock("../../agents/model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider: ({
    provider,
    cfg,
    modelId,
  }: {
    provider?: string;
    cfg?: {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { id?: string } }>;
        };
      };
    };
    modelId?: string;
  }) => {
    const key = provider && modelId ? `${provider}/${modelId}` : undefined;
    const runtime = key
      ? cfg?.agents?.defaults?.models?.[key]?.agentRuntime?.id?.trim()
      : undefined;
    return runtime || provider;
  },
}));

vi.mock("./run-auth-profile.runtime.js", () => ({
  resolveSessionAuthProfileOverride: resolveSessionAuthProfileOverrideMock,
}));

vi.mock("./run-embedded.runtime.js", () => ({
  resolveFastModeState: resolveFastModeStateMock,
  resolveCronAgentLane: resolveCronAgentLaneMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

vi.mock("./run-subagent-registry.runtime.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
  listDescendantRunsForRequester: listDescendantRunsForRequesterMock,
}));

vi.mock("../../agents/cli-runner.runtime.js", () => ({
  clearCliSession: clearCliSessionMock,
  setCliSessionBinding: setCliSessionBindingMock,
  setCliSessionId: vi.fn(),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("../../gateway/call.runtime.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<SessionAccessorModule>(
    "../../config/sessions/session-accessor.js",
  );
  actualReplaceSessionEntry = actual.replaceSessionEntry;
  actualLoadSessionEntry = actual.loadSessionEntry;
  return {
    ...actual,
    replaceSessionEntry: replaceSessionEntryMock,
    patchSessionEntry: patchSessionEntryMock,
  };
});

vi.mock("../delivery-plan.js", async () => ({
  ...(await vi.importActual<typeof import("../delivery-plan.js")>("../delivery-plan.js")),
  resolveCronDeliveryPlan: resolveCronDeliveryPlanMock,
}));

vi.mock("./run-delivery.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./run-delivery.runtime.js")>(
    "./run-delivery.runtime.js",
  );
  return {
    ...actual,
    cleanupDirectCronSession: cleanupDirectCronSessionMock,
    resolveDeliveryTarget: resolveDeliveryTargetMock,
    dispatchCronDelivery: dispatchCronDeliveryMock,
    queueCronMessageToolDeliveryAwareness: queueCronMessageToolDeliveryAwarenessMock,
  };
});

vi.mock("./model-preflight.runtime.js", () => ({
  preflightCronModelProvider: preflightCronModelProviderMock,
}));

vi.mock("./helpers.js", () => ({
  isHeartbeatOnlyResponse: isHeartbeatOnlyResponseMock,
  pickLastNonEmptyTextFromPayloads: pickLastNonEmptyTextFromPayloadsMock,
  pickSummaryFromOutput: vi.fn().mockReturnValue("summary"),
  resolveCronPayloadOutcome: resolveCronPayloadOutcomeMock,
  resolveHeartbeatAckMaxChars: resolveHeartbeatAckMaxCharsMock,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

vi.mock("./session.js", () => ({
  loadCronSessionEntryLatest: loadSessionEntryMock,
  resolveCronSession: resolveCronSessionMock,
}));

export function makeCronSessionEntry(overrides?: Record<string, unknown>): CronSessionEntry {
  return {
    sessionId: "test-session-id",
    updatedAt: 0,
    systemSent: false,
    skillsSnapshot: undefined,
    ...overrides,
  };
}

export function makeCronSession(overrides?: Record<string, unknown>): CronSession {
  const session = {
    storePath: "/tmp/store.json",
    store: {},
    sessionEntry: makeCronSessionEntry(),
    lifecycleRevision: "test-lifecycle-revision",
    initialSessionEntry: undefined,
    systemSent: false,
    isNewSession: true,
    ...overrides,
  } as CronSession;
  // Real resolveCronSession stamps the run's lifecycleRevision onto the live
  // sessionEntry so the accessor-backed persist path can prove ownership on
  // later writes. Mirror that here unless a test seeds its own revision.
  if (session.sessionEntry.lifecycleRevision === undefined) {
    session.sessionEntry.lifecycleRevision = session.lifecycleRevision;
  }
  return session;
}

function makeDefaultModelFallbackResult() {
  return {
    result: {
      payloads: [{ text: "test output" }],
      meta: { agentMeta: {} },
    },
    provider: "openai",
    model: "gpt-5.4",
  };
}

function makeDefaultEmbeddedResult() {
  return {
    payloads: [{ text: "test output" }],
    meta: { agentMeta: {} },
  };
}

export function mockRunCronFallbackPassthrough(): void {
  runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => {
    const result = await run(provider, model);
    return { result, provider, model, attempts: [] };
  });
}

function resetRunConfigMocks(): void {
  buildWorkspaceSkillSnapshotMock.mockReturnValue({
    prompt: "<available_skills></available_skills>",
    resolvedSkills: [],
    version: 42,
  });
  resolveAgentConfigMock.mockReturnValue(undefined);
  resolveEffectiveModelFallbacksMock.mockReset();
  resolveEffectiveModelFallbacksMock.mockImplementation(
    ({ cfg, agentId, hasSessionModelOverride, modelOverrideSource }) => {
      const agentFallbacksOverride = resolveAgentModelFallbacksOverrideMock(cfg, agentId) as
        | string[]
        | undefined;
      if (!hasSessionModelOverride) {
        return agentFallbacksOverride;
      }
      if (modelOverrideSource !== "auto") {
        return [];
      }
      const defaultFallbacks = resolveAgentModelFallbackValues(cfg?.agents?.defaults?.model);
      return agentFallbacksOverride ?? defaultFallbacks;
    },
  );
  resolveSubagentModelFallbacksOverrideMock.mockReset();
  resolveSubagentModelFallbacksOverrideMock.mockImplementation((cfg, agentId) => {
    const agentConfig = resolveAgentConfigMock(cfg, agentId) as
      | { model?: unknown; subagents?: { model?: unknown } }
      | undefined;
    const resolveOverride = (raw: unknown): string[] | undefined => {
      const primary = normalizeModelSelectionForTest(raw);
      if (!raw) {
        return undefined;
      }
      if (typeof raw === "string") {
        return primary ? [] : undefined;
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        return undefined;
      }
      if (!Object.hasOwn(raw, "fallbacks")) {
        return Object.hasOwn(raw, "primary") && primary ? [] : undefined;
      }
      const fallbacks = (raw as { fallbacks?: unknown }).fallbacks;
      return Array.isArray(fallbacks)
        ? fallbacks.filter((entry) => typeof entry === "string")
        : undefined;
    };
    const subagentFallbacks = resolveOverride(agentConfig?.subagents?.model);
    if (subagentFallbacks !== undefined) {
      return subagentFallbacks;
    }
    const selectedConfig = [
      agentConfig?.subagents?.model,
      agentConfig?.model,
      (cfg as { agents?: { defaults?: { subagents?: { model?: unknown } } } })?.agents?.defaults
        ?.subagents?.model,
    ].find((raw) => normalizeModelSelectionForTest(raw));
    return resolveOverride(selectedConfig);
  });
  resolveAgentModelFallbacksOverrideMock.mockReturnValue(undefined);
  resolveAgentSkillsFilterMock.mockReturnValue(undefined);
  resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
  resolveCliRuntimeExecutionProviderMock.mockReturnValue(undefined);
  resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-5.4" } });
  resolveHooksGmailModelMock.mockReturnValue(null);
  resolveThinkingDefaultMock.mockReturnValue("off");
  resolveEffectiveAgentRuntimeMock.mockReturnValue("openclaw");
  getModelRefStatusMock.mockReturnValue({ allowed: false });
  resolveCronStyleNowMock.mockReturnValue({
    formattedTime: "2026-02-10 12:00",
    timeLine: "Current time: 2026-02-10 12:00 UTC",
  });
  resolveAgentTimeoutMsMock.mockReturnValue(60_000);
  deriveSessionTotalTokensMock.mockReturnValue(30);
  hasNonzeroUsageMock.mockImplementation(
    (
      usage:
        | {
            input?: unknown;
            output?: unknown;
            cacheRead?: unknown;
            cacheWrite?: unknown;
            total?: unknown;
          }
        | undefined,
    ) =>
      [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite, usage?.total].some(
        (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
      ),
  );
  ensureAgentWorkspaceMock.mockResolvedValue({ dir: "/tmp/workspace" });
  normalizeThinkLevelMock.mockImplementation((value: unknown) => value);
  isThinkingLevelSupportedMock.mockReturnValue(true);
  resolveSupportedThinkingLevelMock.mockImplementation(({ level }: { level?: unknown }) => level);
  supportsXHighThinkingMock.mockReturnValue(false);
  buildSafeExternalPromptMock.mockImplementation(
    ({ message }: { message?: string }) => message ?? "",
  );
  detectSuspiciousPatternsMock.mockReturnValue([]);
  mapHookExternalContentSourceMock.mockReturnValue("unknown");
  isExternalHookSessionMock.mockReturnValue(false);
  resolveHookExternalContentSourceMock.mockReturnValue(undefined);
  getSkillsSnapshotVersionMock.mockReturnValue(42);
  loadModelCatalogMock.mockResolvedValue([]);
  getRemoteSkillEligibilityMock.mockResolvedValue({ remoteSkillsEnabled: false });
}

function resetRunExecutionMocks(): void {
  isCliProviderMock.mockReturnValue(false);
  resolveBootstrapWarningSignaturesSeenMock.mockReturnValue(new Set());
  resolveFastModeStateMock.mockImplementation((params) => resolveFastModeStateImpl(params));
  resolveCronAgentLaneMock.mockReturnValue(undefined);
  normalizeVerboseLevelMock.mockImplementation((value: unknown) => value ?? "off");
  resolveSessionTranscriptPathMock.mockReturnValue("/tmp/transcript.jsonl");
  registerAgentRunContextMock.mockReturnValue(undefined);
  runWithModelFallbackMock.mockReset();
  runWithModelFallbackMock.mockResolvedValue(makeDefaultModelFallbackResult());
  classifyEmbeddedAgentRunResultForModelFallbackMock.mockReset();
  classifyEmbeddedAgentRunResultForModelFallbackMock.mockReturnValue(null);
  mergeEmbeddedAgentRunResultForModelFallbackExhaustionMock.mockReset();
  mergeEmbeddedAgentRunResultForModelFallbackExhaustionMock.mockImplementation(
    (params: { latestResult: unknown }) => params.latestResult,
  );
  runEmbeddedAgentMock.mockReset();
  runEmbeddedAgentMock.mockResolvedValue(makeDefaultEmbeddedResult());
  runCliAgentMock.mockReset();
  clearCliSessionMock.mockReset();
  setCliSessionBindingMock.mockReset();
  getCliSessionBindingMock.mockReturnValue(undefined);
  getCliSessionIdMock.mockReturnValue(undefined);
  countActiveDescendantRunsMock.mockReset();
  countActiveDescendantRunsMock.mockReturnValue(0);
  listDescendantRunsForRequesterMock.mockReset();
  listDescendantRunsForRequesterMock.mockReturnValue([]);
}

function resetRunOutcomeMocks(): void {
  lookupContextTokensMock.mockReset();
  lookupContextTokensMock.mockReturnValue(undefined);
  pickLastNonEmptyTextFromPayloadsMock.mockReset();
  pickLastNonEmptyTextFromPayloadsMock.mockReturnValue("test output");
  resolveCronPayloadOutcomeMock.mockReset();
  resolveCronPayloadOutcomeMock.mockImplementation(
    ({
      payloads,
      failureSignal,
      runLevelError,
    }: {
      payloads: Array<{ isError?: boolean }>;
      failureSignal?: { fatalForCron?: boolean; message?: string };
      runLevelError?: unknown;
    }) => {
      const runLevelErrorMessage =
        typeof runLevelError === "string" && runLevelError.trim()
          ? `cron isolated run failed: ${runLevelError.trim()}`
          : runLevelError && typeof runLevelError === "object"
            ? (() => {
                const record = runLevelError as { message?: unknown; kind?: unknown };
                const message =
                  typeof record.message === "string" && record.message.trim()
                    ? record.message.trim()
                    : undefined;
                if (message) {
                  return `cron isolated run failed: ${message}`;
                }
                const kind =
                  typeof record.kind === "string" && record.kind.trim()
                    ? record.kind.trim()
                    : undefined;
                return kind ? `cron isolated run failed: ${kind}` : "cron isolated run failed";
              })()
            : undefined;
      const failureMessage =
        failureSignal?.fatalForCron === true
          ? (failureSignal.message ?? "cron isolated run returned a fatal failure signal")
          : undefined;
      const errorPayloadMessage = payloads.some((payload) => payload?.isError === true)
        ? "cron isolated run returned an error payload"
        : undefined;
      const outputText =
        errorPayloadMessage ??
        failureMessage ??
        runLevelErrorMessage ??
        pickLastNonEmptyTextFromPayloadsMock(payloads);
      const synthesizedText = outputText?.trim() || "summary";
      const hasFatalErrorPayload =
        errorPayloadMessage !== undefined ||
        failureMessage !== undefined ||
        runLevelErrorMessage !== undefined;
      const hasFatalStructuredErrorPayload = errorPayloadMessage !== undefined;
      const deliveryPayload =
        errorPayloadMessage || failureMessage || runLevelErrorMessage
          ? { text: errorPayloadMessage ?? failureMessage ?? runLevelErrorMessage, isError: true }
          : undefined;
      return {
        summary: errorPayloadMessage ?? failureMessage ?? runLevelErrorMessage ?? "summary",
        outputText,
        synthesizedText,
        deliveryPayload,
        deliveryPayloads: deliveryPayload
          ? [deliveryPayload]
          : synthesizedText
            ? [{ text: synthesizedText }]
            : [],
        deliveryPayloadHasStructuredContent: false,
        hasFatalErrorPayload,
        hasFatalStructuredErrorPayload,
        embeddedRunError:
          errorPayloadMessage ?? failureMessage ?? runLevelErrorMessage ?? undefined,
      };
    },
  );
  resolveCronDeliveryPlanMock.mockReset();
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  resolveDeliveryTargetMock.mockReset();
  resolveDeliveryTargetMock.mockResolvedValue({
    ok: true,
    channel: "messagechat",
    to: "test-target",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
    error: undefined,
  });
  dispatchCronDeliveryMock.mockReset();
  dispatchCronDeliveryMock.mockImplementation(
    ({
      deliveryPayloads,
      summary,
      outputText,
      synthesizedText,
      deliveryRequested,
      skipHeartbeatDelivery,
      sourceDeliveryOutcome,
      resolvedDelivery,
    }) => ({
      result: undefined,
      delivered: Boolean(
        sourceDeliveryOutcome?.verifiedMessageToolDelivery ||
        (deliveryRequested &&
          !skipHeartbeatDelivery &&
          !sourceDeliveryOutcome?.satisfiesSourceDelivery &&
          resolvedDelivery.ok),
      ),
      deliveryAttempted: Boolean(
        sourceDeliveryOutcome?.verifiedMessageToolDelivery ||
        (deliveryRequested &&
          !skipHeartbeatDelivery &&
          !sourceDeliveryOutcome?.satisfiesSourceDelivery &&
          resolvedDelivery.ok),
      ),
      cronRunSessionCleanupAttempted: false,
      summary,
      outputText,
      synthesizedText,
      deliveryPayloads,
    }),
  );
  queueCronMessageToolDeliveryAwarenessMock.mockReset();
  queueCronMessageToolDeliveryAwarenessMock.mockResolvedValue(undefined);
  cleanupDirectCronSessionMock.mockReset();
  cleanupDirectCronSessionMock.mockResolvedValue(undefined);
  preflightCronModelProviderMock.mockReset();
  preflightCronModelProviderMock.mockResolvedValue({ status: "available" });
  isHeartbeatOnlyResponseMock.mockReset();
  isHeartbeatOnlyResponseMock.mockReturnValue(false);
  resolveHeartbeatAckMaxCharsMock.mockReset();
  resolveHeartbeatAckMaxCharsMock.mockReturnValue(100);
  resolveSessionAuthProfileOverrideMock.mockReset();
  resolveSessionAuthProfileOverrideMock.mockResolvedValue(undefined);
}

function resetRunSessionMocks(): void {
  loadSessionEntryMock.mockReset();
  loadSessionEntryMock.mockReturnValue(undefined);
  replaceSessionEntryMock.mockReset();
  replaceSessionEntryMock.mockImplementation(
    async (
      scope: Parameters<SessionAccessorModule["replaceSessionEntry"]>[0],
      entry: Parameters<SessionAccessorModule["replaceSessionEntry"]>[1],
    ) => {
      if (usesRealAccessorStore(scope.storePath)) {
        await actualReplaceSessionEntry(scope, entry);
      }
    },
  );
  patchSessionEntryMock.mockReset();
  installPatchSessionEntryStore();
  resolveCronSessionMock.mockReset();
  resolveCronSessionMock.mockReturnValue(makeCronSession());
  callGatewayMock.mockReset();
  callGatewayMock.mockResolvedValue({ ok: true, deleted: true });
  retireSessionMcpRuntimeMock.mockReset();
  retireSessionMcpRuntimeMock.mockResolvedValue(true);
}

/**
 * In-memory stand-in for the SQLite accessor `patchSessionEntry` used by the
 * cron persist path. Prod flips real session storage to per-agent SQLite, but
 * these orchestration tests must stay off disk. The store keys on
 * storePath+sessionKey so successive persists in one run observe the row the
 * previous persist committed, mirroring the accessor's read-modify-write and
 * letting the lifecycle claim guard prove ownership without real SQLite.
 */
function installPatchSessionEntryStore(): void {
  type PatchRow = Record<string, unknown>;
  const rows = new Map<string, PatchRow>();
  patchSessionEntryMock.mockImplementation(
    async (
      scope: { storePath?: string; sessionKey: string },
      update: (
        entry: PatchRow,
        context: { existingEntry: PatchRow | undefined },
      ) => PatchRow | null,
      options: { fallbackEntry?: PatchRow } = {},
    ) => {
      const key = `${scope.storePath ?? ""}\\0${scope.sessionKey}`;
      const existingEntry =
        rows.get(key) ??
        (usesRealAccessorStore(scope.storePath)
          ? actualLoadSessionEntry(scope as never)
          : loadSessionEntryMock(scope.storePath, scope.sessionKey));
      const writeBase = existingEntry ?? options.fallbackEntry;
      if (!writeBase) {
        return null;
      }
      const next = update(structuredClone(writeBase), {
        existingEntry: existingEntry ? structuredClone(existingEntry) : undefined,
      });
      if (!next) {
        return structuredClone(writeBase);
      }
      const committed = structuredClone(next);
      rows.set(key, committed);
      if (usesRealAccessorStore(scope.storePath)) {
        await actualReplaceSessionEntry(scope as never, committed as never);
      }
      return committed;
    },
  );
}

export function resetRunCronIsolatedAgentTurnHarness(): void {
  vi.clearAllMocks();
  resetRunConfigMocks();
  resetRunExecutionMocks();
  resetRunOutcomeMocks();
  resetRunSessionMocks();
  setSessionRuntimeModelMock.mockReturnValue(undefined);
  logWarnMock.mockReset();
  ensureRuntimePluginsLoadedMock.mockReset();
  hasUsableWebSearchProviderMock.mockReset();
  hasUsableWebSearchProviderMock.mockImplementation(
    (params?: { runtimeWebSearch?: { selectedProvider?: string } }) =>
      Boolean(params?.runtimeWebSearch?.selectedProvider),
  );
}

export function clearFastTestEnv(): string | undefined {
  const previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
  delete process.env.OPENCLAW_TEST_FAST;
  return previousFastTestEnv;
}

export function restoreFastTestEnv(previousFastTestEnv: string | undefined): void {
  if (previousFastTestEnv == null) {
    delete process.env.OPENCLAW_TEST_FAST;
    return;
  }
  process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
}

export async function loadRunCronIsolatedAgentTurn() {
  const { runCronIsolatedAgentTurn } = await import("./run.js");
  return runCronIsolatedAgentTurn;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
