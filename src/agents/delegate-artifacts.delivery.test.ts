import { afterEach, expect, it, vi, describe } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  DELEGATE_ARTIFACT_RETENTION_MS,
  createDelegateArtifactPolicy,
  inspectDelegateArtifactForRecipient,
  listDelegateArtifactsForRecipient,
  prepareDelegateArtifactDelivery,
  purgeExpiredDelegateArtifacts,
  recordDelegateArtifactDelivery,
} from "./delegate-artifacts.js";
import { finalize, policy, publish, stateOptions } from "./delegate-artifacts.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("managed delegate artifact claims", () => {
  it("preserves expired claimless policy and terminal provenance records", () => {
    const options = stateOptions();
    const statuses = ["active", "staged", "completed", "failed"] as const;
    for (const [index, status] of statuses.entries()) {
      createDelegateArtifactPolicy(
        policy({
          flowId: `flow-${status}`,
          producerRunId: `run-${status}`,
          dispatchRevision: index,
        }),
        options,
      );
      if (status !== "active") {
        openOpenClawStateDatabase(options)
          .db.prepare(
            "UPDATE delegate_artifact_policies SET status = ?, completion_id = ?, completion_finalization_key = ?, completed_at = ?, completion_status = ?, completion_disposition = ? WHERE flow_id = ?",
          )
          .run(
            status,
            `completion-${status}`,
            `finalization-${status}`,
            9_000,
            "ok",
            status === "staged" ? null : `terminal-${status}`,
            `flow-${status}`,
          );
      }
    }
    openOpenClawStateDatabase(options)
      .db.prepare(
        "INSERT INTO delegate_artifact_recipient_outcomes (flow_id, recipient_session_key, recipient_session_id, recipient_relation, purpose, outcome, unavailable_reason, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "flow-failed",
        "agent:main:target",
        "target-session-1",
        "inter_session",
        null,
        "unavailable",
        "policy-failed",
        9_000,
      );

    expect(purgeExpiredDelegateArtifacts(1_000 + DELEGATE_ARTIFACT_RETENTION_MS, options)).toBe(0);
    expect(purgeExpiredDelegateArtifacts(1_000 + DELEGATE_ARTIFACT_RETENTION_MS, options)).toBe(0);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT flow_id, status FROM delegate_artifact_policies ORDER BY flow_id")
        .all(),
    ).toEqual([
      { flow_id: "flow-active", status: "active" },
      { flow_id: "flow-completed", status: "completed" },
      { flow_id: "flow-failed", status: "failed" },
      { flow_id: "flow-staged", status: "staged" },
    ]);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT outcome, unavailable_reason FROM delegate_artifact_recipient_outcomes WHERE flow_id = ?",
        )
        .get("flow-failed"),
    ).toEqual({ outcome: "unavailable", unavailable_reason: "policy-failed" });
  });

  it("terminalizes a finalized binding when its recipient incarnation changes before delivery", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    const finalized = finalize(options);
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    const projection = finalized.projections.get("agent:main:parent")!;
    expect(
      prepareDelegateArtifactDelivery({
        projection,
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "replacement-session",
        now: 10_100,
        options,
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT status, unavailable_reason, arrived_at FROM delegate_artifact_bindings WHERE recipient_session_key = ?",
        )
        .get("agent:main:parent"),
    ).toEqual({
      status: "unavailable",
      unavailable_reason: "recipient-incarnation-changed",
      arrived_at: null,
    });
    expect(
      inspectDelegateArtifactForRecipient({
        claimId: projection.artifacts[0]!.id,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_200,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });
  });

  it("terminalizes a finalized binding that expires before its initial delivery", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    const finalized = finalize(options);
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    const projection = finalized.projections.get("agent:main:parent")!;

    expect(
      prepareDelegateArtifactDelivery({
        projection,
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "parent-session-1",
        now: 1_000 + DELEGATE_ARTIFACT_RETENTION_MS,
        options,
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT outcome, delivery_terminal_reason FROM delegate_artifact_recipient_outcomes WHERE flow_id = ? AND recipient_session_key = ?",
        )
        .get("flow-1", "agent:main:parent"),
    ).toEqual({
      outcome: "available",
      delivery_terminal_reason: "delivery-state-unavailable",
    });
  });

  it("persists the first policy creation as dispatch acceptance across crash replay", () => {
    const options = stateOptions();
    const { dispatchAcceptedAt: _ignored, ...replayedPolicy } = policy();
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000);
    createDelegateArtifactPolicy({ ...replayedPolicy, scheduledAt: 1_000 }, options);
    now.mockReturnValue(9_000);
    createDelegateArtifactPolicy({ ...replayedPolicy, scheduledAt: 1_000 }, options);

    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT dispatch_accepted_at, scheduled_at, retention_deadline FROM delegate_artifact_policies",
        )
        .get(),
    ).toEqual({
      dispatch_accepted_at: 5_000,
      scheduled_at: 1_000,
      retention_deadline: 5_000 + DELEGATE_ARTIFACT_RETENTION_MS,
    });
  });

  it("does not let an unrelated malformed policy break an acknowledged recipient list", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    const finalized = finalize(options);
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    const projection = finalized.projections.get("agent:main:parent")!;
    recordDelegateArtifactDelivery({
      projection,
      phase: "attempt",
      now: 10_100,
      options,
    });
    recordDelegateArtifactDelivery({
      projection,
      phase: "acknowledged",
      now: 10_200,
      options,
    });
    createDelegateArtifactPolicy(
      {
        ...policy(),
        flowId: "unrelated-flow",
        producerRunId: "unrelated-run",
      },
      options,
    );
    openOpenClawStateDatabase(options)
      .db.prepare(
        "UPDATE delegate_artifact_policies SET recipients_json = ? WHERE flow_id = 'unrelated-flow'",
      )
      .run('{"recipient":"file:///private"}');

    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_300,
        options,
      }),
    ).toMatchObject({ outcome: "available", artifacts: [{ id: projection.artifacts[0]!.id }] });
  });

  it("stages while disabled and resumes the same completion without exposing claims", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);

    expect(finalize(options, { runtimeEnabled: false })).toEqual({ status: "deferred" });
    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });

    const resumed = finalize(options, { now: 11_000 });
    expect(resumed.status).toBe("finalized");
    if (resumed.status !== "finalized") {
      throw new Error("expected resumed finalization");
    }
    expect(resumed.projections.get("agent:main:parent")?.artifacts).toHaveLength(1);

    closeOpenClawStateDatabaseForTest();
    const mismatchOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), mismatchOptions);
    publish(mismatchOptions);
    expect(finalize(mismatchOptions, { runtimeEnabled: false })).toEqual({ status: "deferred" });
    expect(
      finalize(mismatchOptions, {
        runtimeEnabled: false,
        completionId: "replacement-completion",
        finalizationKey: "replacement-finalization",
      }),
    ).toEqual({ status: "deferred" });
    expect(
      finalize(mismatchOptions, {
        completionId: "replacement-completion",
        finalizationKey: "replacement-finalization",
      }),
    ).toEqual({
      status: "failed",
      disposition: "global-failed(completion-integrity)",
    });
    expect(
      openOpenClawStateDatabase(mismatchOptions)
        .db.prepare(
          "SELECT completion_id, completion_finalization_key, completion_disposition FROM delegate_artifact_policies",
        )
        .get(),
    ).toEqual({
      completion_id: "completion-1",
      completion_finalization_key: "finalization-1",
      completion_disposition: "global-failed(completion-integrity)",
    });
  });

  it("applies the cross-session gate to explicit and host-wide routes, not tree ancestry", () => {
    const treeOptions = stateOptions();
    createDelegateArtifactPolicy(
      policy({ route: { kind: "fanout", fanoutMode: "tree" } }),
      treeOptions,
    );
    publish(treeOptions);
    expect(finalize(treeOptions, { crossSessionEnabled: false }).status).toBe("finalized");

    closeOpenClawStateDatabaseForTest();
    const allOptions = stateOptions();
    createDelegateArtifactPolicy(
      policy({ route: { kind: "fanout", fanoutMode: "all" } }),
      allOptions,
    );
    publish(allOptions);
    expect(finalize(allOptions, { crossSessionEnabled: false })).toEqual({ status: "deferred" });
  });

  it("isolates mixed recipient incarnation failures and preserves unavailable tombstones", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    const finalized = finalize(options, {
      resolveSessionId: (sessionKey) =>
        sessionKey === "agent:main:parent" ? "parent-session-1" : "target-session-rebound",
    });
    expect(finalized.status).toBe("finalized");
    if (finalized.status !== "finalized") {
      throw new Error("expected mixed-recipient finalization");
    }
    expect([...finalized.projections.keys()]).toEqual(["agent:main:parent"]);

    const row = openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT outcome, unavailable_reason FROM delegate_artifact_recipient_outcomes WHERE recipient_session_key = ?",
      )
      .get("agent:main:target");
    expect(row).toEqual({
      outcome: "unavailable",
      unavailable_reason: "recipient-incarnation-changed",
    });
    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:target",
        recipientSessionId: "target-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });
    expect(purgeExpiredDelegateArtifacts(1_000 + DELEGATE_ARTIFACT_RETENTION_MS, options)).toBe(1);
    expect(purgeExpiredDelegateArtifacts(1_000 + DELEGATE_ARTIFACT_RETENTION_MS, options)).toBe(0);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT outcome, unavailable_reason FROM delegate_artifact_recipient_outcomes WHERE recipient_session_key = ?",
        )
        .get("agent:main:target"),
    ).toEqual(row);
  });

  it("records one mode-specific terminal outcome when no claim or recipient is eligible", () => {
    const optionalOptions = stateOptions();
    createDelegateArtifactPolicy(
      policy({
        recipients: [
          {
            sessionKey: "agent:main:target",
            sessionId: "target-session-1",
            relation: "inter_session",
            purpose: "Use the artifact in the target session.",
          },
        ],
        route: { kind: "target", targetSessionKey: "agent:main:target" },
        recipientContext: "Use the artifact in the target session.",
      }),
      optionalOptions,
    );
    const optional = finalize(optionalOptions);
    expect(optional).toMatchObject({
      status: "finalized",
      disposition: "optional-no-artifacts",
    });
    if (optional.status !== "finalized") {
      throw new Error("expected optional artifact-free completion");
    }
    expect(optional.projections.get("agent:main:target")?.arrivalContext.availability).toBe(
      "unavailable",
    );
    const optionalProjection = optional.projections.get("agent:main:target")!;
    const optionalDelivery = prepareDelegateArtifactDelivery({
      projection: optionalProjection,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      currentRecipientSessionId: "target-session-1",
      now: 10_100,
      options: optionalOptions,
    });
    expect(optionalDelivery.status).toBe("ready");
    if (optionalDelivery.status !== "ready") {
      throw new Error("expected optional artifact-free delivery");
    }
    recordDelegateArtifactDelivery({
      projection: optionalDelivery.projection,
      phase: "attempt",
      now: 10_100,
      options: optionalOptions,
    });
    recordDelegateArtifactDelivery({
      projection: optionalDelivery.projection,
      phase: "replay",
      now: 10_150,
      options: optionalOptions,
    });
    const optionalReplay = prepareDelegateArtifactDelivery({
      projection: optionalProjection,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      currentRecipientSessionId: "target-session-1",
      now: 10_175,
      options: optionalOptions,
    });
    expect(optionalReplay).toMatchObject({
      status: "ready",
      projection: {
        arrivalContext: {
          deliveredAt: 10_100,
          replayedAt: 10_150,
        },
      },
    });
    if (optionalReplay.status !== "ready") {
      throw new Error("expected optional artifact-free replay");
    }
    recordDelegateArtifactDelivery({
      projection: optionalReplay.projection,
      phase: "acknowledged",
      now: 10_200,
      options: optionalOptions,
    });
    expect(
      prepareDelegateArtifactDelivery({
        projection: optionalProjection,
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "target-session-1",
        now: 20_000,
        options: optionalOptions,
      }),
    ).toEqual({ status: "acknowledged" });

    closeOpenClawStateDatabaseForTest();
    const failedOptionalOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), failedOptionalOptions);
    publish(failedOptionalOptions);
    const failedOptional = finalize(failedOptionalOptions, { completionStatus: "error" });
    expect(failedOptional).toMatchObject({
      status: "finalized",
      disposition: "optional-no-artifacts",
    });
    if (failedOptional.status !== "finalized") {
      throw new Error("expected failed optional artifact-free completion");
    }
    expect(failedOptional.projections.get("agent:main:parent")).toMatchObject({
      artifacts: [],
      arrivalContext: { availability: "unavailable" },
    });

    closeOpenClawStateDatabaseForTest();
    const requiredOptions = stateOptions();
    createDelegateArtifactPolicy(
      policy({
        artifactMode: "required",
        recipients: [
          {
            sessionKey: "agent:main:target",
            sessionId: "target-session-1",
            relation: "inter_session",
            purpose: "Use the artifact in the target session.",
          },
        ],
        route: { kind: "target", targetSessionKey: "agent:main:target" },
        recipientContext: "Use the artifact in the target session.",
      }),
      requiredOptions,
    );
    const required = finalize(requiredOptions);
    expect(required).toMatchObject({
      status: "failed",
      disposition: "required-failed",
    });
    if (required.status !== "failed") {
      throw new Error("expected required artifact failure");
    }
    expect(required.projections?.get("agent:main:target")).toMatchObject({
      artifacts: [],
      arrivalContext: { availability: "unavailable" },
    });
    const requiredProjection = required.projections?.get("agent:main:target");
    if (!requiredProjection) {
      throw new Error("expected required failure projection");
    }
    expect(
      prepareDelegateArtifactDelivery({
        projection: requiredProjection,
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "target-session-1",
        now: 10_100,
        options: requiredOptions,
      }),
    ).toMatchObject({
      status: "ready",
      projection: { arrivalContext: { availability: "unavailable" } },
    });

    closeOpenClawStateDatabaseForTest();
    const optionalZeroOptions = stateOptions();
    createDelegateArtifactPolicy(
      policy({
        recipients: [
          {
            sessionKey: "agent:main:target",
            sessionId: "target-session-1",
            relation: "inter_session",
            purpose: "Use the artifact in the target session.",
          },
        ],
        route: { kind: "target", targetSessionKey: "agent:main:target" },
        recipientContext: "Use the artifact in the target session.",
      }),
      optionalZeroOptions,
    );
    publish(optionalZeroOptions);
    const optionalZero = finalize(optionalZeroOptions, {
      resolveSessionId: (sessionKey) =>
        sessionKey === "agent:main:parent" ? "parent-session-1" : "replacement-session",
    });
    expect(optionalZero).toMatchObject({
      status: "finalized",
      disposition: "optional-zero-eligible",
    });
    if (optionalZero.status !== "finalized") {
      throw new Error("expected optional zero-eligible completion");
    }
    expect(optionalZero.projections.size).toBe(0);
    expect(
      openOpenClawStateDatabase(optionalZeroOptions)
        .db.prepare("SELECT outcome, unavailable_reason FROM delegate_artifact_recipient_outcomes")
        .get(),
    ).toEqual({
      outcome: "unavailable",
      unavailable_reason: "recipient-incarnation-changed",
    });

    closeOpenClawStateDatabaseForTest();
    const requiredZeroOptions = stateOptions();
    createDelegateArtifactPolicy(
      policy({
        artifactMode: "required",
        recipients: [
          {
            sessionKey: "agent:main:target",
            sessionId: "target-session-1",
            relation: "inter_session",
            purpose: "Use the artifact in the target session.",
          },
        ],
        route: { kind: "target", targetSessionKey: "agent:main:target" },
        recipientContext: "Use the artifact in the target session.",
      }),
      requiredZeroOptions,
    );
    publish(requiredZeroOptions);
    const requiredZero = finalize(requiredZeroOptions, {
      resolveSessionId: (sessionKey) =>
        sessionKey === "agent:main:parent" ? "parent-session-1" : "replacement-session",
    });
    expect(requiredZero).toMatchObject({
      status: "failed",
      disposition: "required-failed",
    });
    expect(
      openOpenClawStateDatabase(requiredZeroOptions)
        .db.prepare("SELECT count(*) AS count FROM delegate_artifact_bindings")
        .get(),
    ).toEqual({ count: 0 });
  });
});
