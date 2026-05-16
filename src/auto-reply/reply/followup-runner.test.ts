import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DELIVERY_NO_REPLY_RUNTIME_CONTRACT } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";

const runEmbeddedPiAgentMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const routeReplyMock = vi.fn();
const isRoutableChannelMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();
const resolveCommandSecretRefsViaGatewayMock = vi.fn();
const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveProviderFollowupFallbackRouteMock = vi.fn();
let resolveQueuedReplyExecutionConfigActual:
  | (typeof import("./agent-runner-utils.js"))["resolveQueuedReplyExecutionConfig"]
  | undefined;
let createFollowupRunner: typeof import("./followup-runner.js").createFollowupRunner;
let clearRuntimeConfigSnapshot: typeof import("../../config/config.js").clearRuntimeConfigSnapshot;
let loadSessionStore: typeof import("../../config/sessions/store.js").loadSessionStore;
let saveSessionStore: typeof import("../../config/sessions/store.js").saveSessionStore;
let clearSessionStoreCacheForTest: typeof import("../../config/sessions/store.js").clearSessionStoreCacheForTest;
let clearFollowupQueue: typeof import("./queue.js").clearFollowupQueue;
let enqueueFollowupRun: typeof import("./queue.js").enqueueFollowupRun;
let sessionRunAccounting: typeof import("./session-run-accounting.js");
let setRuntimeConfigSnapshot: typeof import("../../config/config.js").setRuntimeConfigSnapshot;
let createMockFollowupRun: typeof import("./test-helpers.js").createMockFollowupRun;
let createMockTypingController: typeof import("./test-helpers.js").createMockTypingController;
const FOLLOWUP_DEBUG = process.env.OPENCLAW_DEBUG_FOLLOWUP_RUNNER_TEST === "1";
const FOLLOWUP_TEST_QUEUES = new Map<
  string,
  {
    items: FollowupRun[];
    lastRun?: FollowupRun["run"];
  }
>();
const FOLLOWUP_TEST_SESSION_STORES = new Map<string, Record<string, SessionEntry>>();

function debugFollowupTest(message: string): void {
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  process.stderr.write(`[followup-runner.test] ${message}\n`);
}

function joinPromptSections(...sections: Array<string | undefined>): string {
  const promptSections: string[] = [];
  for (const section of sections) {
    if (section) {
      promptSections.push(section);
    }
  }
  return promptSections.join("\n\n");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  index: number,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return requireRecord(call[0], `mock call ${index} arg`);
}

function requireLastMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`expected ${label} mock call`);
  }
  return requireRecord(call[0], `${label} mock call arg`);
}

function expectBlockReplyText(onBlockReply: { mock: { calls: unknown[][] } }, text: string): void {
  expect(
    onBlockReply.mock.calls.some(
      (call) => requireRecord(call[0], "block reply payload").text === text,
    ),
  ).toBe(true);
}

function expectNoBlockReplyText(
  onBlockReply: { mock: { calls: unknown[][] } },
  text: string,
): void {
  expect(
    onBlockReply.mock.calls.some(
      (call) => requireRecord(call[0], "block reply payload").text === text,
    ),
  ).toBe(false);
}

function expectNoBlockReplyTextIncludes(
  onBlockReply: { mock: { calls: unknown[][] } },
  fragment: string,
): void {
  expect(
    onBlockReply.mock.calls.some((call) =>
      String(requireRecord(call[0], "block reply payload").text).includes(fragment),
    ),
  ).toBe(false);
}

function registerFollowupTestSessionStore(
  storePath: string,
  sessionStore: Record<string, SessionEntry>,
): void {
  FOLLOWUP_TEST_SESSION_STORES.set(storePath, sessionStore);
}

async function incrementRunCompactionCountForFollowupTest(
  params: Parameters<typeof import("./session-run-accounting.js").incrementRunCompactionCount>[0],
): Promise<number | undefined> {
  const {
    sessionStore,
    sessionKey,
    sessionEntry,
    amount = 1,
    newSessionId,
    lastCallUsage,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }

  const nextCount = Math.max(0, entry.compactionCount ?? 0) + Math.max(0, amount);
  const nextEntry: SessionEntry = {
    ...entry,
    compactionCount: nextCount,
    updatedAt: Date.now(),
  };
  if (newSessionId && newSessionId !== entry.sessionId) {
    nextEntry.sessionId = newSessionId;
    if (entry.sessionFile?.trim()) {
      nextEntry.sessionFile = path.join(path.dirname(entry.sessionFile), `${newSessionId}.jsonl`);
    }
  }
  const promptTokens =
    (lastCallUsage?.input ?? 0) +
    (lastCallUsage?.cacheRead ?? 0) +
    (lastCallUsage?.cacheWrite ?? 0);
  if (promptTokens > 0) {
    nextEntry.totalTokens = promptTokens;
    nextEntry.totalTokensFresh = true;
    nextEntry.inputTokens = undefined;
    nextEntry.outputTokens = undefined;
    nextEntry.cacheRead = undefined;
    nextEntry.cacheWrite = undefined;
  }

  sessionStore[sessionKey] = nextEntry;
  if (sessionEntry) {
    Object.assign(sessionEntry, nextEntry);
  }
  return nextCount;
}

