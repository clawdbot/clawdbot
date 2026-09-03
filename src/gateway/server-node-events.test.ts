// Gateway node event tests protect how node clients surface inbound commands,
// delivery metadata, pairing state, and outbound payload lifecycle events.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getCurrentActiveNodeContext, setActiveNodeContext } from "../infra/active-node-context.js";
import {
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { NodeRegistry } from "./node-registry.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./server-methods/attachment-normalize.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import type { loadSessionEntry as loadSessionEntryType } from "./session-utils.js";

const buildSessionLookup = (
  sessionKey: string,
  entry: {
    agentHarnessId?: string;
    modelSelectionLocked?: boolean;
    sessionId?: string;
    model?: string;
    modelProvider?: string;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
    updatedAt?: number;
    label?: string;
    spawnedBy?: string;
    parentSessionKey?: string;
  } = {},
): ReturnType<typeof loadSessionEntryType> => ({
  cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
  agentId: "main",
  storePath: "/tmp/sessions.json",
  store: {} as ReturnType<typeof loadSessionEntryType>["store"],
  entry: {
    agentHarnessId: entry.agentHarnessId,
    modelSelectionLocked: entry.modelSelectionLocked,
    sessionId: entry.sessionId ?? `sid-${sessionKey}`,
    updatedAt: entry.updatedAt ?? Date.now(),
    model: entry.model,
    modelProvider: entry.modelProvider,
    delivery: normalizeLegacySessionEntryDelivery({
      ...entry,
      sessionId: entry.sessionId ?? `sid-${sessionKey}`,
      updatedAt: entry.updatedAt ?? Date.now(),
    } as SessionEntry).delivery,
    label: entry.label,
    spawnedBy: entry.spawnedBy,
    parentSessionKey: entry.parentSessionKey,
  },
  canonicalKey: sessionKey,
  storeKeys: [sessionKey],
  legacyKey: undefined,
});

const ingressAgentCommandMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const registerApnsRegistrationMock = vi.hoisted(() => vi.fn());
const loadOrCreateProcessDeviceIdentityMock = vi.hoisted(() =>
  vi.fn(() => ({
    deviceId: "gateway-device-1",
    publicKeyPem: "public",
    privateKeyPem: "private",
  })),
);
const parseMessageWithAttachmentsMock = vi.hoisted(() => vi.fn());
const persistInboundImagesForTranscriptMock = vi.hoisted(() => vi.fn());
const normalizeChannelIdMock = vi.hoisted(() =>
  vi.fn((channel?: string | null) => channel ?? null),
);
const updatePairedDevicePresenceMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

const runtimeMocks = vi.hoisted(() => ({
  agentCommandFromIngress: ingressAgentCommandMock,
  ApnsRegistrationPairingChangedError: class ApnsRegistrationPairingChangedError extends Error {
    constructor() {
      super("node pairing changed before APNs registration");
      this.name = "ApnsRegistrationPairingChangedError";
    }
  },
  deleteMediaBuffer: vi.fn(async () => {}),
  deliverOutboundPayloads: vi.fn(async () => {}),
  enqueueSystemEvent: vi.fn(),
  formatForLog: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  getRuntimeConfig: vi.fn(() => ({ session: { mainKey: "agent:main:main" } })),
  INLINE_IMAGE_DURABLE_OMISSION_MARKER:
    "[image attachment omitted: durable managed media claim unavailable]",
  loadOrCreateProcessDeviceIdentity: loadOrCreateProcessDeviceIdentityMock,
  loadSessionEntry: vi.fn((sessionKey: string) => buildSessionLookup(sessionKey)),
  upsertSessionEntryCore: vi.fn(),
  normalizeChannelId: normalizeChannelIdMock,
  normalizeMainKey: vi.fn((key?: string | null) => key?.trim() || "agent:main:main"),
  parseMessageWithAttachments: parseMessageWithAttachmentsMock,
  registerApnsRegistration: registerApnsRegistrationMock,
  requestHeartbeat: vi.fn(),
  resolveSystemMainSessionTarget: vi.fn(() => ({
    agentId: "ops",
    sessionKey: "agent:ops:main",
  })),
  resolveChatAttachmentMaxBytes: vi.fn(() => 20 * 1024 * 1024),
  resolveGatewayModelSupportsImages: vi.fn(
    async ({
      loadGatewayModelCatalog,
      provider,
      model,
    }: {
      loadGatewayModelCatalog: () => Promise<
        Array<{ id: string; provider: string; input?: string[] }>
      >;
      provider?: string;
      model?: string;
    }) => {
      if (!model) {
        return true;
      }
      const catalog = await loadGatewayModelCatalog();
      const modelEntry = catalog.find(
        (entry) => entry.id === model && (!provider || entry.provider === provider),
      );
      return modelEntry ? (modelEntry.input?.includes("image") ?? false) : true;
    },
  ),
  sendDurableMessageBatch: vi.fn(
    async (): Promise<DurableMessageBatchSendResult> => ({
      status: "sent",
      results: [],
      receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
    }),
  ),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(
    (_cfg: OpenClawConfig, entry?: { model?: string; modelProvider?: string }) => ({
      provider: entry?.modelProvider ?? "test-provider",
      model: entry?.model ?? "default-model",
    }),
  ),
  persistInboundImagesForTranscript: persistInboundImagesForTranscriptMock,
  scopedHeartbeatWakeOptions: vi.fn((sessionKey?: string, opts?: { reason: string }) => {
    const wakeOptions = { reason: opts?.reason };
    return /^agent:[^:]+:.+$/i.test(sessionKey ?? "")
      ? { ...wakeOptions, sessionKey: sessionKey as string }
      : wakeOptions;
  }),
}));

import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "./health/types.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent as handleNodeEventWithDependencies } from "./server-node-events.js";

type ServerNodeEventDependencies = NonNullable<
  Parameters<typeof handleNodeEventWithDependencies>[4]
>;

const serverNodeEventDependencies: ServerNodeEventDependencies = {
  ...runtimeMocks,
  buildOutboundSessionContext,
  createOutboundSendDeps,
  defaultRuntime,
  normalizeRpcAttachmentsToChatAttachments,
  resolveOutboundTarget,
  withSystemEventOwner,
  sendDurableMessageBatchCore: runtimeMocks.sendDurableMessageBatch,
  updatePairedDevicePresence: updatePairedDevicePresenceMock,
};

const sentDurableMessageBatchResult: Extract<DurableMessageBatchSendResult, { status: "sent" }> = {
  status: "sent",
  results: [],
  receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
};

function handleNodeEvent(
  ctx: NodeEventContext,
  nodeId: string,
  event: NodeEvent,
  options?: Parameters<typeof handleNodeEventWithDependencies>[3],
) {
  return handleNodeEventWithDependencies(ctx, nodeId, event, options, serverNodeEventDependencies);
}

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const enqueueSystemEventMock = runtimeMocks.enqueueSystemEvent;
const requestHeartbeatMock = runtimeMocks.requestHeartbeat;
const loadConfigMock = runtimeMocks.getRuntimeConfig;
const agentCommandMock = runtimeMocks.agentCommandFromIngress;
const upsertSessionEntryMock = runtimeMocks.upsertSessionEntryCore;
const loadSessionEntryMock = runtimeMocks.loadSessionEntry;
const registerApnsRegistrationVi = runtimeMocks.registerApnsRegistration;
const normalizeChannelIdVi = runtimeMocks.normalizeChannelId;
const sendDurableMessageBatchMock = runtimeMocks.sendDurableMessageBatch;

beforeEach(() => {
  resetGatewayWorkAdmission();
  enqueueSystemEventMock.mockReset().mockReturnValue(true);
  requestHeartbeatMock.mockClear();
});

afterEach(() => {
  resetGatewayWorkAdmission();
});

async function runAdmittedNodeEvent(
  ctx: NodeEventContext,
  nodeId: string,
  event: Parameters<typeof handleNodeEvent>[2],
): Promise<void> {
  const admission = tryBeginGatewayRootWorkAdmission();
  expect(admission).not.toBeNull();
  try {
    await admission?.run(async () => {
      await handleNodeEvent(ctx, nodeId, event);
    });
  } finally {
    admission?.release();
  }
}

function expectSuspendBusyWithRootWork(requestId: string): void {
  expect(
    prepareGatewaySuspend({
      requestId,
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
    }),
  ).toMatchObject({
    status: "busy",
    blockers: expect.arrayContaining([expect.objectContaining({ kind: "root-request", count: 1 })]),
  });
}

function expectSuspendReady(requestId: string): void {
  const result = prepareGatewaySuspend({
    requestId,
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
  });
  expect(result).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  if (result.status === "ready") {
    expect(resumeGatewaySuspend(result.suspensionId)).toMatchObject({
      ok: true,
      status: "running",
      resumed: true,
    });
  }
}

const execEventHeartbeatOptions = (sessionKey?: string) => ({
  source: "exec-event",
  intent: "event",
  reason: "exec-event",
  coalesceMs: 0,
  ...(sessionKey ? { sessionKey } : {}),
});

function buildCtx(
  opts: { authorizeNodeSystemRunEvent?: NodeEventContext["authorizeNodeSystemRunEvent"] } = {},
): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    authorizeNodeSystemRunEvent: opts.authorizeNodeSystemRunEvent ?? (() => false),
    logGateway: { warn: () => {} },
  };
}

