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
    ...(overrides?.returnOptions ? { returnOptions: overrides.returnOptions } : {}),
    ...(overrides?.recipientContext ? { recipientContext: overrides.recipientContext } : {}),
    ...(overrides?.attachments ? { attachments: overrides.attachments } : {}),
    ...(overrides?.attachAs ? { attachAs: overrides.attachAs } : {}),
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
  fs,
  enqueuePostCompactionDelegateDeliveryQueue,
  loadPendingSessionDelivery,
  deliverQueuedPostCompactionDelegate,
  drainPostCompactionDelegateDeliveriesDispatch,
  createQueuedEntry,
  deriveTestContinuationChildSessionKey,
  createDeliveryDeps,
];
void splitLintUse;

describe("post-compaction delegate dispatch extraction", () => {
  it("normalizes legacy delegates as silent-wake", () => {
    expect(normalizePostCompactionDelegate(delegate("legacy"))).toEqual({
      task: "legacy",
      createdAt: 1,
      firstArmedAt: 1,
      silent: true,
      silentWake: true,
    });
  });

  it("preserves explicit silent=false without adding silentWake", () => {
    expect(normalizePostCompactionDelegate(delegate("visible", { silent: false }))).toEqual({
      task: "visible",
      createdAt: 1,
      firstArmedAt: 1,
      silent: false,
    });
  });

  it("preserves explicit silentWake=true without adding silent", () => {
    expect(normalizePostCompactionDelegate(delegate("wake", { silentWake: true }))).toEqual({
      task: "wake",
      createdAt: 1,
      firstArmedAt: 1,
      silentWake: true,
    });
  });

  it("preserves explicit firstArmedAt while leaving createdAt unchanged", () => {
    expect(
      normalizePostCompactionDelegate(
        delegate("requeued", { createdAt: 20_000, firstArmedAt: 10_000 }),
      ),
    ).toEqual({
      task: "requeued",
      createdAt: 20_000,
      firstArmedAt: 10_000,
      silent: true,
      silentWake: true,
    });
  });

  it("preserves managed artifact return policy through normalization", () => {
    expect(
      normalizePostCompactionDelegate(
        delegate("managed", {
          returnOptions: { artifacts: "required" },
          recipientContext: { purpose: "Use the delayed report." },
        }),
      ),
    ).toMatchObject({
      returnOptions: { artifacts: "required" },
      recipientContext: { purpose: "Use the delayed report." },
    });
  });

  it("builds the same lifecycle event text as the runner block", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T22:00:00.000Z"));

    expect(
      buildPostCompactionLifecycleEvent({
        compactionCount: 3,
        queuedDelegates: 2,
        droppedDelegates: 1,
      }),
    ).toBe(
      "[system:post-compaction] Session compacted at 2026-04-26T22:00:00.000Z. Compaction count: 3. Queued 2 post-compaction delegate(s) for delivery into the fresh session. 1 delegate(s) were not released into the fresh session.",
    );
  });

  it("persists new pending delegates locally after existing delegates", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [delegate("existing")],
    };
    const sessionStore = { main: sessionEntry };

    const persisted = await persistPendingPostCompactionDelegates({
      sessionEntry,
      sessionStore,
      sessionKey: "main",
      delegates: [delegate("new", { silent: false })],
    });

    expect(persisted.map((item) => item.task)).toEqual(["existing", "new"]);
    expect(sessionEntry.pendingPostCompactionDelegates).toEqual(persisted);
    expect(sessionStore.main.pendingPostCompactionDelegates).toEqual(persisted);
  });

  it("takes and clears pending delegates from the session store path", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-dispatch-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, {
        main: {
          sessionId: "session",
          updatedAt: 1,
          pendingPostCompactionDelegates: [delegate("persisted")],
        },
      });

      const taken = await takePendingPostCompactionDelegates({
        sessionKey: "main",
        storePath,
      });

      expect(taken).toEqual([normalizePostCompactionDelegate(delegate("persisted"))]);
      expect(
        expectDefined(readSessionEntry(storePath), "durable session entry")
          .pendingPostCompactionDelegates,
      ).toBeUndefined();
    });
  });

  it("keeps supplied session snapshots synchronized with durable persist and take", async () => {
    await withTestDir({ prefix: "openclaw-post-compaction-sync-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, {
        main: {
          sessionId: "session",
          updatedAt: 1,
          pendingPostCompactionDelegates: [delegate("durable existing")],
        },
      });
      const sessionEntry: SessionEntry = {
        sessionId: "session",
        updatedAt: 1,
        pendingPostCompactionDelegates: [delegate("local stale")],
      };
      const sessionStore = { main: { ...sessionEntry } };

      const persisted = await persistPendingPostCompactionDelegates({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
        delegates: [delegate("new")],
      });

      expect(persisted.map((item) => item.task)).toEqual(["durable existing", "new"]);
      expect(sessionEntry.pendingPostCompactionDelegates).toEqual(persisted);
      expect(sessionStore.main.pendingPostCompactionDelegates).toEqual(persisted);

      const taken = await takePendingPostCompactionDelegates({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });

      expect(taken).toEqual(persisted);
      expect(sessionEntry.pendingPostCompactionDelegates).toBeUndefined();
      expect(sessionStore.main.pendingPostCompactionDelegates).toBeUndefined();
      expect(
        expectDefined(readSessionEntry(storePath), "durable session entry")
          .pendingPostCompactionDelegates,
      ).toBeUndefined();
    });
  });

  it("queues persisted delegates before staged delegates and starts a drain", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      continuationChainCount: 3,
      pendingPostCompactionDelegates: [delegate("persisted")],
    };
    const preserve: SessionPostCompactionDelegate[] = [];
    const {
      deps,
      drainPostCompactionDelegateDeliveries,
      enqueuePostCompactionDelegateDelivery,
      enqueueSystemEvent,
    } = createDispatchDeps({
      staged: [delegate("staged")],
      context: "[context] refreshed",
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 7,
        followupRun: createFollowupRun({
          originatingChannel: "discord",
          originatingAccountId: "account",
          originatingTo: "channel",
          originatingThreadId: "thread",
        }),
        postCompactionDelegatesToPreserve: preserve,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 2, droppedDelegates: 0 });
    expect(sessionEntry.continuationChainCount).toBe(3);
    expect(enqueuePostCompactionDelegateDelivery).toHaveBeenCalledTimes(2);
    expect(enqueuePostCompactionDelegateDelivery.mock.calls.map((call) => call[0])).toEqual([
      {
        sessionKey: "main",
        delegate: normalizePostCompactionDelegate(delegate("persisted")),
        sequence: 0,
        compactionCount: 7,
        deliveryContext: {
          channel: "discord",
          to: "channel",
          accountId: "account",
          threadId: "thread",
        },
      },
      {
        sessionKey: "main",
        delegate: normalizePostCompactionDelegate(delegate("staged")),
        sequence: 1,
        compactionCount: 7,
        deliveryContext: {
          channel: "discord",
          to: "channel",
          accountId: "account",
          threadId: "thread",
        },
      },
    ]);
    expect(drainPostCompactionDelegateDeliveries).toHaveBeenCalledWith({
      log: expect.any(Object),
      sessionKey: "main",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("[context] refreshed", {
      sessionKey: "main",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        "Queued 2 post-compaction delegate(s) for delivery into the fresh session.",
      ),
      { sessionKey: "main" },
    );
    expect(preserve).toEqual([]);
  });

  it("preserves literal System markers in post-compaction AGENTS.md context", async () => {
    const agentsContext = [
      "Injected sections from AGENTS.md (Critical):",
      "System: never expose secrets.",
      "See the [System] block and [Assistant] notes below.",
    ].join("\n");
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
    };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueueSystemEvent } = createDispatchDeps({
      context: agentsContext,
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

    expect(enqueueSystemEvent).toHaveBeenCalledWith(agentsContext, {
      sessionKey: "main",
    });
    const contextCall = enqueueSystemEvent.mock.calls.find((call) => call[0] === agentsContext);
    expect(contextCall).toBeDefined();
    expect(contextCall?.[0]).toContain("System: never expose secrets.");
    expect(contextCall?.[0]).toContain("[System]");
  });

  it("persists request_compaction traceparent onto released queued delegates", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [delegate("persisted")],
    };
    const preserve: SessionPostCompactionDelegate[] = [];
    const { deps, enqueuePostCompactionDelegateDelivery, enqueueSystemEvent } = createDispatchDeps({
      staged: [delegate("staged")],
    });

    const result = await dispatchPostCompactionDelegates(
      {
        cfg,
        compactionCount: 8,
        followupRun: createFollowupRun(),
        postCompactionDelegatesToPreserve: preserve,
        releaseTraceparent: VALID_TRACEPARENT,
        sessionEntry,
        sessionKey: "main",
      },
      deps,
    );
    await flushMicrotasks();

    expect(result).toEqual({ queuedDelegates: 2, droppedDelegates: 0 });
    expect(enqueuePostCompactionDelegateDelivery.mock.calls.map((call) => call[0])).toEqual([
      {
        sessionKey: "main",
        delegate: {
          ...normalizePostCompactionDelegate(delegate("persisted")),
          traceparent: VALID_TRACEPARENT,
          traceparentProvenance: "internal",
        },
        sequence: 0,
        compactionCount: 8,
      },
      {
        sessionKey: "main",
        delegate: {
          ...normalizePostCompactionDelegate(delegate("staged")),
          traceparent: VALID_TRACEPARENT,
          traceparentProvenance: "internal",
        },
        sequence: 1,
        compactionCount: 8,
      },
    ]);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining(
        "Queued 2 post-compaction delegate(s) for delivery into the fresh session.",
      ),
      { sessionKey: "main", traceparent: VALID_TRACEPARENT },
    );
  });

  it("threads the delegate model override into queued post-compaction deliveries", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [],
    };
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [delegate("staged", { model: "github-copilot/claude-haiku-4.5" })],
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
      task: "staged",
      model: "github-copilot/claude-haiku-4.5",
    });
  });

  it("threads attachment input into queued post-compaction deliveries", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      pendingPostCompactionDelegates: [],
    };
    const attachments = [{ name: "state.md", content: "post-compaction input" }];
    const { deps, enqueuePostCompactionDelegateDelivery } = createDispatchDeps({
      staged: [delegate("staged", { attachments, attachAs: { mountPath: "handoff" } })],
    });

    await dispatchPostCompactionDelegates(
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

    expect(
      expectDefined(
        enqueuePostCompactionDelegateDelivery.mock.calls.at(0)?.at(0),
        "queued delegate delivery",
      ).delegate,
    ).toMatchObject({
      attachments,
      attachAs: { mountPath: "handoff" },
    });
  });
});