function getFollowupTestQueue(key: string): {
  items: FollowupRun[];
  lastRun?: FollowupRun["run"];
} {
  const cleaned = key.trim();
  const existing = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (existing) {
    return existing;
  }
  const created = {
    items: [] as FollowupRun[],
    lastRun: undefined as FollowupRun["run"] | undefined,
  };
  FOLLOWUP_TEST_QUEUES.set(cleaned, created);
  return created;
}

function clearFollowupQueueForFollowupTest(key: string): number {
  const cleaned = key.trim();
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return 0;
  }
  const cleared = queue.items.length;
  FOLLOWUP_TEST_QUEUES.delete(cleaned);
  return cleared;
}

function enqueueFollowupRunForFollowupTest(key: string, run: FollowupRun): boolean {
  const queue = getFollowupTestQueue(key);
  queue.items.push(run);
  queue.lastRun = run.run;
  return true;
}

function refreshQueuedFollowupSessionForFollowupTest(params: {
  key: string;
  previousSessionId?: string;
  nextSessionId?: string;
  nextSessionFile?: string;
  nextProvider?: string;
  nextModel?: string;
  nextAuthProfileId?: string;
  nextAuthProfileIdSource?: "auto" | "user";
}): void {
  const cleaned = params.key.trim();
  if (!cleaned) {
    return;
  }
  const queue = FOLLOWUP_TEST_QUEUES.get(cleaned);
  if (!queue) {
    return;
  }
  const shouldRewriteSession =
    Boolean(params.previousSessionId) &&
    Boolean(params.nextSessionId) &&
    params.previousSessionId !== params.nextSessionId;
  const shouldRewriteSelection =
    typeof params.nextProvider === "string" ||
    typeof params.nextModel === "string" ||
    Object.hasOwn(params, "nextAuthProfileId") ||
    Object.hasOwn(params, "nextAuthProfileIdSource");
  if (!shouldRewriteSession && !shouldRewriteSelection) {
    return;
  }
  const rewrite = (run?: FollowupRun["run"]) => {
    if (!run) {
      return;
    }
    if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
      run.sessionId = params.nextSessionId!;
      if (params.nextSessionFile?.trim()) {
        run.sessionFile = params.nextSessionFile;
      }
    }
    if (shouldRewriteSelection) {
      if (typeof params.nextProvider === "string") {
        run.provider = params.nextProvider;
      }
      if (typeof params.nextModel === "string") {
        run.model = params.nextModel;
      }
      if (Object.hasOwn(params, "nextAuthProfileId")) {
        run.authProfileId = params.nextAuthProfileId?.trim() || undefined;
      }
      if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
        run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
      }
    }
  };
  rewrite(queue.lastRun);
  for (const item of queue.items) {
    rewrite(item.run);
  }
}

async function persistRunSessionUsageForFollowupTest(
  params: Parameters<typeof import("./session-run-accounting.js").persistRunSessionUsage>[0],
): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }
  const registeredStore = FOLLOWUP_TEST_SESSION_STORES.get(storePath);
  const store = registeredStore ?? loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey];
  if (!entry) {
    return;
  }
  const nextEntry: SessionEntry = {
    ...entry,
    updatedAt: Date.now(),
    modelProvider: params.providerUsed ?? entry.modelProvider,
    model: params.modelUsed ?? entry.model,
    contextTokens: params.contextTokensUsed ?? entry.contextTokens,
    systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
  };
  if (params.usage) {
    nextEntry.inputTokens = params.usage.input ?? 0;
    nextEntry.outputTokens = params.usage.output ?? 0;
    const cacheUsage = params.lastCallUsage ?? params.usage;
    nextEntry.cacheRead = cacheUsage?.cacheRead ?? 0;
    nextEntry.cacheWrite = cacheUsage?.cacheWrite ?? 0;
  }
  const promptTokens =
    params.promptTokens ??
    (params.lastCallUsage?.input ?? params.usage?.input ?? 0) +
      (params.lastCallUsage?.cacheRead ?? params.usage?.cacheRead ?? 0) +
      (params.lastCallUsage?.cacheWrite ?? params.usage?.cacheWrite ?? 0);
  nextEntry.totalTokens = promptTokens > 0 ? promptTokens : undefined;
  nextEntry.totalTokensFresh = promptTokens > 0;
  store[sessionKey] = nextEntry;
  if (registeredStore) {
    return;
  }
  await saveSessionStore(storePath, store);
}

