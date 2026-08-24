import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sessionAccessorModule from "../../config/sessions/session-accessor.js";
import * as sessionStoreModule from "../../config/sessions/store-writer-state.js";
import type { SessionEntry, SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  enqueuePostCompactionDelegateDelivery as enqueuePostCompactionDelegateDeliveryQueue,
  loadPendingSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import type { ChainState, ContinuationRuntimeConfig } from "../continuation/types.js";
import {
  deliverQueuedPostCompactionDelegate,
  normalizePostCompactionDelegate,
  persistPendingPostCompactionDelegates,
  takePendingPostCompactionDelegates,
  type PostCompactionDelegateDeliveryDeps,
  type QueuedPostCompactionDelegateDelivery,
} from "./post-compaction-delegate-delivery.js";
import {
  buildPostCompactionLifecycleEvent,
  drainPostCompactionDelegateDeliveries as drainPostCompactionDelegateDeliveriesDispatch,
  dispatchPostCompactionDelegates,
  type PostCompactionDelegateDispatchDeps,
} from "./post-compaction-delegate-dispatch.js";
import type { FollowupRun } from "./queue/types.js";

const mockRegistryState = vi.hoisted(() => ({
  acceptedChildSessionKeys: new Set<string>(),
}));

vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSubagentRunByChildSessionKey: (childSessionKey: string) =>
    mockRegistryState.acceptedChildSessionKeys.has(childSessionKey)
      ? { runId: `run:${childSessionKey}`, childSessionKey }
      : null,
  hasLiveContinuationDelegateChildRun: (params: { childSessionKey: string }) =>
    mockRegistryState.acceptedChildSessionKeys.has(params.childSessionKey),
}));

const cfg: OpenClawConfig = {};
const VALID_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

const defaultRuntimeConfig: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 0,
  minDelayMs: 0,
  maxDelayMs: 1_000,
  maxChainLength: 4,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  maxPendingWork: 32,
  crossSessionTargeting: "disabled",
};

function delegate(
  task: string,
  overrides?: Partial<SessionPostCompactionDelegate>,
): SessionPostCompactionDelegate {
  return {
    task,
    createdAt: overrides?.createdAt ?? 1,
    ...(overrides?.firstArmedAt != null ? { firstArmedAt: overrides.firstArmedAt } : {}),
    ...(overrides?.silent != null ? { silent: overrides.silent } : {}),
    ...(overrides?.silentWake != null ? { silentWake: overrides.silentWake } : {}),
    ...(overrides?.traceparent
      ? {
          traceparent: overrides.traceparent,
          traceparentProvenance: overrides.traceparentProvenance ?? ("internal" as const),
        }
      : {}),
    ...(overrides?.model ? { model: overrides.model } : {}),
  };
}

