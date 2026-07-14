import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createOperatorApprovalSessionEventRuntime } from "./operator-approval-session-events.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { GatewayClient } from "./server-methods/types.js";

const SOURCE_SESSION_KEY = "agent:main:child";
const PARENT_SESSION_KEY = "agent:main:parent";
const SIBLING_SESSION_KEY = "agent:main:parent:sibling";
const tempDirs: string[] = [];
type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-events-"));
  tempDirs.push(stateDir);
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createClient(params: {
  connId: string;
  scopes: string[];
  deviceId?: string;
  invalidated?: boolean;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: "approval-session-events", displayName: "Approval Session Events" },
      scopes: params.scopes,
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.invalidated ? { invalidated: true } : {}),
  } as unknown as GatewayClient;
}

function createPendingRecord(
  params: {
    id?: string;
    audienceSessionKeys?: string[];
    sourceSessionKey?: string | null;
    reviewerDeviceIds?: string[];
    createdAtMs?: number;
    expiresAtMs?: number;
  } = {},
): OperatorApprovalRecord {
  const id = params.id ?? "approval:child/request?1";
  const createdAtMs = params.createdAtMs ?? 1_000;
  return {
    id,
    resolutionRef: buildApprovalResolutionRef({ approvalId: id, approvalKind: "exec" }),
    kind: "exec",
    status: "pending",
    presentation: {
      kind: "exec",
      commandText: "printf session-approval",
      commandPreview: "printf session-approval",
      warningText: "Review this command",
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: {
      deviceId: "requester-device",
      clientId: "requester-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: params.reviewerDeviceIds ?? ["reviewer-device"],
    source: {
      agentId: "main",
      sessionKey: params.sourceSessionKey ?? SOURCE_SESSION_KEY,
      sessionId: "private-session-id",
      runId: "private-run-id",
      toolCallId: "private-tool-call-id",
      toolName: "exec",
    },
    audienceSessionKeys: params.audienceSessionKeys ?? [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
    runtimeEpoch: "private-runtime-epoch",
    createdAtMs,
    expiresAtMs: params.expiresAtMs ?? 10_000,
    updatedAtMs: createdAtMs,
    decision: null,
    terminalReason: null,
    resolvedAtMs: null,
    resolver: null,
    consumedAtMs: null,
    consumedBy: null,
  };
}

function createTerminalRecord(
  pending: OperatorApprovalRecord,
  resolvedAtMs = 2_000,
): OperatorApprovalRecord {
  return {
    ...pending,
    status: "denied",
    updatedAtMs: resolvedAtMs,
    decision: "deny",
    terminalReason: "user",
    resolvedAtMs,
    resolver: { kind: "device", id: "reviewer-device" },
  };
}

function createRuntime(params: {
  clients: GatewayClient[];
  databaseOptions?: OpenClawStateDatabaseOptions;
  now?: () => number;
  controlUiBasePath?: string;
  reconcileTerminal?: Parameters<
    typeof createOperatorApprovalSessionEventRuntime
  >[0]["reconcileTerminal"];
}) {
  const subscribers = createSessionMessageSubscriberRegistry();
  const broadcastToConnIds = vi.fn<GatewayBroadcastToConnIdsFn>();
  const runtime = createOperatorApprovalSessionEventRuntime({
    clients: params.clients,
    sessionMessageSubscribers: subscribers,
    broadcastToConnIds,
    databaseOptions: params.databaseOptions,
    controlUiBasePath: params.controlUiBasePath,
    now: params.now,
    reconcileTerminal: params.reconcileTerminal,
  });
  return { broadcastToConnIds, runtime, subscribers };
}

function insertPendingApproval(params: {
  databaseOptions: OpenClawStateDatabaseOptions;
  id: string;
  audienceSessionKeys: string[];
  createdAtMs: number;
  expiresAtMs: number;
  reviewerDeviceIds?: string[];
}): OperatorApprovalRecord {
  const record = createPendingRecord(params);
  const approval: NewOperatorApproval = {
    id: record.id,
    kind: record.kind,
    presentation: record.presentation,
    requester: record.requester,
    reviewerDeviceIds: params.reviewerDeviceIds ?? record.reviewerDeviceIds,
    source: record.source,
    audienceSessionKeys: record.audienceSessionKeys,
    runtimeEpoch: record.runtimeEpoch,
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
  };
  const inserted = insertOperatorApproval({ approval, databaseOptions: params.databaseOptions });
  if (inserted.outcome !== "inserted") {
    throw new Error(`expected approval '${params.id}' to be inserted`);
  }
  return inserted.record;
}

describe("operator approval session events", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("targets exact opted-in source and ancestor audiences with reviewer authorization", () => {
    const clients = [
      createClient({ connId: "source-admin", scopes: ["operator.admin"] }),
      createClient({
        connId: "source-device",
        scopes: ["operator.approvals"],
        deviceId: "source-reviewer",
      }),
      createClient({ connId: "source-no-device", scopes: ["operator.approvals"] }),
      createClient({
        connId: "source-unrelated-device",
        scopes: ["operator.approvals"],
        deviceId: "unrelated-device",
      }),
      createClient({
        connId: "source-requester-device",
        scopes: ["operator.approvals"],
        deviceId: "requester-device",
      }),
      createClient({
        connId: "source-no-scope",
        scopes: ["operator.read"],
        deviceId: "unprivileged-device",
      }),
      createClient({ connId: "source-not-opted-in", scopes: ["operator.admin"] }),
      createClient({
        connId: "source-invalidated",
        scopes: ["operator.admin"],
        invalidated: true,
      }),
      createClient({
        connId: "parent-device",
        scopes: ["operator.approvals"],
        deviceId: "parent-reviewer",
      }),
      createClient({ connId: "sibling-admin", scopes: ["operator.admin"] }),
    ];
    const { broadcastToConnIds, runtime, subscribers } = createRuntime({
      clients,
      controlUiBasePath: "/operator/",
    });
    for (const connId of [
      "source-admin",
      "source-device",
      "source-no-device",
      "source-unrelated-device",
      "source-requester-device",
      "source-no-scope",
      "source-invalidated",
    ]) {
      subscribers.subscribe(connId, SOURCE_SESSION_KEY, { includeApprovals: true });
    }
    subscribers.subscribe("source-not-opted-in", SOURCE_SESSION_KEY);
    subscribers.subscribe("parent-device", PARENT_SESSION_KEY, { includeApprovals: true });
    subscribers.subscribe("sibling-admin", SIBLING_SESSION_KEY, { includeApprovals: true });

    const record = createPendingRecord({
      reviewerDeviceIds: ["source-reviewer", "parent-reviewer"],
    });
    runtime.publish({ phase: "pending", record });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(broadcastToConnIds).toHaveBeenNthCalledWith(
      1,
      "session.approval",
      {
        sessionKey: SOURCE_SESSION_KEY,
        sourceSessionKey: SOURCE_SESSION_KEY,
        phase: "pending",
        updatedAtMs: 1_000,
        approval: {
          id: record.id,
          status: "pending",
          presentation: record.presentation,
          urlPath: "/operator/approve/approval%3Achild%2Frequest%3F1",
          createdAtMs: 1_000,
          expiresAtMs: 10_000,
        },
      },
      new Set(["source-admin", "source-device"]),
    );
    expect(broadcastToConnIds).toHaveBeenNthCalledWith(
      2,
      "session.approval",
      expect.objectContaining({
        sessionKey: PARENT_SESSION_KEY,
        sourceSessionKey: SOURCE_SESSION_KEY,
        phase: "pending",
      }),
      new Set(["parent-device"]),
    );

    const payloads = broadcastToConnIds.mock.calls.map((call) => call[1]);
    expect(payloads).not.toContainEqual(
      expect.objectContaining({ sessionKey: SIBLING_SESSION_KEY }),
    );
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("requester-device");
    expect(serialized).not.toContain("requester-client");
    expect(serialized).not.toContain("private-session-id");
    expect(serialized).not.toContain("private-run-id");
    expect(serialized).not.toContain("private-tool-call-id");
    expect(serialized).not.toContain("private-runtime-epoch");
  });

  it("publishes the agent-scoped stream key for global-scope sources", () => {
    const client = createClient({ connId: "admin", scopes: ["operator.admin"] });
    const { broadcastToConnIds, runtime, subscribers } = createRuntime({ clients: [client] });
    subscribers.subscribe("admin", "agent:main:global", { includeApprovals: true });

    // Storage records the bare "global" sentinel; subscribers only know the
    // agent-scoped stream key, so the published event must carry that form.
    const pending = createPendingRecord({
      sourceSessionKey: "global",
      audienceSessionKeys: ["agent:main:global"],
    });
    runtime.publish({ phase: "pending", record: pending });
    runtime.publish({ phase: "terminal", record: createTerminalRecord(pending) });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(broadcastToConnIds).toHaveBeenNthCalledWith(
      1,
      "session.approval",
      expect.objectContaining({
        sessionKey: "agent:main:global",
        sourceSessionKey: "agent:main:global",
        phase: "pending",
      }),
      new Set(["admin"]),
    );
    expect(broadcastToConnIds).toHaveBeenNthCalledWith(
      2,
      "session.approval",
      expect.objectContaining({
        sessionKey: "agent:main:global",
        sourceSessionKey: "agent:main:global",
        phase: "terminal",
      }),
      new Set(["admin"]),
    );
  });

  it("publishes the canonical audience source key for unscoped session aliases", () => {
    const client = createClient({ connId: "admin", scopes: ["operator.admin"] });
    const { broadcastToConnIds, runtime, subscribers } = createRuntime({ clients: [client] });
    subscribers.subscribe("admin", "agent:work:child", { includeApprovals: true });

    // The persisted source may be a raw unscoped alias; subscribers must see
    // the canonical stream key the audience walk seeded first.
    const pending = createPendingRecord({
      sourceSessionKey: "child",
      audienceSessionKeys: ["agent:work:child", "agent:work:parent"],
    });
    runtime.publish({ phase: "pending", record: pending });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.approval",
      expect.objectContaining({
        sessionKey: "agent:work:child",
        sourceSessionKey: "agent:work:child",
        phase: "pending",
      }),
      new Set(["admin"]),
    );
  });

  it("publishes terminal state and rejects lifecycle phases inconsistent with durable status", () => {
    const client = createClient({ connId: "admin", scopes: ["operator.admin"] });
    const { broadcastToConnIds, runtime, subscribers } = createRuntime({ clients: [client] });
    subscribers.subscribe("admin", SOURCE_SESSION_KEY, { includeApprovals: true });

    const pending = createPendingRecord({ audienceSessionKeys: [SOURCE_SESSION_KEY] });
    const terminal = createTerminalRecord(pending);
    runtime.publish({ phase: "terminal", record: pending });
    runtime.publish({ phase: "pending", record: terminal });
    expect(broadcastToConnIds).not.toHaveBeenCalled();

    runtime.publish({ phase: "terminal", record: terminal });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.approval",
      {
        sessionKey: SOURCE_SESSION_KEY,
        sourceSessionKey: SOURCE_SESSION_KEY,
        phase: "terminal",
        updatedAtMs: 2_000,
        approval: {
          id: terminal.id,
          status: "denied",
          decision: "deny",
          reason: "user",
          presentation: terminal.presentation,
          urlPath: `/approve/${encodeURIComponent(terminal.id)}`,
          createdAtMs: 1_000,
          expiresAtMs: 10_000,
          resolvedAtMs: 2_000,
        },
      },
      new Set(["admin"]),
    );
  });

  it("returns the authoritative sanitized pending set for one exact audience", () => {
    const databaseOptions = createDatabaseOptions();
    insertPendingApproval({
      databaseOptions,
      id: "source-and-parent",
      audienceSessionKeys: [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
      createdAtMs: 1_000,
      expiresAtMs: 10_000,
    });
    const parentOnly = insertPendingApproval({
      databaseOptions,
      id: "parent-only",
      audienceSessionKeys: [PARENT_SESSION_KEY],
      createdAtMs: 1_001,
      expiresAtMs: 10_000,
    });
    insertPendingApproval({
      databaseOptions,
      id: "sibling-only",
      audienceSessionKeys: [SIBLING_SESSION_KEY],
      createdAtMs: 1_002,
      expiresAtMs: 10_000,
    });
    const resolved = insertPendingApproval({
      databaseOptions,
      id: "already-resolved",
      audienceSessionKeys: [PARENT_SESSION_KEY],
      createdAtMs: 1_003,
      expiresAtMs: 10_000,
    });
    expect(
      resolveOperatorApproval({
        id: resolved.id,
        decision: "deny",
        resolver: { kind: "device", id: "reviewer-device" },
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "resolved" });
    const { runtime } = createRuntime({
      clients: [],
      databaseOptions,
      controlUiBasePath: "/operator",
      now: () => 5_000,
    });

    const replayReviewer = createClient({
      connId: "replay-reviewer",
      scopes: ["operator.approvals"],
      deviceId: "reviewer-device",
    });
    expect(runtime.replay(PARENT_SESSION_KEY, replayReviewer)).toEqual({
      sessionKey: PARENT_SESSION_KEY,
      updatedAtMs: 5_000,
      truncated: false,
      approvals: [
        {
          id: "source-and-parent",
          status: "pending",
          presentation: createPendingRecord({ id: "source-and-parent" }).presentation,
          urlPath: "/operator/approve/source-and-parent",
          createdAtMs: 1_000,
          expiresAtMs: 10_000,
        },
        {
          id: parentOnly.id,
          status: "pending",
          presentation: parentOnly.presentation,
          urlPath: "/operator/approve/parent-only",
          createdAtMs: 1_001,
          expiresAtMs: 10_000,
        },
      ],
    });
    expect(
      runtime.replay(
        PARENT_SESSION_KEY,
        createClient({
          connId: "unrelated-replay",
          scopes: ["operator.approvals"],
          deviceId: "unrelated-device",
        }),
      ),
    ).toEqual({
      sessionKey: PARENT_SESSION_KEY,
      updatedAtMs: 5_000,
      truncated: false,
      approvals: [],
    });
  });

  it("publishes replay-triggered expiry to existing ancestor recipients before an empty replay", () => {
    const databaseOptions = createDatabaseOptions();
    insertPendingApproval({
      databaseOptions,
      id: "expired-child-approval",
      audienceSessionKeys: [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
      createdAtMs: 1_000,
      expiresAtMs: 4_000,
      reviewerDeviceIds: ["parent-device"],
    });
    const parent = createClient({
      connId: "parent-reviewer",
      scopes: ["operator.approvals"],
      deviceId: "parent-device",
    });
    const { broadcastToConnIds, runtime, subscribers } = createRuntime({
      clients: [parent],
      databaseOptions,
      now: () => 5_000,
    });
    subscribers.subscribe("parent-reviewer", PARENT_SESSION_KEY, { includeApprovals: true });

    const replay = runtime.replay(SOURCE_SESSION_KEY, parent);

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.approval",
      expect.objectContaining({
        sessionKey: PARENT_SESSION_KEY,
        sourceSessionKey: SOURCE_SESSION_KEY,
        phase: "terminal",
        updatedAtMs: 5_000,
        approval: expect.objectContaining({
          id: "expired-child-approval",
          status: "expired",
          reason: "timeout",
          resolvedAtMs: 5_000,
        }),
      }),
      new Set(["parent-reviewer"]),
    );
    expect(replay).toEqual({
      sessionKey: SOURCE_SESSION_KEY,
      updatedAtMs: 5_000,
      approvals: [],
      truncated: false,
    });
  });

  it("settles the owning waiter and publishes replay-triggered expiry once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const databaseOptions = createDatabaseOptions();
    // Replay reconciliation runs only after the manager exists; route it
    // through a holder so both sides can stay const.
    const managerHolder: { current?: ExecApprovalManager } = {};
    const parent = createClient({
      connId: "parent-reviewer",
      scopes: ["operator.approvals"],
      deviceId: "parent-device",
    });
    const harness = createRuntime({
      clients: [parent],
      databaseOptions,
      now: () => Date.now(),
      reconcileTerminal: (record) =>
        managerHolder.current?.reconcileDurableTerminal(record) ?? false,
    });
    const runtime = harness.runtime;
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "session-events", databaseOptions },
      resolveAllowedDecisions: () => ["allow-once", "deny"],
      resolveAudienceSessionKeys: () => [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
      onLifecycle: (event) => runtime.publish(event),
    });
    managerHolder.current = manager;
    harness.subscribers.subscribe("parent-reviewer", PARENT_SESSION_KEY, {
      includeApprovals: true,
    });
    const record = manager.create(
      {
        command: "printf replay-expiry",
        sessionKey: SOURCE_SESSION_KEY,
        agentId: "main",
      },
      3_000,
      "replay-expiry-with-waiter",
    );
    const decisionPromise = manager.register(record, 3_000);
    harness.broadcastToConnIds.mockClear();
    vi.setSystemTime(record.expiresAtMs);

    expect(runtime.replay(SOURCE_SESSION_KEY, parent)).toEqual({
      sessionKey: SOURCE_SESSION_KEY,
      updatedAtMs: record.expiresAtMs,
      approvals: [],
      truncated: false,
    });
    await expect(decisionPromise).resolves.toBeNull();
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
      "session.approval",
      expect.objectContaining({
        sessionKey: PARENT_SESSION_KEY,
        phase: "terminal",
        approval: expect.objectContaining({ status: "expired" }),
      }),
      new Set(["parent-reviewer"]),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
  });
});
