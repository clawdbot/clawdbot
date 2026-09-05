// Tests agent runner memory flush and persisted memory context handling.
import fsCore from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import type { ModelFallbackAttemptProvenance } from "../../agents/model-fallback.types.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  readSessionTranscriptActiveStats,
  readTranscriptStatsSync,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryFlushPlan,
  type MemoryFlushPlanResolver,
} from "../../plugins/memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { ReplyPayload } from "../types.js";
import {
  runMemoryFlushIfNeeded as runMemoryFlushIfNeededRaw,
  runSessionCompactionIfNeeded as runSessionCompactionIfNeededRaw,
} from "./agent-runner-memory.js";
import {
  createTestFollowupRun,
  createTestTemplateContext,
  withTestModelContextTokens,
  writeTestSessionStore,
} from "./agent-runner.test-fixtures.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createSourceReplyDeliveryRuntime } from "./source-reply-delivery-runtime.js";
import { createMockReplyOperation } from "./test-helpers.js";

const {
  compactEmbeddedAgentSessionMock,
  runEmbeddedAgentEntryMock,
  runEmbeddedAgentMock,
  refreshQueuedFollowupSessionMock,
  incrementCompactionCountMock,
  registerAgentRunContextMock,
  clearAgentRunContextMock,
} = vi.hoisted(() => ({
  compactEmbeddedAgentSessionMock: vi.fn(),
  runEmbeddedAgentEntryMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
  refreshQueuedFollowupSessionMock: vi.fn(),
  incrementCompactionCountMock: vi.fn(),
  registerAgentRunContextMock: vi.fn(),
  clearAgentRunContextMock: vi.fn(),
}));
const runWithModelFallbackMock = vi.fn();
const ensureSelectedAgentHarnessPluginMock = vi.fn();

vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runEmbeddedAgentEntryMock,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
}));
vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
}));
vi.mock("./session-updates.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-updates.js")>()),
  incrementCompactionCount: incrementCompactionCountMock,
}));
vi.mock("../../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/agent-run-registry.js")>()),
  registerAgentRunContext: registerAgentRunContextMock,
  clearAgentRunContext: clearAgentRunContextMock,
}));

let incrementCompactionCount: typeof import("./session-updates.js").incrementCompactionCount;
beforeAll(async () => {
  ({ incrementCompactionCount } =
    await vi.importActual<typeof import("./session-updates.js")>("./session-updates.js"));
});

const TEST_MAX_FLUSH_FAILURES = 3;

type MemoryFlushTestParams = Parameters<typeof runMemoryFlushIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

async function runMemoryFlushIfNeeded(params: MemoryFlushTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runMemoryFlushIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({
      cfg: runParams.cfg,
      followupRun: runParams.followupRun,
      defaultModel: runParams.defaultModel,
      contextTokens: modelContextTokens,
    }),
  });
}

type PreflightCompactionTestParams = Parameters<typeof runSessionCompactionIfNeededRaw>[0] & {
  modelContextTokens?: number;
};

async function runSessionCompactionIfNeeded(params: PreflightCompactionTestParams) {
  const { modelContextTokens, ...runParams } = params;
  return await runSessionCompactionIfNeededRaw({
    ...runParams,
    cfg: withTestModelContextTokens({
      cfg: runParams.cfg,
      followupRun: runParams.followupRun,
      defaultModel: runParams.defaultModel,
      contextTokens: modelContextTokens,
    }),
  });
}

function createMemoryFlushPlan(): MemoryFlushPlan {
  return {
    softThresholdTokens: 4_000,
    forceFlushTranscriptBytes: 1_000_000_000,
    reserveTokensFloor: 20_000,
    prompt: "Pre-compaction memory flush.\nNO_REPLY",
    systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    relativePath: "memory/2023-11-14.md",
  };
}

function createModifiedMemoryFlushPlan(overrides: Partial<MemoryFlushPlan>): MemoryFlushPlan {
  return { ...createMemoryFlushPlan(), ...overrides };
}

function createFlushSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: Date.now(),
    totalTokens: 80_000,
    totalTokensFresh: true,
    totalTokensVersion: 1,
    compactionCount: 1,
    ...overrides,
  };
}

function registerMemoryFlushPlanResolverForTest(resolver: MemoryFlushPlanResolver): void {
  registerMemoryCapability("memory-core", { flushPlanResolver: resolver });
}

function registerClaudeCliBackend(ownsNativeCompaction = false): void {
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        ownsNativeCompaction,
      },
    ],
  });
}

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
  updateSessionId: ReturnType<typeof vi.fn<ReplyOperation["updateSessionId"]>>;
};

function createReplyOperation(): TestReplyOperation {
  const { replyOperation } = createMockReplyOperation({ key: "test" });
  return Object.assign(replyOperation, {
    phase: "queued" as const,
    setPhase: vi.fn<ReplyOperation["setPhase"]>(),
    updateSessionId: vi.fn<ReplyOperation["updateSessionId"]>(),
  });
}

function createCompactionLifecycle(replyOperation: ReplyOperation) {
  return {
    abortSignal: replyOperation.abortSignal,
    onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
    onSessionIdChanged: (sessionId: string) => replyOperation.updateSessionId(sessionId),
  };
}

function loadMainSessionEntry(storePath: string): SessionEntry {
  const entry = loadSessionEntry({ storePath, sessionKey: "main" });
  if (!entry) {
    throw new Error("expected persisted main session entry");
  }
  return entry;
}

