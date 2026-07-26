import { afterEach, expect, it, describe, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  DELEGATE_ARTIFACT_RETENTION_MS,
  createDelegateArtifactPolicy,
  discardDelegateArtifactForRecipient,
  inspectDelegateArtifactForRecipient,
  listDelegateArtifactsForRecipient,
  purgeExpiredDelegateArtifacts,
  readDelegateArtifactForMaterialization,
  recordDelegateArtifactDelivery,
} from "./delegate-artifacts.js";
import { finalize, policy, publish, stateOptions } from "./delegate-artifacts.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("managed delegate artifact claims", () => {
  it("fails corrupt, expired, and revoked claims closed without content fallback", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    openOpenClawStateDatabase(options)
      .db.prepare("UPDATE delegate_artifact_claims SET sha256 = ?")
      .run("0".repeat(64));
    expect(finalize(options)).toEqual({
      status: "failed",
      disposition: "global-failed(corrupt)",
    });
    expect(
      openOpenClawStateDatabase(options)
        .db.prepare("SELECT count(*) AS count FROM delegate_artifact_bindings")
        .get(),
    ).toEqual({ count: 0 });

    closeOpenClawStateDatabaseForTest();
    const malformedOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), malformedOptions);
    publish(malformedOptions);
    openOpenClawStateDatabase(malformedOptions)
      .db.prepare("UPDATE delegate_artifact_policies SET recipients_json = ?")
      .run(
        JSON.stringify([
          {
            sessionKey: "agent:main:parent",
            sessionId: "parent-session-1",
            relation: "parent",
          },
          {
            sessionKey: "agent:main:target",
            sessionId: "target-session-1",
            relation: "inter_session",
          },
        ]),
      );
    expect(finalize(malformedOptions)).toEqual({
      status: "failed",
      disposition: "global-failed(malformed-policy)",
    });
    expect(
      openOpenClawStateDatabase(malformedOptions)
        .db.prepare(
          "SELECT delegate_artifact_claims.status AS status, backing, completion_disposition FROM delegate_artifact_claims JOIN delegate_artifact_policies USING (flow_id)",
        )
        .get(),
    ).toEqual({
      status: "purged",
      backing: null,
      completion_disposition: "global-failed(malformed-policy)",
    });

    closeOpenClawStateDatabaseForTest();
    const revokeOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), revokeOptions);
    publish(revokeOptions);
    const finalized = finalize(revokeOptions);
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    const projection = finalized.projections.get("agent:main:parent")!;
    recordDelegateArtifactDelivery({
      projection,
      phase: "attempt",
      now: 9_900,
      options: revokeOptions,
    });
    recordDelegateArtifactDelivery({
      projection,
      phase: "acknowledged",
      now: 9_950,
      options: revokeOptions,
    });
    const claimId = projection.artifacts[0]!.id;
    expect(
      readDelegateArtifactForMaterialization({
        claimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options: revokeOptions,
      }),
    ).toMatchObject({ outcome: "available" });
    expect(
      discardDelegateArtifactForRecipient({
        claimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options: revokeOptions,
      }),
    ).toEqual({ outcome: "available" });
    expect(
      inspectDelegateArtifactForRecipient({
        claimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options: revokeOptions,
      }),
    ).toEqual({ outcome: "revoked" });

    expect(
      purgeExpiredDelegateArtifacts(1_000 + DELEGATE_ARTIFACT_RETENTION_MS, revokeOptions),
    ).toBe(1);
    expect(
      inspectDelegateArtifactForRecipient({
        claimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 1_000 + DELEGATE_ARTIFACT_RETENTION_MS,
        options: revokeOptions,
      }),
    ).toEqual({ outcome: "expired" });
    closeOpenClawStateDatabaseForTest();
    const expiryOptions = stateOptions();
    createDelegateArtifactPolicy(policy(), expiryOptions);
    publish(expiryOptions);
    const expiring = finalize(expiryOptions);
    if (expiring.status !== "finalized") {
      throw new Error("expected expiring claims");
    }
    const expiringProjection = expiring.projections.get("agent:main:parent");
    if (!expiringProjection) {
      throw new Error("expected expiring parent projection");
    }
    recordDelegateArtifactDelivery({
      projection: expiringProjection,
      phase: "attempt",
      now: 9_900,
      options: expiryOptions,
    });
    recordDelegateArtifactDelivery({
      projection: expiringProjection,
      phase: "acknowledged",
      now: 9_950,
      options: expiryOptions,
    });
    purgeExpiredDelegateArtifacts(1_000 + DELEGATE_ARTIFACT_RETENTION_MS, expiryOptions);
    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 1_000 + DELEGATE_ARTIFACT_RETENTION_MS,
        options: expiryOptions,
      }),
    ).toEqual({ outcome: "expired" });
  });

  it("lists a live flow without historical expired or discarded flows poisoning it", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(
      policy({
        flowId: "00-expired-flow",
        producerRunId: "expired-run",
      }),
      options,
    );
    publish(options, "expired-publication", "expired-run");
    const expired = finalize(options, {
      producerRunId: "expired-run",
      completionId: "expired-completion",
      finalizationKey: "expired-finalization",
    });
    if (expired.status !== "finalized") {
      throw new Error("expected expired flow finalization");
    }
    const expiredProjection = expired.projections.get("agent:main:parent");
    if (!expiredProjection) {
      throw new Error("expected expired parent projection");
    }
    recordDelegateArtifactDelivery({
      projection: expiredProjection,
      phase: "attempt",
      now: 9_900,
      options,
    });
    recordDelegateArtifactDelivery({
      projection: expiredProjection,
      phase: "acknowledged",
      now: 9_950,
      options,
    });

    createDelegateArtifactPolicy(
      policy({
        flowId: "zz-live-flow",
        producerRunId: "live-run",
        dispatchAcceptedAt: 2_000,
        scheduledAt: 2_100,
        notBefore: 32_100,
      }),
      options,
    );
    publish(options, "live-publication", "live-run");
    const live = finalize(options, {
      producerRunId: "live-run",
      completionId: "live-completion",
      finalizationKey: "live-finalization",
    });
    if (live.status !== "finalized") {
      throw new Error("expected live flow finalization");
    }
    const liveProjection = live.projections.get("agent:main:parent");
    if (!liveProjection) {
      throw new Error("expected live parent projection");
    }
    recordDelegateArtifactDelivery({
      projection: liveProjection,
      phase: "attempt",
      now: 10_000,
      options,
    });
    recordDelegateArtifactDelivery({
      projection: liveProjection,
      phase: "acknowledged",
      now: 10_050,
      options,
    });
    const expiredAt = 1_000 + DELEGATE_ARTIFACT_RETENTION_MS;

    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: expiredAt,
        options,
      }),
    ).toEqual({
      outcome: "available",
      artifacts: liveProjection.artifacts,
    });

    const expiredClaimId = expiredProjection.artifacts[0]?.id;
    if (!expiredClaimId) {
      throw new Error("expected expired claim");
    }
    expect(
      discardDelegateArtifactForRecipient({
        claimId: expiredClaimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_100,
        options,
      }),
    ).toEqual({ outcome: "available" });
    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_200,
        options,
      }),
    ).toEqual({
      outcome: "available",
      artifacts: liveProjection.artifacts,
    });
    expect(
      listDelegateArtifactsForRecipient({
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 2_000 + DELEGATE_ARTIFACT_RETENTION_MS,
        options,
      }),
    ).toEqual({ outcome: "expired" });
  });

  it("purges backing bytes after restart without losing recipient isolation or provenance", () => {
    const options = stateOptions();
    createDelegateArtifactPolicy(policy(), options);
    publish(options);
    const finalized = finalize(options);
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claims");
    }
    for (const projection of finalized.projections.values()) {
      recordDelegateArtifactDelivery({
        projection,
        phase: "attempt",
        now: 9_900,
        options,
      });
      recordDelegateArtifactDelivery({
        projection,
        phase: "acknowledged",
        now: 9_950,
        options,
      });
    }
    const claimId = finalized.projections.get("agent:main:parent")?.artifacts[0]?.id;
    if (!claimId) {
      throw new Error("expected finalized claim");
    }
    expect(
      discardDelegateArtifactForRecipient({
        claimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options,
      }),
    ).toEqual({ outcome: "available" });
    expect(
      inspectDelegateArtifactForRecipient({
        claimId,
        recipientSessionKey: "agent:main:parent",
        recipientSessionId: "parent-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options,
      }),
    ).toEqual({ outcome: "revoked" });
    expect(
      readDelegateArtifactForMaterialization({
        claimId,
        recipientSessionKey: "agent:main:target",
        recipientSessionId: "target-session-1",
        runtimeEnabled: true,
        crossSessionEnabled: true,
        now: 10_000,
        options,
      }),
    ).toMatchObject({ outcome: "available" });

    const db = openOpenClawStateDatabase(options).db;
    const auditBeforeRestart = db
      .prepare("SELECT * FROM delegate_artifact_audit ORDER BY sequence")
      .all();
    closeOpenClawStateDatabaseForTest();

    const expiredAt = 1_000 + DELEGATE_ARTIFACT_RETENTION_MS;
    expect(purgeExpiredDelegateArtifacts(expiredAt, options)).toBe(1);
    expect(purgeExpiredDelegateArtifacts(expiredAt, options)).toBe(0);
    closeOpenClawStateDatabaseForTest();

    for (const recipient of [
      {
        sessionKey: "agent:main:parent",
        sessionId: "parent-session-1",
      },
      {
        sessionKey: "agent:main:target",
        sessionId: "target-session-1",
      },
    ]) {
      expect(
        inspectDelegateArtifactForRecipient({
          claimId,
          recipientSessionKey: recipient.sessionKey,
          recipientSessionId: recipient.sessionId,
          runtimeEnabled: true,
          crossSessionEnabled: true,
          now: expiredAt,
          options,
        }),
      ).toEqual({ outcome: "expired" });
      expect(
        listDelegateArtifactsForRecipient({
          recipientSessionKey: recipient.sessionKey,
          recipientSessionId: recipient.sessionId,
          runtimeEnabled: true,
          crossSessionEnabled: true,
          now: expiredAt,
          options,
        }),
      ).toEqual({ outcome: "expired" });
      expect(
        readDelegateArtifactForMaterialization({
          claimId,
          recipientSessionKey: recipient.sessionKey,
          recipientSessionId: recipient.sessionId,
          runtimeEnabled: true,
          crossSessionEnabled: true,
          now: expiredAt,
          options,
        }),
      ).toEqual({ outcome: "expired" });
    }

    const reopened = openOpenClawStateDatabase(options).db;
    expect(
      reopened
        .prepare("SELECT status, backing FROM delegate_artifact_claims WHERE claim_id = ?")
        .get(claimId),
    ).toEqual({ status: "purged", backing: null });
    expect(
      reopened.prepare("SELECT count(*) AS count FROM delegate_artifact_policies").get(),
    ).toEqual({ count: 1 });
    expect(
      reopened.prepare("SELECT count(*) AS count FROM delegate_artifact_recipient_outcomes").get(),
    ).toEqual({ count: 2 });
    const auditAfterRestart = reopened
      .prepare("SELECT * FROM delegate_artifact_audit ORDER BY sequence")
      .all();
    expect(auditAfterRestart.slice(0, auditBeforeRestart.length)).toEqual(auditBeforeRestart);
  });
});