async function loadFreshFollowupRunnerModuleForTest() {
  vi.resetModules();
  vi.doUnmock("../../config/config.js");
  vi.doMock(
    "../../agents/model-fallback.js",
    async () => await import("../../test-utils/model-fallback.mock.js"),
  );
  vi.doMock("../../agents/session-write-lock.js", () => ({
    acquireSessionWriteLock: vi.fn(async () => ({
      release: async () => {},
    })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(() => 1),
  }));
  vi.doMock("../../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn(async () => false),
    compactEmbeddedPiSession: (params: unknown) => compactEmbeddedPiSessionMock(params),
    isEmbeddedPiRunActive: vi.fn(() => false),
    isEmbeddedPiRunStreaming: vi.fn(() => false),
    queueEmbeddedPiMessage: vi.fn(async () => undefined),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
    waitForEmbeddedPiRunEnd: vi.fn(async () => undefined),
  }));
  vi.doMock("./queue.js", () => ({
    clearFollowupQueue: clearFollowupQueueForFollowupTest,
    completeFollowupRunLifecycle: (run: Pick<FollowupRun, "queuedLifecycle">) =>
      run.queuedLifecycle?.onComplete?.(),
    enqueueFollowupRun: enqueueFollowupRunForFollowupTest,
    isFollowupRunAborted: (run: Pick<FollowupRun, "abortSignal">) =>
      run.abortSignal?.aborted === true,
    refreshQueuedFollowupSession: refreshQueuedFollowupSessionForFollowupTest,
  }));
  vi.doMock("./session-run-accounting.js", () => ({
    persistRunSessionUsage: persistRunSessionUsageForFollowupTest,
    incrementRunCompactionCount: incrementRunCompactionCountForFollowupTest,
  }));
  vi.doMock("./agent-runner-memory.js", () => ({
    runMemoryFlushIfNeeded: async (params: { sessionEntry?: SessionEntry }) => params.sessionEntry,
    runPreflightCompactionIfNeeded: (...args: unknown[]) =>
      runPreflightCompactionIfNeededMock(...args),
  }));
  vi.doMock("./route-reply.js", () => ({
    isRoutableChannel: (...args: unknown[]) => isRoutableChannelMock(...args),
    routeReply: (...args: unknown[]) => routeReplyMock(...args),
  }));
  vi.doMock("../../plugins/provider-runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../../plugins/provider-runtime.js")>(
      "../../plugins/provider-runtime.js",
    );
    return {
      ...actual,
      resolveProviderFollowupFallbackRoute: (...args: unknown[]) =>
        resolveProviderFollowupFallbackRouteMock(...args),
    };
  });
  vi.doMock("./agent-runner-utils.js", async () => {
    const actual =
      await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
    resolveQueuedReplyExecutionConfigActual = actual.resolveQueuedReplyExecutionConfig;
    resolveQueuedReplyExecutionConfigMock.mockImplementation(
      async (...args: Parameters<typeof actual.resolveQueuedReplyExecutionConfig>) =>
        await actual.resolveQueuedReplyExecutionConfig(...args),
    );
    return {
      ...actual,
      resolveQueuedReplyExecutionConfig: (
        ...args: Parameters<typeof actual.resolveQueuedReplyExecutionConfig>
      ) => resolveQueuedReplyExecutionConfigMock(...args),
    };
  });
  vi.doMock("../../cli/command-secret-gateway.js", () => ({
    resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
      resolveCommandSecretRefsViaGatewayMock(...args),
  }));
  vi.doMock("../../cli/command-secret-targets.js", () => ({
    getAgentRuntimeCommandSecretTargetIds: () => new Set(["skills.entries."]),
    getScopedChannelsCommandSecretTargets: ({
      channel,
      accountId,
    }: {
      channel?: string;
      accountId?: string;
    }) => {
      const normalizedChannel = channel?.trim() ?? "";
      if (!normalizedChannel) {
        return { targetIds: new Set<string>() };
      }
      const targetIds = new Set<string>([`channels.${normalizedChannel}.token`]);
      const normalizedAccountId = accountId?.trim() ?? "";
      if (!normalizedAccountId) {
        return { targetIds };
      }
      return {
        targetIds,
        allowedPaths: new Set<string>([
          `channels.${normalizedChannel}.token`,
          `channels.${normalizedChannel}.accounts.${normalizedAccountId}.token`,
        ]),
      };
    },
  }));
  ({ createFollowupRunner } = await import("./followup-runner.js"));
  ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
    await import("../../config/config.js"));
  ({ clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } =
    await import("../../config/sessions/store.js"));
  ({ clearFollowupQueue, enqueueFollowupRun } = await import("./queue.js"));
  sessionRunAccounting = await import("./session-run-accounting.js");
  ({ createMockFollowupRun, createMockTypingController } = await import("./test-helpers.js"));
}

const ROUTABLE_TEST_CHANNELS = new Set([
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "whatsapp",
  "feishu",
]);

beforeAll(async () => {
  await loadFreshFollowupRunnerModuleForTest();
});