async function writeTestSessionTranscript(params: {
  rootDir: string;
  events: Parameters<typeof replaceTranscriptEvents>[1];
  sessionKey?: string;
  sessionId?: string;
}): Promise<void> {
  const sessionId = params.sessionId ?? "session";
  const sessionKey = params.sessionKey ?? "main";
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(params.rootDir, "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId, updatedAt: 10 });
  await replaceTranscriptEvents(scope, params.events);
}

type RefreshQueuedFollowupSessionParams = {
  key?: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
};

type ModelFallbackParams = {
  provider?: string;
  model?: string;
  abortSignal?: AbortSignal;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  fallbacksOverride?: unknown[];
  requestedRouteResolution?: "raw" | "resolved";
  userLockedAuthProfileId?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
  prepareAgentHarnessRuntime?: (params: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => Promise<void> | void;
  run: (
    provider: string,
    model: string,
    options: {
      allowTransientCooldownProbe?: boolean;
      isFinalFallbackAttempt?: boolean;
      modelRoutingProvenance: ModelFallbackAttemptProvenance;
    },
  ) => Promise<EmbeddedAgentRunResult>;
};

function modelRoutingProvenance(
  requestedProvider: string,
  requestedModel: string,
  stage: ModelFallbackAttemptProvenance["stage"] = "initial",
): ModelFallbackAttemptProvenance {
  return { requestedProvider, requestedModel, stage };
}

type EmbeddedAgentParams = {
  preparedRunAdmission?: PreparedAgentRunAdmission;
  provider?: string;
  model?: string;
  thinkLevel?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  authProfileId?: unknown;
  authProfileIdSource?: unknown;
  prompt?: string;
  transcriptPrompt?: string;
  memoryFlushWritePath?: string;
  silentExpected?: boolean;
  allowEmptyAssistantReplyAsSilent?: boolean;
  terminalReplyExpectation?: "required" | "optional";
  extraSystemPrompt?: string;
  bootstrapPromptWarningSignaturesSeen?: string[];
  bootstrapPromptWarningSignature?: string;
  abortSignal?: AbortSignal;
  isFinalFallbackAttempt?: boolean;
  onCompactionAccounting?: (fact: CompactionAccountingFact | undefined) => void;
  onAgentEvent?: (evt: {
    stream: string;
    data: { completed?: boolean; isError?: boolean; name?: string; phase?: string };
  }) => void;
};

type CompactEmbeddedAgentSessionParams = {
  agentId?: string;
  agentHarnessId?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  contextTokenBudget?: number;
  sessionKey?: string;
  sandboxSessionKey?: string;
  currentTokenCount?: number;
  cwd?: string;
  force?: boolean;
  forcePreflight?: boolean;
  modelSelectionLocked?: boolean;
  preflightRequired?: boolean;
  preflightCompactionTrigger?: string;
  sessionEntry?: SessionEntry;
  sessionFile?: string;
  sessionId?: string;
  trigger?: string;
};

function requireRefreshQueuedFollowupSessionCall(index = 0) {
  const call = refreshQueuedFollowupSessionMock.mock.calls[index]?.[0] as
    | RefreshQueuedFollowupSessionParams
    | undefined;
  if (!call) {
    throw new Error(`refreshQueuedFollowupSession call ${index} missing`);
  }
  return call;
}

function requireModelFallbackCall(index = 0) {
  const call = runWithModelFallbackMock.mock.calls[index]?.[0] as ModelFallbackParams | undefined;
  if (!call) {
    throw new Error(`runWithModelFallback call ${index} missing`);
  }
  return call;
}

function requireEmbeddedAgentCall(index = 0) {
  const call = runEmbeddedAgentMock.mock.calls[index]?.[0] as EmbeddedAgentParams | undefined;
  if (!call) {
    throw new Error(`runEmbeddedAgent call ${index} missing`);
  }
  return call;
}

function requireCompactEmbeddedAgentSessionCall(index = 0) {
  const call = compactEmbeddedAgentSessionMock.mock.calls[index]?.[0] as
    | CompactEmbeddedAgentSessionParams
    | undefined;
  if (!call) {
    throw new Error(`compactEmbeddedAgentSession call ${index} missing`);
  }
  return call;
}

async function commitMemoryCompaction(params: {
  sessionKey: string;
  storePath: string;
  run?: EmbeddedAgentParams;
}) {
  const entry = loadSessionEntry({ sessionKey: params.sessionKey, storePath: params.storePath });
  if (!entry) {
    throw new Error("expected compaction predecessor");
  }
  const accepted = await acceptCompactionSuccessor({
    currentTarget: {
      agentId: "main",
      sessionId: entry.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    expectedEntry: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      activeWriterRunId: entry.activeWriterRunId,
    },
    assertActive: () => params.run?.abortSignal?.throwIfAborted(),
    result: {
      ok: true,
      compacted: true,
      result: { sessionId: "session-rotated", tokensBefore: 120, tokensAfter: 42 },
    },
  });
  params.run?.onCompactionAccounting?.({
    kind: "durable",
    count: 1,
    currentContextSnapshot: { tokens: 42 },
    target: {
      ...accepted.sessionTarget,
      lifecycleRevision: accepted.entry.lifecycleRevision,
      activeWriterRunId: accepted.entry.activeWriterRunId,
    },
  });
  return accepted;
}

describe("runMemoryFlushIfNeeded", () => {
  let rootDir = "";

  async function runDefaultMemoryFlush(
    sessionEntry: SessionEntry,
    overrides: Partial<MemoryFlushTestParams> = {},
  ) {
    const sessionKey = overrides.sessionKey ?? "main";
    return await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun(),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      ...overrides,
    });
  }

  async function runDefaultPreflight(
    sessionEntry: SessionEntry,
    overrides: Partial<PreflightCompactionTestParams> = {},
  ) {
    const sessionKey = overrides.sessionKey ?? "main";
    return await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
      ...overrides,
    });
  }

  async function runProjectedCompaction(completed: boolean, followupRun = createTestFollowupRun()) {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = createFlushSessionEntry();
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);
    runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      if (completed) {
        await commitMemoryCompaction({ sessionKey, storePath, run: params });
      }
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", completed } });
      return {
        payloads: [],
        meta: { agentMeta: { sessionId: "session-rotated" } },
      };
    });
    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun,
      sessionStore,
      sessionKey,
      storePath,
    });
    return { followupRun, result, sessionKey, storePath };
  }

  async function createOversizedByteCompactionFixture() {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    await writeTestSessionTranscript({
      rootDir,
      events: [{ type: "message", message: { role: "user", content: "x".repeat(256) } }],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, sessionEntry);
    const run = async (entry: SessionEntry, maxActiveTranscriptBytes = "10b") =>
      await runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { maxActiveTranscriptBytes } } } },
        followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100_000,
        sessionEntry: entry,
        sessionStore: { [sessionKey]: entry },
        sessionKey,
        storePath,
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      });
    return { run, sessionEntry, storePath };
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
    registerMemoryFlushPlanResolverForTest(createMemoryFlushPlan);
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model, {
        modelRoutingProvenance: modelRoutingProvenance(provider, model),
      }),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedAgentEntryMock
      .mockReset()
      .mockImplementation(
        async (params: Parameters<typeof runEmbeddedAgentEntry<EmbeddedAgentRunResult>>[0]) => {
          const fallbackResult = (await runWithModelFallbackMock({
            ...params.selection,
            ...params.identity,
            abortSignal: params.abortSignal,
            resolveAgentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride,
            prepareAgentHarnessRuntime: async ({
              provider,
              model,
              agentHarnessRuntimeOverride,
            }: {
              provider: string;
              model: string;
              agentHarnessRuntimeOverride?: string;
            }) => {
              await ensureSelectedAgentHarnessPluginMock({
                config: params.selection.cfg,
                provider,
                modelId: model,
                agentId: params.identity.agentId,
                sessionKey: params.harness.sessionKey,
                agentHarnessId: agentHarnessRuntimeOverride,
                agentHarnessRuntimeOverride,
                workspaceDir: params.harness.workspaceDir,
              });
            },
            run: (
              provider: string,
              model: string,
              options: Parameters<ModelFallbackParams["run"]>[2],
            ) =>
              params.runCandidate(provider, model, {
                classifyResult: () => undefined,
                allowTransientCooldownProbe: options.allowTransientCooldownProbe,
                isFinalFallbackAttempt: options.isFinalFallbackAttempt,
                isFallbackRetry: false,
                modelRoutingProvenance: options.modelRoutingProvenance,
                contextEngineLogicalTurnLease: {} as never,
                onContextEngineTurnCandidate: () => {},
              }),
          })) as {
            outcome?: "completed" | "exhausted";
            result: EmbeddedAgentRunResult;
            provider: string;
            model: string;
            attempts: [];
          };
          return {
            ...fallbackResult,
            outcome: fallbackResult.outcome ?? ("completed" as const),
            terminal: {
              outcome: { reason: "completed" as const, status: "ok" as const },
              metadata: {},
            },
            settleSessionOverride: async () => undefined,
          };
        },
      );
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });
    refreshQueuedFollowupSessionMock.mockReset();
    ensureSelectedAgentHarnessPluginMock.mockReset().mockResolvedValue(undefined);
    registerAgentRunContextMock.mockReset();
    clearAgentRunContextMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + Math.max(0, params.amount ?? 1),
        transcriptByteCompactionLatch: params.transcriptByteCompactionLatch,
      };
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeTestSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
  });

  afterEach(async () => {
    cliBackendsTesting.resetDepsForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearMemoryPluginState();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("preserves an external memory provider's disabled maintenance thresholds", async () => {
    const resolver = vi.fn<MemoryFlushPlanResolver>(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 50_000 }),
    );
    registerMemoryCapability("third-party-memory", { flushPlanResolver: resolver });
    const sessionEntry = createFlushSessionEntry({ totalTokens: 8_000 });

    const result = await runDefaultMemoryFlush(sessionEntry, { modelContextTokens: 32_000 });
    await runDefaultPreflight(sessionEntry, { modelContextTokens: 32_000 });

    expect(result.outcome).toBe("skipped");
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ contextWindowTokens: 32_000 }));
  });

  it.each([
    ["provider", 8_767, false, false],
    ["provider", 8_768, true, false],
    ["provider", 12_767, true, false],
    ["provider", 12_768, true, true],
    ["custom", 18_767, false, false],
    ["custom", 18_768, true, false],
    ["custom", 20_767, true, false],
    ["custom", 20_768, true, true],
  ] as const)(
    "separates early flush and blocking compaction for %s plan at %i tokens",
    async (plan, totalTokens, flushExpected, compactionExpected) => {
      if (plan === "custom") {
        registerMemoryCapability("third-party-memory", {
          flushPlanResolver: () =>
            createModifiedMemoryFlushPlan({
              reserveTokensFloor: 12_000,
              softThresholdTokens: 2_000,
            }),
        });
      }
      const entry = createFlushSessionEntry({ totalTokens, compactionCount: 0 });
      const storePath = path.join(rootDir, "sessions.json");
      await writeTestSessionStore(storePath, "main", entry);
      const overrides = { modelContextTokens: 32_768, promptForEstimate: "", storePath };
      const first = await runDefaultMemoryFlush(entry, overrides);
      expect(first.outcome).toBe(flushExpected ? "completed" : "skipped");
      const second = await runDefaultMemoryFlush(first.sessionEntry ?? entry, overrides);
      expect(second.outcome).toBe("skipped");
      expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(flushExpected ? 1 : 0);
      await runDefaultPreflight(first.sessionEntry ?? entry, overrides);
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(compactionExpected ? 1 : 0);
    },
  );

  it("runs exactly one auto-reply memory flush turn, rotates, and persists metadata", async () => {
    const followupRun = createTestFollowupRun({
      authProfileId: "anthropic:work",
      authProfileIdSource: "user",
      allowEmptyAssistantReplyAsSilent: false,
      terminalReplyExpectation: "required",
    });
    const targetPath = path.join(followupRun.run.workspaceDir, "memory/2023-11-14.md");
    registerAgentRunContextMock.mockImplementationOnce(() => {
      expect(fsCore.readFileSync(targetPath, "utf8")).toBe("");
    });
    const { result, sessionKey, storePath } = await runProjectedCompaction(true, followupRun);

    expect(result.outcome).toBe("completed");
    expect(result.sessionEntry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedAgentEntryMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(requireModelFallbackCall().userLockedAuthProfileId).toBe("anthropic:work");
    const flushCall = requireEmbeddedAgentCall();
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.prompt).not.toBe(flushCall.transcriptPrompt);
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.allowEmptyAssistantReplyAsSilent).toBe(true);
    expect(flushCall.terminalReplyExpectation).toBe("optional");
    const flushRunId = runEmbeddedAgentEntryMock.mock.calls[0]?.[0].identity.runId;
    expect(flushRunId).toEqual(expect.any(String));
    expect(flushRunId).not.toBe("");
    expect(registerAgentRunContextMock).toHaveBeenCalledWith(
      flushRunId,
      expect.objectContaining({
        isControlUiVisible: false,
        projectSessionActive: false,
        projectSessionLifecycle: false,
        projectSessionMessages: false,
        sessionId: "session",
        sessionKey,
      }),
    );
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(await fs.readFile(targetPath, "utf8")).toBe("");
    expect(registerAgentRunContextMock.mock.invocationCallOrder[0]).toBeLessThan(
      runEmbeddedAgentEntryMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(runEmbeddedAgentEntryMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearAgentRunContextMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(clearAgentRunContextMock).toHaveBeenCalledOnce();
    expect(clearAgentRunContextMock).toHaveBeenCalledWith(flushRunId);
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledTimes(1);
    const refreshCall = requireRefreshQueuedFollowupSessionCall();
    expect(refreshCall.key).toBe(sessionKey);
    expect(refreshCall.previousSessionId).toBe("session");
    expect(refreshCall.nextSessionId).toBe("session-rotated");
    expect(refreshCall.nextSessionFile).toBe(sessionKey);

    const persisted = loadMainSessionEntry(storePath);
    expect(persisted.sessionId).toBe("session-rotated");
    expect(persisted.compactionCount).toBe(2);
    expect(persisted.memoryFlush).toEqual({ kind: "succeeded", compactionCount: 1 });
  });

  it("accounts accepted memory compaction once after a model-only fallback refreshes context", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = createFlushSessionEntry({ lifecycleRevision: "memory-generation" });
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);
    const primaryError = new Error("primary failed after accepted compaction");
    let accepted: Awaited<ReturnType<typeof commitMemoryCompaction>> | undefined;
    let admission: PreparedAgentRunAdmission | undefined;
    let admittedContext: AdmittedRunContext | undefined;
    runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        admission = params.preparedRunAdmission;
        if (!admission) {
          throw new Error("expected the memory turn's prepared admission");
        }
        admittedContext = await admission.admit("embedded");
        expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeDefined();
        accepted = await commitMemoryCompaction({ sessionKey, storePath, run: params });
        throw primaryError;
      })
      .mockImplementationOnce(async (params: EmbeddedAgentParams) => {
        if (!accepted || !admission || !admittedContext) {
          throw new Error("expected the first candidate's accepted successor and admission");
        }
        expect(params.preparedRunAdmission).toBe(admission);
        expect(await admission.admit("embedded")).toBe(admittedContext);
        expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeDefined();
        expect(params).toMatchObject({ sessionId: "session-rotated", sessionFile: sessionKey });
        expect(incrementCompactionCountMock).not.toHaveBeenCalled();
        expect(loadMainSessionEntry(storePath).compactionCount).toBe(1);
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 0,
          currentContextSnapshot: { tokens: 120 },
          target: {
            ...accepted.sessionTarget,
            lifecycleRevision: accepted.entry.lifecycleRevision,
            activeWriterRunId: accepted.entry.activeWriterRunId,
          },
        });
        return {
          payloads: [],
          meta: {
            agentMeta: {
              sessionId: "session-rotated",
              compactionCount: 0,
              compactionTokensAfter: 42,
              lastCallUsage: { input: 999 },
            },
          },
        };
      });
    runWithModelFallbackMock.mockImplementationOnce(async (params: ModelFallbackParams) => {
      await expect(
        params.run("anthropic", "claude", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude"),
        }),
      ).rejects.toBe(primaryError);
      return {
        result: await params.run("anthropic", "fallback", {
          modelRoutingProvenance: modelRoutingProvenance("anthropic", "claude", "fallback"),
        }),
        provider: "anthropic",
        model: "fallback",
        attempts: [],
      };
    });

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({
        thinkingCatalog: [
          { provider: "anthropic", id: "claude", input: ["text"] },
          { provider: "anthropic", id: "fallback", input: ["text"] },
        ],
      }),
      sessionStore,
      sessionKey,
      storePath,
    });

    expect(result.outcome).toBe("completed");
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(2);
    expect(incrementCompactionCountMock).toHaveBeenCalledOnce();
    expect(loadMainSessionEntry(storePath)).toMatchObject({
      sessionId: "session-rotated",
      lifecycleRevision: "memory-generation",
      compactionCount: 2,
      totalTokens: 120,
      totalTokensFresh: true,
      memoryFlush: { kind: "succeeded", compactionCount: 1 },
    });
    expect(result.sessionEntry).toEqual(loadMainSessionEntry(storePath));
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledOnce();
    if (!admittedContext) {
      throw new Error("expected the memory turn to have admitted its first candidate");
    }
    expect(getAdmittedRunDelegatedAuthority(admittedContext)).toBeUndefined();
  });

  it("does not rotate or increment for an incomplete projected compaction end", async () => {
    const { followupRun, result, storePath } = await runProjectedCompaction(false);

    expect(result.sessionEntry?.sessionId).toBe("session");
    expect(followupRun.run.sessionId).toBe("session");
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
    expect(loadMainSessionEntry(storePath).compactionCount).toBe(1);
  });

  it("inherits requester taint across a multi-write flush", async () => {
    const targetPath = path.join(rootDir, "memory", "2023-11-14.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "trusted existing line\n", "utf8");
    runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await fs.appendFile(targetPath, "first untrusted line\n", "utf8");
      params.onAgentEvent?.({
        stream: "tool",
        data: { name: "write", phase: "result", isError: false },
      });
      await fs.appendFile(targetPath, "second untrusted line\n", "utf8");
      params.onAgentEvent?.({
        stream: "tool",
        data: { name: "write", phase: "result", isError: false },
      });
      return { payloads: [], meta: {} };
    });
    const sessionEntry = createFlushSessionEntry();

    await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({ workspaceDir: rootDir, senderIsOwner: false }),
    });

    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialTurnTainted: true }),
    );
  });

  it("downgrades an owner-directed flush after a network-tainted embedded turn", async () => {
    const storePath = path.join(rootDir, "tainted-owner-session.json");
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      {
        type: "message",
        message: { role: "user", content: "Research this", __openclaw: { senderIsOwner: true } },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "untrusted page",
          __openclaw: { resultContentSource: "network" },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "network-derived answer",
          __openclaw: { turnTainted: true },
        },
      },
      // Force the bounded SQLite tail to lose the turn boundary and taint marker.
      // A truncated active turn must remain conservatively tainted.
      ...Array.from({ length: 512 }, (_, index) => ({
        type: "custom",
        data: { index },
      })),
    ]);
    const targetPath = path.join(rootDir, "memory", "2023-11-14.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await fs.writeFile(targetPath, "network-derived memory\n", "utf8");
      params.onAgentEvent?.({
        stream: "tool",
        data: { name: "write", phase: "result", isError: false },
      });
      return { payloads: [], meta: {} };
    });
    const sessionEntry = createFlushSessionEntry();

    await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({
        workspaceDir: rootDir,
        sessionId: "session",
        sessionKey,
        senderIsOwner: true,
      }),
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
    });

    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialTurnTainted: true }),
    );
  });

  it.each([undefined, "default", "ultra"] as const)(
    "revalidates original thinking for memory-flush fallback with turn request=%s",
    async (override) => {
      const storePath = path.join(rootDir, "sessions.json");
      const sessionKey = "main";
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        thinkingLevel: "ultra",
      };
      const sessionStore = { [sessionKey]: sessionEntry };
      await writeTestSessionStore(storePath, sessionKey, sessionEntry);
      runWithModelFallbackMock.mockImplementationOnce(
        async (params: { run: ModelFallbackParams["run"] }) => {
          await params.run("openai", "gpt-5.6-sol", {
            modelRoutingProvenance: modelRoutingProvenance("openai", "gpt-5.6-sol"),
          });
          return {
            result: await params.run("demo", "basic", {
              modelRoutingProvenance: modelRoutingProvenance("openai", "gpt-5.6-sol", "fallback"),
            }),
            provider: "demo",
            model: "basic",
            attempts: [],
          };
        },
      );
      const followupRun = createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.6-sol",
        thinkLevel: "ultra",
        thinkingCatalog: [
          { provider: "openai", id: "gpt-5.6-sol", input: ["text"] },
          { provider: "demo", id: "basic", input: ["text"] },
        ],
      });

      if (override !== undefined) {
        followupRun.run = {
          ...followupRun.run,
          thinkLevel: override === "ultra" ? "off" : "ultra",
          thinkLevelOverride: override,
        };
      }

      await runMemoryFlushIfNeeded({
        cfg: {
          agents: {
            defaults: {
              compaction: { memoryFlush: {} },
              models: {
                "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        },
        followupRun,
        sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
        defaultModel: "openai/gpt-5.6-sol",
        modelContextTokens: 100_000,
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      });

      expect(runEmbeddedAgentMock.mock.calls.map((call) => call[0]?.thinkLevel)).toEqual([
        "ultra",
        "high",
      ]);
      expect(followupRun.run.thinkLevel).toBe(override === "ultra" ? "off" : "ultra");
    },
  );

  it("preserves thinking for runtime-discovered Ollama memory-flush models", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      thinkingLevel: "high",
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);
    const followupRun = createTestFollowupRun({
      provider: "ollama",
      model: "qwen3.5:4b",
    });
    followupRun.run.thinkLevel = "high";
    followupRun.run.thinkingCatalog = [
      { provider: "ollama", id: "qwen3.5:4b", reasoning: true, input: ["text"] },
    ];

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun,
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "ollama/qwen3.5:4b",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(requireEmbeddedAgentCall().thinkLevel).toBe("high");
  });

  it("keeps catalog-adopted sessions on Codex for memory flush turns", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "catalog-adopted-session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
      agentHarnessId: "codex",
      agentRuntimeOverride: "claude-cli",
      modelSelectionLocked: true,
      pluginExtensions: {
        codex: {
          supervision: {
            sourceThreadId: "019f-codex-thread",
            modelLocked: true,
          },
        },
      },
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: { memoryFlush: {} },
            models: {
              "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude-opus-4-6",
        sessionId: sessionEntry.sessionId,
        sessionKey: "main",
      }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result.outcome).toBe("completed");
    expect(requireEmbeddedAgentCall()).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-6",
      agentHarnessId: "codex",
      agentHarnessRuntimeOverride: "codex",
    });
  });

  it("counts resolved error payloads as failed memory flushes", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await commitMemoryCompaction({ sessionKey: "main", storePath, run: params });
      return {
        payloads: [
          { text: "normal silent maintenance reply" },
          {
            text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
            isError: true,
          },
        ],
        meta: { agentMeta: { sessionId: "session-rotated" } },
      };
    });
    const followupRun = createTestFollowupRun();
    incrementCompactionCountMock.mockImplementation(incrementCompactionCount);

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun,
      sessionStore,
      storePath,
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([
      {
        text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
        isError: true,
      },
    ]);
    expect(requireModelFallbackCall().userLockedAuthProfileId).toBeUndefined();
    expect(result.outcome).toBe("failed");
    expect(result.sessionEntry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    const persisted = loadMainSessionEntry(storePath);
    expect(persisted.sessionId).toBe("session-rotated");
    expect(persisted.compactionCount).toBe(2);
    expect(persisted.memoryFlush).toEqual({ kind: "failed", failureCount: 1 });
  });

  it("reports restricted memory-flush write failures for visible delivery", async () => {
    const sessionEntry = createFlushSessionEntry();
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error(
        "write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
      ),
    );

    await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({
        authProfileId: "anthropic:auto",
        authProfileIdSource: "auto",
      }),
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([
      {
        text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
        isError: true,
      },
    ]);
  });

  it("surfaces generic non-abort memory-flush failures so cron meta.error is populated (regression: #80755)", async () => {
    const sessionEntry = createFlushSessionEntry();
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error("provider timed out after 60s while flushing memory"),
    );

    await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([
      {
        text: "⚠️ provider timed out after 60s while flushing memory",
        isError: true,
      },
    ]);
  });

  it("redacts and caps generic visible memory-flush failures before delivery", async () => {
    const sessionEntry = createFlushSessionEntry();
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    const token = "sk-abcdefghijklmnopqrstuv";
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error(`provider failed with Authorization: Bearer ${token} ${"🚀".repeat(400)}`),
    );

    await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    const [payload] = visibleErrorPayloads;
    expect(payload?.isError).toBe(true);
    expect(payload?.text).toMatch(/^⚠️ provider failed with Authorization: Bearer /);
    expect(payload?.text).not.toContain(token);
    expect(payload?.text?.length).toBeLessThanOrEqual(600);
    expect(payload?.text?.endsWith("🚀…")).toBe(true);
  });

  it("does not surface user-abort errors as visible payloads (regression: #80755)", async () => {
    const sessionEntry = createFlushSessionEntry();
    const visibleErrorPayloads: Array<{ text?: string; isError?: boolean }> = [];
    const abortErr = new Error("operation aborted by user");
    abortErr.name = "AbortError";
    runWithModelFallbackMock.mockRejectedValueOnce(abortErr);

    await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    expect(visibleErrorPayloads).toEqual([]);
  });

  it("increments and UTF-16-safely persists a capped non-abort flush failure", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const failureMessage = `${"a".repeat(198)}🚀tail`;
    runWithModelFallbackMock.mockRejectedValueOnce(new Error(failureMessage));

    const result = await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      storePath,
    });

    const persisted = loadMainSessionEntry(storePath);
    expect(result.outcome).toBe("failed");
    expect(persisted.memoryFlush).toEqual({ kind: "failed", failureCount: 1 });
  });

  it.each<{
    stage: string;
    afterRegistration: boolean;
    setup: (error: Error) => void | (() => void);
  }>([
    {
      stage: "initial plan resolution",
      afterRegistration: false,
      setup: (error: Error) => {
        const resolver = vi
          .fn<MemoryFlushPlanResolver>()
          .mockImplementationOnce(() => {
            throw error;
          })
          .mockImplementation(createMemoryFlushPlan);
        registerMemoryFlushPlanResolverForTest(resolver);
      },
    },
    {
      stage: "time-refreshed plan resolution",
      afterRegistration: false,
      setup: (error: Error) => {
        const resolver = vi
          .fn<MemoryFlushPlanResolver>()
          .mockImplementationOnce(createMemoryFlushPlan)
          .mockImplementationOnce(() => {
            throw error;
          })
          .mockImplementation(createMemoryFlushPlan);
        registerMemoryFlushPlanResolverForTest(resolver);
      },
    },
    {
      stage: "target preparation",
      afterRegistration: false,
      setup: (error: Error) => {
        const originalOpen = fsCore.promises.open.bind(fsCore.promises);
        const targetPath = path.join(rootDir, "memory/2023-11-14.md");
        const openSpy = vi
          .spyOn(fsCore.promises, "open")
          .mockImplementation(async (target, flags, mode) => {
            if (target === targetPath) {
              openSpy.mockRestore();
              throw error;
            }
            return await originalOpen(target, flags, mode);
          });
        return () => openSpy.mockRestore();
      },
    },
    {
      stage: "maintenance execution setup",
      afterRegistration: true,
      setup: (error: Error) => {
        runEmbeddedAgentEntryMock.mockRejectedValueOnce(error);
      },
    },
  ])("records a failed $stage attempt, cleans up, and retries", async (failure) => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    const sessionStore = { main: sessionEntry };
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const message = `${failure.stage} failed`;
    const error = new Error(message);
    const cleanup = failure.setup(error);
    const replyOperation = createReplyOperation();
    const visibleErrorPayloads: ReplyPayload[] = [];
    const params = {
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-7",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off" as const,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      isHeartbeat: false,
      replyOperation,
      onVisibleErrorPayloads: (payloads: ReplyPayload[]) => {
        visibleErrorPayloads.push(...payloads);
      },
    };

    try {
      const result = await runMemoryFlushIfNeeded(params);

      expect(result.outcome).toBe("failed");
      expect(sessionStore.main.memoryFlush).toEqual({ kind: "failed", failureCount: 1 });
      const persistedFailure = loadMainSessionEntry(storePath);
      expect(persistedFailure.memoryFlush).toEqual({
        kind: "failed",
        failureCount: 1,
      });
      expect(result.sessionEntry).toEqual(persistedFailure);
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(visibleErrorPayloads).toEqual([{ text: `⚠️ ${message}`, isError: true }]);
      expect(registerAgentRunContextMock).toHaveBeenCalledTimes(failure.afterRegistration ? 1 : 0);
      expect(clearAgentRunContextMock).toHaveBeenCalledTimes(failure.afterRegistration ? 1 : 0);
      if (failure.afterRegistration) {
        expect(clearAgentRunContextMock).toHaveBeenCalledWith(
          registerAgentRunContextMock.mock.calls[0]?.[0],
        );
        expect(registerAgentRunContextMock.mock.invocationCallOrder[0]).toBeLessThan(
          clearAgentRunContextMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
      }

      const retry = await runMemoryFlushIfNeeded({
        ...params,
        sessionEntry: result.sessionEntry,
        replyOperation: createReplyOperation(),
      });

      expect(retry.outcome).toBe("completed");
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      expect(registerAgentRunContextMock).toHaveBeenCalledTimes(failure.afterRegistration ? 2 : 1);
      expect(clearAgentRunContextMock).toHaveBeenCalledTimes(failure.afterRegistration ? 2 : 1);
      expect(loadMainSessionEntry(storePath).memoryFlush).toEqual({
        kind: "succeeded",
        compactionCount: 1,
      });
    } finally {
      if (cleanup) {
        cleanup();
      }
    }
  });

  it("honors a time-refreshed null plan before preparing or registering a run", async () => {
    const resolver = vi
      .fn<MemoryFlushPlanResolver>()
      .mockImplementationOnce(createMemoryFlushPlan)
      .mockReturnValueOnce(null);
    registerMemoryFlushPlanResolverForTest(resolver);
    const sessionEntry = createFlushSessionEntry();

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      defaultModel: "anthropic/claude-opus-4-7",
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    await expect(fs.stat(path.join(rootDir, "memory/2023-11-14.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(registerAgentRunContextMock).not.toHaveBeenCalled();
    expect(runEmbeddedAgentEntryMock).not.toHaveBeenCalled();
  });

  it("does not track failure on abort error", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry();
    await writeTestSessionStore(storePath, "main", sessionEntry);
    const abortErr = new Error("operation aborted by user");
    abortErr.name = "AbortError";
    runWithModelFallbackMock.mockRejectedValueOnce(abortErr);

    const result = await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      storePath,
    });

    const persisted = loadMainSessionEntry(storePath);
    expect(result.outcome).toBe("failed");
    expect(persisted.memoryFlush).toBeUndefined();
  });

  it("clears failure counters on successful flush", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry({
      memoryFlush: { kind: "failed", failureCount: 2 },
    });
    await writeTestSessionStore(storePath, "main", sessionEntry);

    const result = await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      storePath,
    });

    const persisted = loadMainSessionEntry(storePath);
    expect(result.outcome).toBe("completed");
    expect(persisted.memoryFlush).toEqual({ kind: "succeeded", compactionCount: 1 });
  });

  it("marks flush as completed after MAX_FLUSH_FAILURES to break retry loop", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry = createFlushSessionEntry({
      memoryFlush: { kind: "failed", failureCount: TEST_MAX_FLUSH_FAILURES - 1 },
    });
    await writeTestSessionStore(storePath, "main", sessionEntry);
    runWithModelFallbackMock.mockRejectedValueOnce(new Error("provider crashed during flush"));

    const visibleErrorPayloads: ReplyPayload[] = [];
    const result = await runDefaultMemoryFlush(sessionEntry, {
      defaultModel: "anthropic/claude-opus-4-7",
      storePath,
      onVisibleErrorPayloads: (payloads) => {
        visibleErrorPayloads.push(...payloads);
      },
    });

    const persisted = loadMainSessionEntry(storePath);
    expect(result.outcome).toBe("exhausted");
    expect(persisted.memoryFlush).toEqual({ kind: "succeeded", compactionCount: 1 });
    expect(visibleErrorPayloads[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("skipping for this cycle"),
        isError: true,
      }),
    );
  });

  it("runs memory flush on the configured maintenance model without active fallbacks", async () => {
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ model: "ollama/qwen3:8b" }),
    );
    const sessionEntry = createFlushSessionEntry();

    const replyOperation = createReplyOperation();
    await runMemoryFlushIfNeeded({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude",
              fallbacks: ["openai/gpt-5.4"],
            },
            models: {
              "ollama/qwen3:8b": { alias: "memory-flush" },
              "openrouter/qwen3:8b": { alias: "qwen3:8b" },
            },
            compaction: {
              memoryFlush: {
                model: "ollama/qwen3:8b",
              },
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude",
        thinkingCatalog: [
          { provider: "anthropic", id: "claude", input: ["text"] },
          { provider: "ollama", id: "qwen3:8b", input: ["text"] },
        ],
      }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation,
    });

    expect(runWithModelFallbackMock).toHaveBeenCalledTimes(1);
    const fallbackCall = requireModelFallbackCall();
    expect(fallbackCall.provider).toBe("ollama");
    expect(fallbackCall.model).toBe("qwen3:8b");
    expect(fallbackCall.requestedRouteResolution).toBe("raw");
    expect(fallbackCall.abortSignal?.aborted).toBe(false);
    expect(fallbackCall.sessionId).toBe("session");
    expect(fallbackCall.fallbacksOverride).toEqual([]);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    const agentCall = requireEmbeddedAgentCall();
    expect(agentCall.provider).toBe("ollama");
    expect(agentCall.model).toBe("qwen3:8b");
    expect(agentCall.abortSignal).toBe(fallbackCall.abortSignal);
    expect(agentCall.authProfileId).toBeUndefined();
    expect(agentCall.authProfileIdSource).toBeUndefined();
  });

  it.each([undefined, "model-owner"])(
    "prepares the requested memory runtime without pinning observations (owner %s)",
    async (pluginOwnerId) => {
      const cfg = {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {},
            },
          },
        },
      };
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 80_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        compactionCount: 1,
        agentRuntimeOverride: "codex",
        modelSelectionLocked: pluginOwnerId !== undefined,
        pluginOwnerId,
        agentHarnessId: "openclaw",
      };
      const runtimePolicySessionKey = "agent:main:telegram:default:direct:12345";
      runWithModelFallbackMock.mockImplementationOnce(
        async (params: { provider: string; model: string; run: ModelFallbackParams["run"] }) => ({
          result: await params.run(params.provider, params.model, {
            isFinalFallbackAttempt: false,
            modelRoutingProvenance: modelRoutingProvenance(params.provider, params.model),
          }),
          provider: params.provider,
          model: params.model,
          attempts: [],
        }),
      );

      await runMemoryFlushIfNeeded({
        cfg,
        followupRun: createTestFollowupRun({
          agentId: "main",
          sessionKey: "main",
          runtimePolicySessionKey,
          workspaceDir: rootDir,
          provider: "openai",
          model: "gpt-5.4",
          modelSelectionLocked: sessionEntry.modelSelectionLocked,
        }),
        sessionCtx: createTestTemplateContext({ Provider: "telegram" }),
        defaultModel: "openai/gpt-5.4",
        modelContextTokens: 100_000,
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        runtimePolicySessionKey,
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      });

      const fallbackCall = requireModelFallbackCall();
      expect(fallbackCall.agentId).toBe("main");
      expect(fallbackCall.sessionKey).toBe(runtimePolicySessionKey);
      expect(fallbackCall.resolveAgentHarnessRuntimeOverride?.("openai", "gpt-5.4")).toBe("codex");
      expect(requireEmbeddedAgentCall()).toMatchObject({
        isFinalFallbackAttempt: false,
        agentHarnessId: undefined,
        agentHarnessRuntimeOverride: "codex",
      });

      await fallbackCall.prepareAgentHarnessRuntime?.({
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessRuntimeOverride: "codex",
      });

      expect(ensureSelectedAgentHarnessPluginMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          modelId: "gpt-5.4",
          agentId: "main",
          sessionKey: runtimePolicySessionKey,
          agentHarnessId: "codex",
          agentHarnessRuntimeOverride: "codex",
          workspaceDir: rootDir,
        }),
      );
    },
  );

  it("ignores stale runtime pins before memory-flush fallback preflight", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
      agentRuntimeOverride: "unsupported-runtime",
    };

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.4",
      }),
      sessionCtx: createTestTemplateContext({ Provider: "telegram" }),
      defaultModel: "openai/gpt-5.4",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(
      requireModelFallbackCall().resolveAgentHarnessRuntimeOverride?.("openai", "gpt-5.4"),
    ).toBeUndefined();
  });

  it("skips memory flush for CLI providers", async () => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push({
      pluginId: "test-codex-cli",
      source: "test",
      backend: { id: "codex-cli", config: { command: "codex" } },
    });
    setActivePluginRegistry(registry);
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: {},
      followupRun: createTestFollowupRun({ provider: "codex-cli" }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "codex-cli/gpt-5.5",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips memory flush for incognito sessions", async () => {
    const sessionEntry = createFlushSessionEntry({
      incognito: true,
      sessionId: "incognito-session",
    });

    const result = await runDefaultMemoryFlush(sessionEntry, {
      followupRun: createTestFollowupRun({ workspaceDir: rootDir }),
      sessionCtx: createTestTemplateContext({ Provider: "webchat" }),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(rootDir, "memory/2023-11-14.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("skips memory flush for an incognito key after process-local state is gone", async () => {
    const sessionKey = "agent:main:dashboard:incognito-deleted-memory";
    const sessionEntry = createFlushSessionEntry({
      sessionId: "rematerialized-session",
    });

    const result = await runDefaultMemoryFlush(sessionEntry, {
      sessionCtx: createTestTemplateContext({ Provider: "webchat" }),
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("skips memory flush for compatible CLI session runtime pins", async () => {
    registerClaudeCliBackend();
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
      agentRuntimeOverride: "claude-cli",
    };

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it.each([
    { agentId: "main", sessionKey: "global", runtimePolicySessionKey: "global" },
    {
      agentId: "other",
      sessionKey: "agent:other:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
    },
  ])(
    "uses the policy owner's memory-flush writability for $sessionKey",
    async ({ agentId, sessionKey, runtimePolicySessionKey }) => {
      const sessionEntry = createFlushSessionEntry();

      const result = await runMemoryFlushIfNeeded({
        cfg: {
          agents: {
            ownership: "explicit",
            entries: { main: {}, other: { sandbox: { workspaceAccess: "rw" } } },
            defaults: {
              sandbox: {
                mode: "all",
                scope: "agent",
                workspaceAccess: "ro",
              },
              compaction: {
                memoryFlush: {},
              },
            },
          },
        },
        followupRun: createTestFollowupRun({
          agentId,
          sessionKey,
          runtimePolicySessionKey,
        }),
        sessionCtx: createTestTemplateContext({ Provider: "telegram" }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100_000,
        resolvedVerboseLevel: "off",
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        runtimePolicySessionKey,
        isHeartbeat: false,
        replyOperation: createReplyOperation(),
      });

      expect(result).toEqual({ sessionEntry, outcome: "skipped" });
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    },
  );

  it("skips memory flush when a persisted sandbox requirement caps workspace access", async () => {
    const sessionKey = "agent:main:guest";
    const storePath = path.join(rootDir, "agents", "main", "sessions", "sessions.json");
    const sessionEntry = createFlushSessionEntry({ sandbox: "required" });
    await writeTestSessionStore(storePath, sessionKey, sessionEntry);

    const result = await runDefaultMemoryFlush(sessionEntry, {
      cfg: {
        session: { store: storePath },
        agents: {
          defaults: {
            sandbox: { mode: "off", workspaceAccess: "rw" },
            compaction: { memoryFlush: {} },
          },
        },
      },
      followupRun: createTestFollowupRun({ sessionKey, workspaceDir: rootDir }),
      sessionKey,
      storePath,
    });

    expect(result).toEqual({ sessionEntry, outcome: "skipped" });
    await expect(fs.stat(path.join(rootDir, "memory/2023-11-14.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues when preflight compaction reports the session is already under target", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
    );
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "already under target",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    };
    const onCompactionNotice = vi.fn();

    const entry = await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
      }),
      modelContextTokens: 100,
      sessionKey: "agent:main:main",
      onCompactionNotice,
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
      trigger: "budget",
      force: true,
      forcePreflight: true,
      preflightRequired: true,
      preflightCompactionTrigger: "tokens",
      deferOwningContextEngineCompaction: false,
      contextTokenBudget: 100,
      agentHarnessId: "openclaw",
      modelSelectionLocked: true,
    });
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "skipped");

    onCompactionNotice.mockClear();
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "no real conversation messages",
    });
    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100,
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
        onCompactionNotice,
      }),
    ).rejects.toThrow("Preflight compaction required but failed: no real conversation messages");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "incomplete");
  });

  it("fails when required preflight context-engine compaction is deferred to background maintenance", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
    );
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "deferred to background context-engine maintenance",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };

    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100,
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      }),
    ).rejects.toThrow(
      "Preflight compaction required but failed: deferred to background context-engine maintenance",
    );

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("passes persisted session policy and runtime policy key to preflight compaction", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      permissionMode: "full",
      sessionRoot: "/tmp/workspace",
    };

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "agent:main:main",
        cwd: "/tmp/task-repo",
        runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
      }),
      modelContextTokens: 100,
      sessionKey: "agent:main:main",
      runtimePolicySessionKey: "agent:main:telegram:default:direct:12345",
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.sessionKey).toBe("agent:main:main");
    expect(compactCall.cwd).toBe("/tmp/task-repo");
    expect(compactCall.sandboxSessionKey).toBe("agent:main:telegram:default:direct:12345");
    expect(compactCall.sessionEntry).toBe(sessionEntry);
  });

  it.each([
    ["stale_thread_binding", "thread not found: <codex-thread-id>"],
    ["missing_thread_binding", "no thread binding for session"],
  ])(
    "fails required preflight compaction after native harness %s failure",
    async (failureReason, reason) => {
      const sessionFile = path.join(rootDir, "session.jsonl");
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
        "utf8",
      );
      registerMemoryFlushPlanResolverForTest(() => ({
        softThresholdTokens: 1,
        forceFlushTranscriptBytes: 1_000_000_000,
        reserveTokensFloor: 0,
        prompt: "Pre-compaction memory flush.\nNO_REPLY",
        systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
        relativePath: "memory/2023-11-14.md",
      }));
      compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason,
        failure: { reason: failureReason },
      });
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 120,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      };
      const sessionStore = { "agent:main:telegram:group:redacted": sessionEntry };

      await expect(
        runSessionCompactionIfNeeded({
          cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
          followupRun: createTestFollowupRun({
            sessionId: "session",
            sessionFile,
            sessionKey: "agent:main:telegram:group:redacted",
          }),
          defaultModel: "anthropic/claude-opus-4-6",
          modelContextTokens: 100,
          sessionEntry,
          sessionStore,
          sessionKey: "agent:main:telegram:group:redacted",
          storePath: path.join(rootDir, "sessions.json"),
          isHeartbeat: false,
          ...createCompactionLifecycle(createReplyOperation()),
        }),
      ).rejects.toThrow(`Preflight compaction required but failed: ${reason}`);

      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
      expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    },
  );

  it("fails required preflight compaction after an unstructured thread-not-found failure", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "thread not found: <codex-thread-id>",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    const sessionStore = { "agent:main:telegram:group:redacted": sessionEntry };

    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:telegram:group:redacted",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:telegram:group:redacted",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      }),
    ).rejects.toThrow(
      "Preflight compaction required but failed: thread not found: <codex-thread-id>",
    );

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("still fails preflight compaction for non-binding native harness failures", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ message: { role: "user", content: "x".repeat(5_000) } })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "auth profile mismatch",
      failure: { reason: "auth_profile_mismatch" },
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    const sessionStore = { "agent:main:telegram:group:redacted": sessionEntry };

    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "agent:main:telegram:group:redacted",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100,
        sessionEntry,
        sessionStore,
        sessionKey: "agent:main:telegram:group:redacted",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      }),
    ).rejects.toThrow("Preflight compaction required but failed: auth profile mismatch");

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it.each(["user", "auto"] as const)(
    "passes resolved context budget and %s auth profile to preflight compaction",
    async (authProfileIdSource) => {
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 245_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        compactionCount: 0,
      };

      await runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          authProfileId: "anthropic:claude@martian.engineering",
          authProfileIdSource,
          provider: "anthropic",
          model: "claude-opus-4-6",
          sessionKey: "agent:main:main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 258_000,
        sessionEntry,
        sessionStore: { "agent:main:main": sessionEntry },
        sessionKey: "agent:main:main",
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      });

      const compactCall = requireCompactEmbeddedAgentSessionCall();
      expect(compactCall.authProfileId).toBe("anthropic:claude@martian.engineering");
      expect(compactCall.authProfileIdSource).toBe(authProfileIdSource);
      expect(compactCall.contextTokenBudget).toBe(258_000);
    },
  );
  it.each([
    {
      label: "fresh local tool turn in a 32K window",
      totalTokens: 12_824,
      shouldCompact: false,
      requestedRuntime: "openclaw",
      contextWindowTokens: 32_768,
    },
    {
      label: "below the 32K threshold",
      totalTokens: 24_575,
      shouldCompact: false,
      requestedRuntime: "openclaw",
      contextWindowTokens: 32_768,
    },
    {
      label: "at the 32K threshold",
      totalTokens: 24_576,
      shouldCompact: true,
      requestedRuntime: "openclaw",
      contextWindowTokens: 32_768,
    },
    {
      label: "below the capped 8K threshold",
      totalTokens: 5_999,
      shouldCompact: false,
      requestedRuntime: "openclaw",
      contextWindowTokens: 8_000,
    },
    {
      label: "at the capped 8K threshold",
      totalTokens: 6_000,
      shouldCompact: true,
      requestedRuntime: "openclaw",
      contextWindowTokens: 8_000,
    },
    {
      label: "below threshold",
      totalTokens: 901_999,
      shouldCompact: false,
      requestedRuntime: "openclaw",
      contextWindowTokens: 922_000,
    },
    {
      label: "at threshold",
      totalTokens: 902_000,
      shouldCompact: true,
      requestedRuntime: "openclaw",
      contextWindowTokens: 922_000,
    },
    {
      label: "reported pressure",
      totalTokens: 904_869,
      shouldCompact: true,
      requestedRuntime: "openclaw",
      contextWindowTokens: 922_000,
    },
    {
      label: "reported pressure after a runtime fallback",
      totalTokens: 904_869,
      shouldCompact: true,
      requestedRuntime: "codex",
      contextWindowTokens: 922_000,
    },
  ] as const)(
    "applies session compaction at $label with memory flush disabled",
    async ({ totalTokens, shouldCompact, requestedRuntime, contextWindowTokens }) => {
      // A disabled memory plugin supplies no flush plan; compaction still owns its budget.
      registerMemoryFlushPlanResolverForTest(() => null);
      const sessionEntry = createFlushSessionEntry({
        totalTokens,
        compactionCount: 0,
        agentHarnessId: requestedRuntime,
        agentRuntimeOverride: requestedRuntime,
        lifecycleRevision: "owned-generation",
      });
      const authorize = () => true;
      const overrides: Partial<PreflightCompactionTestParams> = {
        cfg: {
          agents: {
            defaults: { compaction: { mode: "safeguard", memoryFlush: { enabled: false } } },
          },
          tools: { deny: ["*"] },
          models: {
            providers: {
              openai: {
                agentRuntime: { id: requestedRuntime },
                baseUrl: "https://chatgpt.com/backend-api",
                api: "openai-chatgpt-responses",
                models: [
                  {
                    id: "gpt-5.6-luna",
                    name: "Context budget test",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1_050_000,
                    contextTokens: 922_000,
                    maxTokens: 128_000,
                  },
                ],
              },
            },
          },
        },
        followupRun: createTestFollowupRun({
          provider: "openai",
          model: "gpt-5.6-luna",
          workspaceDir: rootDir,
          agentDir: rootDir,
        }),
        defaultModel: "openai/gpt-5.6-luna",
        modelContextTokens: contextWindowTokens,
        promptForEstimate: "",
        authorize,
        ...(requestedRuntime === "codex" ? { agentHarnessId: "openclaw" } : {}),
      };

      const flush = await runDefaultMemoryFlush(sessionEntry, overrides);
      expect(flush.outcome).toBe("skipped");
      await runDefaultPreflight(sessionEntry, overrides);

      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(shouldCompact ? 1 : 0);
      if (shouldCompact) {
        expect(requireCompactEmbeddedAgentSessionCall()).toMatchObject({
          agentHarnessId: "openclaw",
          contextTokenBudget: contextWindowTokens,
          currentTokenCount: totalTokens,
          force: true,
          forcePreflight: true,
          preflightRequired: true,
          preflightCompactionTrigger: "tokens",
        });
        expect(incrementCompactionCountMock).toHaveBeenCalledWith(
          expect.objectContaining({
            expectedSession: expect.objectContaining({
              sessionId: "session",
              lifecycleRevision: "owned-generation",
            }),
          }),
        );
      }
    },
  );

  it.each([
    { stage: "before start", invalidation: "authorization" },
    { stage: "before start", invalidation: "abort" },
    { stage: "after start notice", invalidation: "authorization" },
    { stage: "after start notice", invalidation: "abort" },
    { stage: "after awaited compactor", invalidation: "authorization" },
    { stage: "after awaited compactor", invalidation: "abort" },
  ] as const)(
    "rejects $invalidation invalidation $stage without accounting or adopting compaction",
    async ({ stage, invalidation }) => {
      const sessionEntry = createFlushSessionEntry();
      const sessionStore = { main: sessionEntry };
      const followupRun = createTestFollowupRun({ workspaceDir: rootDir });
      const controller = new AbortController();
      let authorized = true;
      const invalidate = () => {
        if (invalidation === "authorization") {
          authorized = false;
        } else {
          controller.abort(new Error("caller aborted"));
        }
      };
      const compactorStarted = createDeferred();
      const releaseCompactor = createDeferred();
      compactEmbeddedAgentSessionMock.mockImplementationOnce(async (_params, host) => {
        compactorStarted.resolve();
        await releaseCompactor.promise;
        host?.assertActive?.();
        return { ok: true, compacted: true, result: { tokensAfter: 42, sessionId: "successor" } };
      });
      const onCompactionStart = vi.fn();
      const onSessionIdChanged = vi.fn();
      const onCompactionNotice = vi.fn(async (phase: string) => {
        if (stage === "after start notice" && phase === "start") {
          invalidate();
        }
      });
      if (stage === "before start") {
        invalidate();
      }
      if (stage !== "after awaited compactor") {
        releaseCompactor.resolve();
      }

      const pending = runDefaultPreflight(sessionEntry, {
        followupRun,
        sessionStore,
        abortSignal: controller.signal,
        authorize: () => authorized,
        onCompactionStart,
        onSessionIdChanged,
        onCompactionNotice,
      });
      if (stage === "after awaited compactor") {
        await compactorStarted.promise;
        invalidate();
        releaseCompactor.resolve();
      }
      await expect(pending).rejects.toThrow(
        invalidation === "authorization"
          ? "Session compaction maintenance is no longer active"
          : "caller aborted",
      );

      expect(onCompactionStart).toHaveBeenCalledTimes(stage === "before start" ? 0 : 1);
      if (stage === "before start") {
        expect(onCompactionNotice).not.toHaveBeenCalled();
      }
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(
        stage === "after awaited compactor" ? 1 : 0,
      );
      expect(incrementCompactionCountMock).not.toHaveBeenCalled();
      expect(onSessionIdChanged).not.toHaveBeenCalled();
      expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
      expect(sessionStore.main).toBe(sessionEntry);
      expect(followupRun.run.sessionId).toBe("session");
    },
  );

  it("preflight compacts a fresh session when the current prompt estimate pushes the next request over budget", async () => {
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 0, reserveTokensFloor: 10 }),
    );
    const storePath = path.join(rootDir, "preflight-fresh-sessions.json");
    const sessionKey = "agent:main:main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 985,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, sessionEntry);

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude",
        sessionKey,
      }),
      promptForEstimate: "Please summarize the entire design discussion above. ".repeat(8),
      defaultModel: "anthropic/claude",
      modelContextTokens: 1000,
      sessionKey,
      storePath,
    });

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
  });
  it("does not preflight compact a fresh session when only accumulated output tokens are large and the latest output keeps the request under budget", async () => {
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 0, reserveTokensFloor: 10 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 985,
      outputTokens: 50_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };

    await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude",
        sessionKey: "agent:main:main",
      }),
      promptForEstimate: "",
      defaultModel: "anthropic/claude",
      modelContextTokens: 1000,
      sessionEntry,
      sessionStore: { "agent:main:main": sessionEntry },
      sessionKey: "agent:main:main",
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });
  it("stops at unavailable context and accepts only a later valid transcript snapshot", async () => {
    const sessionKey = "agent:main:main";
    const storePath = path.join(rootDir, "sessions.json");
    const oldCumulative = {
      type: "message",
      message: {
        role: "assistant",
        content: "old cumulative turn",
        usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      },
    };
    const unavailable = {
      type: "message",
      message: {
        role: "assistant",
        content: "usage unavailable",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          contextUsage: { state: "unavailable" },
        },
      },
    };
    await writeTestSessionTranscript({ rootDir, sessionKey, events: [oldCumulative, unavailable] });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
      compactionCount: 0,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const run = () =>
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          provider: "anthropic",
          model: "claude",
          sessionId: "session",
          sessionKey,
        }),
        promptForEstimate: "",
        defaultModel: "anthropic/claude",
        modelContextTokens: 100_000,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      });

    await run();
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();

    await writeTestSessionTranscript({
      rootDir,
      sessionKey,
      events: [
        oldCumulative,
        unavailable,
        {
          type: "message",
          message: {
            role: "assistant",
            content: "valid later turn",
            usage: { input: 67_932, output: 2_000, cacheRead: 18_944, totalTokens: 88_876 },
          },
        },
      ],
    });
    await run();

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    expect(requireCompactEmbeddedAgentSessionCall().currentTokenCount).toBe(88_876);
  });
  it("ignores unversioned fresh state and legacy CLI usage on the first upgraded turn", async () => {
    const sessionKey = "agent:main:main";
    const storePath = path.join(rootDir, "sessions.json");
    const legacyCli = {
      type: "message",
      message: {
        role: "assistant",
        api: "cli",
        content: "legacy cumulative turn",
        usage: { input: 128_814, output: 3_000, cacheRead: 992_953, totalTokens: 1_124_767 },
      },
    };
    await writeTestSessionTranscript({ rootDir, sessionKey, events: [legacyCli] });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1_124_767,
      totalTokensFresh: true,
      compactionCount: 0,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    const run = () =>
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          provider: "anthropic",
          model: "claude",
          sessionId: "session",
          sessionKey,
        }),
        promptForEstimate: "",
        defaultModel: "anthropic/claude",
        modelContextTokens: 100_000,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      });

    await run();
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();

    await writeTestSessionTranscript({
      rootDir,
      sessionKey,
      events: [
        legacyCli,
        {
          type: "message",
          message: {
            role: "assistant",
            api: "cli",
            content: "repaired exact turn",
            usage: {
              input: 67_932,
              output: 2_000,
              cacheRead: 18_944,
              totalTokens: 88_876,
              contextUsage: {
                state: "available",
                promptTokens: 86_876,
                totalTokens: 88_876,
              },
            },
          },
        },
      ],
    });
    await run();

    expect(requireCompactEmbeddedAgentSessionCall().currentTokenCount).toBe(88_876);
  });
  it("updates the active preflight run after transcript rotation", async () => {
    const sessionFile = path.join(rootDir, "session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      sessionKey: "agent:main:main",
      events: [{ type: "message", message: { role: "user", content: "x".repeat(5_000) } }],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 1, reserveTokensFloor: 0 }),
    );
    compactEmbeddedAgentSessionMock.mockImplementationOnce(async (_params, host) => {
      host?.assertActive?.();
      const accepted = await commitMemoryCompaction({
        sessionKey: "agent:main:main",
        storePath: path.join(rootDir, "sessions.json"),
      });
      host?.onCommitted?.(accepted);
      return {
        ok: true,
        compacted: true,
        result: { tokensAfter: 42, sessionId: accepted.sessionId },
      };
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const sessionStore = { "agent:main:main": sessionEntry };
    const followupRun = createTestFollowupRun({
      sessionId: "session",
      sessionFile,
      sessionKey: "agent:main:main",
    });
    const replyOperation = createReplyOperation();

    const entry = await runDefaultPreflight(sessionEntry, {
      followupRun,
      modelContextTokens: 100,
      sessionStore,
      sessionKey: "agent:main:main",
      ...createCompactionLifecycle(replyOperation),
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(entry?.sessionFile).toBeUndefined();
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionFile).toBe("agent:main:main");
    expect(replyOperation.updateSessionId).toHaveBeenCalledWith("session-rotated");
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "agent:main:main",
      previousSessionId: "session",
      nextSessionId: "session-rotated",
      nextSessionFile: "agent:main:main",
    });
  });

  it("includes recent output tokens when deciding preflight compaction", async () => {
    const sessionFile = path.join(rootDir, "session-usage.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: "large answer",
            usage: { input: 90_000, output: 10_000 },
          },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
    });

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(100_000);
  });

  it("keeps nonzero unavailable output as growth after the previous exact snapshot", async () => {
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: "large answer",
            usage: {
              input: 128_814,
              output: 10_000,
              cacheRead: 992_953,
              totalTokens: 1_131_767,
              contextUsage: { state: "unavailable" },
            },
          },
        },
      ],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 72_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };

    await runDefaultPreflight(sessionEntry, {
      promptForEstimate: "continue",
    });

    expect(requireCompactEmbeddedAgentSessionCall().currentTokenCount).toBeGreaterThanOrEqual(
      82_000,
    );
  });

  it("does not add unavailable output twice when full-message estimation already includes it", async () => {
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: "x".repeat(3_600),
            usage: {
              input: 1,
              output: 200,
              totalTokens: 201,
              contextUsage: { state: "unavailable" },
            },
          },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ softThresholdTokens: 0, reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runDefaultPreflight(sessionEntry, {
      promptForEstimate: "",
      modelContextTokens: 1_000,
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("reads flush usage and byte size from SQLite without statting a retired transcript path", async () => {
    const sessionFile = path.join(rootDir, "memory-flush-usage-and-size.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: "large answer",
            usage: { input: 80_000, output: 4_000 },
          },
        },
      ],
    });
    const originalStat = fsCore.promises.stat.bind(fsCore.promises);
    const statSpy = vi
      .spyOn(fsCore.promises, "stat")
      .mockImplementation(async (target, options) => originalStat(target, options));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    let directTranscriptStats: unknown[];
    try {
      await runDefaultMemoryFlush(sessionEntry, {
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
        storePath: path.join(rootDir, "sessions.json"),
      });
      directTranscriptStats = statSpy.mock.calls.filter(
        ([target]) => String(target) === sessionFile,
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(directTranscriptStats).toEqual([]);
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
  });

  it("fails when required preflight compaction returns an unknown successful no-op", async () => {
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: false,
      reason: "plugin already stored this turn",
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 180_499,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };
    const replyOperation = createReplyOperation();

    await expect(
      runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionKey: "main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 200_000,
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(replyOperation),
      }),
    ).rejects.toThrow("Preflight compaction required but failed: plugin already stored this turn");

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.contextTokenBudget).toBe(200_000);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    expect(
      replyOperation.setPhase.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      compactEmbeddedAgentSessionMock.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
    expect(replyOperation.updateSessionId).not.toHaveBeenCalled();
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSessionMock).not.toHaveBeenCalled();
  });

  it("skips OpenClaw preflight compaction for explicit Codex runtime overrides", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: false,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    };

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("skips fresh persisted token totals for explicit Codex runtime overrides", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    };

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("skips preflight compaction for compatible CLI session runtime pins", async () => {
    registerClaudeCliBackend();
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      agentRuntimeOverride: "claude-cli",
    };

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            anthropic: { models: [{ id: "claude-opus-4-6", contextWindow: 350_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "anthropic",
        model: "claude-opus-4-6",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps the OpenAI API context window for persisted OpenClaw runtime overrides", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: false,
      agentRuntimeOverride: "openclaw",
    };

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }] },
          },
        },
        agents: { defaults: { compaction: { memoryFlush: {} } } },
      } as never,
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it.each([
    ["without provider usage", undefined],
    ["after provider usage", 20_000],
  ])(
    "estimates Codex tool-result mirrors through the provider projection %s after runtime cutover",
    async (_label, providerPromptTokens) => {
      const storePath = path.join(rootDir, "sessions.json");
      const sessionKey = "agent:main:telegram:default:direct:12345";
      const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
      const output = "x".repeat(8_192);
      await writeTestSessionTranscript({
        rootDir,
        sessionKey,
        events: [
          ...(providerPromptTokens === undefined
            ? []
            : [
                {
                  type: "message" as const,
                  message: {
                    role: "assistant" as const,
                    content: "Codex usage anchor",
                    usage: {
                      input: providerPromptTokens,
                      output: 100,
                      totalTokens: providerPromptTokens + 100,
                      contextUsage: {
                        state: "available" as const,
                        promptTokens: providerPromptTokens,
                        totalTokens: providerPromptTokens + 100,
                      },
                    },
                  },
                },
              ]),
          ...Array.from({ length: 64 }, (_, index) => {
            const toolCallId = `call-${index}`;
            return [
              {
                type: "message" as const,
                message: {
                  role: "assistant" as const,
                  content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: {} }],
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
                },
              },
              {
                type: "message" as const,
                message: {
                  role: "toolResult" as const,
                  toolCallId,
                  toolName: "exec",
                  isError: false,
                  content: [
                    {
                      type: "toolResult",
                      id: toolCallId,
                      name: "exec",
                      toolName: "exec",
                      toolCallId,
                      toolUseId: toolCallId,
                      tool_use_id: toolCallId,
                      text: output,
                      content: output,
                    },
                  ],
                },
              },
            ];
          }).flat(),
        ],
      });
      const transcriptBefore = readSessionTranscriptMessageEvents(scope);
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokensFresh: false,
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
      };
      compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "guard_blocked",
      });

      const entry = await runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          provider: "openai",
          model: "gpt-5.5",
          sessionId: "session",
          sessionKey,
        }),
        defaultModel: "gpt-5.5",
        modelContextTokens: 128_000,
        sessionEntry,
        sessionStore: { [sessionKey]: sessionEntry },
        sessionKey,
        storePath,
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      });

      expect(entry).toBe(sessionEntry);
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      expect(readSessionTranscriptMessageEvents(scope)).toEqual(transcriptBefore);
    },
  );

  it("accounts for provider-visible history beyond the recent read bounds", async () => {
    await writeTestSessionTranscript({
      rootDir,
      events: Array.from({ length: 250 }, (_, index) => ({
        type: "message" as const,
        message: {
          role: "user" as const,
          content: index < 50 ? "x".repeat(8_192) : "small",
        },
      })),
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
      agentHarnessId: "codex",
      agentRuntimeOverride: "openclaw",
    };

    await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey: "main",
      }),
      defaultModel: "gpt-5.5",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(requireCompactEmbeddedAgentSessionCall().currentTokenCount).toBeGreaterThan(100_000);
  });

  it.each([
    ["below", 20_000, false],
    ["above", 72_000, true],
  ])(
    "uses a provider usage anchor older than the scan window when pressure is %s threshold",
    async (_label, providerPromptTokens, shouldCompact) => {
      await writeTestSessionTranscript({
        rootDir,
        events: [
          ...Array.from({ length: 50 }, () => ({
            type: "message" as const,
            message: { role: "user" as const, content: "x".repeat(8_192) },
          })),
          {
            type: "message",
            message: {
              role: "assistant",
              content: "usage anchor",
              usage: {
                input: providerPromptTokens,
                output: 100,
                totalTokens: providerPromptTokens + 100,
                contextUsage: {
                  state: "available",
                  promptTokens: providerPromptTokens,
                  totalTokens: providerPromptTokens + 100,
                },
              },
            },
          },
          ...Array.from({ length: 520 }, () => ({
            type: "message" as const,
            message: { role: "user" as const, content: "x".repeat(64) },
          })),
        ],
      });
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokensFresh: false,
        agentHarnessId: "codex",
        agentRuntimeOverride: "openclaw",
      };

      await runSessionCompactionIfNeeded({
        cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
        followupRun: createTestFollowupRun({
          provider: "openai",
          model: "gpt-5.5",
          sessionId: "session",
          sessionKey: "main",
        }),
        defaultModel: "gpt-5.5",
        modelContextTokens: 100_000,
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
      });

      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(shouldCompact ? 1 : 0);
    },
  );

  it("does not use the active run sessionFile when the session entry has no transcript path", async () => {
    const sessionFile = path.join(rootDir, "active-run-session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: "large answer",
          usage: { input: 90_000, output: 8_000 },
        },
      })}\n`,
      "utf8",
    );
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("does not treat unavailable Anthropic context as transcript prompt usage", async () => {
    const sessionFile = path.join(rootDir, "unavailable-context-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: "small answer",
            usage: {
              input: 12,
              output: 15_104,
              cacheRead: 819_661,
              cacheWrite: 93_130,
              contextUsage: { state: "unavailable" },
              totalTokens: 927_907,
            },
          },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("keeps preflight compaction conservative for content appended after latest usage", async () => {
    const sessionFile = path.join(rootDir, "post-usage-tail-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: "small answer",
            usage: { input: 40_000, output: 2_000 },
          },
        },
        {
          type: "message",
          message: {
            role: "user",
            content: `large follow-up ${"x".repeat(450_000)}`,
          },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
    });

    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.currentTokenCount).toBeGreaterThan(100_000);
  });

  it.each([0, 513])(
    "combines latest usage with post-usage tail pressure across %i display-only messages",
    async (activityCount) => {
      const sessionFile = path.join(rootDir, "combined-tail-pressure-session.jsonl");
      await writeTestSessionTranscript({
        rootDir,
        events: [
          {
            type: "message",
            message: {
              role: "assistant",
              content: "small answer",
              usage: { input: 90_000, output: 2_000 },
            },
          },
          ...Array.from({ length: activityCount }, () => ({
            type: "message",
            message: {
              role: "custom",
              customType: "tool-activity",
              display: true,
              excludeFromContext: true,
              content: "completed",
            },
          })),
          {
            type: "message",
            message: {
              role: "user",
              content: `moderate follow-up ${"x".repeat(36_000)}`,
            },
          },
        ],
      });
      registerMemoryFlushPlanResolverForTest(() =>
        createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
      );
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokensFresh: false,
      };

      await runDefaultPreflight(sessionEntry, {
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
      });

      const compactCall = requireCompactEmbeddedAgentSessionCall();
      expect(compactCall.currentTokenCount).toBeGreaterThanOrEqual(100_000);
    },
  );

  it("does not count bytes from a large latest usage record as post-usage tail pressure", async () => {
    const sessionFile = path.join(rootDir, "large-usage-record-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: `large answer ${"x".repeat(300_000)}`,
            usage: { input: 40_000, output: 2_000 },
          },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const entry = await runDefaultPreflight(sessionEntry, {
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      modelContextTokens: undefined,
    });

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("does not treat raw transcript metadata bytes as token pressure", async () => {
    const sessionFile = path.join(rootDir, "metadata-heavy-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [
        {
          type: "custom",
          payload: "x".repeat(450_000),
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "small answer",
            usage: { input: 40_000, output: 2_000 },
          },
        },
      ],
    });
    registerMemoryFlushPlanResolverForTest(() =>
      createModifiedMemoryFlushPlan({ reserveTokensFloor: 0 }),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };
    const originalStat = fsCore.promises.stat.bind(fsCore.promises);
    const statSpy = vi
      .spyOn(fsCore.promises, "stat")
      .mockImplementation(async (target, options) => originalStat(target, options));

    let entry: SessionEntry | undefined;
    let directTranscriptStats: unknown[];
    try {
      entry = await runDefaultPreflight(sessionEntry, {
        cfg: {
          agents: {
            defaults: {
              compaction: {
                memoryFlush: {},
                maxActiveTranscriptBytes: "10mb",
              },
            },
          },
        },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
      });
      directTranscriptStats = statSpy.mock.calls.filter(
        ([target]) => String(target) === sessionFile,
      );
    } finally {
      statSpy.mockRestore();
    }

    expect(entry).toBe(sessionEntry);
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(directTranscriptStats).toEqual([]);
  });

  it("triggers preflight compaction when the active transcript exceeds the configured byte threshold", async () => {
    const sessionFile = path.join(rootDir, "large-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [{ type: "message", message: { role: "user", content: "x".repeat(256) } }],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const sessionStore = { main: sessionEntry };
    const replyOperation = createReplyOperation();

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(replyOperation),
    });

    expect(entry?.compactionCount).toBe(1);
    expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.sessionId).toBe("session");
    expect(compactCall.trigger).toBe("budget");
    expect(compactCall.currentTokenCount).toBe(12);
    expect(compactCall.sessionFile).toBe("main");
  });

  it("does not repeat byte-triggered compaction until an oversized successor grows by one threshold", async () => {
    const fixture = await createOversizedByteCompactionFixture();

    await fixture.run(fixture.sessionEntry);
    await fixture.run(loadMainSessionEntry(fixture.storePath));
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId: "session",
        sessionKey: "main",
        storePath: fixture.storePath,
      },
      [{ type: "message", message: { role: "user", content: "x".repeat(260) } }],
    );
    await fixture.run(loadMainSessionEntry(fixture.storePath));

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms byte-triggered compaction after the oversized successor grows by one threshold", async () => {
    const fixture = await createOversizedByteCompactionFixture();

    await fixture.run(fixture.sessionEntry);
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId: "session",
        sessionKey: "main",
        storePath: fixture.storePath,
      },
      [{ type: "message", message: { role: "user", content: "x".repeat(512) } }],
    );
    await fixture.run(loadMainSessionEntry(fixture.storePath));

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(2);
  });

  it("preserves token-pressure compaction while byte retries are latched", async () => {
    const fixture = await createOversizedByteCompactionFixture();

    await fixture.run(fixture.sessionEntry);
    const tokenHeavyEntry: SessionEntry = {
      ...loadMainSessionEntry(fixture.storePath),
      totalTokens: 90_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
    };
    await fixture.run(tokenHeavyEntry);

    expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(requireCompactEmbeddedAgentSessionCall(1).preflightCompactionTrigger).toBe("tokens");
  });

  it.each([
    ["fresh session selected from the outset", "fresh", "codex"],
    ["upgraded session with historical embedded ownership", "upgraded", "openclaw"],
  ])(
    "byte-guards a Codex runtime %s through native preflight",
    async (_label, fixtureId, agentHarnessId) => {
      const storePath = path.join(rootDir, `sqlite-codex-byte-guard-${fixtureId}.json`);
      const sessionKey = "agent:main:main";
      const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
      await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
      await replaceTranscriptEvents(scope, [
        { message: { role: "user", content: "x".repeat(256) }, type: "message" },
      ]);
      expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);

      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 10,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        compactionCount: 0,
        agentRuntimeOverride: "codex",
        agentHarnessId,
      };
      const sessionStore = { [sessionKey]: sessionEntry };
      const replyOperation = createReplyOperation();

      let entry: SessionEntry | undefined = sessionEntry;
      for (let turn = 0; turn < 2; turn += 1) {
        entry = await runSessionCompactionIfNeeded({
          cfg: {
            agents: {
              defaults: {
                compaction: { maxActiveTranscriptBytes: "10b" },
              },
            },
          },
          followupRun: createTestFollowupRun({
            provider: "openai",
            model: "gpt-5.5",
            sessionId: "session",
            sessionKey,
          }),
          defaultModel: "gpt-5.5",
          modelContextTokens: 1_000_000,
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          storePath,
          isHeartbeat: false,
          ...createCompactionLifecycle(replyOperation),
        });
      }

      expect(entry?.compactionCount).toBe(2);
      expect(replyOperation.setPhase).toHaveBeenCalledWith("preflight_compacting");
      expect(compactEmbeddedAgentSessionMock).toHaveBeenCalledTimes(2);
      expect(requireCompactEmbeddedAgentSessionCall(1)).toMatchObject({
        agentHarnessId: "codex",
        contextTokenBudget: 1_000_000,
        deferOwningContextEngineCompaction: false,
        preflightCompactionTrigger: "transcript_bytes",
        preflightRequired: true,
        sessionId: "session",
        sessionKey,
        trigger: "budget",
      });
      expect(loadMainSessionEntry(storePath).transcriptByteCompactionLatch).toBeUndefined();
    },
  );

  it("leaves a reset SQLite Codex session below the byte fuse for native compaction", async () => {
    const storePath = path.join(rootDir, "sqlite-codex-under-byte-guard.json");
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      {
        type: "message",
        id: "discarded-old",
        parentId: null,
        message: { role: "user", content: "x".repeat(20_000) },
      },
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "discarded-old",
        timestamp: "2026-08-15T00:00:00.000Z",
        reason: "new",
      },
      {
        type: "message",
        id: "fresh-turn",
        parentId: "reset-boundary",
        message: { role: "user", content: "small" },
      },
    ]);
    expect(readSessionTranscriptActiveStats(scope).sizeBytes).toBeLessThan(10 * 1024);

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 347_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
      agentRuntimeOverride: "codex",
      agentHarnessId: "openclaw",
    };
    const replyOperation = createReplyOperation();

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: { maxActiveTranscriptBytes: "10kb" },
          },
        },
      },
      followupRun: createTestFollowupRun({
        provider: "openai",
        model: "gpt-5.5",
        sessionId: "session",
        sessionKey,
      }),
      defaultModel: "gpt-5.5",
      modelContextTokens: 1_000_000,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
      ...createCompactionLifecycle(replyOperation),
    });

    expect(entry).toBe(sessionEntry);
    expect(replyOperation.setPhase).not.toHaveBeenCalled();
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    expect(incrementCompactionCountMock).not.toHaveBeenCalled();
  });

  it("keeps ownsNativeCompaction absolute over the SQLite transcript byte guard", async () => {
    registerClaudeCliBackend(true);
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 10,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const storePath = path.join(rootDir, "sqlite-cli-owned-session.json");
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
          },
          compaction: {
            memoryFlush: {},
            maxActiveTranscriptBytes: "10b",
          },
        },
      },
    } as const;
    const followupRun = createTestFollowupRun({
      provider: "anthropic",
      model: "claude-opus-4-6",
      sessionId: "session",
      sessionKey,
    });

    const flushResult = await runMemoryFlushIfNeeded({
      cfg,
      followupRun,
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });
    const preflightEntry = await runSessionCompactionIfNeeded({
      cfg,
      followupRun,
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(flushResult).toEqual({ sessionEntry, outcome: "skipped" });
    expect(preflightEntry).toBe(sessionEntry);
    expect(preflightEntry?.compactionCount).toBe(0);
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("preserves post-compaction context when prepared delivery ownership changes", async () => {
    const storePath = path.join(rootDir, "sqlite-large-session.json");
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    expect(readTranscriptStatsSync(scope).sizeBytes).toBeGreaterThan(10);

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const replyOperation = createReplyOperation();
    await fs.writeFile(
      path.join(rootDir, "AGENTS.md"),
      [
        "## Session Startup",
        "Reload this required startup context after compaction.",
        "",
        "## Unrelated",
        "Do not inject this section.",
      ].join("\n"),
      "utf-8",
    );
    const inboundPrompt = "current inbound metadata";
    const messageToolPrompt = "message-tool delivery guidance";
    const automaticPrompt = "automatic delivery guidance";
    const independentPrompt = "group and operator context";
    const followupRun = createTestFollowupRun({
      sessionId: "session",
      sessionKey,
      workspaceDir: rootDir,
      extraSystemPrompt: [inboundPrompt, messageToolPrompt, independentPrompt].join("\n\n"),
    });
    const sourceReplyDeliveryRuntime = createSourceReplyDeliveryRuntime({
      origin: "runtime_default",
      initialMode: "message_tool_only",
      projections: [followupRun.run],
      promptComponentByMode: {
        automatic: automaticPrompt,
        message_tool_only: messageToolPrompt,
      },
      promptComponentOffset: inboundPrompt.length + 2,
    });

    const entry = await runSessionCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              maxActiveTranscriptBytes: "10b",
              postCompactionSections: ["Session Startup"],
            },
          },
        },
      },
      followupRun,
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
      ...createCompactionLifecycle(replyOperation),
    });

    expect(entry?.compactionCount).toBe(1);
    const compactCall = requireCompactEmbeddedAgentSessionCall();
    expect(compactCall.trigger).toBe("budget");
    expect(compactCall.preflightCompactionTrigger).toBe("transcript_bytes");
    expect(followupRun.run.extraSystemPrompt).toContain(
      "Reload this required startup context after compaction.",
    );

    sourceReplyDeliveryRuntime.applyPreparedMode(followupRun.run, "automatic");
    expect(followupRun.run.extraSystemPrompt).toContain(automaticPrompt);
    expect(followupRun.run.extraSystemPrompt).not.toContain(messageToolPrompt);
    expect(followupRun.run.extraSystemPrompt).toContain(inboundPrompt);
    expect(followupRun.run.extraSystemPrompt).toContain(independentPrompt);
    expect(followupRun.run.extraSystemPrompt).toContain(
      "Reload this required startup context after compaction.",
    );
    expect(followupRun.run.extraSystemPrompt).not.toContain("Do not inject this section.");
  });

  it("keeps incognito preflight compaction in the process-local transcript store", async () => {
    const durableStorePath = path.join(rootDir, "durable-sessions.json");
    const sessionKey = "agent:main:dashboard:incognito-preflight";
    const sessionEntry: SessionEntry = {
      sessionId: "incognito-session",
      updatedAt: Date.now(),
      totalTokens: 90_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };

    await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({
        sessionId: sessionEntry.sessionId,
        sessionKey,
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: durableStorePath,
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    const expectedStorePath = resolveSessionStorePathForScope({
      agentId: "main",
      sessionKey,
      storePath: durableStorePath,
    });
    expect(
      (requireCompactEmbeddedAgentSessionCall() as { sessionTarget?: Record<string, unknown> })
        .sessionTarget,
    ).toMatchObject({
      agentId: "main",
      sessionId: sessionEntry.sessionId,
      sessionKey,
      storePath: expectedStorePath,
    });
    expect(incrementCompactionCountMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey, storePath: expectedStorePath }),
    );
  });

  it("resolves usage from an active branch whose leaf target predates the bounded tail", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 0,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const storePath = path.join(rootDir, "sqlite-deep-leaf-session.json");
    const sessionKey = "agent:main:deep-leaf";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    const activeRoot = {
      type: "message",
      id: "active-root",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: "active",
        usage: { input: 10, output: 5 },
      },
    };
    let parentId = activeRoot.id;
    const abandonedBranch = Array.from({ length: 512 }, (_, index) => {
      const id = `abandoned-${index}`;
      const event = {
        type: "message",
        id,
        parentId,
        timestamp: `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
        message: {
          role: "assistant",
          content: "abandoned",
          usage: { input: 90_000, output: 10_000 },
        },
      };
      parentId = id;
      return event;
    });
    await replaceTranscriptEvents(scope, [
      activeRoot,
      ...abandonedBranch,
      {
        type: "leaf",
        id: "return-to-active-root",
        parentId,
        targetId: activeRoot.id,
        appendParentId: activeRoot.id,
        timestamp: "2026-01-01T00:01:00.000Z",
      },
    ]);
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokensFresh: false,
    };

    await runSessionCompactionIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
    });

    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("forces memory flush when a SQLite-backed transcript exceeds the byte threshold", async () => {
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 10,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
      relativePath: "memory/2023-11-14.md",
    }));
    const storePath = path.join(rootDir, "sqlite-force-flush-session.json");
    const sessionKey = "agent:main:main";
    const scope = { agentId: "main", sessionId: "session", sessionKey, storePath };
    await upsertSessionEntryCore(scope, { sessionId: "session", updatedAt: 10 });
    await replaceTranscriptEvents(scope, [
      { message: { role: "user", content: "x".repeat(256) }, type: "message" },
    ]);
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const replyOperation = createReplyOperation();

    const result = await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ sessionId: "session", sessionKey }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      isHeartbeat: false,
      replyOperation,
    });

    expect(result.outcome).toBe("completed");
    expect(replyOperation.setPhase).toHaveBeenCalledWith("memory_flushing");
    expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("emits preflight compaction notices around a successful budget compaction", async () => {
    const sessionFile = path.join(rootDir, "notify-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [{ type: "message", message: { role: "user", content: "x".repeat(5_000) } }],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const onCompactionNotice = vi.fn();
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "server-endpoint",
      result: { kind: "server-endpoint", tokensBefore: 8_614, tokensAfter: 736 },
    });

    await runSessionCompactionIfNeeded({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              notifyUser: true,
              maxActiveTranscriptBytes: "10b",
            },
          },
        },
      },
      followupRun: createTestFollowupRun({
        sessionId: "session",
        sessionFile,
        sessionKey: "main",
      }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      storePath: path.join(rootDir, "sessions.json"),
      isHeartbeat: false,
      ...createCompactionLifecycle(createReplyOperation()),
      onCompactionNotice,
    });

    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(
      2,
      "end",
      "🧹 Server-side compaction complete (8.6k → 736)",
    );
  });

  it("emits an incomplete preflight compaction notice when post-compaction state update throws", async () => {
    const sessionFile = path.join(rootDir, "notify-failed-session.jsonl");
    await writeTestSessionTranscript({
      rootDir,
      events: [{ type: "message", message: { role: "user", content: "x".repeat(5_000) } }],
    });
    incrementCompactionCountMock.mockRejectedValueOnce(new Error("count update failed"));
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 120,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 0,
    };
    const onCompactionNotice = vi.fn();

    await expect(
      runSessionCompactionIfNeeded({
        cfg: {
          agents: {
            defaults: {
              compaction: {
                notifyUser: true,
                maxActiveTranscriptBytes: "10b",
              },
            },
          },
        },
        followupRun: createTestFollowupRun({
          sessionId: "session",
          sessionFile,
          sessionKey: "main",
        }),
        defaultModel: "anthropic/claude-opus-4-6",
        modelContextTokens: 100_000,
        sessionEntry,
        sessionStore: { main: sessionEntry },
        sessionKey: "main",
        storePath: path.join(rootDir, "sessions.json"),
        isHeartbeat: false,
        ...createCompactionLifecycle(createReplyOperation()),
        onCompactionNotice,
      }),
    ).rejects.toThrow("count update failed");

    expect(onCompactionNotice).toHaveBeenNthCalledWith(1, "start");
    expect(onCompactionNotice).toHaveBeenNthCalledWith(2, "incomplete");
  });

  it("uses configured prompts and stored bootstrap warning signatures", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 80_000,
      totalTokensFresh: true,
      totalTokensVersion: 1,
      compactionCount: 1,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
        bootstrapTruncation: {
          warningMode: "once",
          warningShown: true,
          promptWarningSignature: "sig-b",
          warningSignaturesSeen: ["sig-a", "sig-b"],
          truncatedFiles: 1,
          nearLimitFiles: 0,
          totalNearLimit: false,
        },
      },
    };
    registerMemoryFlushPlanResolverForTest(() => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 1_000_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Write notes.\nNO_REPLY to memory/2023-11-14.md and MEMORY.md",
      systemPrompt: "Flush memory now. NO_REPLY memory/YYYY-MM-DD.md MEMORY.md",
      relativePath: "memory/2023-11-14.md",
    }));

    await runMemoryFlushIfNeeded({
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      followupRun: createTestFollowupRun({ extraSystemPrompt: "extra system" }),
      sessionCtx: createTestTemplateContext({ Provider: "whatsapp" }),
      defaultModel: "anthropic/claude-opus-4-6",
      modelContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      sessionEntry,
      sessionStore: { main: sessionEntry },
      sessionKey: "main",
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
    });

    const flushCall = requireEmbeddedAgentCall();
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.transcriptPrompt).toBe("");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
