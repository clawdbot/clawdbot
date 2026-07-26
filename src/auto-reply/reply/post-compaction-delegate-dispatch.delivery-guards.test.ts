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
  SessionDeliveryDeferredError,
} from "../../infra/session-delivery-queue-storage.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import type { ContinuationRuntimeConfig } from "../continuation/types.js";
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
const { assertDelegateArtifactPolicyPreparedMock, removeUnacceptedDelegateArtifactPolicyMock } =
  vi.hoisted(() => ({
    assertDelegateArtifactPolicyPreparedMock: vi.fn(),
    removeUnacceptedDelegateArtifactPolicyMock: vi.fn(),
  }));

vi.mock("../../agents/delegate-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/delegate-artifacts.js")>()),
  assertDelegateArtifactPolicyPrepared: assertDelegateArtifactPolicyPreparedMock,
  removeUnacceptedDelegateArtifactPolicy: removeUnacceptedDelegateArtifactPolicyMock,
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
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

function createQueuedEntry(
  overrides?: Partial<QueuedPostCompactionDelegateDelivery>,
): QueuedPostCompactionDelegateDelivery {
  return {
    id: "queue-1",
    kind: "postCompactionDelegate",
    sessionKey: "main",
    task: "queued delegate",
    createdAt: 1,
    enqueuedAt: 1,
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
  const loadSessionEntry = vi.fn(({ storePath, sessionKey }) =>
    sessionAccessorModule.loadSessionEntry({ storePath, sessionKey }),
  );
  const markPendingDelegateSpawnAccepted = vi.fn(() => true);
  const markPendingDelegateFailed = vi.fn(() => true);
  const deps: PostCompactionDelegateDeliveryDeps = {
    enqueueSystemEvent,
    getRuntimeConfig: vi.fn(() => cfg),
    loadSessionEntry,
    log,
    now: vi.fn(() => 1_700_000_000_000),
    patchSessionEntry: sessionAccessorModule.patchSessionEntry,
    resolveContinuationRuntimeConfig: vi.fn(() => ({
      ...defaultRuntimeConfig,
      ...params.runtimeConfig,
    })),
    resolveSessionAgentId: vi.fn(() => "main"),
    resolveStorePath: vi.fn(() => params.storePath),
    spawnSubagentDirect,
    markPendingDelegateSpawnAccepted,
    markPendingDelegateFailed,
  };
  return {
    deps,
    enqueueSystemEvent,
    loadSessionEntry,
    log,
    markPendingDelegateFailed,
    markPendingDelegateSpawnAccepted,
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
      await sessionAccessorModule.upsertSessionEntry({ storePath, sessionKey }, entry);
    }),
  );
}

function readSessionStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    sessionAccessorModule
      .listSessionEntries({ storePath })
      .map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

afterEach(() => {
  vi.useRealTimers();
  assertDelegateArtifactPolicyPreparedMock.mockClear();
  removeUnacceptedDelegateArtifactPolicyMock.mockClear();
  mockRegistryState.acceptedChildSessionKeys.clear();
  sessionStoreModule.clearSessionStoreCacheForTest();
});

const splitLintUse = [
  fs,
  expectDefined,
  enqueuePostCompactionDelegateDeliveryQueue,
  loadPendingSessionDelivery,
  normalizePostCompactionDelegate,
  persistPendingPostCompactionDelegates,
  takePendingPostCompactionDelegates,
  buildPostCompactionLifecycleEvent,
  drainPostCompactionDelegateDeliveriesDispatch,
  dispatchPostCompactionDelegates,
  delegate,
  createFollowupRun,
  createDispatchDeps,
  flushMicrotasks,
];
void splitLintUse;