beforeEach(() => {
  clearRuntimeConfigSnapshot?.();
  runEmbeddedPiAgentMock.mockReset();
  compactEmbeddedPiSessionMock.mockReset();
  runPreflightCompactionIfNeededMock.mockReset();
  resolveCommandSecretRefsViaGatewayMock.mockReset();
  resolveQueuedReplyExecutionConfigMock.mockReset();
  resolveProviderFollowupFallbackRouteMock.mockReset();
  resolveProviderFollowupFallbackRouteMock.mockReturnValue(undefined);
  const resolveQueuedReplyExecutionConfig = resolveQueuedReplyExecutionConfigActual;
  if (!resolveQueuedReplyExecutionConfig) {
    throw new Error("resolveQueuedReplyExecutionConfig mock not initialized");
  }
  resolveQueuedReplyExecutionConfigMock.mockImplementation(
    async (...args: Parameters<typeof resolveQueuedReplyExecutionConfig>) =>
      await resolveQueuedReplyExecutionConfig(...args),
  );
  runPreflightCompactionIfNeededMock.mockImplementation(
    async (params: { sessionEntry?: SessionEntry }) => params.sessionEntry,
  );
  resolveCommandSecretRefsViaGatewayMock.mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  }));
  routeReplyMock.mockReset();
  routeReplyMock.mockResolvedValue({ ok: true });
  isRoutableChannelMock.mockReset();
  isRoutableChannelMock.mockImplementation((ch: string | undefined) =>
    Boolean(ch?.trim() && ROUTABLE_TEST_CHANNELS.has(ch.trim().toLowerCase())),
  );
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
  FOLLOWUP_TEST_SESSION_STORES.clear();
});

afterEach(() => {
  clearRuntimeConfigSnapshot?.();
  clearFollowupQueue("main");
  FOLLOWUP_TEST_QUEUES.clear();
  FOLLOWUP_TEST_SESSION_STORES.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  clearSessionStoreCacheForTest();
  if (!FOLLOWUP_DEBUG) {
    return;
  }
  const handles = (process as NodeJS.Process & { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles?.()
    .map((handle) => handle?.constructor?.name ?? typeof handle);
  debugFollowupTest(`active handles: ${JSON.stringify(handles ?? [])}`);
  const requests = (process as NodeJS.Process & { _getActiveRequests?: () => unknown[] })
    ._getActiveRequests?.()
    .map((request) => request?.constructor?.name ?? typeof request);
  debugFollowupTest(`active requests: ${JSON.stringify(requests ?? [])}`);
});

const baseQueuedRun = (messageProvider = "whatsapp"): FollowupRun =>
  createMockFollowupRun({ run: { messageProvider } });

function createQueuedRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  return createMockFollowupRun(overrides);
}

async function normalizeComparablePath(filePath: string): Promise<string> {
  const parent = await fs.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
  return path.join(parent, path.basename(filePath));
}

function mockCompactionRun(params: {
  willRetry: boolean;
  result: {
    payloads: Array<{ text: string }>;
    meta: Record<string, unknown>;
  };
}) {
  runEmbeddedPiAgentMock.mockImplementationOnce(
    async (args: {
      onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
    }) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: params.willRetry, completed: true },
      });
      return params.result;
    },
  );
}

function createAsyncReplySpy() {
  return vi.fn(async () => {});
}

describe("createFollowupRunner runtime config", () => {
  it("uses the active runtime snapshot for queued embedded followup runs", async () => {
    const sourceConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
            models: [],
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "resolved-runtime-key",
            models: [],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        run: {
          config: sourceConfig,
          provider: "openai",
          model: "gpt-5.4",
        },
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.config).toBe(runtimeConfig);
  });

  it("skips aborted queued room-event followups", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const onBlockReply = vi.fn(async () => {});
    const typing = createMockTypingController();
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        currentTurnKind: "room_event",
        abortSignal: abortController.signal,
        run: {
          provider: "openai",
          model: "gpt-5.4",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      }),
    );

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("passes queued room-event abort signals into followup agent runs", async () => {
    const abortController = new AbortController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        currentTurnKind: "room_event",
        abortSignal: abortController.signal,
        run: {
          provider: "openai",
          model: "gpt-5.4",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.abortSignal).toBe(abortController.signal);
  });

  it("keeps queued delivery correlations active during followup agent runs", async () => {
    const events: string[] = [];
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      events.push("run");
      return {
        payloads: [],
        meta: {},
      };
    });
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });

    await runner(
      createQueuedRun({
        currentTurnKind: "room_event",
        deliveryCorrelations: [
          {
            begin: () => {
              events.push("begin");
              return () => {
                events.push("end");
              };
            },
          },
        ],
        run: {
          provider: "openai",
          model: "gpt-5.4",
          sourceReplyDeliveryMode: "message_tool_only",
        },
      }),
    );

    expect(events).toEqual(["begin", "run", "end"]);
  });

  it("resolves queued embedded followups before preflight helpers read config", async () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          whisper: {
            apiKey: {
              source: "env",
              provider: "default",
              id: "OPENAI_API_KEY",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          whisper: {
            apiKey: "resolved-runtime-key",
          },
        },
      },
    };
    resolveCommandSecretRefsViaGatewayMock.mockResolvedValueOnce({
      resolvedConfig: runtimeConfig,
      diagnostics: [],
      targetStatesByPath: { "skills.entries.whisper.apiKey": "resolved_local" },
      hadUnresolvedTargets: false,
    });
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });
    const queued = createQueuedRun({
      run: {
        config: sourceConfig,
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    await runner(queued);

    expect(queued.run.config).toBe(runtimeConfig);
    expect(requireMockCallArg(runPreflightCompactionIfNeededMock, 0).cfg).toBe(runtimeConfig);
    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.config).toBe(runtimeConfig);
  });

  it("passes queued origin scope into queued execution-config resolution", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const sourceConfig: OpenClawConfig = {};
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
    });
    const queued = createQueuedRun({
      originatingChannel: "discord",
      originatingAccountId: "work",
      run: {
        config: sourceConfig,
        provider: "openai",
        model: "gpt-5.4",
        messageProvider: "discord",
        agentAccountId: "bot-account",
      },
    });

    await runner(queued);

    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledWith(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "discord",
      originatingAccountId: "work",
      agentAccountId: "bot-account",
    });
  });

  it("passes queued images into queued embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });
    const images = [{ type: "image" as const, data: "base64-cat", mimeType: "image/png" }];
    const imageOrder = ["inline" as const];
    const runner = createFollowupRunner({
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "openai/gpt-5.4",
      opts: {
        images: [{ type: "image", data: "fallback", mimeType: "image/png" }],
        imageOrder: ["inline"],
      },
    });

    await runner(
      createQueuedRun({
        images,
        imageOrder,
      }),
    );

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.images).toBe(images);
    expect(call.imageOrder).toBe(imageOrder);
  });
});

