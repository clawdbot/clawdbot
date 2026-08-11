/**
 * Scenario: post-compaction delegate recovery + one-way ownership.
 *
 * Covers:
 * - recovery of accepted/replayed chain hops and source-less entries
 * - batch dispatch vs single-entry delivery ownership stays one-way
 * - restart-sentinel delivery may call the delivery owner, never dispatch
 *
 * Stubs: `subagents/registry/subagent-registry-read` for accepted-child
 * lookup only. Ownership assertions are source inspection: delivery lives in
 * `post-compaction-delegate-delivery.ts`; gateway restart sentinel imports that
 * leaf via `../auto-reply/reply/post-compaction-delegate-delivery.js` and must
 * not import the dispatch module.
 */
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
  const requeueReleasedPostCompactionDelegate = vi.fn(() => false);
  const stagePostCompactionDelegate = vi.fn();
  const deps: PostCompactionDelegateDispatchDeps = {
    consumeStagedPostCompactionDelegates: vi.fn(() => options?.staged ?? []),
    finalizeStagedPostCompactionDelegates,
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

// upsertSessionEntryCore canonicalizes a bare seed key ("main" -> "agent:main:main"),
// so read entries back through the same accessor production writes with instead
// of indexing the raw key on a listing.
function readSessionEntry(storePath: string, sessionKey = "main"): SessionEntry | undefined {
  return sessionAccessorModule.loadSessionEntry({ storePath, sessionKey });
}

afterEach(() => {
  vi.useRealTimers();
  mockRegistryState.acceptedChildSessionKeys.clear();
  sessionStoreModule.clearSessionStoreCacheForTest();
});

const splitLintUse = [
  expectDefined,
  enqueuePostCompactionDelegateDeliveryQueue,
  normalizePostCompactionDelegate,
  persistPendingPostCompactionDelegates,
  takePendingPostCompactionDelegates,
  buildPostCompactionLifecycleEvent,
  drainPostCompactionDelegateDeliveriesDispatch,
  VALID_TRACEPARENT,
  deriveTestContinuationChildSessionKey,
];
void splitLintUse;

describe("post-compaction delegate dispatch extraction", () => {
  it("allows queued self-targeting delivery when cross-session targeting is disabled", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: 1 } });
      const { deps, spawnSubagentDirect } = createDeliveryDeps({
        storePath,
        runtimeConfig: { crossSessionTargeting: "disabled" },
      });

      await deliverQueuedPostCompactionDelegate(
        { entry: createQueuedEntry({ targetSessionKey: " main " }) },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({ continuationTargetSessionKey: " main " }),
        expect.any(Object),
      );
    });
  });

  it("allows queued fanoutMode=tree post-compaction delivery when cross-session targeting is disabled", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: 1 } });
      const { deps, spawnSubagentDirect } = createDeliveryDeps({
        storePath,
        runtimeConfig: { crossSessionTargeting: "disabled" },
      });

      await deliverQueuedPostCompactionDelegate(
        { entry: createQueuedEntry({ fanoutMode: "tree" }) },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({ continuationFanoutMode: "tree" }),
        expect.any(Object),
      );
    });
  });

  // ---- Regression tests for queue-model correctness repairs ----

  it("drains unfiltered for sessionKey so prior failed entries are reconsidered", async () => {
    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, drainPostCompactionDelegateDeliveries } = createDispatchDeps({
      staged: [delegate("fresh")],
    });

    await dispatchPostCompactionDelegates(
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
    await flushMicrotasks();

    expect(drainPostCompactionDelegateDeliveries).toHaveBeenCalledTimes(1);
    const calls = drainPostCompactionDelegateDeliveries.mock.calls as ReadonlyArray<
      ReadonlyArray<unknown>
    >;
    const callArg = calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArg).toBeDefined();
    // Must omit entryIds so the drain is sessionKey-scoped and
    // backoff-eligible (no bypass), rescuing prior failed pending entries.
    expect(callArg).not.toHaveProperty("entryIds");
    expect(callArg).toMatchObject({ sessionKey: "main" });
  });

  it("records retry metadata only for the selected session during a mixed-session drain", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-drain-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, {
        main: { sessionId: "main-session", updatedAt: 1 },
        other: { sessionId: "other-session", updatedAt: 1 },
      });
      const mainId = await enqueuePostCompactionDelegateDeliveryQueue(
        {
          sessionKey: "main",
          delegate: delegate("main retry", {
            createdAt: DELIVERY_NOW_MS,
            firstArmedAt: DELIVERY_NOW_MS,
          }),
          sequence: 0,
          compactionCount: 1,
        },
        tempDir,
      );
      const otherId = await enqueuePostCompactionDelegateDeliveryQueue(
        {
          sessionKey: "other",
          delegate: delegate("other untouched", {
            createdAt: DELIVERY_NOW_MS,
            firstArmedAt: DELIVERY_NOW_MS,
          }),
          sequence: 0,
          compactionCount: 1,
        },
        tempDir,
      );
      const { deps, spawnSubagentDirect } = createDeliveryDeps({
        storePath,
        spawnError: new Error("transient spawn failure"),
      });

      await drainPostCompactionDelegateDeliveriesDispatch({
        sessionKey: "main",
        stateDir: tempDir,
        deliveryDeps: deps,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });

      expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDelivery(mainId, tempDir)).toMatchObject({
        sessionKey: "main",
        retryCount: 1,
        lastError: "transient spawn failure",
      });
      expect(await loadPendingSessionDelivery(otherId, tempDir)).toMatchObject({
        sessionKey: "other",
        retryCount: 0,
      });
    });
  });

  it("does not re-spawn an accepted child when the post-acceptance chain persist fails", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-persist-fail-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: 1 } });
      const { deps, log, markPendingDelegateSpawnAccepted, spawnSubagentDirect } =
        createDeliveryDeps({ storePath });
      const entry = createQueuedEntry({
        sourceFlowId: "pc-flow-source",
        sourceExpectedRevision: 7,
      });

      // The chain is charged only after the child is accepted, so a persist
      // failure now happens with a live child. The delivery must reject (entry
      // stays pending) without committing acceptance.
      const persist = vi.fn<typeof sessionAccessorModule.patchSessionEntryCore>();
      persist.mockRejectedValueOnce(new Error("persist failed"));
      deps.patchSessionEntryCore = persist;
      await expect(deliverQueuedPostCompactionDelegate({ entry }, deps)).rejects.toBeDefined();
      expect(persist).toHaveBeenCalledWith(
        { storePath, sessionKey: "main" },
        expect.any(Function),
        expect.objectContaining({ requireWriteSuccess: true }),
      );
      expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(markPendingDelegateSpawnAccepted).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("Failed to persist post-compaction delegate chain state for main"),
      );

      // The load-bearing assertion: the retry sees the accepted child and
      // settles it instead of spawning a duplicate. Duplicate protection is the
      // accepted-child replay guard, not a persist-before-spawn ordering.
      mockRegistryState.acceptedChildSessionKeys.add(
        deriveTestContinuationChildSessionKey("main", "pc-flow-source"),
      );
      deps.patchSessionEntryCore = sessionAccessorModule.patchSessionEntryCore;
      await deliverQueuedPostCompactionDelegate({ entry }, deps);
      expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(markPendingDelegateSpawnAccepted).toHaveBeenCalledTimes(1);
      expect(expectDefined(readSessionEntry(storePath), "main").continuationChainCount).toBe(1);
    });
  });

  it("reports queuedDelegates count (not delivered count) in the lifecycle event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T22:30:00.000Z"));

    const sessionEntry: SessionEntry = { sessionId: "session", updatedAt: 1 };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueueSystemEvent } = createDispatchDeps({
      staged: [delegate("a"), delegate("b"), delegate("c")],
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 4,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 3, droppedDelegates: 0 });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "[system:post-compaction] Session compacted at 2026-04-26T22:30:00.000Z. Compaction count: 4. Queued 3 post-compaction delegate(s) for delivery into the fresh session.",
      { sessionKey: "main" },
    );
  });

  it("re-stages preserved delegates and finalizes claimed rows when the durable persist fails", async () => {
    // Two staged rows are claimed; the first delegate's delivery enqueue fails
    // so it lands in the preserve list, and the session-store re-stage then
    // throws. The dispatch must re-stage the preserved delegate as a fresh
    // queued TaskFlow row AND finalize the claimed rows — leaving them `running`
    // would let listRecoverableStagedPostCompactionDelegates replay
    // already-delivered / re-staged delegates as duplicates on the next startup.
    const staged: SessionPostCompactionDelegate[] = [
      { ...delegate("staged one"), flowId: "flow-1" },
      { ...delegate("staged two"), flowId: "flow-2" },
    ];
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps } = createDispatchDeps({ staged, rejectEnqueueAt: 0 });

    const persistSpy = vi
      .spyOn(sessionAccessorModule, "patchSessionEntryCore")
      .mockRejectedValue(new Error("store write failed"));
    try {
      await dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: createFollowupRun(),
          postCompactionDelegatesToPreserve: preserve,
          sessionKey: "main",
          storePath: "/tmp/post-compaction-persist-fail.json",
        },
        deps,
      );
    } finally {
      persistSpy.mockRestore();
    }
    await flushMicrotasks();

    // The preserved delegate is re-staged as a fresh durable queued row.
    const stageCalls = vi.mocked(deps["stagePostCompactionDelegate"]).mock.calls;
    expect(stageCalls).toHaveLength(1);
    // The claimed rows are finished so recovery cannot replay them.
    const finalizeCalls = vi.mocked(deps["finalizeStagedPostCompactionDelegates"]).mock.calls;
    expect(finalizeCalls).toContainEqual([["flow-1", "flow-2"]]);
    // Preserve list drained: the caller's finally must not re-stage a second time.
    expect(preserve).toHaveLength(0);
  });

  it("requeues source-backed preserved delegates instead of creating a duplicate copy", async () => {
    const staged: SessionPostCompactionDelegate[] = [
      { ...delegate("staged one"), flowId: "flow-1", expectedRevision: 3 },
      { ...delegate("staged two"), flowId: "flow-2", expectedRevision: 4 },
    ];
    const preserve: SessionPostCompactionDelegate[] = [];
    const {
      deps,
      finalizeStagedPostCompactionDelegates,
      requeueReleasedPostCompactionDelegate,
      stagePostCompactionDelegate,
    } = createDispatchDeps({
      staged,
      rejectEnqueueAt: 0,
    });
    requeueReleasedPostCompactionDelegate.mockReturnValueOnce(true);

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 1,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 1, droppedDelegates: 1 });
    expect(requeueReleasedPostCompactionDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: "flow-1",
        expectedRevision: 3,
        task: "staged one",
      }),
    );
    expect(stagePostCompactionDelegate).not.toHaveBeenCalled();
    expect(finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith(["flow-2"]);
    expect(preserve).toHaveLength(0);
  });

  it("fails queued release when claimed row finalization is incomplete", async () => {
    const staged: SessionPostCompactionDelegate[] = [
      { ...delegate("staged one"), flowId: "flow-1" },
      { ...delegate("staged two"), flowId: "flow-2" },
    ];
    const { deps, finalizeStagedPostCompactionDelegates } = createDispatchDeps({ staged });
    finalizeStagedPostCompactionDelegates.mockReturnValueOnce(1);

    await expect(
      dispatchPostCompactionDelegates(
        {
          cfg,
          compactionCount: 1,
          followupRun: createFollowupRun(),
          postCompactionDelegatesToPreserve: [],
          sessionKey: "main",
        },
        deps,
      ),
    ).rejects.toThrow("post-compaction-finalize-incomplete");

    expect(finalizeStagedPostCompactionDelegates).toHaveBeenCalledWith(["flow-1", "flow-2"]);
  });

  it("keeps batch dispatch and single-entry delivery ownership one-way", async () => {
    const dispatchSource = await fs.readFile(
      new URL("./post-compaction-delegate-dispatch.ts", import.meta.url),
      "utf8",
    );
    const deliverySource = await fs.readFile(
      new URL("./post-compaction-delegate-delivery.ts", import.meta.url),
      "utf8",
    );
    const restartDeliverySource = await fs.readFile(
      new URL("../../gateway/server-restart-sentinel-delivery.ts", import.meta.url),
      "utf8",
    );
    const combinedSource = `${dispatchSource}\n${deliverySource}`;

    expect(dispatchSource).toContain('from "./post-compaction-delegate-delivery.js"');
    expect(deliverySource).not.toContain("post-compaction-delegate-dispatch");
    // Restart sentinel lives under gateway/, so its delivery import is absolute
    // to the auto-reply reply leaf — not a same-directory `./` specifier.
    expect(restartDeliverySource).toContain(
      'from "../auto-reply/reply/post-compaction-delegate-delivery.js"',
    );
    expect(restartDeliverySource).not.toContain("post-compaction-delegate-dispatch");
    expect(
      combinedSource.match(/export async function deliverQueuedPostCompactionDelegate/g),
    ).toHaveLength(1);
    expect(dispatchSource).not.toMatch(
      /\b(?:updateSessionStore|loadSessionStore|spawnSubagentDirect|markPendingDelegateSpawnAccepted|failReleasedPostCompactionDelegate)\b/,
    );
    expect(deliverySource).not.toMatch(
      /\b(?:DispatchPostCompactionDelegatesParams|buildPostCompactionLifecycleEvent|postCompactionDelegatesToPreserve|readPostCompactionContext|drainPostCompactionDelegateDeliveries)\b/,
    );
  });
});
