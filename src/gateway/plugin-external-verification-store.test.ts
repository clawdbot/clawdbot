import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  closeOrphanedOperatorApprovals,
  forceDenyOperatorApproval,
  getOperatorApprovalDetailed,
  insertOperatorApproval,
  resolveOperatorApproval,
} from "./operator-approval-store.js";
import {
  completeExternalVerificationAttempt,
  resolveApprovalsCoveredBySessionGrant,
  failExternalVerificationAttempt,
  getExternalVerificationAttemptSnapshot,
  getExternalVerificationNativeActionState,
  startExternalVerificationAttempt,
} from "./plugin-external-verification-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("openclaw-external-verification-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function insertExternalApproval(params: {
  databaseOptions: OpenClawStateDatabaseOptions;
  id?: string;
  reviewerDeviceIds?: string[];
  runId?: string | null;
  runtimeEpoch?: string;
  expiresAtMs?: number;
}) {
  const id = params.id ?? "plugin:approval-1";
  return insertOperatorApproval({
    approval: {
      id,
      kind: "plugin",
      presentation: {
        kind: "plugin",
        title: "World verification",
        description: "Verify personhood before continuing.",
        severity: "warning",
        pluginId: "agentkit",
        toolName: "dangerous-tool",
        agentId: "main",
        allowedDecisions: ["deny"],
        externalResolution: {
          label: "Verify with World",
          decisions: ["allow-once", "allow-always"],
        },
      },
      source: {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        runId: params.runId === undefined ? "run-1" : params.runId,
        toolCallId: "call-1",
        toolName: "dangerous-tool",
      },
      runtimeEpoch: params.runtimeEpoch ?? "epoch-1",
      createdAtMs: 1_000,
      expiresAtMs: params.expiresAtMs ?? 10_000,
      reviewerDeviceIds: params.reviewerDeviceIds,
    },
    databaseOptions: params.databaseOptions,
  });
}

function getApproval(id: string, databaseOptions: OpenClawStateDatabaseOptions, nowMs = 2_000) {
  const result = getOperatorApprovalDetailed({ id, nowMs, databaseOptions });
  return result.outcome === "found" ? result.record : null;
}