describe("createFollowupRunner compaction", () => {
  it("adds verbose auto-compaction notice and tracks count", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});
    registerFollowupTestSessionStore(storePath, sessionStore);

    mockCompactionRun({
      willRetry: true,
      result: { payloads: [{ text: "final" }], meta: {} },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(1);
  });

  it("tracks auto-compaction from embedded result metadata even when no compaction event is emitted", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-meta-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});
    registerFollowupTestSessionStore(storePath, sessionStore);

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          compactionCount: 2,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toContain("Auto-compaction complete");
    expect(sessionStore.main.compactionCount).toBe(2);
    expect(sessionStore.main.sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(sessionStore.main.sessionFile ?? "")).toBe(
      await normalizeComparablePath(path.join(path.dirname(storePath), "session-rotated.jsonl")),
    );
  });

  it("refreshes queued followup runs to the rotated transcript", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-queue-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    registerFollowupTestSessionStore(storePath, sessionStore);

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "final" }],
      meta: {
        agentMeta: {
          sessionId: "session-rotated",
          compactionCount: 1,
          lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queuedNext = createQueuedRun({
      prompt: "next",
      run: {
        sessionId: "session",
        sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      },
    });
    const queueSettings: QueueSettings = { mode: "followup" };
    enqueueFollowupRun("main", queuedNext, queueSettings);

    const current = createQueuedRun({
      run: {
        verboseLevel: "on",
        sessionId: "session",
        sessionFile: path.join(path.dirname(storePath), "session.jsonl"),
      },
    });

    await runner(current);

    expect(queuedNext.run.sessionId).toBe("session-rotated");
    expect(await normalizeComparablePath(queuedNext.run.sessionFile)).toBe(
      await normalizeComparablePath(path.join(path.dirname(storePath), "session-rotated.jsonl")),
    );
  });

  it("does not count failed compaction end events in followup runs", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(tmpdir(), "openclaw-compaction-failed-")),
      "sessions.json",
    );
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    const onBlockReply = vi.fn(async () => {});
    registerFollowupTestSessionStore(storePath, sessionStore);

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
    });

    const queued = createQueuedRun({
      run: {
        verboseLevel: "on",
      },
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (args) => {
      args.onAgentEvent?.({
        stream: "compaction",
        data: { phase: "end", willRetry: false, completed: false },
      });
      return {
        payloads: [{ text: "final" }],
        meta: {
          agentMeta: {
            compactionCount: 0,
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
          },
        },
      };
    });

    await runner(queued);

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const firstCall = (onBlockReply.mock.calls as unknown as Array<Array<{ text?: string }>>)[0];
    expect(firstCall?.[0]?.text).toBe("final");
    expect(sessionStore.main.compactionCount).toBeUndefined();
  });

  it("injects the post-compaction refresh prompt before followup runs after preflight compaction", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-preflight-followup-"));
    const storePath = path.join(workspaceDir, "sessions.json");
    const transcriptPath = path.join(workspaceDir, "session.jsonl");
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        message: {
          role: "user",
          content: "x".repeat(320_000),
          timestamp: Date.now(),
        },
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "AGENTS.md"),
      [
        "## Session Startup",
        "Read AGENTS.md before replying.",
        "",
        "## Red Lines",
        "Never skip safety checks.",
      ].join("\n"),
      "utf-8",
    );

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      sessionFile: transcriptPath,
      totalTokens: 10,
      totalTokensFresh: false,
      compactionCount: 1,
    };
    const sessionStore: Record<string, SessionEntry> = {
      main: sessionEntry,
    };
    registerFollowupTestSessionStore(storePath, sessionStore);

    compactEmbeddedPiSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "compacted",
        firstKeptEntryId: "first-kept",
        tokensBefore: 90_000,
        tokensAfter: 8_000,
      },
    });
    runPreflightCompactionIfNeededMock.mockImplementationOnce(
      async (params: {
        followupRun: FollowupRun;
        sessionEntry?: SessionEntry;
        sessionStore?: Record<string, SessionEntry>;
        sessionKey?: string;
        storePath?: string;
      }) => {
        await compactEmbeddedPiSessionMock({
          sessionFile: transcriptPath,
          workspaceDir,
        });
        params.followupRun.run.extraSystemPrompt = joinPromptSections(
          params.followupRun.run.extraSystemPrompt,
          "Post-compaction context refresh",
          "Read AGENTS.md before replying.",
        );
        const updatedEntry =
          params.sessionEntry ??
          (params.sessionKey && params.sessionStore
            ? params.sessionStore[params.sessionKey]
            : undefined);
        if (updatedEntry) {
          updatedEntry.compactionCount = 2;
          updatedEntry.updatedAt = Date.now();
          if (params.sessionKey && params.sessionStore) {
            params.sessionStore[params.sessionKey] = updatedEntry;
          }
          if (params.storePath && params.sessionKey) {
            const registeredStore = FOLLOWUP_TEST_SESSION_STORES.get(params.storePath);
            if (registeredStore) {
              registeredStore[params.sessionKey] = updatedEntry;
            } else {
              const store = loadSessionStore(params.storePath, { skipCache: true });
              store[params.sessionKey] = updatedEntry;
              await saveSessionStore(params.storePath, store);
            }
          }
        }
        return updatedEntry;
      },
    );

    const embeddedCalls: Array<{ extraSystemPrompt?: string }> = [];
    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: { extraSystemPrompt?: string }) => {
        embeddedCalls.push({ extraSystemPrompt: params.extraSystemPrompt });
        return {
          payloads: [{ text: "final" }],
          meta: { agentMeta: { usage: { input: 1, output: 1 } } },
        };
      },
    );

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      storePath,
      defaultModel: "anthropic/claude-opus-4-6",
      agentCfgContextTokens: 100_000,
    });

    const queued = createQueuedRun({
      run: {
        sessionFile: transcriptPath,
        workspaceDir,
      },
    });

    await runner(queued);

    expect(compactEmbeddedPiSessionMock).toHaveBeenCalledOnce();
    expect(embeddedCalls[0]?.extraSystemPrompt).toContain("Post-compaction context refresh");
    expect(embeddedCalls[0]?.extraSystemPrompt).toContain("Read AGENTS.md before replying.");
    expect(sessionStore.main?.compactionCount).toBe(2);
  });
});