function buildExecCtx() {
  return buildCtx({ authorizeNodeSystemRunEvent: () => true });
}

function makeNodeClient(connId: string, nodeId: string): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      readyState: WebSocket.OPEN,
      send: () => {},
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "node-host",
        version: "1.0.0",
        platform: "linux",
        mode: "node",
      },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    } as GatewayWsClient["connect"],
  };
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
}

function expectPresencePersistCall(
  mock: ReturnType<typeof vi.fn>,
  deviceId: string,
  reason: string,
): void {
  expect(mock).toHaveBeenCalledTimes(1);
  const [actualDeviceId, metadata, generation] = mockCall(mock) ?? [];
  expect(actualDeviceId).toBe(deviceId);
  expectFields(metadata, { lastSeenReason: reason });
  expect(generation).toEqual({ nodeId: deviceId, key: `${deviceId}-generation` });
  const lastSeenAtMs = (metadata as { lastSeenAtMs?: unknown } | undefined)?.lastSeenAtMs;
  expect(typeof lastSeenAtMs).toBe("number");
}

function presenceConnection(deviceId: string, generation = `${deviceId}-generation`) {
  return {
    deviceId,
    pairingGeneration: { nodeId: deviceId, key: generation },
  };
}

describe("node exec events", () => {
  beforeEach(() => {
    registerApnsRegistrationVi.mockClear();
    loadOrCreateProcessDeviceIdentityMock.mockClear();
    normalizeChannelIdVi.mockClear();
    persistInboundImagesForTranscriptMock.mockReset();
    persistInboundImagesForTranscriptMock.mockResolvedValue({ entries: [], omission: "none" });
    normalizeChannelIdVi.mockImplementation((channel?: string | null) => channel ?? null);
    updatePairedDevicePresenceMock.mockClear();
    updatePairedDevicePresenceMock.mockResolvedValue(true);
  });

  it("enqueues exec.started events", async () => {
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-1", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:main:main",
        runId: "run-1",
        command: "ls -la",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec started (node=node-1 id=run-1): ls -la",
      {
        sessionKey: "agent:main:main",
        contextKey: "exec:run-1",
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(execEventHeartbeatOptions("agent:main:main"));
  });

  it("rejects exec lifecycle events without a pending node run", async () => {
    const ctx = buildCtx();
    const result = await handleNodeEvent(
      ctx,
      "node-1",
      {
        event: "exec.finished",
        payloadJSON: JSON.stringify({
          sessionKey: "agent:main:main",
          runId: "forged-run",
          exitCode: 0,
          output: "done",
        }),
      },
      { connId: "conn-1" },
    );

    expect(result).toEqual({
      ok: true,
      event: "exec.finished",
      handled: false,
      reason: "unmatched_exec_event",
    });
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves exec authorization and terminal consumption with suppressNotifyOnExit=%s",
    async (suppressNotifyOnExit) => {
      const registry = new NodeRegistry();
      const connection = { connId: "conn-1" };
      const runId = `run-seq-suppress-${suppressNotifyOnExit}`;
      const sessionKey = "agent:main:main";
      const eventRouting = { sessionKey, contextKey: `exec:${runId}` };
      const startedPayload = { runId, sessionKey, command: "printf ok" };
      const finishedPayload = {
        ...startedPayload,
        exitCode: 0,
        timedOut: false,
        output: "done",
        suppressNotifyOnExit,
      };
      const finishedEvent = {
        event: "exec.finished",
        payloadJSON: JSON.stringify(finishedPayload),
      };
      const unmatchedEvent = {
        ok: true,
        event: "exec.finished",
        handled: false,
        reason: "unmatched_exec_event",
      };
      const ctx = buildCtx({
        authorizeNodeSystemRunEvent: (params) => registry.authorizeSystemRunEvent(params),
      });
      registry.register(makeNodeClient(connection.connId, "node-1"), {
        pairingIdentity: "identity-a",
      });
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "system.run",
        params: { runId, sessionKey },
        timeoutMs: 0,
      });
      try {
        await expect(
          handleNodeEvent(ctx, "node-1", finishedEvent, { connId: "wrong-conn" }),
        ).resolves.toEqual(unmatchedEvent);
        await expect(
          handleNodeEvent(
            ctx,
            "node-1",
            { event: "exec.started", payloadJSON: JSON.stringify(startedPayload) },
            connection,
          ),
        ).resolves.toBeUndefined();

        expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
        expect(enqueueSystemEventMock).toHaveBeenNthCalledWith(
          1,
          `Exec started (node=node-1 id=${runId}): printf ok`,
          eventRouting,
        );
        expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
        expect(requestHeartbeatMock).toHaveBeenNthCalledWith(
          1,
          execEventHeartbeatOptions(sessionKey),
        );

        await expect(
          handleNodeEvent(ctx, "node-1", finishedEvent, connection),
        ).resolves.toBeUndefined();
        if (!suppressNotifyOnExit) {
          expect(enqueueSystemEventMock).toHaveBeenNthCalledWith(
            2,
            `Exec finished (node=node-1 id=${runId}, code 0)\ndone`,
            eventRouting,
          );
          expect(requestHeartbeatMock).toHaveBeenNthCalledWith(
            2,
            execEventHeartbeatOptions(sessionKey),
          );
        }
        // Remove suppression on replay so filtering cannot hide unconsumed authorization.
        await expect(
          handleNodeEvent(
            ctx,
            "node-1",
            {
              event: "exec.finished",
              payloadJSON: JSON.stringify({ ...finishedPayload, suppressNotifyOnExit: false }),
            },
            connection,
          ),
        ).resolves.toEqual(unmatchedEvent);
        const notificationCount = suppressNotifyOnExit ? 1 : 2;
        expect(enqueueSystemEventMock).toHaveBeenCalledTimes(notificationCount);
        expect(requestHeartbeatMock).toHaveBeenCalledTimes(notificationCount);
      } finally {
        registry.unregister(connection.connId);
        await invoke;
      }
    },
  );

  it("enqueues exec.finished events with output", async () => {
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-finished",
        exitCode: 0,
        timedOut: false,
        output: "done",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-finished, code 0)\ndone",
      {
        sessionKey: "node-node-2",
        contextKey: "exec:run-finished",
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(execEventHeartbeatOptions());
  });

  it("accepts legacy exec.finished events when authorization matches without runId", async () => {
    const authorizeNodeSystemRunEvent = vi.fn(() => true);
    const ctx = buildCtx({ authorizeNodeSystemRunEvent });
    await handleNodeEvent(
      ctx,
      "node-2",
      {
        event: "exec.finished",
        payloadJSON: JSON.stringify({
          sessionKey: "agent:main:main",
          exitCode: 0,
          timedOut: false,
          output: "done",
        }),
      },
      { connId: "conn-1" },
    );

    expect(authorizeNodeSystemRunEvent).toHaveBeenCalledWith({
      nodeId: "node-2",
      connId: "conn-1",
      sessionKey: "agent:main:main",
      terminal: true,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2, code 0)\ndone",
      {
        sessionKey: "agent:main:main",
        contextKey: "exec",
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(execEventHeartbeatOptions("agent:main:main"));
  });

  it("dedupes duplicate exec.finished events for the same runId on the same session", async () => {
    const ctx = buildExecCtx();
    const payloadJSON = JSON.stringify({
      sessionKey: "agent:main:main",
      runId: "run-dup-finished",
      exitCode: 0,
      timedOut: false,
      output: "done",
    });

    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON,
    });
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON,
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-dup-finished, code 0)\ndone",
      {
        sessionKey: "agent:main:main",
        contextKey: "exec:run-dup-finished",
      },
    );
  });

  it("canonicalizes exec session key before enqueue and wake", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup("node-node-2"),
      canonicalKey: "agent:main:node-node-2",
    });
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-2",
        exitCode: 0,
        timedOut: false,
        output: "done",
      }),
    });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("node-node-2");
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Exec finished (node=node-2 id=run-2, code 0)\ndone",
      {
        sessionKey: "agent:main:node-node-2",
        contextKey: "exec:run-2",
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith(
      execEventHeartbeatOptions("agent:main:node-node-2"),
    );
  });

  it("suppresses noisy exec.finished success events with empty output", async () => {
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-quiet",
        exitCode: 0,
        timedOut: false,
        output: "   ",
      }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("truncates long exec.finished output in system events", async () => {
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-long",
        exitCode: 0,
        timedOut: false,
        output: "x".repeat(600),
      }),
    });

    const [text] = expectDefined(
      enqueueSystemEventMock.mock.calls[0],
      "(enqueueSystemEventMock.mock.calls)[0] test invariant",
    );
    expect(typeof text).toBe("string");
    expect(text.startsWith("Exec finished (node=node-2 id=run-long, code 0)\n")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThan(280);
    expect(requestHeartbeatMock).toHaveBeenCalledWith(execEventHeartbeatOptions());
  });

  it("does not split surrogate pairs when truncating exec.finished output", async () => {
    // 178 ASCII chars + emoji (🫠 = 2 UTF-16 code units at pos 178-179) = 180+ total.
    // safe = 179 → old slice(0,179) would land on a lone high surrogate at pos 178.
    const emoji = "🫠";
    const padded = "A".repeat(178) + emoji + "tail";
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-surrogate",
        exitCode: 0,
        timedOut: false,
        output: padded,
      }),
    });

    const [text] = expectDefined(
      enqueueSystemEventMock.mock.calls[0],
      "(enqueueSystemEventMock.mock.calls)[0] test invariant",
    );
    // Must not contain a lone high surrogate (U+D800–U+DBFF).
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text.endsWith("…")).toBe(true);
  });

  it("does not enqueue or wake agent work for exec.denied events", async () => {
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-3", {
      event: "exec.denied",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:demo:main",
        runId: "run-3",
        command: "rm -rf /",
        reason: "allowlist-miss",
      }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses exec.started when notifyOnExit is false", async () => {
    loadConfigMock.mockReturnValueOnce({
      session: { mainKey: "agent:main:main" },
      tools: { exec: { notifyOnExit: false } },
    } as {
      session: { mainKey: string };
      tools: { exec: { notifyOnExit: boolean } };
    });
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-1", {
      event: "exec.started",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:main:main",
        runId: "run-silent-1",
        command: "ls -la",
      }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses exec.finished when notifyOnExit is false", async () => {
    loadConfigMock.mockReturnValueOnce({
      session: { mainKey: "agent:main:main" },
      tools: { exec: { notifyOnExit: false } },
    } as {
      session: { mainKey: string };
      tools: { exec: { notifyOnExit: boolean } };
    });
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-2", {
      event: "exec.finished",
      payloadJSON: JSON.stringify({
        runId: "run-silent-2",
        exitCode: 0,
        timedOut: false,
        output: "some output",
      }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("suppresses exec.denied when notifyOnExit is false", async () => {
    loadConfigMock.mockReturnValueOnce({
      session: { mainKey: "agent:main:main" },
      tools: { exec: { notifyOnExit: false } },
    } as {
      session: { mainKey: string };
      tools: { exec: { notifyOnExit: boolean } };
    });
    const ctx = buildExecCtx();
    await handleNodeEvent(ctx, "node-3", {
      event: "exec.denied",
      payloadJSON: JSON.stringify({
        sessionKey: "agent:demo:main",
        runId: "run-silent-3",
        command: "rm -rf /",
        reason: "allowlist-miss",
      }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("stores direct APNs registrations from node events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-direct",
      {
        event: "push.apns.register",
        payloadJSON: JSON.stringify({
          token: "abcd1234abcd1234abcd1234abcd1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
        }),
      },
      { resolveApnsRegistrationGeneration: () => "generation-node-direct" },
    );

    expect(registerApnsRegistrationVi).toHaveBeenCalledWith({
      nodeId: "node-direct",
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      expectedPairingGeneration: "generation-node-direct",
    });
  });

  it("stores relay APNs registrations from node events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-relay",
      {
        event: "push.apns.register",
        payloadJSON: JSON.stringify({
          transport: "relay",
          relayHandle: "relay-handle-123",
          sendGrant: "send-grant-123",
          gatewayDeviceId: "gateway-device-1",
          installationId: "install-123",
          topic: "ai.openclaw.ios",
          environment: "production",
          distribution: "official",
          tokenDebugSuffix: "abcd1234",
        }),
      },
      { resolveApnsRegistrationGeneration: () => "generation-node-relay" },
    );

    expect(registerApnsRegistrationVi).toHaveBeenCalledWith({
      nodeId: "node-relay",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "production",
      distribution: "official",
      tokenDebugSuffix: "abcd1234",
      expectedPairingGeneration: "generation-node-relay",
    });
  });

  it("stores sandbox relay APNs registrations from node events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "node-relay-sandbox",
      {
        event: "push.apns.register",
        payloadJSON: JSON.stringify({
          transport: "relay",
          relayHandle: "relay-handle-123",
          sendGrant: "send-grant-123",
          gatewayDeviceId: "gateway-device-1",
          installationId: "install-123",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          distribution: "official",
          tokenDebugSuffix: "abcd1234",
        }),
      },
      { resolveApnsRegistrationGeneration: () => "generation-node-relay-sandbox" },
    );

    expect(registerApnsRegistrationVi).toHaveBeenCalledWith({
      nodeId: "node-relay-sandbox",
      transport: "relay",
      relayHandle: "relay-handle-123",
      sendGrant: "send-grant-123",
      installationId: "install-123",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      distribution: "official",
      tokenDebugSuffix: "abcd1234",
      expectedPairingGeneration: "generation-node-relay-sandbox",
    });
  });

  it("rejects relay registrations bound to a different gateway identity", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-relay", {
      event: "push.apns.register",
      payloadJSON: JSON.stringify({
        transport: "relay",
        relayHandle: "relay-handle-123",
        sendGrant: "send-grant-123",
        gatewayDeviceId: "gateway-device-other",
        installationId: "install-123",
        topic: "ai.openclaw.ios",
        environment: "production",
        distribution: "official",
      }),
    });

    expect(registerApnsRegistrationVi).not.toHaveBeenCalled();
  });

  it("rejects APNs registration after the source pairing session is invalidated", async () => {
    const warn = vi.fn();
    const ctx: NodeEventContext = { ...buildCtx(), logGateway: { warn } };
    const result = await handleNodeEvent(
      ctx,
      "node-invalidated-register",
      {
        event: "push.apns.register",
        payloadJSON: JSON.stringify({
          token: "abcd1234abcd1234abcd1234abcd1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
        }),
      },
      { resolveApnsRegistrationGeneration: async () => null },
    );

    expect(result).toEqual({
      ok: true,
      event: "push.apns.register",
      handled: false,
      reason: "pairing_changed",
    });
    expect(registerApnsRegistrationVi).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "push apns register rejected node=node-invalidated-register: stale or invalidated pairing session",
    );
  });

  it("returns pairing changed when APNs registration loses ownership in its transaction", async () => {
    registerApnsRegistrationVi.mockRejectedValueOnce(
      new runtimeMocks.ApnsRegistrationPairingChangedError(),
    );
    const result = await handleNodeEvent(
      buildCtx(),
      "node-transaction-invalidated-register",
      {
        event: "push.apns.register",
        payloadJSON: JSON.stringify({
          token: "abcd1234abcd1234abcd1234abcd1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
        }),
      },
      { resolveApnsRegistrationGeneration: async () => "generation-before-transaction" },
    );

    expect(result).toEqual({
      ok: true,
      event: "push.apns.register",
      handled: false,
      reason: "pairing_changed",
    });
  });
});