function createFollowupRun(overrides?: {
  workspaceDir?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingAccountId?: string;
  originatingTo?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    prompt: "hello",
    enqueuedAt: 1,
    originatingChannel: overrides?.originatingChannel,
    originatingAccountId: overrides?.originatingAccountId,
    originatingTo: overrides?.originatingTo,
    originatingThreadId: overrides?.originatingThreadId,
    run: {
      agentId: "main",
      agentDir: "/tmp/agent",
      sessionId: "session",
      sessionKey: "main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: overrides?.workspaceDir ?? "/tmp/workspace",
      config: cfg,
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
  };
}

function createDispatchDeps(options?: {
  staged?: SessionPostCompactionDelegate[];
  context?: string | null;
  contextError?: Error;
  rejectEnqueueAt?: number;
  runtimeConfig?: ContinuationRuntimeConfig;
  now?: number;
}) {
  const enqueueSystemEvent = vi.fn();
  const log = vi.fn();
  const readPostCompactionContext = vi.fn(async () => {
    if (options?.contextError) {
      throw options.contextError;
    }
    return options?.context ?? null;
  });
  const resolveAgentWorkspaceDir = vi.fn(() => "/fallback-workspace");
  const resolveContinuationRuntimeConfig = vi.fn(
    () => options?.runtimeConfig ?? defaultRuntimeConfig,
  );
  const enqueuePostCompactionDelegateDelivery = vi.fn(async ({ sequence }) => {
    if (options?.rejectEnqueueAt === sequence) {
      throw new Error("queue write failed");
    }
    return `queue-${sequence}`;
  });
  const drainPostCompactionDelegateDeliveries = vi.fn(async () => undefined);
  const finalizeStagedPostCompactionDelegates = vi.fn(
    (flowIds: readonly (string | undefined)[]) => flowIds.filter(Boolean).length,
  );
  const rejectPostCompactionTaskFlowDelegate = vi.fn(() => true);
  const requeueReleasedPostCompactionDelegate = vi.fn(() => false);
  const stagePostCompactionDelegate = vi.fn();
  const deps: PostCompactionDelegateDispatchDeps = {
    consumeStagedPostCompactionDelegates: vi.fn(() => options?.staged ?? []),
    finalizeStagedPostCompactionDelegates,
    rejectPostCompactionTaskFlowDelegate,
    requeueReleasedPostCompactionDelegate,
    stagePostCompactionDelegate,
    drainPostCompactionDelegateDeliveries,
    enqueuePostCompactionDelegateDelivery,
    enqueueSystemEvent,
    log,
    now: vi.fn(() => options?.now ?? 1),
    readPostCompactionContext,
    resolveAgentWorkspaceDir,
    resolveContinuationRuntimeConfig,
    resolveSessionAgentId: vi.fn(() => "main"),
  };
  return {
    deps,
    drainPostCompactionDelegateDeliveries,
    enqueuePostCompactionDelegateDelivery,
    enqueueSystemEvent,
    finalizeStagedPostCompactionDelegates,
    log,
    rejectPostCompactionTaskFlowDelegate,
    readPostCompactionContext,
    requeueReleasedPostCompactionDelegate,
    resolveAgentWorkspaceDir,
    resolveContinuationRuntimeConfig,
    stagePostCompactionDelegate,
  };
}

/** Delivery-time clock every `createDeliveryDeps()` mock reports. */
const DELIVERY_NOW_MS = 1_700_000_000_000;

function createQueuedEntry(
  overrides?: Partial<QueuedPostCompactionDelegateDelivery>,
): QueuedPostCompactionDelegateDelivery {
  return {
    id: "queue-1",
    kind: "postCompactionDelegate",
    sessionKey: "main",
    task: "queued delegate",
    // Armed at the delivery clock: an entry stamped at epoch 1 would be ~54
    // years old and would terminalize on the RFC §4.4 stale gate instead of
    // exercising the guard under test.
    createdAt: DELIVERY_NOW_MS,
    firstArmedAt: DELIVERY_NOW_MS,
    enqueuedAt: DELIVERY_NOW_MS,
    retryCount: 0,
    ...overrides,
    ...(overrides?.traceparent && overrides.traceparentProvenance === undefined
      ? { traceparentProvenance: "internal" as const }
      : {}),
  };
}

function deriveTestContinuationChildSessionKey(agentId: string, flowId: string): string {
  const digest = crypto.createHash("sha256").update(flowId).digest("hex").slice(0, 32);
  return `agent:${agentId}:subagent:continuation-${digest}`;
}

function createDeliveryDeps(params: {
  storePath: string;
  runtimeConfig?: Partial<ContinuationRuntimeConfig>;
  /** Pre-existing accepted-hop marker on the source row, as a replay would see. */
  reservedChainState?: ChainState;
  spawnStatus?: "accepted" | "forbidden" | "error";
  spawnError?: Error;
}) {
  const enqueueSystemEvent = vi.fn();
  const log = vi.fn();
  const spawnSubagentDirect = vi.fn(async () => {
    if (params.spawnError) {
      throw params.spawnError;
    }
    return { status: params.spawnStatus ?? "accepted" };
  });
  const markPendingDelegateSpawnAccepted = vi.fn(() => true);
  const failReleasedPostCompactionDelegate = vi.fn(() => true);
  // Mirrors the real store: the marker write bumps the TaskFlow revision, and a
  // row that already carries a marker returns that same hop on every replay.
  const reserveAcceptedPostCompactionChainHop = vi.fn(
    (flowRef: { flowId?: string; expectedRevision?: number }, plannedChainState: ChainState) => ({
      chainState: params.reservedChainState ?? plannedChainState,
      expectedRevision:
        flowRef.expectedRevision === undefined ? undefined : flowRef.expectedRevision + 1,
    }),
  );
  const deps: PostCompactionDelegateDeliveryDeps = {
    enqueueSystemEvent,
    getRuntimeConfig: vi.fn(() => cfg),
    loadSessionEntry: vi.fn(({ storePath, sessionKey }) =>
      sessionAccessorModule.loadSessionEntry({ storePath, sessionKey }),
    ),
    log,
    now: vi.fn(() => DELIVERY_NOW_MS),
    patchSessionEntryCore: sessionAccessorModule.patchSessionEntryCore,
    resolveContinuationRuntimeConfig: vi.fn(() => ({
      ...defaultRuntimeConfig,
      ...params.runtimeConfig,
    })),
    resolveSessionAgentId: vi.fn(() => "main"),
    resolveSessionStorePathCore: vi.fn(() => params.storePath),
    spawnSubagentDirect,
    revalidatePendingDelegateForSpawn: vi.fn(() => ({ allowed: true }) as const),
    markPendingDelegateSpawnAccepted,
    failReleasedPostCompactionDelegate,
    reserveAcceptedPostCompactionChainHop,
  };
  return {
    deps,
    enqueueSystemEvent,
    log,
    failReleasedPostCompactionDelegate,
    markPendingDelegateSpawnAccepted,
    reserveAcceptedPostCompactionChainHop,
    spawnSubagentDirect,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function seedSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await Promise.all(
    Object.entries(store).map(async ([sessionKey, entry]) => {
      await sessionAccessorModule.upsertSessionEntryCore({ storePath, sessionKey }, entry);
    }),
  );
}

function readSessionStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    sessionAccessorModule
      .listSessionEntriesCore({ storePath })
      .map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

afterEach(() => {
  vi.useRealTimers();
  mockRegistryState.acceptedChildSessionKeys.clear();
  sessionStoreModule.clearSessionStoreCacheForTest();
});

const splitLintUse = [
  enqueuePostCompactionDelegateDeliveryQueue,
  loadPendingSessionDelivery,
  persistPendingPostCompactionDelegates,
  takePendingPostCompactionDelegates,
  buildPostCompactionLifecycleEvent,
  drainPostCompactionDelegateDeliveriesDispatch,
  deriveTestContinuationChildSessionKey,
];
void splitLintUse;

describe("post-compaction delegate dispatch extraction", () => {
  it("carries staged TaskFlow source ids into queued post-compaction deliveries", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [],
    };
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [
        {
          ...delegate("staged from taskflow"),
          flowId: "pc-flow-source",
          expectedRevision: 4,
        },
      ],
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 3,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: [],
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 1, droppedDelegates: 0 });
    expect(
      expectDefined(
        enqueuePostCompactionDelegateDelivery.mock.calls.at(0)?.at(0),
        "queued delegate delivery",
      ).delegate,
    ).toMatchObject({
      task: "staged from taskflow",
      flowId: "pc-flow-source",
      expectedRevision: 4,
    });
  });

  it("preserves delegate-specific traceparent over request_compaction traceparent", async () => {
    const delegateTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [delegate("persisted", { traceparent: delegateTraceparent })],
    };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps();

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 9,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        releaseTraceparent: VALID_TRACEPARENT,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(enqueuePostCompactionDelegateDelivery.mock.calls[0]?.[0]).toMatchObject({
      delegate: expect.objectContaining({
        traceparent: delegateTraceparent,
        traceparentProvenance: "internal",
      }),
    });
  });

  it("replaces an unmarked persisted traceparent with the internal release context", async () => {
    const attackerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [
        { task: "persisted", createdAt: 1, traceparent: attackerTraceparent },
      ],
    };
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps();

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 9,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: [],
        releaseTraceparent: VALID_TRACEPARENT,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    const queuedDelegate = enqueuePostCompactionDelegateDelivery.mock.calls[0]?.[0]?.delegate;
    expect(queuedDelegate).toMatchObject({
      traceparent: VALID_TRACEPARENT,
      traceparentProvenance: "internal",
    });
    expect(queuedDelegate?.traceparent).not.toBe(attackerTraceparent);
  });

  it("surfaces post-compaction context read failures to the fresh session", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const { deps, enqueueSystemEvent, log } = createDispatchDeps({
      contextError: new Error("workspace locked"),
    });

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: [],
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(log).toHaveBeenCalledWith(
      "[continuation:post-compaction-context-read-failed] sessionKey=main error=workspace locked",
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("Context evacuation read failed: workspace locked"),
      { sessionKey: "main" },
    );
  });

  it("surfaces persisted post-compaction delegate load failures without clearing local pending delegates", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-dispatch-fail-" }, async (tempDir) => {
      const blockerPath = path.join(tempDir, "not-a-directory");
      await fs.writeFile(blockerPath, "blocks sqlite parent directory", "utf-8");
      const storePath = path.join(blockerPath, "sessions.json");
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        pendingPostCompactionDelegates: [delegate("persisted")],
      };
      const { deps, enqueueSystemEvent, log } = createDispatchDeps();

      const result = await dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: createFollowupRun(),
          postCompactionDelegatesToPreserve: [],
          sessionEntry,
          sessionKey: "main",
          storePath,
        },
        deps,
      );

      expect(result).toEqual({ queuedDelegates: 0, droppedDelegates: 0 });
      expect(sessionEntry.pendingPostCompactionDelegates).toEqual([delegate("persisted")]);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load post-compaction delegates for main:"),
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to load persisted post-compaction delegates for this session:",
        ),
        { sessionKey: "main" },
      );
    });
  });

  it("caps queued delegates at maxDelegatesPerTurn and drops the overflow", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery, log } = createDispatchDeps({
      staged: [
        delegate("a"),
        delegate("b"),
        delegate("c"),
        delegate("d"),
        delegate("e"),
        delegate("f"),
        delegate("g"),
      ],
      runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn: 5 },
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 5, droppedDelegates: 2 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(5);
    expect(
      enqueuePostCompactionDelegateDelivery.mock.calls.map((call) => call[0].delegate.task),
    ).toEqual(["a", "b", "c", "d", "e"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("2 over maxDelegatesPerTurn budget (5, bracketOffset=0)"),
    );
    expect(preserve).toEqual([]);
  });

  it("drops stale delegates using stable firstArmedAt age", async () => {
    const now = 1_700_000_000_000;
    const staleFirstArmedAt = now - 8 * 24 * 60 * 60 * 1000;
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery, log } = createDispatchDeps({
      staged: [
        delegate("stale", {
          createdAt: now,
          firstArmedAt: staleFirstArmedAt,
        }),
        delegate("fresh", {
          createdAt: now,
          firstArmedAt: now - 60_000,
        }),
      ],
      now,
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 1, droppedDelegates: 1 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(1);
    expect(enqueuePostCompactionDelegateDelivery.mock.calls[0]?.[0].delegate).toMatchObject({
      task: "fresh",
      firstArmedAt: now - 60_000,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Post-compaction delegate dropped as stale for main"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`firstArmedAt=${staleFirstArmedAt}`));
  });

  it.each([
    { name: "stale", maxDelegatesPerTurn: 5, firstArmedAtOffsetMs: 8 * 24 * 60 * 60 * 1000 },
    { name: "over budget", maxDelegatesPerTurn: 0, firstArmedAtOffsetMs: 60_000 },
  ])(
    "terminalizes managed TaskFlow claims dropped as $name",
    async ({ firstArmedAtOffsetMs, maxDelegatesPerTurn }) => {
      const now = 1_700_000_000_000;
      const managedDelegate: SessionPostCompactionDelegate = {
        task: "managed drop",
        createdAt: now,
        firstArmedAt: now - firstArmedAtOffsetMs,
        flowId: "flow-managed-drop",
        expectedRevision: 7,
        returnOptions: { artifacts: "required" },
      };
      const { deps, finalizeStagedPostCompactionDelegates, rejectPostCompactionTaskFlowDelegate } =
        createDispatchDeps({
          staged: [managedDelegate],
          runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn },
          now,
        });

      const result = await dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: createFollowupRun(),
          postCompactionDelegatesToPreserve: [],
          sessionEntry: { sessionId: "session", updatedAt: 1 },
          sessionKey: "main",
        },
        deps,
      );

      expect(result).toEqual({ queuedDelegates: 0, droppedDelegates: 1 });
      expect(rejectPostCompactionTaskFlowDelegate).toHaveBeenCalledWith(
        expect.objectContaining(managedDelegate),
        expect.stringContaining("Post-compaction delegate rejected"),
      );
      expect(finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([]);
    },
  );

  it.each([
    {
      name: "continuation",
      runtimeConfig: {
        ...defaultRuntimeConfig,
        enabled: false,
        maxDelegatesPerTurn: 0,
        crossSessionTargeting: "enabled" as const,
      },
      targetSessionKey: undefined,
    },
    {
      name: "cross-session targeting",
      runtimeConfig: {
        ...defaultRuntimeConfig,
        enabled: true,
        maxDelegatesPerTurn: 0,
        crossSessionTargeting: "disabled" as const,
      },
      targetSessionKey: "agent:main:other",
    },
  ])(
    "requeues managed TaskFlow rows before stale and cap handling when $name is disabled",
    async ({ runtimeConfig, targetSessionKey }) => {
      const now = 1_700_000_000_000;
      const managedDelegate: SessionPostCompactionDelegate = {
        task: "defer managed post-compaction work",
        createdAt: 1,
        firstArmedAt: 1,
        flowId: "flow-managed-disabled",
        expectedRevision: 4,
        returnOptions: { artifacts: "required" },
        ...(targetSessionKey ? { targetSessionKey } : {}),
      };
      const preserve: SessionPostCompactionDelegate[] = [];
      const {
        deps,
        enqueuePostCompactionDelegateDelivery,
        finalizeStagedPostCompactionDelegates,
        requeueReleasedPostCompactionDelegate,
      } = createDispatchDeps({
        staged: [managedDelegate],
        runtimeConfig,
        now,
      });
      requeueReleasedPostCompactionDelegate.mockReturnValue(true);

      const result = await dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: createFollowupRun(),
          postCompactionDelegatesToPreserve: preserve,
          sessionEntry: { sessionId: "session", updatedAt: 1 },
          sessionKey: "main",
        },
        deps,
      );

      expect(result).toEqual({ queuedDelegates: 0, droppedDelegates: 0 });
      expect(requeueReleasedPostCompactionDelegate).toHaveBeenCalledWith(
        expect.objectContaining(managedDelegate),
      );
      expect(enqueuePostCompactionDelegateDelivery).not.toHaveBeenCalled();
      expect(finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([]);
      expect(preserve).toEqual([]);
    },
  );

  it("does not restage a managed return when its authoritative TaskFlow requeue is not applied", async () => {
    const managedDelegate: SessionPostCompactionDelegate = {
      task: "defer managed post-compaction work",
      createdAt: 1,
      firstArmedAt: 1,
      flowId: "flow-managed-disabled",
      expectedRevision: 4,
      returnOptions: { artifacts: "required" },
    };
    const preserve: SessionPostCompactionDelegate[] = [];
    const {
      deps,
      finalizeStagedPostCompactionDelegates,
      log,
      requeueReleasedPostCompactionDelegate,
      stagePostCompactionDelegate,
    } = createDispatchDeps({
      staged: [managedDelegate],
      runtimeConfig: {
        ...defaultRuntimeConfig,
        enabled: false,
        maxDelegatesPerTurn: 0,
      },
    });

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry: { sessionId: "session", updatedAt: 1 },
        sessionKey: "main",
      },
      deps,
    );

    expect(requeueReleasedPostCompactionDelegate).toHaveBeenCalledWith(
      expect.objectContaining(managedDelegate),
    );
    expect(stagePostCompactionDelegate).not.toHaveBeenCalled();
    expect(finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("preserving authoritative TaskFlow state"),
    );
    expect(preserve).toEqual([]);
  });

  it("reduces compaction budget by one when a bracket delegate was already spawned this turn", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [delegate("a"), delegate("b"), delegate("c"), delegate("d"), delegate("e")],
      runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn: 5 },
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        continuationSignalKind: "delegate",
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 4, droppedDelegates: 1 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(4);
  });

  it("does not enqueue any delegate when the bracket offset zeros the budget", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [delegate("a"), delegate("b")],
      runtimeConfig: { ...defaultRuntimeConfig, maxDelegatesPerTurn: 1 },
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        continuationSignalKind: "delegate",
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 0, droppedDelegates: 2 });
    expect(enqueuePostCompactionDelegateDelivery).not.toHaveBeenCalled();
  });

  it("settles every enqueue before preserving failures and finalizing exact claims", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const {
      deps,
      enqueuePostCompactionDelegateDelivery,
      finalizeStagedPostCompactionDelegates,
      log,
    } = createDispatchDeps({
      staged: [
        { ...delegate("first"), flowId: "flow-first" },
        { ...delegate("second"), flowId: "flow-second" },
      ],
      rejectEnqueueAt: 1,
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );

    expect(result).toEqual({ queuedDelegates: 1, droppedDelegates: 1 });
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(2);
    expect(
      enqueuePostCompactionDelegateDelivery.mock.calls.map((call) => call[0].delegate.task),
    ).toEqual(["first", "second"]);
    expect(sessionEntry.pendingPostCompactionDelegates).toEqual([
      normalizePostCompactionDelegate(delegate("second")),
    ]);
    expect(finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith([
      "flow-first",
      "flow-second",
    ]);
    expect(
      Math.max(...enqueuePostCompactionDelegateDelivery.mock.invocationCallOrder),
    ).toBeLessThan(finalizeStagedPostCompactionDelegates.mock.invocationCallOrder[0]!);
    expect(preserve).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "Failed to enqueue post-compaction delegate for main (re-staged): Error: queue write failed",
    );
  });

  it("uses the fallback workspace resolver only when the run workspace is blank", async () => {
    const { deps, readPostCompactionContext, resolveAgentWorkspaceDir } = createDispatchDeps();

    await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun({ workspaceDir: "   " }),
        postCompactionDelegatesToPreserve: [],
        sessionEntry: { sessionId: "session", updatedAt: 1 },
        sessionKey: "main",
      },
      deps,
    );

    expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(cfg, "main");
    expect(readPostCompactionContext).toHaveBeenCalledWith("/fallback-workspace", {
      cfg,
      agentId: "main",
    });
  });

  it("charges chain count only after queued delivery spawns successfully", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps, enqueueSystemEvent, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            deliveryContext: {
              channel: "discord",
              to: "channel",
              accountId: "account",
              threadId: "thread",
            },
          }),
        },
        deps,
      );

      const stored = readSessionStore(storePath);
      expect(Object.values(stored).some((entry) => entry.continuationChainCount === 1)).toBe(true);
      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          task: "[continuation:post-compaction] [continuation:chain-hop:1] Compaction just completed. Carry this working state to the post-compaction session: queued delegate",
          silentAnnounce: true,
          wakeOnReturn: true,
          drainsContinuationDelegateQueue: true,
          continuationDelegateFlowId: "queue-1",
          continuationChainState: expect.objectContaining({ count: 1, tokens: 0 }),
        }),
        expect.objectContaining({
          agentSessionKey: "main",
          agentChannel: "discord",
          agentAccountId: "account",
          agentTo: "channel",
          agentThreadId: "thread",
        }),
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        { sessionKey: "main" },
      );
    });
  });
});