describe("createFollowupRunner bootstrap warning dedupe", () => {
  it("passes stored warning signature history to embedded followup runs", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {},
    });

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 1,
          projectContextChars: 0,
          nonProjectContextChars: 1,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 0,
          entries: [],
        },
        tools: {
          listChars: 0,
          schemaChars: 0,
          entries: [],
        },
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
    const sessionStore: Record<string, SessionEntry> = { main: sessionEntry };

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing: createMockTypingController(),
      typingMode: "instant",
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());

    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.allowGatewaySubagentBinding).toBe(true);
    expect(call.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(call.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});

describe("createFollowupRunner messaging delivery and dedupe", () => {
  function createMessagingDedupeRunner(
    onBlockReply: (payload: unknown) => Promise<void>,
    overrides: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }> = {},
  ) {
    if (overrides.storePath && overrides.sessionStore) {
      registerFollowupTestSessionStore(overrides.storePath, overrides.sessionStore);
    }
    return createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry: overrides.sessionEntry,
      sessionStore: overrides.sessionStore,
      sessionKey: overrides.sessionKey,
      storePath: overrides.storePath,
    });
  }

  async function runMessagingCase(params: {
    agentResult: Record<string, unknown>;
    queued?: FollowupRun;
    runnerOverrides?: Partial<{
      sessionEntry: SessionEntry;
      sessionStore: Record<string, SessionEntry>;
      sessionKey: string;
      storePath: string;
    }>;
  }) {
    const onBlockReply = createAsyncReplySpy();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...params.agentResult,
    });
    const runner = createMessagingDedupeRunner(onBlockReply, params.runnerOverrides);
    await runner(params.queued ?? baseQueuedRun());
    return { onBlockReply };
  }

  function makeTextReplyDedupeResult(overrides?: Record<string, unknown>) {
    return {
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      ...overrides,
    };
  }

  it("persists usage even when replies are suppressed", async () => {
    const storePath = "/tmp/openclaw-followup-usage.json";
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    persistSpy.mockImplementationOnce(async (params) => {
      const nextEntry: SessionEntry = {
        ...sessionStore[sessionKey],
        updatedAt: Date.now(),
        totalTokens: params.lastCallUsage?.input,
        totalTokensFresh: true,
        model: params.modelUsed,
        modelProvider: params.providerUsed,
        inputTokens: params.usage?.input,
        outputTokens: params.usage?.output,
      };
      sessionStore[sessionKey] = nextEntry;
      Object.assign(sessionEntry, nextEntry);
    });

    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        ...makeTextReplyDedupeResult({ messagingToolSentTexts: ["hello world!"] }),
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
        meta: {
          agentMeta: {
            usage: { input: 1_000, output: 50 },
            lastCallUsage: { input: 400, output: 20 },
            model: "claude-opus-4-6",
            provider: "anthropic",
          },
        },
      },
      runnerOverrides: {
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      },
      queued: baseQueuedRun("slack"),
    });

    expect(onBlockReply).not.toHaveBeenCalled();
    const persistCall = requireMockCallArg(persistSpy, 0);
    expect(persistCall.storePath).toBe(storePath);
    expect(persistCall.sessionKey).toBe(sessionKey);
    expect(persistCall.modelUsed).toBe("claude-opus-4-6");
    expect(persistCall.providerUsed).toBe("anthropic");
    expect(sessionStore[sessionKey]?.totalTokens).toBe(400);
    expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
    // Accumulated usage is still stored for usage/cost tracking.
    expect(sessionStore[sessionKey]?.inputTokens).toBe(1_000);
    expect(sessionStore[sessionKey]?.outputTokens).toBe(50);
    persistSpy.mockRestore();
  });

  it("passes queued config into usage persistence during drained followups", async () => {
    const storePath = "/tmp/openclaw-followup-usage-cfg.json";
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };

    const cfg = {
      messages: {
        responsePrefix: "agent",
      },
    };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          lastCallUsage: { input: 6, output: 3 },
          model: "claude-opus-4-6",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(
      runner(
        createQueuedRun({
          run: {
            config: cfg,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    const persistCall = requireMockCallArg(persistSpy, 0);
    expect(persistCall.storePath).toBe(storePath);
    expect(persistCall.sessionKey).toBe(sessionKey);
    expect(persistCall.cfg).toBe(cfg);
    persistSpy.mockRestore();
  });

  it("uses providerUsed for snapshot freshness when agent metadata overrides the run provider", async () => {
    const storePath = "/tmp/openclaw-followup-usage-provider.json";
    const sessionKey = "main";
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    const sessionStore: Record<string, SessionEntry> = { [sessionKey]: sessionEntry };
    const persistSpy = vi.spyOn(sessionRunAccounting, "persistRunSessionUsage");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          lastCallUsage: { input: 6, output: 3 },
          model: "claude-opus-4-6",
          provider: "anthropic",
        },
      },
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });

    await expect(
      runner(
        createQueuedRun({
          run: {
            provider: "openai",
            config: {
              agents: {
                defaults: {
                  cliBackends: {
                    anthropic: { command: "anthropic" },
                  },
                },
              },
            } as OpenClawConfig,
          },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(requireMockCallArg(persistSpy, 0).providerUsed).toBe("anthropic");
    expect(requireMockCallArg(persistSpy, 0).usageIsContextSnapshot).toBeUndefined();
    persistSpy.mockRestore();
  });

  it("does not send cross-channel payload content to dispatcher when origin routing fails", async () => {
    routeReplyMock.mockResolvedValue({
      ok: false,
      error: "forced route failure",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }, { text: "second payload" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const reply = requireMockCallArg(onBlockReply, 0);
    expect(reply.isError).toBe(true);
    expect(String(reply.text)).toContain("could not deliver it to the originating channel");
    expectNoBlockReplyText(onBlockReply, "hello world!");
    expectNoBlockReplyText(onBlockReply, "second payload");
  });

  it("does not emit cross-channel route-failure notice when a later payload routes", async () => {
    routeReplyMock
      .mockResolvedValueOnce({
        ok: false,
        error: "transient route failure",
      })
      .mockResolvedValueOnce({ ok: true });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }, { text: "second payload" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledTimes(2);
    expectNoBlockReplyTextIncludes(onBlockReply, "could not deliver it to the originating channel");
  });

  it("uses dispatcher when origin routing metadata is incomplete", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: undefined,
      } as FollowupRun,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyText(onBlockReply, "hello world!");
  });

  it("keeps message-tool-only queued followup finals private", async () => {
    const queued = baseQueuedRun("discord");
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...queued,
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        run: {
          ...queued.run,
          sourceReplyDeliveryMode: "message_tool_only",
        },
      } as FollowupRun,
    });

    const runArg = requireMockCallArg(runEmbeddedPiAgentMock, 0);
    expect(runArg.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(runArg.forceMessageTool).toBe(true);
    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("lets provider followup route hooks force dispatcher delivery", async () => {
    resolveProviderFollowupFallbackRouteMock.mockReturnValue({
      route: "dispatcher",
      reason: "operator-visible review copy",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyText(onBlockReply, "hello world!");
    const routeArg = requireMockCallArg(resolveProviderFollowupFallbackRouteMock, 0);
    expect(routeArg.provider).toBe("anthropic");
    const context = requireRecord(routeArg.context, "provider fallback context");
    expect(context.provider).toBe("anthropic");
    expect(context.modelId).toBe("claude");
    expect(context.originRoutable).toBe(true);
    expect(context.dispatcherAvailable).toBe(true);
    expect(requireRecord(context.payload, "provider fallback payload").text).toBe("hello world!");
  });

  it("lets provider followup route hooks drop payloads explicitly", async () => {
    resolveProviderFollowupFallbackRouteMock.mockReturnValue({
      route: "drop",
      reason: "already delivered out of band",
    });
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
      } as FollowupRun,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses exact NO_REPLY followups without origin or dispatcher delivery", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: `  ${DELIVERY_NO_REPLY_RUNTIME_CONTRACT.silentText}  ` }],
      meta: {},
    });
    const runner = createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(createQueuedRun({ originatingChannel: undefined, originatingTo: undefined }));

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("suppresses JSON NO_REPLY followups without origin or dispatcher delivery", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.jsonSilentText }],
      meta: {},
    });
    const runner = createFollowupRunner({
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(createQueuedRun({ originatingChannel: undefined, originatingTo: undefined }));

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalledTimes(1);
  });

  it("keeps NO_REPLY followups with media deliverable", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: {
        payloads: [
          {
            text: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.silentText,
            mediaUrl: "file:///tmp/followup.png",
          },
        ],
      },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: undefined,
        originatingTo: undefined,
      } as FollowupRun,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    const reply = requireMockCallArg(onBlockReply, 0);
    expect(reply.text).toBe(DELIVERY_NO_REPLY_RUNTIME_CONTRACT.silentText);
    expect(reply.mediaUrl).toBe("file:///tmp/followup.png");
  });

  it("falls back to dispatcher when successful output has no complete origin route", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.dispatcherText }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: DELIVERY_NO_REPLY_RUNTIME_CONTRACT.originChannel,
        originatingTo: undefined,
      } as FollowupRun,
    });

    expect(routeReplyMock).not.toHaveBeenCalled();
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyText(onBlockReply, DELIVERY_NO_REPLY_RUNTIME_CONTRACT.dispatcherText);
  });

  it("falls back to dispatcher when same-channel origin routing fails", async () => {
    routeReplyMock.mockResolvedValueOnce({
      ok: false,
      error: "outbound adapter unavailable",
    });
    const queued = baseQueuedRun(" Feishu ");
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...queued,
        originatingChannel: "FEISHU",
        originatingTo: "ou_abc123",
        run: {
          ...queued.run,
          agentAccountId: undefined,
        },
      } as FollowupRun,
    });

    expect(routeReplyMock).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectBlockReplyText(onBlockReply, "hello world!");
  });

  it("routes followups with originating account/thread metadata", async () => {
    const { onBlockReply } = await runMessagingCase({
      agentResult: { payloads: [{ text: "hello world!" }] },
      queued: {
        ...baseQueuedRun("webchat"),
        originatingChannel: "discord",
        originatingTo: "channel:C1",
        originatingAccountId: "work",
        originatingThreadId: "1739142736.000100",
      } as FollowupRun,
    });

    const routeArg = requireMockCallArg(routeReplyMock, 0);
    expect(routeArg.channel).toBe("discord");
    expect(routeArg.to).toBe("channel:C1");
    expect(routeArg.accountId).toBe("work");
    expect(routeArg.threadId).toBe("1739142736.000100");
    expect(onBlockReply).not.toHaveBeenCalled();
  });
});