describe("voice transcript events", () => {
  beforeEach(() => {
    agentCommandMock.mockClear();
    upsertSessionEntryMock.mockClear();
    loadSessionEntryMock.mockClear();
    loadSessionEntryMock.mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
    runtimeMocks.resolveSystemMainSessionTarget.mockClear();
    agentCommandMock.mockResolvedValue({ status: "ok" } as never);
    upsertSessionEntryMock.mockImplementation(async (_scope, patch) => patch);
  });

  it("dedupes repeated transcript agent dispatches for the same session", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;

    const payload = {
      text: "hello from mic",
      sessionKey: "voice-dedupe-session",
    };

    await handleNodeEvent(ctx, "node-v1", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify(payload),
    });
    await handleNodeEvent(ctx, "node-v1", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify(payload),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
  });

  it("persists only the accepted replay session ID when identical new-session events race", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    }));
    let persistedEntry: { sessionId?: string } | undefined;
    upsertSessionEntryMock.mockImplementation(async (_scope, patch) => {
      persistedEntry = patch;
      return patch;
    });
    const detachedChecksStarted = createDeferred();
    const detachedAdmission = createDeferred<boolean>();
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      if (checkCount <= 2) {
        return true;
      }
      if (checkCount === 4) {
        detachedChecksStarted.resolve();
      }
      return detachedAdmission.promise;
    });
    const payload = {
      text: "one command for a new session",
      sessionKey: "voice-new-session-replay-race",
    };

    const firstReplay = handleNodeEvent(
      ctx,
      "node-new-session-replay",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify(payload),
      },
      { isConnectionCurrent },
    );
    const duplicateReplay = handleNodeEvent(
      ctx,
      "node-new-session-replay",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify(payload),
      },
      { isConnectionCurrent },
    );
    await Promise.all([firstReplay, duplicateReplay]);
    await detachedChecksStarted.promise;
    detachedAdmission.resolve(true);
    await waitForFast(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));

    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    const dispatched = mockCallArg(agentCommandMock) as { sessionId?: unknown };
    expect(persistedEntry?.sessionId).toBe(dispatched.sessionId);
  });

  it("uses receipt time when delayed identical transcript admissions finish together", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const detachedChecksStarted = createDeferred();
    const detachedAdmission = createDeferred<boolean>();
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      if (checkCount === 1 || checkCount === 3) {
        return true;
      }
      if (checkCount === 4) {
        detachedChecksStarted.resolve();
      }
      return detachedAdmission.promise;
    });
    const payload = {
      text: "repeat after the replay window",
      sessionKey: "voice-delayed-admission-window",
    };

    try {
      await handleNodeEvent(
        ctx,
        "node-delayed-admission",
        {
          event: "voice.transcript",
          payloadJSON: JSON.stringify(payload),
        },
        { isConnectionCurrent },
      );
      now = 3_000;
      await handleNodeEvent(
        ctx,
        "node-delayed-admission",
        {
          event: "voice.transcript",
          payloadJSON: JSON.stringify(payload),
        },
        { isConnectionCurrent },
      );
      await detachedChecksStarted.promise;
      now = 10_000;
      detachedAdmission.resolve(true);
      await waitForFast(() => expect(agentCommandMock).toHaveBeenCalledTimes(2));

      expect(addChatRun).toHaveBeenCalledTimes(2);
      expect(upsertSessionEntryMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("allows a current replay after rejecting the same transcript from a stale connection", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    const detachedChecksStarted = createDeferred();
    const staleAdmission = createDeferred<boolean>();
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      if (checkCount === 1) {
        return true;
      }
      if (checkCount === 2) {
        detachedChecksStarted.resolve();
      }
      return staleAdmission.promise;
    });
    const payload = {
      text: "replay after reconnect",
      sessionKey: "voice-stale-replay-session",
    };

    await handleNodeEvent(
      ctx,
      "node-stale-voice",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify(payload),
      },
      { isConnectionCurrent },
    );
    await detachedChecksStarted.promise;
    await handleNodeEvent(
      ctx,
      "node-current-voice",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify(payload),
      },
      { isConnectionCurrent: () => true },
    );

    expect(addChatRun).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();

    staleAdmission.resolve(false);
    await waitForFast(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(addChatRun).toHaveBeenCalledTimes(1);
    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
  });

  it("rechecks a queued replay after an earlier stale reservation is released", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    const staleCheckStarted = createDeferred();
    const staleAdmission = createDeferred<boolean>();
    let staleCheckCount = 0;
    const isStaleConnectionCurrent = vi.fn(() => {
      staleCheckCount += 1;
      if (staleCheckCount === 1) {
        return true;
      }
      staleCheckStarted.resolve();
      return staleAdmission.promise;
    });
    let replayCurrent = true;
    const isReplayConnectionCurrent = vi.fn(() => replayCurrent);
    const payload = {
      text: "invalidate while queued",
      sessionKey: "voice-queued-replay-currentness",
    };

    await handleNodeEvent(
      ctx,
      "node-stale-queued-voice",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify(payload),
      },
      { isConnectionCurrent: isStaleConnectionCurrent },
    );
    await staleCheckStarted.promise;
    await handleNodeEvent(
      ctx,
      "node-replay-invalidated-while-queued",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify(payload),
      },
      { isConnectionCurrent: isReplayConnectionCurrent },
    );
    await waitForFast(() => expect(isReplayConnectionCurrent).toHaveBeenCalledTimes(2));

    replayCurrent = false;
    staleAdmission.resolve(false);
    await waitForFast(() => expect(isReplayConnectionCurrent).toHaveBeenCalledTimes(3));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(addChatRun).not.toHaveBeenCalled();
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("skips the detached session-store touch after voice admission loses ownership", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;
    let checkCount = 0;
    const isConnectionCurrent = vi.fn(() => {
      checkCount += 1;
      return checkCount <= 3;
    });

    await handleNodeEvent(
      ctx,
      "node-stale-after-voice-admission",
      {
        event: "voice.transcript",
        payloadJSON: JSON.stringify({
          text: "do not persist stale voice ownership",
          sessionKey: "voice-detached-store-currentness",
        }),
      },
      { isConnectionCurrent },
    );
    await waitForFast(() => expect(isConnectionCurrent).toHaveBeenCalledTimes(4));
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
  });

  it("rejects a missing harness-owned session before touching the store", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-voice";
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    });
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;

    await handleNodeEvent(ctx, "node-harness-voice-missing", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({ text: "do not create this", sessionKey }),
    });
    await Promise.resolve();

    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(addChatRun).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("dispatches voice transcripts to an existing harness-owned session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:existing-voice";
    loadSessionEntryMock.mockReturnValueOnce(
      buildSessionLookup(sessionKey, {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    );

    await handleNodeEvent(buildCtx(), "node-harness-voice-existing", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({ text: "continue supervised work", sessionKey }),
    });
    await Promise.resolve();

    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expectFields(mockCallArg(agentCommandMock), { sessionKey });
  });

  it.each([
    ["wrong owner", { agentHarnessId: "other", modelSelectionLocked: true }],
    ["missing session id", { agentHarnessId: "codex", modelSelectionLocked: true, sessionId: "" }],
  ] as const)(
    "rejects a harness-owned voice session with %s before side effects",
    async (_label, entry) => {
      const sessionKey = `agent:main:harness:codex:supervision:invalid-voice-${_label.replaceAll(" ", "-")}`;
      loadSessionEntryMock.mockReturnValueOnce(buildSessionLookup(sessionKey, entry));
      const addChatRun = vi.fn();
      const ctx = buildCtx();
      ctx.addChatRun = addChatRun;

      await handleNodeEvent(ctx, "node-harness-voice-invalid", {
        event: "voice.transcript",
        payloadJSON: JSON.stringify({ text: "do not dispatch this", sessionKey }),
      });
      await Promise.resolve();

      expect(upsertSessionEntryMock).not.toHaveBeenCalled();
      expect(addChatRun).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("does not dedupe identical text when source event IDs differ", async () => {
    const ctx = buildCtx();

    await handleNodeEvent(ctx, "node-v1", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({
        text: "hello from mic",
        sessionKey: "voice-dedupe-eventid-session",
        eventId: "evt-voice-1",
      }),
    });
    await handleNodeEvent(ctx, "node-v1", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({
        text: "hello from mic",
        sessionKey: "voice-dedupe-eventid-session",
        eventId: "evt-voice-2",
      }),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(2);
  });

  it("forwards transcript with voice provenance", async () => {
    const addChatRun = vi.fn();
    const ctx = buildCtx();
    ctx.addChatRun = addChatRun;

    await handleNodeEvent(ctx, "node-v2", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({
        text: "check provenance",
        sessionKey: "voice-provenance-session",
      }),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = mockCallArg(agentCommandMock);
    expectFields(opts, {
      message: "check provenance",
      deliver: false,
      messageChannel: "node",
    });
    const optsRecord = opts as Record<string, unknown>;
    expectFields(optsRecord.inputProvenance, {
      kind: "external_user",
      sourceChannel: "voice",
      sourceTool: "gateway.voice.transcript",
    });
    expect(typeof optsRecord.runId).toBe("string");
    expect(optsRecord.runId).not.toBe(optsRecord.sessionId);
    expect(addChatRun).toHaveBeenCalledTimes(1);
    const [runId, runMetadata] = mockCall(addChatRun) ?? [];
    expect(runId).toBe(optsRecord.runId);
    const clientRunId = (runMetadata as { clientRunId?: unknown } | undefined)?.clientRunId;
    expect(clientRunId).toBe(runId);
  });

  it("does not block agent dispatch when session-store touch fails", async () => {
    const warn = vi.fn();
    const ctx = buildCtx();
    ctx.logGateway = { warn };
    upsertSessionEntryMock.mockRejectedValueOnce(new Error("disk down"));

    await handleNodeEvent(ctx, "node-v3", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({
        text: "continue anyway",
        sessionKey: "voice-store-fail-session",
      }),
    });
    await Promise.resolve();

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    await waitForFast(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(mockCallArg(warn))).toContain("voice session-store update failed");
  });

  it("keeps an accepted detached session-store touch visible to suspension", async () => {
    const touch = createDeferred();
    upsertSessionEntryMock.mockImplementationOnce(() => touch.promise);

    await runAdmittedNodeEvent(buildCtx(), "node-v-suspend", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({
        text: "persist before suspension",
        sessionKey: "voice-suspend-session",
      }),
    });

    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
    expectSuspendBusyWithRootWork("voice-touch-busy");
    touch.resolve();
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expectSuspendReady("voice-touch-ready");
  });

  it("preserves existing session metadata when touching the store for voice transcripts", async () => {
    const ctx = buildCtx();
    loadSessionEntryMock.mockImplementation((sessionKey: string) =>
      buildSessionLookup(sessionKey, {
        sessionId: "sess-preserve",
        updatedAt: 10,
        label: "existing label",
        spawnedBy: "agent:main:parent",
        parentSessionKey: "agent:main:parent",
        lastChannel: "discord",
        lastTo: "thread-1",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      }),
    );

    let updatedEntry: Record<string, unknown> | undefined;
    upsertSessionEntryMock.mockImplementationOnce(async (_scope, patch) => {
      const existing = {
        sessionId: "sess-preserve",
        updatedAt: 10,
        label: "existing label",
        spawnedBy: "agent:main:parent",
        parentSessionKey: "agent:main:parent",
        lastChannel: "discord",
        lastTo: "thread-1",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      };
      updatedEntry = {
        ...existing,
        ...patch,
      };
      return updatedEntry;
    });

    await handleNodeEvent(ctx, "node-v4", {
      event: "voice.transcript",
      payloadJSON: JSON.stringify({
        text: "preserve metadata",
        sessionKey: "voice-preserve-session",
      }),
    });
    await Promise.resolve();

    expectFields(updatedEntry, {
      sessionId: "sess-preserve",
      label: "existing label",
      spawnedBy: "agent:main:parent",
      parentSessionKey: "agent:main:parent",
      lastChannel: "discord",
      lastTo: "thread-1",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    });
  });
});