describe("post-compaction delegate dispatch extraction", () => {
  it("uses queued source flow ids for idempotent post-compaction spawns and commits accepted TaskFlow rows", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-source-flow-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps, enqueueSystemEvent, markPendingDelegateSpawnAccepted, spawnSubagentDirect } =
        createDeliveryDeps({ storePath });
      const entry = createQueuedEntry({
        sourceFlowId: "pc-flow-source",
        sourceExpectedRevision: 7,
      });

      await deliverQueuedPostCompactionDelegate({ entry }, deps);

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          continuationDelegateFlowId: "pc-flow-source",
        }),
        expect.objectContaining({
          agentSessionKey: "main",
        }),
      );
      expect(markPendingDelegateSpawnAccepted).toHaveBeenCalledWith(
        {
          flowId: "pc-flow-source",
          expectedRevision: 7,
          task: "queued delegate",
        },
        expect.stringMatching(/^agent:main:subagent:continuation-/),
      );
      expect(spawnSubagentDirect.mock.invocationCallOrder[0]).toBeLessThan(
        markPendingDelegateSpawnAccepted.mock.invocationCallOrder[0]!,
      );
      expect(markPendingDelegateSpawnAccepted.mock.invocationCallOrder[0]).toBeLessThan(
        enqueueSystemEvent.mock.invocationCallOrder[0]!,
      );
    });
  });

  it("keeps source-backed queued delivery retryable when accepted source-row commit fails", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-source-flow-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps, enqueueSystemEvent, markPendingDelegateSpawnAccepted, spawnSubagentDirect } =
        createDeliveryDeps({
          storePath,
        });
      markPendingDelegateSpawnAccepted.mockReturnValue(false);

      await expect(
        deliverQueuedPostCompactionDelegate(
          {
            entry: createQueuedEntry({
              sourceFlowId: "pc-flow-source",
              sourceExpectedRevision: 7,
              returnOptions: { artifacts: "required" },
            }),
          },
          deps,
        ),
      ).rejects.toThrow("post-compaction-source-accept-not-committed");

      expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(markPendingDelegateSpawnAccepted).toHaveBeenCalledWith(
        {
          flowId: "pc-flow-source",
          expectedRevision: 7,
          task: "queued delegate",
        },
        expect.stringMatching(/^agent:main:subagent:continuation-/),
      );
      expect(enqueueSystemEvent).not.toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        expect.anything(),
      );
    });
  });

  it("finalizes an already accepted source-backed retry before charging another chain hop", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-source-flow-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, {
        main: {
          sessionId: "session",
          updatedAt: Date.now(),
          continuationChainCount: 1,
        },
      });
      const childSessionKey = deriveTestContinuationChildSessionKey("main", "pc-flow-source");
      mockRegistryState.acceptedChildSessionKeys.add(childSessionKey);
      const {
        deps,
        enqueueSystemEvent,
        log,
        markPendingDelegateFailed,
        markPendingDelegateSpawnAccepted,
        spawnSubagentDirect,
      } = createDeliveryDeps({
        storePath,
        runtimeConfig: { maxChainLength: 1 },
      });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            sourceFlowId: "pc-flow-source",
            sourceExpectedRevision: 7,
            returnOptions: { artifacts: "required" },
          }),
        },
        deps,
      );

      expect(spawnSubagentDirect).not.toHaveBeenCalled();
      expect(markPendingDelegateFailed).not.toHaveBeenCalled();
      expect(markPendingDelegateSpawnAccepted).toHaveBeenCalledWith(
        {
          flowId: "pc-flow-source",
          expectedRevision: 7,
          task: "queued delegate",
        },
        childSessionKey,
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        { sessionKey: "main" },
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("post-compaction-source-accepted-recovered"),
      );
    });
  });

  it("fails source rows for forbidden delivery spawns but leaves transient spawn errors retryable", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-source-flow-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const forbidden = createDeliveryDeps({
        storePath,
        spawnStatus: "forbidden",
      });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            sourceFlowId: "pc-flow-source",
            sourceExpectedRevision: 7,
            returnOptions: { artifacts: "required" },
          }),
        },
        forbidden.deps,
      );

      expect(forbidden.markPendingDelegateFailed).toHaveBeenCalledWith(
        {
          flowId: "pc-flow-source",
          expectedRevision: 7,
          task: "queued delegate",
        },
        "Post-compaction delegate spawn forbidden: delegation was not accepted.",
        "Post-compaction delegate rejected",
      );
      expect(forbidden.markPendingDelegateSpawnAccepted).not.toHaveBeenCalled();
      expect(forbidden.markPendingDelegateFailed.mock.invocationCallOrder[0]).toBeLessThan(
        removeUnacceptedDelegateArtifactPolicyMock.mock.invocationCallOrder[0]!,
      );
      expect(removeUnacceptedDelegateArtifactPolicyMock).toHaveBeenCalledWith("pc-flow-source");
      removeUnacceptedDelegateArtifactPolicyMock.mockClear();

      const transient = createDeliveryDeps({
        storePath,
        spawnStatus: "error",
      });

      await expect(
        deliverQueuedPostCompactionDelegate(
          {
            entry: createQueuedEntry({
              sourceFlowId: "pc-flow-source",
              sourceExpectedRevision: 7,
              returnOptions: { artifacts: "required" },
            }),
          },
          transient.deps,
        ),
      ).rejects.toThrow("post-compaction delegate spawn error");

      expect(transient.markPendingDelegateFailed).not.toHaveBeenCalled();
      expect(transient.markPendingDelegateSpawnAccepted).not.toHaveBeenCalled();
      expect(removeUnacceptedDelegateArtifactPolicyMock).not.toHaveBeenCalled();

      const nonSourceForbidden = createDeliveryDeps({
        storePath,
        spawnStatus: "forbidden",
      });

      await expect(
        deliverQueuedPostCompactionDelegate(
          {
            entry: createQueuedEntry(),
          },
          nonSourceForbidden.deps,
        ),
      ).rejects.toThrow("post-compaction delegate spawn forbidden");

      expect(nonSourceForbidden.markPendingDelegateFailed).not.toHaveBeenCalled();
      expect(nonSourceForbidden.markPendingDelegateSpawnAccepted).not.toHaveBeenCalled();
    });
  });

  it("preserves traceparent when queued post-compaction replay spawns a child", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps, enqueueSystemEvent, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({ traceparent }),
        },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({ traceparent }),
        expect.any(Object),
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        { sessionKey: "main", traceparent },
      );
    });
  });

  it("does not trust an unmarked queued post-compaction traceparent", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      const attackerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps, enqueueSystemEvent, spawnSubagentDirect } = createDeliveryDeps({ storePath });
      const entry = createQueuedEntry();
      entry.traceparent = attackerTraceparent;

      await deliverQueuedPostCompactionDelegate({ entry }, deps);

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.not.objectContaining({ traceparent: attackerTraceparent }),
        expect.any(Object),
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation:compaction-delegate-spawned] Post-compaction shard dispatched: queued delegate",
        { sessionKey: "main" },
      );
    });
  });

  it("threads the delegate model override when queued post-compaction replay spawns a child", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({ model: "github-copilot/claude-sonnet-4.6" }),
        },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({ model: "github-copilot/claude-sonnet-4.6" }),
        expect.any(Object),
      );
    });
  });

  it("persists attachment input in the durable queue and forwards it on replay", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      const stateDir = path.join(tempDir, "state");
      const attachments = [{ name: "state.md", content: "durable compacted input" }];
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const deliveryId = await enqueuePostCompactionDelegateDeliveryQueue(
        {
          sessionKey: "main",
          delegate: {
            task: "queued delegate",
            createdAt: 1,
            attachments,
            attachAs: { mountPath: "handoff" },
          },
          sequence: 0,
        },
        stateDir,
      );
      const queued = expectDefined(
        await loadPendingSessionDelivery(deliveryId, stateDir),
        "queued delivery",
      );
      expect(queued).toMatchObject({
        kind: "postCompactionDelegate",
        attachments,
        attachAs: { mountPath: "handoff" },
      });
      const { deps, spawnSubagentDirect } = createDeliveryDeps({ storePath });

      await deliverQueuedPostCompactionDelegate(
        { entry: queued as QueuedPostCompactionDelegateDelivery },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments,
          attachMountPath: "handoff",
        }),
        expect.any(Object),
      );
    });
  });

  it("defers disabled queued delivery without mutating source state and delivers exactly once after re-enable", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      const stateDir = path.join(tempDir, "state");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const deliveryId = await enqueuePostCompactionDelegateDeliveryQueue(
        {
          sessionKey: "main",
          delegate: {
            task: "hold while continuation is disabled",
            createdAt: 1,
            attachments: [{ name: "state.md", content: "must not materialize while disabled" }],
          },
          sequence: 0,
        },
        stateDir,
      );
      const entry = expectDefined(
        await loadPendingSessionDelivery(deliveryId, stateDir),
        "queued disabled delivery",
      ) as QueuedPostCompactionDelegateDelivery;
      const disabled = createDeliveryDeps({ storePath, runtimeConfig: { enabled: false } });

      await expect(
        deliverQueuedPostCompactionDelegate({ entry }, disabled.deps),
      ).rejects.toBeInstanceOf(SessionDeliveryDeferredError);
      expect(disabled.loadSessionEntry).not.toHaveBeenCalled();
      expect(disabled.spawnSubagentDirect).not.toHaveBeenCalled();
      expect(disabled.markPendingDelegateSpawnAccepted).not.toHaveBeenCalled();
      expect(disabled.markPendingDelegateFailed).not.toHaveBeenCalled();
      expect(await loadPendingSessionDelivery(deliveryId, stateDir)).toBeTruthy();

      await drainPostCompactionDelegateDeliveriesDispatch({
        sessionKey: "main",
        stateDir,
        deliveryDeps: disabled.deps,
      });
      expect(disabled.spawnSubagentDirect).not.toHaveBeenCalled();
      expect(await loadPendingSessionDelivery(deliveryId, stateDir)).toBeTruthy();

      const enabled = createDeliveryDeps({ storePath, runtimeConfig: { enabled: true } });
      await drainPostCompactionDelegateDeliveriesDispatch({
        sessionKey: "main",
        stateDir,
        deliveryDeps: enabled.deps,
      });
      expect(enabled.spawnSubagentDirect).toHaveBeenCalledTimes(1);
      expect(await loadPendingSessionDelivery(deliveryId, stateDir)).toBeNull();

      await drainPostCompactionDelegateDeliveriesDispatch({
        sessionKey: "main",
        stateDir,
        deliveryDeps: enabled.deps,
      });
      expect(enabled.spawnSubagentDirect).toHaveBeenCalledTimes(1);
    });
  });

  it("charges chain count even when the spawn fails (cmt451: persist-then-spawn over-counts conservatively)", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: Date.now() } });
      const { deps } = createDeliveryDeps({
        storePath,
        spawnError: new Error("spawn unavailable"),
      });

      await expect(
        deliverQueuedPostCompactionDelegate(
          {
            entry: createQueuedEntry({
              sourceFlowId: "pc-flow-source",
              sourceExpectedRevision: 7,
              returnOptions: { artifacts: "optional" },
            }),
          },
          deps,
        ),
      ).rejects.toThrow("spawn unavailable");
      expect(removeUnacceptedDelegateArtifactPolicyMock).not.toHaveBeenCalled();

      // With persist-then-spawn (cmt451), the chain count is advanced BEFORE the
      // spawn. A spawn failure therefore leaves the count charged for a delegate
      // that did not start. This is the deliberate, SAFE direction: an over-count
      // only makes `maxChainLength` more protective (chain terminates earlier),
      // never overruns it. The alternative ordering (persist-after-spawn) would
      // avoid this over-count but re-introduce the duplicate-spawn bug on a
      // post-spawn persist failure.
      const stored = readSessionStore(storePath);
      expect(Object.values(stored).some((entry) => entry.continuationChainCount === 1)).toBe(true);
    });
  });

  it("rejects queued delivery when the compaction chain length is already capped", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, {
        main: { sessionId: "session", updatedAt: 1, continuationChainCount: 2 },
      });
      const { deps, enqueueSystemEvent, log, markPendingDelegateFailed, spawnSubagentDirect } =
        createDeliveryDeps({
          storePath,
          runtimeConfig: { maxChainLength: 2 },
        });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            sourceFlowId: "pc-flow-source",
            sourceExpectedRevision: 7,
          }),
        },
        deps,
      );

      expect(spawnSubagentDirect).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "Post-compaction delegate rejected: chain length 2 >= 2 for session main",
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation] Post-compaction delegate rejected: chain length 2 reached. Task: queued delegate",
        { sessionKey: "main" },
      );
      expect(markPendingDelegateFailed).toHaveBeenCalledWith(
        {
          flowId: "pc-flow-source",
          expectedRevision: 7,
          task: "queued delegate",
        },
        "Post-compaction delegate rejected: chain length 2 reached.",
        "Post-compaction delegate rejected",
      );
    });
  });

  it("rejects queued delivery when continuation tokens exceed the cost cap", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, {
        main: { sessionId: "session", updatedAt: 1, continuationChainTokens: 11 },
      });
      const { deps, enqueueSystemEvent, log, markPendingDelegateFailed, spawnSubagentDirect } =
        createDeliveryDeps({
          storePath,
          runtimeConfig: { costCapTokens: 10 },
        });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            sourceFlowId: "source-flow-cost",
            sourceExpectedRevision: 4,
          }),
        },
        deps,
      );

      expect(spawnSubagentDirect).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "Post-compaction delegate rejected: cost cap exceeded (11 > 10) for session main",
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation] Post-compaction delegate rejected: cost cap exceeded (11 > 10). Task: queued delegate",
        { sessionKey: "main" },
      );
      expect(markPendingDelegateFailed).toHaveBeenCalledWith(
        {
          flowId: "source-flow-cost",
          expectedRevision: 4,
          task: "queued delegate",
        },
        "Post-compaction delegate rejected: cost cap exceeded (11 > 10).",
        "Post-compaction delegate rejected",
      );
    });
  });

  it("rejects an enabled-at-stage cross-session queued delegate when disabled at delivery", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: 1 } });
      const { deps, enqueueSystemEvent, log, markPendingDelegateFailed, spawnSubagentDirect } =
        createDeliveryDeps({
          storePath,
          runtimeConfig: { crossSessionTargeting: "disabled" },
        });

      await deliverQueuedPostCompactionDelegate(
        {
          entry: createQueuedEntry({
            targetSessionKey: "other",
            traceparent: VALID_TRACEPARENT,
            sourceFlowId: "source-flow-cross-session",
            sourceExpectedRevision: 5,
          }),
        },
        deps,
      );

      expect(spawnSubagentDirect).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "Post-compaction delegate rejected: crossSessionTargeting=disabled at delivery time for session main",
      );
      expect(enqueueSystemEvent).toHaveBeenCalledWith(
        "[continuation] Post-compaction delegate rejected: cross-session targeting was disabled at delivery time. Task: queued delegate",
        { sessionKey: "main", traceparent: VALID_TRACEPARENT },
      );
      const stored = readSessionStore(storePath);
      expect(Object.values(stored).some((entry) => entry.continuationChainCount != null)).toBe(
        false,
      );
      expect(markPendingDelegateFailed).toHaveBeenCalledWith(
        {
          flowId: "source-flow-cross-session",
          expectedRevision: 5,
          task: "queued delegate",
        },
        "Post-compaction delegate rejected: cross-session targeting was disabled at delivery time.",
        "Post-compaction delegate rejected",
      );
    });
  });

  it("allows queued cross-session delivery when targeting is still enabled", async () => {
    await withTempDir({ prefix: "openclaw-post-compaction-delivery-" }, async (tempDir) => {
      const storePath = path.join(tempDir, "sessions.json");
      await seedSessionStore(storePath, { main: { sessionId: "session", updatedAt: 1 } });
      const { deps, spawnSubagentDirect } = createDeliveryDeps({
        storePath,
        runtimeConfig: { crossSessionTargeting: "enabled" },
      });

      await deliverQueuedPostCompactionDelegate(
        { entry: createQueuedEntry({ targetSessionKey: "other" }) },
        deps,
      );

      expect(spawnSubagentDirect).toHaveBeenCalledWith(
        expect.objectContaining({ continuationTargetSessionKey: "other" }),
        expect.any(Object),
      );
    });
  });
});