describe("createFollowupRunner typing cleanup", () => {
  async function runTypingCase(agentResult: Record<string, unknown>) {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      ...agentResult,
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply: createAsyncReplySpy() },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());
    return typing;
  }

  function expectTypingCleanup(typing: ReturnType<typeof createMockTypingController>) {
    expect(typing.markRunComplete).toHaveBeenCalledTimes(1);
    expect(typing.markDispatchIdle).toHaveBeenCalledTimes(1);
  }

  it("calls both markRunComplete and markDispatchIdle on NO_REPLY", async () => {
    const typing = await runTypingCase({ payloads: [{ text: "NO_REPLY" }] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on empty payloads", async () => {
    const typing = await runTypingCase({ payloads: [] });
    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on agent error", async () => {
    const typing = createMockTypingController();
    runEmbeddedPiAgentMock.mockRejectedValueOnce(new Error("agent exploded"));

    const runner = createFollowupRunner({
      opts: { onBlockReply: vi.fn(async () => {}) },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());

    expectTypingCleanup(typing);
  });

  it("calls both markRunComplete and markDispatchIdle on successful delivery", async () => {
    const typing = createMockTypingController();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      meta: {},
    });

    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing,
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });

    await runner(baseQueuedRun());

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expectTypingCleanup(typing);
  });
});

describe("createFollowupRunner agentDir forwarding", () => {
  it("passes queued run agentDir to runEmbeddedPiAgent", async () => {
    runEmbeddedPiAgentMock.mockClear();
    const onBlockReply = vi.fn(async () => {});
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
    });
    const runner = createFollowupRunner({
      opts: { onBlockReply },
      typing: createMockTypingController(),
      typingMode: "instant",
      defaultModel: "anthropic/claude-opus-4-6",
    });
    const agentDir = path.join("/tmp", "agent-dir");
    const queued = createQueuedRun();
    await runner({
      ...queued,
      run: {
        ...queued.run,
        agentDir,
      },
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = requireLastMockCallArg(runEmbeddedPiAgentMock, "run embedded pi agent");
    expect(call.agentDir).toBe(agentDir);
  });
});