describe("notifications changed events", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockClear();
    normalizeChannelIdVi.mockClear();
    normalizeChannelIdVi.mockImplementation((channel?: string | null) => channel ?? null);
    loadSessionEntryMock.mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  });

  it("enqueues notifications.changed posted events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-n1", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({
        change: "posted",
        key: "notif-1",
        packageName: "com.example.chat",
        title: "Message",
        text: "Ping from Alex",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Notification posted (node=node-n1 key=notif-1 package=com.example.chat): Message - Ping from Alex",
      expect.objectContaining({
        sessionKey: "agent:ops:main",
        contextKey: "notification:notif-1",
      }),
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "event",
      reason: "notifications-event",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
  });

  it("enqueues notifications.changed removed events", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-n2", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({
        change: "removed",
        key: "notif-2",
        packageName: "com.example.mail",
      }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Notification removed (node=node-n2 key=notif-2 package=com.example.mail)",
      expect.objectContaining({
        sessionKey: "agent:ops:main",
        contextKey: "notification:notif-2",
      }),
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "event",
      reason: "notifications-event",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
  });

  it("records non-delivery when a targetless notification has no system owner", async () => {
    const warn = vi.fn();
    runtimeMocks.resolveSystemMainSessionTarget.mockImplementationOnce(() => {
      throw new Error("Set agents.defaults.systemAgent.agentId");
    });

    await handleNodeEvent({ ...buildCtx(), logGateway: { warn } }, "node-unowned", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({ change: "posted", key: "notif-unowned" }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "notification event not delivered node=node-unowned: Set agents.defaults.systemAgent.agentId",
    );
  });

  it("wakes heartbeat on payload sessionKey when provided", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-n4", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({
        change: "posted",
        key: "notif-4",
        sessionKey: "agent:main:main",
      }),
    });

    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "event",
      reason: "notifications-event",
      sessionKey: "agent:main:main",
    });
  });

  it("canonicalizes notifications session key before enqueue and wake", async () => {
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup("node-node-n5"),
      canonicalKey: "agent:main:node-node-n5",
    });
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-n5", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({
        change: "posted",
        key: "notif-5",
        sessionKey: "node-node-n5",
      }),
    });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("node-node-n5");
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "Notification posted (node=node-n5 key=notif-5)",
      {
        sessionKey: "agent:main:node-node-n5",
        contextKey: "notification:notif-5",
      },
    );
    expect(requestHeartbeatMock).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "event",
      reason: "notifications-event",
      sessionKey: "agent:main:node-node-n5",
    });
  });

  it("rejects missing reserved notification contexts before enqueue", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-notification";
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    });

    await handleNodeEvent(buildCtx(), "node-harness-missing", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({ change: "posted", key: "notif", sessionKey }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("preserves valid durable harness notification contexts", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:existing-notification";
    loadSessionEntryMock.mockReturnValueOnce(
      buildSessionLookup(sessionKey, {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    );

    await handleNodeEvent(buildCtx(), "node-harness-existing", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({ change: "posted", key: "notif", sessionKey }),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledOnce();
    expect(requestHeartbeatMock).toHaveBeenCalledWith(expect.objectContaining({ sessionKey }));
  });

  it("ignores notifications.changed payloads missing required fields", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(ctx, "node-n3", {
      event: "notifications.changed",
      payloadJSON: JSON.stringify({
        change: "posted",
      }),
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });

  it("does not wake heartbeat when notifications.changed event is deduped", async () => {
    enqueueSystemEventMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const ctx = buildCtx();
    const payload = JSON.stringify({
      change: "posted",
      key: "notif-dupe",
      packageName: "com.example.chat",
      title: "Message",
      text: "Ping from Alex",
    });

    await handleNodeEvent(ctx, "node-n6", {
      event: "notifications.changed",
      payloadJSON: payload,
    });
    await handleNodeEvent(ctx, "node-n6", {
      event: "notifications.changed",
      payloadJSON: payload,
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(2);
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(1);
  });
});

describe("agent request events", () => {
  beforeEach(() => {
    agentCommandMock.mockClear();
    parseMessageWithAttachmentsMock.mockReset();
    runtimeMocks.resolveSessionAgentId.mockClear();
    runtimeMocks.resolveSessionModelRef.mockClear();
    runtimeMocks.resolveGatewayModelSupportsImages.mockClear();
    persistInboundImagesForTranscriptMock.mockReset();
    persistInboundImagesForTranscriptMock.mockResolvedValue({ entries: [], omission: "none" });
    runtimeMocks.deleteMediaBuffer.mockClear();
    upsertSessionEntryMock.mockClear();
    loadSessionEntryMock.mockClear();
    normalizeChannelIdVi.mockClear();
    normalizeChannelIdVi.mockImplementation((channel?: string | null) => channel ?? null);
    sendDurableMessageBatchMock.mockReset();
    sendDurableMessageBatchMock.mockResolvedValue(sentDurableMessageBatchResult);
    parseMessageWithAttachmentsMock.mockResolvedValue({
      message: "parsed message",
      images: [],
      imageOrder: [],
      offloadedRefs: [],
    });
    agentCommandMock.mockResolvedValue({ status: "ok" } as never);
    upsertSessionEntryMock.mockImplementation(async (_scope, patch) => patch);
    loadSessionEntryMock.mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  });

  it("rejects a missing harness-owned session before touching the store", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:missing-request";
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup(sessionKey),
      entry: undefined,
    });

    await handleNodeEvent(buildCtx(), "node-harness-request-missing", {
      event: "agent.request",
      payloadJSON: JSON.stringify({ message: "do not create this", sessionKey }),
    });

    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("dispatches agent requests to an existing harness-owned session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:existing-request";
    loadSessionEntryMock.mockReturnValueOnce(
      buildSessionLookup(sessionKey, {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    );

    await handleNodeEvent(buildCtx(), "node-harness-request-existing", {
      event: "agent.request",
      payloadJSON: JSON.stringify({ message: "continue supervised work", sessionKey }),
    });

    expect(upsertSessionEntryMock).toHaveBeenCalledTimes(1);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expectFields(mockCallArg(agentCommandMock), { sessionKey });
  });

  it("keeps an accepted detached agent dispatch visible to suspension", async () => {
    const dispatch = createDeferred<never>();
    agentCommandMock.mockImplementationOnce(() => dispatch.promise);

    await runAdmittedNodeEvent(buildCtx(), "node-agent-suspend", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "finish before suspension",
        sessionKey: "agent:main:suspend-agent",
      }),
    });

    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
    expectSuspendBusyWithRootWork("agent-dispatch-busy");
    dispatch.resolve(undefined as never);
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expectSuspendReady("agent-dispatch-ready");
  });

  it("keeps an accepted detached receipt delivery visible to suspension", async () => {
    const receipt = createDeferred<DurableMessageBatchSendResult>();
    sendDurableMessageBatchMock.mockImplementationOnce(() => receipt.promise);

    await runAdmittedNodeEvent(buildCtx(), "node-receipt-suspend", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "acknowledge before suspension",
        sessionKey: "agent:main:suspend-receipt",
        deliver: true,
        receipt: true,
        channel: "telegram",
        to: "123",
      }),
    });

    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(1));
    expectSuspendBusyWithRootWork("receipt-delivery-busy");
    receipt.resolve(sentDurableMessageBatchResult);
    await waitForFast(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expectSuspendReady("receipt-delivery-ready");
  });

  it("does not launch agent work when pairing changes during model lookup", async () => {
    const modelCatalog =
      createDeferred<Awaited<ReturnType<NodeEventContext["loadGatewayModelCatalog"]>>>();
    const ctx = buildCtx();
    ctx.loadGatewayModelCatalog = vi.fn(() => modelCatalog.promise);
    let connectionCurrent = true;
    const isConnectionCurrent = vi.fn(async () => connectionCurrent);

    const request = handleNodeEvent(
      ctx,
      "node-revoked-during-model-lookup",
      {
        event: "agent.request",
        payloadJSON: JSON.stringify({
          message: "describe this image",
          sessionKey: "agent:main:revoked-during-model-lookup",
          attachments: [{ type: "image", mimeType: "image/png", content: "AAAA" }],
          deliver: true,
          receipt: true,
          channel: "telegram",
          to: "123",
        }),
      },
      { isConnectionCurrent },
    );

    await waitForFast(() => expect(ctx.loadGatewayModelCatalog).toHaveBeenCalledTimes(1));
    connectionCurrent = false;
    modelCatalog.resolve([]);

    await expect(request).resolves.toEqual({
      ok: true,
      event: "agent.request",
      handled: false,
      reason: "pairing_changed",
    });
    expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
    expect(upsertSessionEntryMock).not.toHaveBeenCalled();
    expect(sendDurableMessageBatchMock).not.toHaveBeenCalled();
    expect(persistInboundImagesForTranscriptMock).not.toHaveBeenCalled();
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it("cleans persisted transcript media when detached agent admission is revoked", async () => {
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
      entries: [
        {
          id: "saved-after-admission",
          path: "/media/inbound/saved-after-admission.png",
          sourceIndex: 0,
          imageKind: "inline",
          fact: { url: "media://inbound/saved-after-admission.png", contentType: "image/png" },
        },
      ],
      omission: "none",
    });
    let currentnessChecks = 0;
    const isConnectionCurrent = vi.fn(async () => {
      currentnessChecks += 1;
      return currentnessChecks < 6;
    });

    await handleNodeEvent(
      buildCtx(),
      "node-revoked-before-detached-start",
      {
        event: "agent.request",
        payloadJSON: JSON.stringify({
          message: "do not retain this media",
          sessionKey: "agent:main:revoked-before-detached-start",
        }),
      },
      { isConnectionCurrent },
    );

    await waitForFast(() => {
      expect(runtimeMocks.deleteMediaBuffer).toHaveBeenCalledWith("saved-after-admission");
    });
    expect(agentCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong owner", { agentHarnessId: "other", modelSelectionLocked: true }],
    ["missing session id", { agentHarnessId: "codex", modelSelectionLocked: true, sessionId: "" }],
  ] as const)(
    "rejects a harness-owned agent request with %s before side effects",
    async (_label, entry) => {
      const sessionKey = `agent:main:harness:codex:supervision:invalid-request-${_label.replaceAll(" ", "-")}`;
      loadSessionEntryMock.mockReturnValueOnce(buildSessionLookup(sessionKey, entry));

      await handleNodeEvent(buildCtx(), "node-harness-request-invalid", {
        event: "agent.request",
        payloadJSON: JSON.stringify({
          message: "do not dispatch this",
          sessionKey,
          attachments: [{ type: "image", mimeType: "image/png", content: "aGVsbG8=" }],
        }),
      });

      expect(runtimeMocks.resolveSessionAgentId).not.toHaveBeenCalled();
      expect(runtimeMocks.resolveSessionModelRef).not.toHaveBeenCalled();
      expect(runtimeMocks.resolveGatewayModelSupportsImages).not.toHaveBeenCalled();
      expect(parseMessageWithAttachmentsMock).not.toHaveBeenCalled();
      expect(upsertSessionEntryMock).not.toHaveBeenCalled();
      expect(persistInboundImagesForTranscriptMock).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
    },
  );

  it("disables delivery when route is unresolved instead of falling back globally", async () => {
    const warn = vi.fn();
    const ctx = buildCtx();
    ctx.logGateway = { warn };

    await handleNodeEvent(ctx, "node-route-miss", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "summarize this",
        sessionKey: "agent:main:main",
        deliver: true,
      }),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = mockCallArg(agentCommandMock);
    expectFields(opts, {
      message: "summarize this",
      sessionKey: "agent:main:main",
      deliver: false,
      channel: undefined,
      to: undefined,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(mockCallArg(warn))).toContain("agent delivery disabled node=node-route-miss");
  });

  it("reuses the current session route when delivery target is omitted", async () => {
    const ctx = buildCtx();
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup("agent:main:main", {
        sessionId: "sid-current",
        lastChannel: "telegram",
        lastTo: "123",
      }),
      canonicalKey: "agent:main:main",
    });

    await handleNodeEvent(ctx, "node-route-hit", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "route on session",
        sessionKey: "agent:main:main",
        deliver: true,
      }),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = mockCallArg(agentCommandMock);
    expectFields(opts, {
      message: "route on session",
      sessionKey: "agent:main:main",
      deliver: true,
      channel: "telegram",
      to: "123",
    });
    const optsRecord = opts as Record<string, unknown>;
    expect(optsRecord.runId).toBe(optsRecord.sessionId);
  });

  it("preserves session-scoped routing across two distinct agent.request turns", async () => {
    loadSessionEntryMock.mockReturnValue(
      buildSessionLookup("agent:main:node-repeat", { sessionId: "node-session-1" }),
    );

    for (const message of ["first turn", "second turn"]) {
      await handleNodeEvent(buildCtx(), "node-repeat", {
        event: "agent.request",
        payloadJSON: JSON.stringify({ message, sessionKey: "agent:main:node-repeat" }),
      });
    }

    expect(agentCommandMock).toHaveBeenCalledTimes(2);
    const calls = agentCommandMock.mock.calls.map(([opts]) => opts as Record<string, unknown>);
    expect(calls.map((opts) => opts.message)).toEqual(["first turn", "second turn"]);
    expect(calls.map((opts) => opts.runId)).toEqual(["node-session-1", "node-session-1"]);
    expect(calls.map((opts) => opts.sessionId)).toEqual(["node-session-1", "node-session-1"]);
  });

  it("passes supportsInlineImages false for text-only node-session models", async () => {
    const ctx = buildCtx();
    ctx.loadGatewayModelCatalog = async () => [
      {
        id: "text-only",
        name: "Text only",
        provider: "test-provider",
        input: ["text"],
      },
    ];
    loadSessionEntryMock.mockReturnValueOnce({
      ...buildSessionLookup("agent:main:main", {
        model: "text-only",
        modelProvider: "test-provider",
      }),
      canonicalKey: "agent:main:main",
    });

    await handleNodeEvent(ctx, "node-text-only", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "describe",
        sessionKey: "agent:main:main",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: "AAAA",
          },
        ],
      }),
    });

    expect(parseMessageWithAttachmentsMock).toHaveBeenCalledTimes(1);
    const parseCall = mockCall(parseMessageWithAttachmentsMock);
    expect(parseCall?.[0]).toBe("describe");
    expect(Array.isArray(parseCall?.[1])).toBe(true);
    expectFields(parseCall?.[2], { supportsInlineImages: false });
  });

  it("passes ordered durable media metadata to the agent transcript recorder", async () => {
    parseMessageWithAttachmentsMock.mockResolvedValueOnce({
      message: "describe\n[media attached: media://inbound/offloaded]",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 1 }],
      imageOrder: ["offloaded", "inline"],
      offloadedRefs: [
        {
          mediaRef: "media://inbound/offloaded",
          id: "offloaded",
          path: "/media/inbound/offloaded.png",
          kind: "image",
          mimeType: "image/png",
          label: "offloaded.png",
          sizeBytes: 2_100_000,
          sourceIndex: 0,
        },
      ],
    });
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
      entries: [
        {
          id: "offloaded",
          path: "/media/inbound/offloaded.png",
          sourceIndex: 0,
          imageKind: "offloaded",
          fact: { url: "media://inbound/offloaded", contentType: "image/png" },
        },
        {
          id: "saved-inline",
          path: "/media/inbound/saved-inline.jpg",
          sourceIndex: 1,
          imageKind: "inline",
          fact: { url: "media://inbound/saved-inline", contentType: "image/jpeg" },
        },
      ],
      omission: "none",
    });

    await handleNodeEvent(buildCtx(), "node-media", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "describe",
        sessionKey: "agent:main:main",
        attachments: [{ type: "image", mimeType: "image/png", content: "AAAA" }],
      }),
    });

    expect(persistInboundImagesForTranscriptMock).toHaveBeenCalledOnce();
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expectFields(mockCallArg(agentCommandMock), {
      message: "describe\n[media attached: media://inbound/offloaded]",
      transcriptMessage: "describe",
      transcriptMedia: [
        { url: "media://inbound/offloaded", contentType: "image/png" },
        { url: "media://inbound/saved-inline", contentType: "image/jpeg" },
      ],
    });
  });

  it("records a visible durable omission when inline image persistence fails", async () => {
    parseMessageWithAttachmentsMock.mockResolvedValueOnce({
      message: "describe",
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/jpeg", sourceIndex: 0 }],
      imageOrder: ["inline"],
      offloadedRefs: [],
    });
    persistInboundImagesForTranscriptMock.mockResolvedValueOnce({
      entries: [],
      omission: "inline-image-save-failed",
    });

    await handleNodeEvent(buildCtx(), "node-media-omission", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "describe",
        sessionKey: "agent:main:main",
        attachments: [{ type: "image", mimeType: "image/jpeg", content: "AAAA" }],
      }),
    });

    expectFields(mockCallArg(agentCommandMock), {
      message: "describe",
      transcriptMessage:
        "describe\n[image attachment omitted: durable managed media claim unavailable]",
    });
  });

  it("declines non-image attachments cleanly when parse throws UnsupportedAttachmentError", async () => {
    const warn = vi.fn();
    const ctx = buildCtx();
    ctx.logGateway = { warn };

    parseMessageWithAttachmentsMock.mockRejectedValueOnce(
      Object.assign(new Error("attachment a.pdf: non-image attachments not supported"), {
        name: "UnsupportedAttachmentError",
        reason: "unsupported-non-image",
      }),
    );

    await handleNodeEvent(ctx, "node-non-image-refusal", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "read this",
        sessionKey: "agent:main:main",
        attachments: [
          {
            type: "file",
            mimeType: "application/pdf",
            fileName: "a.pdf",
            content: "JVBERi0=",
          },
        ],
      }),
    });

    // server-node-events must log-and-return on parse failure — no agent
    // dispatch, no crash, and the refusal reason bubbles up via logGateway.
    expect(agentCommandMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "agent.request attachment parse failed: attachment a.pdf: non-image attachments not supported",
    );
  });

  beforeEach(() => {
    updatePairedDevicePresenceMock.mockClear();
    updatePairedDevicePresenceMock.mockResolvedValue(true);
  });

  it("persists authenticated node presence alive events", async () => {
    const ctx = buildCtx();
    const result = await handleNodeEvent(
      ctx,
      "ios-presence-persist",
      {
        event: "node.presence.alive",
        payloadJSON: JSON.stringify({ trigger: "bg_app_refresh", sentAtMs: 123 }),
      },
      presenceConnection("ios-presence-persist"),
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: true,
      reason: "persisted",
    });
    expectPresencePersistCall(
      updatePairedDevicePresenceMock,
      "ios-presence-persist",
      "bg_app_refresh",
    );
  });

  it("rejects node presence alive events without authenticated device identity", async () => {
    const ctx = buildCtx();
    const result = await handleNodeEvent(ctx, "ios-presence-missing-identity", {
      event: "node.presence.alive",
      payloadJSON: JSON.stringify({ trigger: "silent_push" }),
    });

    expect(result).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: false,
      reason: "missing_device_identity",
    });
    expect(updatePairedDevicePresenceMock).not.toHaveBeenCalled();
  });

  it("rejects node presence alive events without the authenticated pairing generation", async () => {
    const result = await handleNodeEvent(
      buildCtx(),
      "ios-presence-missing-generation",
      {
        event: "node.presence.alive",
        payloadJSON: JSON.stringify({ trigger: "silent_push" }),
      },
      { deviceId: "ios-presence-missing-generation" },
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: false,
      reason: "pairing_changed",
    });
    expect(updatePairedDevicePresenceMock).not.toHaveBeenCalled();
  });

  it("does not throttle stale node presence alive generations", async () => {
    updatePairedDevicePresenceMock.mockResolvedValue(false);
    const ctx = buildCtx();
    const result = await handleNodeEvent(
      ctx,
      "ios-presence-unpaired",
      {
        event: "node.presence.alive",
        payloadJSON: JSON.stringify({ trigger: "silent_push" }),
      },
      presenceConnection("ios-presence-unpaired"),
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: false,
      reason: "pairing_changed",
    });

    updatePairedDevicePresenceMock.mockClear();
    updatePairedDevicePresenceMock.mockResolvedValue(true);
    const retry = await handleNodeEvent(
      ctx,
      "ios-presence-unpaired",
      {
        event: "node.presence.alive",
        payloadJSON: JSON.stringify({ trigger: "silent_push" }),
      },
      presenceConnection("ios-presence-unpaired"),
    );
    expect(retry).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: true,
      reason: "persisted",
    });
    expect(updatePairedDevicePresenceMock).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated node presence alive persistence per device", async () => {
    const ctx = buildCtx();
    const event = {
      event: "node.presence.alive" as const,
      payloadJSON: JSON.stringify({ trigger: "silent_push" }),
    };
    const connection = presenceConnection("ios-presence-throttle");

    await handleNodeEvent(ctx, "ios-presence-throttle", event, connection);
    const result = await handleNodeEvent(ctx, "ios-presence-throttle", event, connection);

    expect(result).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: true,
      reason: "throttled",
    });
    expect(updatePairedDevicePresenceMock).toHaveBeenCalledTimes(1);
  });

  it("does not throttle the first presence update from a replacement generation", async () => {
    const ctx = buildCtx();
    const event = {
      event: "node.presence.alive" as const,
      payloadJSON: JSON.stringify({ trigger: "silent_push" }),
    };

    await handleNodeEvent(
      ctx,
      "ios-presence-replacement",
      event,
      presenceConnection("ios-presence-replacement", "generation-a"),
    );
    const result = await handleNodeEvent(
      ctx,
      "ios-presence-replacement",
      event,
      presenceConnection("ios-presence-replacement", "generation-b"),
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.alive",
      handled: true,
      reason: "persisted",
    });
    expect(updatePairedDevicePresenceMock).toHaveBeenCalledTimes(2);
  });

  it("stores host stats on the current connection without Accessibility or prompt changes", async () => {
    const registry = new NodeRegistry();
    const client = makeNodeClient("stats-connection", "stats-node");
    const session = registry.register(client, { pairingIdentity: "stats-identity" });
    const broadcast = vi.fn();
    const ctx: NodeEventContext = {
      ...buildCtx(),
      broadcast,
      updateNodeHostStats: (params) => registry.updateHostStats(params),
    };
    const stats = {
      cpuCount: 8,
      loadAverage: [1.5, 1, 0.5],
      memoryTotalBytes: 8192,
      memoryFreeBytes: 4096,
      diskTotalBytes: 32768,
      diskAvailableBytes: 16384,
    };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100_000);
    setActiveNodeContext({ nodeId: "active-computer" });
    try {
      await expect(
        handleNodeEvent(
          ctx,
          session.nodeId,
          { event: "node.host.stats", payloadJSON: JSON.stringify(stats) },
          { connId: client.connId, presenceAllowed: false },
        ),
      ).resolves.toEqual({
        ok: true,
        event: "node.host.stats",
        handled: true,
        reason: "updated",
      });
      expect(session.hostStats).toEqual({ ...stats, updatedAtMs: 100_000 });
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(
        "node.hostStats",
        { nodeId: session.nodeId, hostStats: { ...stats, updatedAtMs: 100_000 } },
        { dropIfSlow: true },
      );
      expect(getCurrentActiveNodeContext()).toEqual({ nodeId: "active-computer" });
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(updatePairedDevicePresenceMock).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      setActiveNodeContext(null);
      registry.unregister(client.connId);
    }
  });

  it.each(["stale", "missing", "unknown", "invalidated"] as const)(
    "rejects host stats from a %s connection without replacing the live snapshot",
    async (connection) => {
      const registry = new NodeRegistry();
      const client = makeNodeClient("stats-connection", "stats-node");
      const session = registry.register(client, { pairingIdentity: "stats-identity" });
      const stats = { cpuCount: 4, memoryTotalBytes: 8192, memoryFreeBytes: 4096 };
      registry.updateHostStats({
        nodeId: session.nodeId,
        connId: client.connId,
        stats,
        observedAtMs: 100,
      });
      if (connection === "invalidated") {
        registry.invalidateConnectionForPairingChange(client.connId);
      }
      const broadcast = vi.fn();
      const ctx: NodeEventContext = {
        ...buildCtx(),
        broadcast,
        updateNodeHostStats: (params) => registry.updateHostStats(params),
      };
      try {
        await expect(
          handleNodeEvent(
            ctx,
            connection === "unknown" ? "unknown-node" : session.nodeId,
            {
              event: "node.host.stats",
              payloadJSON: JSON.stringify({ ...stats, memoryFreeBytes: 1024 }),
            },
            {
              connId:
                connection === "missing"
                  ? undefined
                  : connection === "stale"
                    ? "retired-connection"
                    : client.connId,
            },
          ),
        ).resolves.toEqual({
          ok: true,
          event: "node.host.stats",
          handled: false,
          reason: "stale_connection",
        });
        expect(session.hostStats).toEqual({ ...stats, updatedAtMs: 100 });
        expect(broadcast).not.toHaveBeenCalled();
      } finally {
        registry.unregister(client.connId);
      }
    },
  );

  it.each(["not json", "null", "[]", '{"cpuCount":4}'])(
    "rejects malformed host stats: %s",
    async (payloadJSON) => {
      const updateNodeHostStats = vi.fn();
      const broadcast = vi.fn();
      await expect(
        handleNodeEvent(
          { ...buildCtx(), updateNodeHostStats, broadcast },
          "stats-node",
          { event: "node.host.stats", payloadJSON },
          { connId: "stats-connection" },
        ),
      ).resolves.toEqual({
        ok: true,
        event: "node.host.stats",
        handled: false,
        reason: "invalid_payload",
      });
      expect(updateNodeHostStats).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it("updates authenticated accessibility-backed node activity without a system event", async () => {
    const broadcast = vi.fn();
    const updateNodePresenceActivity = vi.fn(() => ({
      lastActiveAtMs: 90_000,
      presenceUpdatedAtMs: 100_000,
    }));
    const ctx: NodeEventContext = {
      ...buildCtx(),
      broadcast,
      updateNodePresenceActivity,
    };
    const result = await handleNodeEvent(
      ctx,
      "mac-node",
      {
        event: "node.presence.activity",
        payloadJSON: JSON.stringify({ idleSeconds: 10 }),
      },
      { connId: "conn-1", deviceId: "mac-node", presenceAllowed: true },
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.activity",
      handled: true,
      reason: "updated",
    });
    expect(updateNodePresenceActivity).toHaveBeenCalledWith({
      nodeId: "mac-node",
      connId: "conn-1",
      idleSeconds: 10,
    });
    expect(broadcast).toHaveBeenCalledWith(
      "node.presence",
      {
        nodeId: "mac-node",
        lastActiveAtMs: 90_000,
        presenceUpdatedAtMs: 100_000,
      },
      { dropIfSlow: true },
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("rejects node activity without the advertised accessibility permission", async () => {
    const updateNodePresenceActivity = vi.fn();
    const ctx: NodeEventContext = { ...buildCtx(), updateNodePresenceActivity };
    const result = await handleNodeEvent(
      ctx,
      "mac-node",
      {
        event: "node.presence.activity",
        payloadJSON: JSON.stringify({ idleSeconds: 0 }),
      },
      { connId: "conn-1", deviceId: "mac-node", presenceAllowed: false },
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.activity",
      handled: false,
      reason: "permission_required",
    });
    expect(updateNodePresenceActivity).not.toHaveBeenCalled();
  });

  it("clears authenticated node activity without requiring Accessibility", async () => {
    const broadcast = vi.fn();
    const clearNodePresenceActivity = vi.fn(() => true);
    const ctx: NodeEventContext = {
      ...buildCtx(),
      broadcast,
      clearNodePresenceActivity,
    };
    const result = await handleNodeEvent(
      ctx,
      "mac-node",
      {
        event: "node.presence.activity",
        payloadJSON: JSON.stringify({ action: "clear" }),
      },
      { connId: "conn-1", deviceId: "mac-node", presenceAllowed: false },
    );

    expect(result).toEqual({
      ok: true,
      event: "node.presence.activity",
      handled: true,
      reason: "cleared",
    });
    expect(clearNodePresenceActivity).toHaveBeenCalledWith({
      nodeId: "mac-node",
      connId: "conn-1",
    });
    expect(broadcast).toHaveBeenCalledWith(
      "node.presence",
      { nodeId: "mac-node", lastActiveAtMs: null, presenceUpdatedAtMs: null },
      { dropIfSlow: true },
    );
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("normalizes unknown node presence alive triggers before persistence", async () => {
    const ctx = buildCtx();
    await handleNodeEvent(
      ctx,
      "ios-presence-normalize",
      {
        event: "node.presence.alive",
        payloadJSON: JSON.stringify({ trigger: "x".repeat(4096) }),
      },
      presenceConnection("ios-presence-normalize"),
    );

    expectPresencePersistCall(
      updatePairedDevicePresenceMock,
      "ios-presence-normalize",
      "background",
    );
  });
});

describe("chat subscribe/unsubscribe events", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockClear();
    loadSessionEntryMock.mockImplementation((sessionKey: string) => buildSessionLookup(sessionKey));
  });

  it("canonicalizes the session key for chat.subscribe", async () => {
    const nodeSubscribe = vi.fn();
    const ctx = { ...buildCtx(), nodeSubscribe };

    // parseSessionKeyFromPayloadJSON trims whitespace; canonicalization
    // may further normalize (e.g. lowercasing, agent-key resolution).
    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      ...buildSessionLookup(sessionKey),
      canonicalKey: `agent:main:${sessionKey.toLowerCase()}`,
    }));

    await handleNodeEvent(
      ctx,
      "node-c1",
      {
        event: "chat.subscribe",
        payloadJSON: JSON.stringify({ sessionKey: "  Main  " }),
      },
      { connId: "node-c1-connection" },
    );

    // The canonicalized key (not the parsed raw key) must be passed to
    // nodeSubscribe. On unfixed main, nodeSubscribe receives the parsed
    // key ("Main"), causing a mismatch with delivery which uses the
    // canonical form ("agent:main:main").
    expect(nodeSubscribe).toHaveBeenCalledWith("node-c1", "agent:main:main", "node-c1-connection");
    // loadSessionEntry is called with the parsed (trimmed) key from the payload.
    expect(loadSessionEntryMock).toHaveBeenCalledWith("Main");
  });

  it("canonicalizes the session key for chat.unsubscribe", async () => {
    const nodeUnsubscribe = vi.fn();
    const ctx = { ...buildCtx(), nodeUnsubscribe };

    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      ...buildSessionLookup(sessionKey),
      canonicalKey: `agent:other:${sessionKey.toLowerCase()}`,
    }));

    await handleNodeEvent(
      ctx,
      "node-c2",
      {
        event: "chat.unsubscribe",
        payloadJSON: JSON.stringify({ sessionKey: "\tOtherAgent " }),
      },
      { connId: "node-c2-connection" },
    );

    // parseSessionKeyFromPayloadJSON trims "\tOtherAgent " to "OtherAgent".
    // The fix canonicalizes it to the canonical key.
    expect(nodeUnsubscribe).toHaveBeenCalledWith(
      "node-c2",
      "agent:other:otheragent",
      "node-c2-connection",
    );
    expect(loadSessionEntryMock).toHaveBeenCalledWith("OtherAgent");
  });

  it("skips the event when the payload is missing a session key", async () => {
    const nodeSubscribe = vi.fn();
    const ctx = { ...buildCtx(), nodeSubscribe };

    await handleNodeEvent(ctx, "node-c3", {
      event: "chat.subscribe",
      payloadJSON: JSON.stringify({ other: 1 }),
    });

    expect(nodeSubscribe).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
