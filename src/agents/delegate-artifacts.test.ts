import { afterEach, expect, it, describe, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  DELEGATE_ARTIFACT_RETENTION_MS,
  DELEGATE_ARTIFACT_MAX_BYTES,
  createDelegateArtifactPolicy,
  finalizeDelegateArtifacts,
  inspectDelegateArtifactForRecipient,
  listDelegateArtifactsForRecipient,
  prepareDelegateArtifactDelivery,
  publishDelegateArtifactCandidates,
  recordDelegateArtifactDelivery,
  removeUnacceptedDelegateArtifactPolicy,
} from "./delegate-artifacts.js";
import { finalize, policy, publish, stateOptions } from "./delegate-artifacts.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("managed delegate artifact claims", () => {
  it("keeps pending bytes private, finalizes once, and projects per-recipient arrival context", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    const storedPolicy = openOpenClawStateDatabase(options)
      .db.prepare(
        "SELECT producer_run_id, origin_parent_session_id, recipients_json, route_json, output_root, max_artifact_count, max_artifact_bytes, max_total_bytes, allowed_mimes_json, retention_deadline FROM delegate_artifact_policies WHERE flow_id = ?",
      )
      .get("flow-1") as Record<string, unknown>;
    expect(storedPolicy).toMatchObject({
      producer_run_id: "continuation-delegate-run-1",
      origin_parent_session_id: "parent-session-1",
      output_root: ".openclaw/delegate-output",
      max_artifact_count: 8,
      max_artifact_bytes: 16 * 1024 * 1024,
      max_total_bytes: 32 * 1024 * 1024,
      retention_deadline: 1_000 + DELEGATE_ARTIFACT_RETENTION_MS,
    });
    expect(JSON.parse(String(storedPolicy.route_json))).toEqual({
      kind: "targets",
      targetSessionKeys: ["agent:main:parent", "agent:main:target"],
    });
    expect(JSON.parse(String(storedPolicy.recipients_json))).toEqual(policy().recipients);
    expect(JSON.parse(String(storedPolicy.allowed_mimes_json))).toEqual([
      "image/*",
      "audio/*",
      "video/*",
      "text/*",
      "application/json",
      "application/pdf",
      "application/zip",
    ]);
    expect(publish(options)).toEqual({ status: "published", count: 1 });

    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_300,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });

    const finalized = finalize(options);
    expect(finalized.status).toBe("finalized");
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    const parent = finalized.projections.get("agent:main:parent");
    const target = finalized.projections.get("agent:main:target");
    expect(parent).toMatchObject({
      arrivalContext: {
        deliveryClass: "delegate result",
        deliveryMode: "silent",
        dispatchId: "flow-1",
        completionId: "completion-1",
        completedAt: 9_000,
        deliveredAt: 10_000,
      },
      artifacts: [
        {
          type: "report",
          title: "Delegate report",
          mimeType: "application/pdf",
          source: "delegate-return",
          download: { mode: "unsupported" },
        },
      ],
    });
    expect(parent?.arrivalContext).not.toHaveProperty("recipientContext");
    expect(target).toMatchObject({
      arrivalContext: {
        deliveryClass: "inter-session enrichment",
        recipientContext: {
          purpose: "Compare the generated report with the target's current plan.",
        },
      },
    });
    expect(JSON.stringify(target)).not.toContain("agent:main:parent");
    expect(JSON.stringify(parent)).not.toContain("agent:main:target");
    if (!parent) {
      throw new Error("expected parent projection");
    }
    expect(
      inspectDelegateArtifactForRecipient({
        claimId: parent.artifacts[0]!.id,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_010,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });
    expect(() =>
      recordDelegateArtifactDelivery({
        projection: parent,
        phase: "acknowledged",
        now: 10_020,
        options,
      }),
    ).toThrow("cannot be acknowledged before its attempt");
    expect(
      prepareDelegateArtifactDelivery({
        projection: parent,
        runtimeEnabled: false,
        crossSessionEnabled: true,
        currentRecipientSessionId: "parent-session-1",
        now: 10_050,
        options,
      }),
    ).toEqual({ status: "deferred" });
    expect(
      prepareDelegateArtifactDelivery({
        projection: {
          ...parent,
          arrivalContext: {
            ...parent.arrivalContext,
            deliveryMode: "announced",
          },
        },
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "parent-session-1",
        now: 10_075,
        options,
      }),
    ).toEqual({ status: "unavailable" });
    const preparedParent = prepareDelegateArtifactDelivery({
      projection: parent,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      currentRecipientSessionId: "parent-session-1",
      now: 10_100,
      options,
    });
    expect(preparedParent).toMatchObject({
      status: "ready",
      projection: { arrivalContext: { deliveredAt: 10_100 } },
    });
    if (preparedParent.status !== "ready") {
      throw new Error("expected prepared parent delivery");
    }
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT first_delivery_at FROM delegate_artifact_recipient_outcomes WHERE recipient_session_key = ?",
        )
        .get("agent:main:parent"),
    ).toEqual({ first_delivery_at: null });
    recordDelegateArtifactDelivery({
      projection: preparedParent.projection,
      phase: "attempt",
      now: 10_100,
      options,
    });
    if (!target) {
      throw new Error("expected target projection");
    }
    expect(
      prepareDelegateArtifactDelivery({
        projection: {
          ...target,
          artifacts: target.artifacts.map((artifact) => ({
            ...artifact,
            title: "Swapped recipient artifact",
          })),
          arrivalContext: {
            ...target.arrivalContext,
            binding: parent.arrivalContext.binding,
          },
        },
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "parent-session-1",
        now: 10_075,
        options,
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      prepareDelegateArtifactDelivery({
        projection: target,
        runtimeEnabled: true,
        crossSessionEnabled: false,
        currentRecipientSessionId: "target-session-1",
        now: 10_100,
        options,
      }),
    ).toEqual({ status: "deferred" });
    const preparedTarget = prepareDelegateArtifactDelivery({
      projection: target,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      currentRecipientSessionId: "target-session-1",
      now: 10_100,
      options,
    });
    if (preparedTarget.status !== "ready") {
      throw new Error("expected prepared target delivery");
    }
    recordDelegateArtifactDelivery({
      projection: preparedTarget.projection,
      phase: "attempt",
      now: 10_100,
      options,
    });
    recordDelegateArtifactDelivery({
      projection: preparedTarget.projection,
      phase: "acknowledged",
      now: 10_200,
      options,
    });
    expect(
      inspectDelegateArtifactForRecipient({
        claimId: target.artifacts[0]!.id,
        recipientSessionKey: "agent:main:target",
        recipientSessionId: "target-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: false,
        now: 10_300,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });

    const replay = finalize(options, { now: 20_000 });
    expect(replay.status).toBe("finalized");
    if (replay.status !== "finalized") {
      throw new Error("expected replayed finalized claims");
    }
    expect(replay.projections.get("agent:main:parent")?.artifacts).toEqual(parent?.artifacts);
    expect(replay.projections.get("agent:main:parent")?.arrivalContext).toMatchObject({
      dispatchAcceptedAt: 1_000,
      completedAt: 9_000,
      deliveredAt: 10_100,
    });

    const replayedParent = replay.projections.get("agent:main:parent");
    if (!replayedParent) {
      throw new Error("expected parent projection");
    }
    recordDelegateArtifactDelivery({
      projection: replayedParent,
      phase: "replay",
      now: 20_100,
      options,
    });
    const preparedReplay = prepareDelegateArtifactDelivery({
      projection: replayedParent,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      currentRecipientSessionId: "parent-session-1",
      now: 20_100,
      options,
    });
    expect(preparedReplay).toMatchObject({
      status: "ready",
      projection: {
        arrivalContext: {
          deliveredAt: 10_100,
          replayedAt: 20_100,
        },
      },
    });
    if (preparedReplay.status !== "ready") {
      throw new Error("expected prepared replay");
    }
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT delivery_acknowledged_at FROM delegate_artifact_bindings WHERE recipient_session_key = ?",
        )
        .get("agent:main:parent"),
    ).toEqual({ delivery_acknowledged_at: null });
    recordDelegateArtifactDelivery({
      projection: preparedReplay.projection,
      phase: "acknowledged",
      now: 20_200,
      options,
    });
    recordDelegateArtifactDelivery({
      projection: preparedReplay.projection,
      phase: "acknowledged",
      now: 20_500,
      options,
    });
    expect(
      inspectDelegateArtifactForRecipient({
        claimId: parent.artifacts[0]!.id,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 20_300,
        options,
      }),
    ).toMatchObject({ outcome: "available" });
    expect(
      prepareDelegateArtifactDelivery({
        projection: replayedParent,
        runtimeEnabled: true,
        crossSessionEnabled: true,
        currentRecipientSessionId: "parent-session-1",
        now: 30_000,
        options,
      }),
    ).toEqual({ status: "acknowledged" });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT arrived_at, replayed_at, last_delivery_attempt_at, delivery_acknowledged_at FROM delegate_artifact_bindings WHERE recipient_session_key = ?",
        )
        .get("agent:main:parent"),
    ).toEqual({
      arrived_at: 10_100,
      replayed_at: 20_100,
      last_delivery_attempt_at: 20_100,
      delivery_acknowledged_at: 20_200,
    });

    recordDelegateArtifactDelivery({
      projection: replayedParent,
      phase: "attempt",
      now: 30_000,
      options,
    });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare(
          "SELECT arrived_at, replayed_at, last_delivery_attempt_at FROM delegate_artifact_bindings WHERE recipient_session_key = ?",
        )
        .get("agent:main:parent"),
    ).toEqual({
      arrived_at: 10_100,
      replayed_at: 20_100,
      last_delivery_attempt_at: 20_100,
    });
  });

  it("lists acknowledged claims without letting a later undelivered claim poison them", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(
      policy({
        recipients: [
          {
            sessionKey: "agent:main:parent",
            sessionId: "parent-session-1",
            relation: "parent",
          },
        ],
        route: { kind: "parent" },
        recipientContext: undefined,
      }),
      options,
    );
    publish(options);
    const first = finalize(options);
    if (first.status !== "finalized") {
      throw new Error("expected first finalized claim");
    }
    const firstProjection = first.projections.get("agent:main:parent");
    if (!firstProjection) {
      throw new Error("expected first parent projection");
    }
    const firstDelivery = prepareDelegateArtifactDelivery({
      projection: firstProjection,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      currentRecipientSessionId: "parent-session-1",
      now: 10_100,
      options,
    });
    if (firstDelivery.status !== "ready") {
      throw new Error("expected first prepared delivery");
    }
    recordDelegateArtifactDelivery({
      projection: firstDelivery.projection,
      phase: "attempt",
      now: 10_100,
      options,
    });
    recordDelegateArtifactDelivery({
      projection: firstDelivery.projection,
      phase: "acknowledged",
      now: 10_200,
      options,
    });

    createDelegateArtifactPolicy(
      policy({
        flowId: "flow-2",
        producerSessionKey: "agent:main:subagent:continuation-child-2",
        producerRunId: "continuation-delegate-run-2",
        dispatchRevision: 5,
        recipients: [
          {
            sessionKey: "agent:main:parent",
            sessionId: "parent-session-1",
            relation: "parent",
          },
        ],
        route: { kind: "parent" },
        recipientContext: undefined,
      }),
      options,
    );
    expect(
      publishDelegateArtifactCandidates({
        producerSessionKey: "agent:main:subagent:continuation-child-2",
        producerSessionId: "child-session-2",
        producerRunId: "continuation-delegate-run-2",
        publicationKey: "tool-call-2",
        candidates: [
          { bytes: Buffer.from("%PDF-1.7 second delegate report"), mimeType: "application/pdf" },
        ],
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 2_100,
        options,
      }),
    ).toEqual({ status: "published", count: 1 });
    expect(
      finalizeDelegateArtifacts({
        producerSessionKey: "agent:main:subagent:continuation-child-2",
        producerSessionId: "child-session-2",
        producerRunId: "continuation-delegate-run-2",
        completionId: "completion-2",
        finalizationKey: "finalization-2",
        completionStatus: "ok",
        completedAt: 9_100,
        silent: true,
        runtimeEnabled: true,
        crossSessionEnabled: true,
        resolveSessionId: () => "parent-session-1",
        now: 10_300,
        options,
      }).status,
    ).toBe("finalized");

    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_400,
        options,
      }),
    ).toEqual({
      outcome: "available",
      artifacts: firstProjection.artifacts,
    });
  });

  it("makes publication idempotent and never authorizes an unbound or guessed claim", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    expect(
      publishDelegateArtifactCandidates({
        producerSessionKey: "agent:main:subagent:continuation-child",
        producerSessionId: "child-session-1",
        producerRunId: "continuation-delegate-run-1",
        publicationKey: "cross-session-disabled",
        candidates: [{ bytes: Buffer.from("report"), mimeType: "application/pdf" }],
        runtimeEnabled: true,
        crossSessionEnabled: false,
        options,
      }),
    ).toEqual({ status: "rejected", reason: "runtime_disabled" });
    expect(publish(options)).toEqual({ status: "published", count: 1 });
    expect(publish(options)).toEqual({ status: "published", count: 1 });
    const finalized = finalize(options);
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    const artifact = finalized.projections.get("agent:main:parent")?.artifacts[0];
    expect(artifact).toBeDefined();
    expect(
      inspectDelegateArtifactForRecipient({
        claimId: artifact!.id,
        recipientSessionKey: "agent:main:outsider",
        recipientSessionId: "outsider-session",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });
    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:outsider",
        recipientSessionId: "outsider-session",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        options,
      }),
    ).toEqual({ outcome: "unauthorized" });
    expect(
      inspectDelegateArtifactForRecipient({
        claimId: "00000000-0000-4000-8000-000000000000",
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_300,
        options,
      }),
    ).toEqual({ outcome: "missing" });
  });

  it("enforces per-artifact and aggregate publication byte limits before persistence", () => {
    const oversizedOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), oversizedOptions);
    expect(
      publishDelegateArtifactCandidates({
        producerSessionKey: "agent:main:subagent:continuation-child",
        producerSessionId: "child-session-1",
        producerRunId: "continuation-delegate-run-1",
        publicationKey: "oversized",
        candidates: [
          {
            bytes: Buffer.alloc(DELEGATE_ARTIFACT_MAX_BYTES + 1),
            mimeType: "application/pdf",
          },
        ],
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 2_000,
        options: oversizedOptions,
      }),
    ).toEqual({ status: "rejected", reason: "invalid_candidate" });

    closeOpenClawStateDatabaseForTest();
    const capturedPolicyOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), capturedPolicyOptions);
    openOpenClawStateDatabase(capturedPolicyOptions)
      .db.prepare(
        "UPDATE delegate_artifact_policies SET max_artifact_bytes = 4, allowed_mimes_json = ?",
      )
      .run(JSON.stringify(["text/*"]));
    expect(
      publishDelegateArtifactCandidates({
        producerSessionKey: "agent:main:subagent:continuation-child",
        producerSessionId: "child-session-1",
        producerRunId: "continuation-delegate-run-1",
        publicationKey: "captured-policy",
        candidates: [{ bytes: Buffer.from("pdf!"), mimeType: "application/pdf" }],
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 2_000,
        options: capturedPolicyOptions,
      }),
    ).toEqual({ status: "rejected", reason: "invalid_candidate" });
    expect(
      publishDelegateArtifactCandidates({
        producerSessionKey: "agent:main:subagent:continuation-child",
        producerSessionId: "child-session-1",
        producerRunId: "continuation-delegate-run-1",
        publicationKey: "captured-policy",
        candidates: [{ bytes: Buffer.from("12345"), mimeType: "text/plain" }],
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 2_000,
        options: capturedPolicyOptions,
      }),
    ).toEqual({ status: "rejected", reason: "invalid_candidate" });

    closeOpenClawStateDatabaseForTest();
    const aggregateOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), aggregateOptions);
    expect(
      publishDelegateArtifactCandidates({
        producerSessionKey: "agent:main:subagent:continuation-child",
        producerSessionId: "child-session-1",
        producerRunId: "continuation-delegate-run-1",
        publicationKey: "aggregate-overflow",
        candidates: Array.from({ length: 3 }, () => ({
          bytes: Buffer.alloc(11 * 1024 * 1024),
          mimeType: "application/pdf",
        })),
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 2_000,
        options: aggregateOptions,
      }),
    ).toEqual({ status: "rejected", reason: "policy_limit" });
    expect(
      openOpenClawStateDatabase(aggregateOptions)
        .db.prepare("SELECT count(*) AS count FROM delegate_artifact_claims")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("removes only a pre-spawn policy that no accepted child has used", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    removeUnacceptedDelegateArtifactPolicy("flow-1", options);
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT count(*) AS count FROM delegate_artifact_policies")
        .get(),
    ).toEqual({ count: 0 });

    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    expect(() => removeUnacceptedDelegateArtifactPolicy("flow-1", options)).toThrow(
      "cannot remove an accepted delegate artifact policy",
    );
  });
});