describe("plugin external verification store", () => {
  it("resolves grant-covered pending approvals once and records the ledger attempt", () => {
    const databaseOptions = createDatabaseOptions();
    expect(insertExternalApproval({ databaseOptions })).toMatchObject({ outcome: "inserted" });
    expect(
      insertExternalApproval({ databaseOptions, id: "plugin:approval-covered" }),
    ).toMatchObject({ outcome: "inserted" });

    const started = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-always",
      interactionId: "c".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    expect(started).toMatchObject({ outcome: "started" });
    const attemptId = started.outcome === "started" ? started.attempt.id : "";
    const completed = completeExternalVerificationAttempt({
      attemptId,
      pluginId: "agentkit",
      outcome: "succeeded",
      runtimeEpoch: "epoch-1",
      nowMs: 3_000,
      databaseOptions,
    });
    expect(completed).toMatchObject({ outcome: "completed", applied: true });
    const grantAuthorizationId =
      completed.outcome === "completed" && completed.grantAuthorization
        ? completed.grantAuthorization.id
        : "";
    expect(grantAuthorizationId).not.toBe("");

    const covered = resolveApprovalsCoveredBySessionGrant({
      grantAuthorizationId,
      grantedApprovalId: "plugin:approval-1",
      pluginId: "agentkit",
      toolName: "dangerous-tool",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      runtimeEpoch: "epoch-1",
      nowMs: 3_000,
      databaseOptions,
    });
    expect(covered).toEqual([{ approvalId: "plugin:approval-covered" }]);
    expect(getApproval("plugin:approval-covered", databaseOptions, 3_500)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      resolver: { kind: "runtime", id: "plugin:agentkit" },
    });

    // Idempotent: nothing pending matches on a second sweep.
    expect(
      resolveApprovalsCoveredBySessionGrant({
        grantAuthorizationId,
        grantedApprovalId: "plugin:approval-1",
        pluginId: "agentkit",
        toolName: "dangerous-tool",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
        runtimeEpoch: "epoch-1",
        nowMs: 3_100,
        databaseOptions,
      }),
    ).toEqual([]);

    // A different session lifecycle never matches the grant predicate.
    expect(
      resolveApprovalsCoveredBySessionGrant({
        grantAuthorizationId,
        grantedApprovalId: "plugin:approval-1",
        pluginId: "agentkit",
        toolName: "dangerous-tool",
        sessionKey: "agent:main:main",
        sessionId: "session-other",
        runtimeEpoch: "epoch-1",
        nowMs: 3_200,
        databaseOptions,
      }),
    ).toEqual([]);
  });

  it("starts one host-bound attempt and replays the same interaction without replacement", () => {
    const databaseOptions = createDatabaseOptions();
    expect(insertExternalApproval({ databaseOptions })).toMatchObject({ outcome: "inserted" });

    const first = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    expect(first).toMatchObject({
      outcome: "started",
      attempt: {
        context: {
          approvalId: "plugin:approval-1",
          pluginId: "agentkit",
          runId: "run-1",
          toolName: "dangerous-tool",
          toolCallId: "call-1",
          sessionId: "session-1",
          decision: "allow-once",
        },
      },
    });

    expect(
      startExternalVerificationAttempt({
        approvalId: "plugin:approval-1",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        runtimeEpoch: "epoch-1",
        nowMs: 2_001,
        databaseOptions,
      }),
    ).toEqual({ outcome: "replay", attempt: first.outcome === "started" ? first.attempt : null });
  });

  it("reports expiry before replaying an active interaction", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions, expiresAtMs: 2_050 });
    const request = {
      approvalId: "plugin:approval-1",
      decision: "allow-once" as const,
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      databaseOptions,
    };
    const started = startExternalVerificationAttempt({ ...request, nowMs: 2_000 });
    if (started.outcome !== "started") {
      throw new Error("expected active attempt");
    }

    expect(startExternalVerificationAttempt({ ...request, nowMs: 2_100 })).toEqual({
      outcome: "approval-expired",
    });
    expect(getApproval("plugin:approval-1", databaseOptions, 2_000)).toMatchObject({
      status: "pending",
    });
    expect(
      getExternalVerificationAttemptSnapshot({
        attemptId: started.attempt.id,
        pluginId: "agentkit",
        databaseOptions,
      }),
    ).not.toHaveProperty("outcome");
  });

  it("replays a superseded interaction instead of reviving its stale decision", () => {
    const databaseOptions = createDatabaseOptions();
    expect(insertExternalApproval({ databaseOptions })).toMatchObject({ outcome: "inserted" });

    const first = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    expect(first.outcome).toBe("started");
    if (first.outcome !== "started") {
      throw new Error("expected the first external verification attempt to start");
    }

    const stronger = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_001,
      databaseOptions,
    });
    expect(stronger).toMatchObject({
      outcome: "started",
      attempt: { context: { decision: "allow-always" } },
    });
    if (stronger.outcome !== "started") {
      throw new Error("expected the stronger external verification attempt to start");
    }

    const staleReplay = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_002,
      databaseOptions,
    });
    expect(staleReplay).toEqual({
      outcome: "replay",
      attempt: {
        ...first.attempt,
        endedAtMs: 2_001,
        outcome: "cancelled",
        terminalSource: "reviewer-retry",
      },
    });
    expect(
      getExternalVerificationAttemptSnapshot({
        attemptId: first.attempt.id,
        pluginId: "agentkit",
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "cancelled",
      terminalSource: "reviewer-retry",
    });
    const activeAttempt = getExternalVerificationAttemptSnapshot({
      attemptId: stronger.attempt.id,
      pluginId: "agentkit",
      databaseOptions,
    });
    expect(activeAttempt).toMatchObject({ context: { decision: "allow-always" } });
    expect(activeAttempt).not.toHaveProperty("outcome");
    expect(
      startExternalVerificationAttempt({
        approvalId: "plugin:approval-1",
        decision: "allow-always",
        interactionId: "a".repeat(64),
        runtimeEpoch: "epoch-1",
        nowMs: 2_003,
        databaseOptions,
      }),
    ).toEqual({ outcome: "replay", attempt: stronger.attempt });
  });

  it("enforces the approval reviewer binding before starting or replaying an attempt", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({
      databaseOptions,
      reviewerDeviceIds: ["device-authorized"],
    });
    const request = {
      approvalId: "plugin:approval-1",
      decision: "allow-once" as const,
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    };
    expect(
      startExternalVerificationAttempt({
        ...request,
        reviewerDeviceId: "device-other",
      }),
    ).toEqual({ outcome: "reviewer-unauthorized" });
    expect(
      startExternalVerificationAttempt({
        ...request,
        reviewerDeviceId: "device-authorized",
      }),
    ).toMatchObject({ outcome: "started" });
    expect(startExternalVerificationAttempt(request)).toEqual({
      outcome: "reviewer-unauthorized",
    });
  });

  it("treats a new reviewer interaction as an explicit retry and closes only the active attempt", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const first = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    const second = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-always",
      interactionId: "b".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_100,
      databaseOptions,
    });
    expect(second).toMatchObject({
      outcome: "started",
      attempt: { context: { decision: "allow-always" } },
    });
    if (first.outcome !== "started") {
      throw new Error("expected first attempt");
    }
    expect(
      completeExternalVerificationAttempt({
        attemptId: first.attempt.id,
        pluginId: "agentkit",
        outcome: "succeeded",
        runtimeEpoch: "epoch-1",
        nowMs: 2_200,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "replay",
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "reviewer-retry" },
    });
  });

  it("requires a core-issued native retry generation to replace the exact active attempt", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const common = {
      approvalId: "plugin:approval-1",
      decision: "allow-once" as const,
      runtimeEpoch: "epoch-1",
      databaseOptions,
    };
    expect(getExternalVerificationNativeActionState({ ...common, nowMs: 2_000 })).toEqual({
      outcome: "ready",
      action: { intent: "start", expectedAttemptId: null },
    });

    const first = startExternalVerificationAttempt({
      ...common,
      interactionId: "a".repeat(64),
      nativeAction: { intent: "start", expectedAttemptId: null },
      nowMs: 2_001,
    });
    expect(first.outcome).toBe("started");
    if (first.outcome !== "started") {
      throw new Error("expected native start attempt");
    }
    expect(
      startExternalVerificationAttempt({
        ...common,
        interactionId: "a".repeat(64),
        nativeAction: { intent: "start", expectedAttemptId: null },
        nowMs: 2_002,
      }),
    ).toEqual({ outcome: "replay", attempt: first.attempt });
    expect(
      startExternalVerificationAttempt({
        ...common,
        interactionId: "b".repeat(64),
        nativeAction: { intent: "start", expectedAttemptId: null },
        nowMs: 2_003,
      }),
    ).toEqual({ outcome: "stale-action", attempt: first.attempt });

    const retryAction = {
      intent: "retry" as const,
      expectedAttemptId: first.attempt.id,
    };
    expect(getExternalVerificationNativeActionState({ ...common, nowMs: 2_004 })).toEqual({
      outcome: "ready",
      action: retryAction,
    });
    const retry = startExternalVerificationAttempt({
      ...common,
      interactionId: "c".repeat(64),
      nativeAction: retryAction,
      nowMs: 2_005,
    });
    expect(retry.outcome).toBe("started");
    if (retry.outcome !== "started") {
      throw new Error("expected native retry attempt");
    }
    expect(
      startExternalVerificationAttempt({
        ...common,
        interactionId: "a".repeat(64),
        nativeAction: { intent: "start", expectedAttemptId: null },
        nowMs: 2_006,
      }),
    ).toEqual({ outcome: "stale-action", attempt: retry.attempt });
    expect(
      startExternalVerificationAttempt({
        ...common,
        interactionId: "d".repeat(64),
        nativeAction: retryAction,
        nowMs: 2_007,
      }),
    ).toEqual({ outcome: "stale-action", attempt: retry.attempt });
    expect(
      getExternalVerificationAttemptSnapshot({
        attemptId: first.attempt.id,
        pluginId: "agentkit",
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "cancelled", terminalSource: "reviewer-retry" });

    failExternalVerificationAttempt({
      attemptId: retry.attempt.id,
      pluginId: "agentkit",
      nowMs: 2_008,
      errorClass: "proof-rejected",
      databaseOptions,
    });
    expect(getExternalVerificationNativeActionState({ ...common, nowMs: 2_009 })).toEqual({
      outcome: "ready",
      action: { intent: "start", expectedAttemptId: retry.attempt.id },
    });
  });

  it("does not expose a stronger attempt through a stale weaker native action", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const common = {
      approvalId: "plugin:approval-1",
      runtimeEpoch: "epoch-1",
      databaseOptions,
    };
    const weakerAction = { intent: "start" as const, expectedAttemptId: null };
    const weaker = startExternalVerificationAttempt({
      ...common,
      decision: "allow-once",
      interactionId: "a".repeat(64),
      nativeAction: weakerAction,
      nowMs: 2_000,
    });
    if (weaker.outcome !== "started") {
      throw new Error("expected weaker native attempt");
    }
    const stronger = startExternalVerificationAttempt({
      ...common,
      decision: "allow-always",
      interactionId: "b".repeat(64),
      nowMs: 2_001,
    });
    if (stronger.outcome !== "started") {
      throw new Error("expected stronger replacement attempt");
    }

    expect(
      startExternalVerificationAttempt({
        ...common,
        decision: "allow-once",
        interactionId: "a".repeat(64),
        nativeAction: weakerAction,
        nowMs: 2_002,
      }),
    ).toEqual({ outcome: "stale-action" });
    expect(
      startExternalVerificationAttempt({
        ...common,
        decision: "allow-once",
        interactionId: "c".repeat(64),
        nativeAction: weakerAction,
        nowMs: 2_003,
      }),
    ).toEqual({ outcome: "stale-action" });
    expect(
      getExternalVerificationAttemptSnapshot({
        attemptId: stronger.attempt.id,
        pluginId: "agentkit",
        databaseOptions,
      }),
    ).toMatchObject({ context: { decision: "allow-always" } });
  });

  it("keeps failure pending, then atomically records a stable grant on success", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const failed = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    if (failed.outcome !== "started") {
      throw new Error("expected failed attempt fixture");
    }
    expect(
      completeExternalVerificationAttempt({
        attemptId: failed.attempt.id,
        pluginId: "agentkit",
        outcome: "failed",
        runtimeEpoch: "epoch-1",
        nowMs: 2_100,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "completed", applied: false, attempt: { outcome: "failed" } });
    expect(getApproval("plugin:approval-1", databaseOptions)).toMatchObject({ status: "pending" });

    const successful = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-always",
      interactionId: "b".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_200,
      databaseOptions,
    });
    if (successful.outcome !== "started") {
      throw new Error("expected successful attempt fixture");
    }
    const completed = completeExternalVerificationAttempt({
      attemptId: successful.attempt.id,
      pluginId: "agentkit",
      outcome: "succeeded",
      runtimeEpoch: "epoch-1",
      nowMs: 2_300,
      databaseOptions,
    });
    expect(completed).toMatchObject({
      outcome: "completed",
      applied: true,
      attempt: { outcome: "succeeded" },
      grantAuthorization: {
        approvalId: "plugin:approval-1",
        attemptId: successful.attempt.id,
        decision: "allow-always",
      },
    });
    expect(getApproval("plugin:approval-1", databaseOptions)).toMatchObject({
      status: "allowed",
      decision: "allow-always",
      resolver: { kind: "runtime", id: "plugin:agentkit" },
    });
    expect(
      completeExternalVerificationAttempt({
        attemptId: successful.attempt.id,
        pluginId: "agentkit",
        outcome: "succeeded",
        runtimeEpoch: "epoch-1",
        nowMs: 2_400,
        databaseOptions,
      }),
    ).toEqual({ ...completed, outcome: "replay", applied: false });
  });

  it("does not issue reusable grant authorization for allow-once", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const started = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    if (started.outcome !== "started") {
      throw new Error("expected allow-once attempt");
    }

    const completed = completeExternalVerificationAttempt({
      attemptId: started.attempt.id,
      pluginId: "agentkit",
      outcome: "succeeded",
      runtimeEpoch: "epoch-1",
      nowMs: 2_100,
      databaseOptions,
    });

    expect(completed).toMatchObject({ outcome: "completed", applied: true });
    expect(completed).not.toHaveProperty("grantAuthorization");
  });

  it("never grants after denial wins and rejects caller-selected plugin ownership", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const started = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-once",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    if (started.outcome !== "started") {
      throw new Error("expected attempt");
    }
    expect(
      completeExternalVerificationAttempt({
        attemptId: started.attempt.id,
        pluginId: "different-plugin",
        outcome: "succeeded",
        runtimeEpoch: "epoch-1",
        nowMs: 2_050,
        databaseOptions,
      }),
    ).toEqual({ outcome: "attempt-not-found" });
    expect(
      resolveOperatorApproval({
        id: "plugin:approval-1",
        decision: "deny",
        resolver: { kind: "channel", id: "telegram:owner" },
        expectedKind: "plugin",
        runtimeEpoch: "epoch-1",
        nowMs: 2_100,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "resolved", record: { status: "denied" } });
    expect(
      completeExternalVerificationAttempt({
        attemptId: started.attempt.id,
        pluginId: "agentkit",
        outcome: "succeeded",
        runtimeEpoch: "epoch-1",
        nowMs: 2_200,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "replay",
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "user" },
    });
  });

  it("reports an expired approval to the runtime before a late success can authorize a grant", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions, expiresAtMs: 2_050 });
    const started = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    if (started.outcome !== "started") {
      throw new Error("expected expiring attempt");
    }

    const completion = completeExternalVerificationAttempt({
      attemptId: started.attempt.id,
      pluginId: "agentkit",
      outcome: "succeeded",
      runtimeEpoch: "epoch-1",
      nowMs: 2_100,
      databaseOptions,
    });

    expect(completion).toMatchObject({
      outcome: "approval-expired",
      approvalId: "plugin:approval-1",
    });
    expect(completion).not.toHaveProperty("grantAuthorization");
    expect(getApproval("plugin:approval-1", databaseOptions, 2_000)).toMatchObject({
      status: "pending",
    });
    expect(
      getExternalVerificationAttemptSnapshot({
        attemptId: started.attempt.id,
        pluginId: "agentkit",
        databaseOptions,
      }),
    ).not.toHaveProperty("outcome");
  });

  it("records run cancellation as terminal before replaying a late completion", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions });
    const started = startExternalVerificationAttempt({
      approvalId: "plugin:approval-1",
      decision: "allow-always",
      interactionId: "a".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    if (started.outcome !== "started") {
      throw new Error("expected run-bound attempt");
    }
    expect(
      forceDenyOperatorApproval({
        id: "plugin:approval-1",
        status: "cancelled",
        reason: "run-aborted",
        resolver: { kind: "system", id: null },
        expectedKind: "plugin",
        runtimeEpoch: "epoch-1",
        nowMs: 2_100,
        databaseOptions,
      }),
    ).toMatchObject({ outcome: "denied", record: { status: "cancelled" } });

    const completion = completeExternalVerificationAttempt({
      attemptId: started.attempt.id,
      pluginId: "agentkit",
      outcome: "succeeded",
      runtimeEpoch: "epoch-1",
      nowMs: 2_200,
      databaseOptions,
    });
    expect(completion).toMatchObject({
      outcome: "replay",
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "run-aborted" },
    });
    expect(completion).not.toHaveProperty("grantAuthorization");
  });

  it("fails closed without a run binding and reconciles active attempts on restart", () => {
    const databaseOptions = createDatabaseOptions();
    insertExternalApproval({ databaseOptions, id: "plugin:no-run", runId: null });
    expect(
      startExternalVerificationAttempt({
        approvalId: "plugin:no-run",
        decision: "allow-once",
        interactionId: "a".repeat(64),
        runtimeEpoch: "epoch-1",
        nowMs: 2_000,
        databaseOptions,
      }),
    ).toEqual({ outcome: "run-unavailable" });

    insertExternalApproval({ databaseOptions, id: "plugin:restart" });
    const started = startExternalVerificationAttempt({
      approvalId: "plugin:restart",
      decision: "allow-once",
      interactionId: "b".repeat(64),
      runtimeEpoch: "epoch-1",
      nowMs: 2_000,
      databaseOptions,
    });
    if (started.outcome !== "started") {
      throw new Error("expected restart attempt");
    }
    expect(
      closeOrphanedOperatorApprovals({
        runtimeEpoch: "epoch-2",
        nowMs: 2_100,
        databaseOptions,
      }),
    ).toMatchObject({ affected: 2 });
    expect(
      completeExternalVerificationAttempt({
        attemptId: started.attempt.id,
        pluginId: "agentkit",
        outcome: "succeeded",
        runtimeEpoch: "epoch-1",
        nowMs: 2_200,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "replay",
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "gateway-restart" },
    });
    expect(
      completeExternalVerificationAttempt({
        attemptId: started.attempt.id,
        pluginId: "agentkit",
        outcome: "succeeded",
        runtimeEpoch: "epoch-2",
        nowMs: 2_300,
        databaseOptions,
      }),
    ).toMatchObject({
      outcome: "replay",
      applied: false,
      attempt: { outcome: "cancelled", terminalSource: "gateway-restart" },
    });
  });
});
