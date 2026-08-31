import {
  parseReturnCovenantDriverAttestation,
  parseReturnCovenantPhaseRequest,
  parseReturnCovenantPlan,
  sha256ReturnCovenant,
  type ReturnCovenantDriverAttestation,
  type ReturnCovenantEffects,
  type ReturnCovenantForm,
  type ReturnCovenantPhase,
  type ReturnCovenantPhaseRequest,
  type ReturnCovenantPlan,
} from "./protocol.js";

const allowedEffects = {
  "allowed-ordinary-new": {
    promptAdoptions: 1,
    wakes: 1,
    channelDeliveries: 0,
  },
  "allowed-ordinary-reset": {
    promptAdoptions: 1,
    wakes: 1,
    channelDeliveries: 1,
  },
  "allowed-provider-fallback": {
    promptAdoptions: 1,
    wakes: 0,
    channelDeliveries: 0,
  },
  "allowed-compaction": {
    promptAdoptions: 1,
    wakes: 1,
    channelDeliveries: 0,
  },
  "allowed-gateway-restart-replay": {
    promptAdoptions: 1,
    wakes: 1,
    channelDeliveries: 0,
  },
  "allowed-session-id-rollover": {
    promptAdoptions: 1,
    wakes: 1,
    channelDeliveries: 1,
  },
  "allowed-late-materialization": {
    promptAdoptions: 1,
    wakes: 1,
    channelDeliveries: 0,
  },
} as const satisfies Record<string, ReturnCovenantEffects>;

const zeroEffects = {
  promptAdoptions: 0,
  wakes: 0,
  channelDeliveries: 0,
} as const;

const definitions = [
  ["allowed-ordinary-new", "ordinary-new", "silent-wake", "fresh-v19"],
  ["allowed-ordinary-reset", "ordinary-reset", "normal", "covenant-v18-upgrade"],
  ["allowed-provider-fallback", "provider-fallback", "silent", "participant-v18-upgrade"],
  ["allowed-compaction", "compaction", "post-compaction", "idempotent-v19-reopen"],
  ["allowed-gateway-restart-replay", "gateway-restart-replay", "silent-wake", "fresh-v19"],
  ["allowed-session-id-rollover", "session-id-rollover", "normal", "covenant-v18-upgrade"],
  [
    "allowed-late-materialization",
    "late-recipient-materialization",
    "silent-wake",
    "participant-v18-upgrade",
  ],
  ["forbidden-delete-recreate", "explicit-delete-recreate", "normal", "idempotent-v19-reopen"],
  ["forbidden-owner-reassignment", "effective-owner-reassignment", "silent-wake", "fresh-v19"],
  [
    "forbidden-member-access-removal",
    "actual-member-access-removal",
    "silent",
    "covenant-v18-upgrade",
  ],
  [
    "forbidden-restrictive-visibility",
    "restrictive-visibility-change",
    "normal",
    "participant-v18-upgrade",
  ],
  ["forbidden-explicit-revocation", "explicit-revocation", "silent-wake", "idempotent-v19-reopen"],
] as const;

export function createReturnCovenantTestPlan(): ReturnCovenantPlan {
  const runId = "rcv-00000000000000000000000000000001";
  return parseReturnCovenantPlan({
    schema: "openclaw.k6.return-covenant-fixture-input.v1",
    rowId: "R-CD-RETURN-COVENANT-AUTHORITY",
    runId,
    target: {
      candidateSha: "1".repeat(40),
      productTreeSha: "3".repeat(40),
      runtimeBuildSha: "1".repeat(40),
      docsHarnessSha: "2".repeat(40),
      runtimeConfigRelativePath:
        "tools/k6-proofs/tests/fixtures/return-covenant-authority/runtime-config.valid.json",
      runtimeConfigGitBlob: "4".repeat(40),
      runtimeConfigSha256: "a".repeat(64),
      runtimeArtifactManifestSha256: "d".repeat(64),
    },
    driver: {
      schema: "openclaw.k6.return-covenant-fixture-driver.v1",
      ownership: "product",
      fixtureCommand: {
        status: "available",
        relativePath: "scripts/return-covenant-fixture-driver.mjs",
        sha256: "b".repeat(64),
      },
      gatewayCommand: {
        relativePath: "openclaw.mjs",
        sha256: "c".repeat(64),
        args: ["gateway"],
      },
    },
    settlementWindowMs: 1000,
    isolation: {
      home: "temporary-isolated",
      state: "temporary-isolated",
      config: "temporary-isolated",
      syntheticData: true,
    },
    syntheticChannelKey: `synthetic:proof:${runId}:channel`,
    cases: definitions.map(([id, lifecycleEdge, returnMode, databaseProfile]) => {
      const expected = id.startsWith("allowed-")
        ? allowedEffects[id as keyof typeof allowedEffects]
        : zeroEffects;
      return Object.assign(
        {
          id,
          kind: id.startsWith("allowed-") ? "allowed" : "forbidden",
          lifecycleEdge,
          returnMode,
          logicalSessionKey: `agent:proof:${runId}:${id}`,
          databaseProfile,
          forms: ["typed-tool", "bracket-token"],
          expectedEffects: {
            "typed-tool": expected,
            "bracket-token": expected,
          },
          restartBetweenAcceptanceAndRelease: id === "allowed-gateway-restart-replay",
        },
        id === "forbidden-explicit-revocation"
          ? { applicability: "required-if-exposed" as const }
          : {},
      );
    }),
  });
}

export function createReturnCovenantTestAttestation(
  plan: ReturnCovenantPlan,
): ReturnCovenantDriverAttestation {
  return parseReturnCovenantDriverAttestation({
    schema: "openclaw.k6.return-covenant-driver-attestation.v1",
    runId: plan.runId,
    rowId: plan.rowId,
    candidateSha: plan.target.candidateSha,
    productTreeSha: plan.target.productTreeSha,
    runtimeBuildSha: plan.target.runtimeBuildSha,
    docsHarnessSha: plan.target.docsHarnessSha,
    runtimeConfigSha256: plan.target.runtimeConfigSha256,
    attestationSha256: "e".repeat(64),
    launchNonceFingerprint: sha256ReturnCovenant("return-covenant-test-launch-nonce"),
    phaseChallenge: "return-covenant-test-launch-nonce",
    phaseKeyFingerprint: sha256ReturnCovenant("return-covenant-test-phase-signing-key"),
    process: {
      startFingerprint: "f".repeat(64),
      endpointSocketFingerprint: "9".repeat(64),
    },
    gatewayCommand: { sha256: plan.driver.gatewayCommand.sha256 },
    isolation: { processGroupId: 42 },
  });
}

let requestSequence = 0;

export function createReturnCovenantTestRequest(params: {
  caseHandle?: string;
  casePlan: ReturnCovenantPlan["cases"][number];
  form: ReturnCovenantForm;
  phase: ReturnCovenantPhase;
  plan: ReturnCovenantPlan;
  acceptance?: {
    capturedAuthorityGeneration: string;
    heldResultId: string;
    receiptId: string;
    resultMarker: string;
  };
  transition?: { receiptId: string };
  cleanupBindings?: {
    observationSetSha256: string;
    phaseChainSha256: string;
    driverAttestationSha256: string;
  };
  fallback?: true;
}): ReturnCovenantPhaseRequest {
  requestSequence += 1;
  const driverBinding = {
    attestationSha256: "e".repeat(64),
    challenge: "return-covenant-test-launch-nonce",
    launchNonceFingerprint: sha256ReturnCovenant("return-covenant-test-launch-nonce"),
    processStartFingerprint: "f".repeat(64),
    endpointSocketFingerprint: "9".repeat(64),
    runtimeConfigSha256: params.plan.target.runtimeConfigSha256,
    requestNonce: sha256ReturnCovenant(`request-${requestSequence}`),
  };
  const identity = {
    schema: "openclaw.k6.return-covenant-fixture-driver.v1",
    runId: params.plan.runId,
    rowId: params.plan.rowId,
    candidateSha: params.plan.target.candidateSha,
    productTreeSha: params.plan.target.productTreeSha,
    docsHarnessSha: params.plan.target.docsHarnessSha,
    runtimeConfigSha256: params.plan.target.runtimeConfigSha256,
    runtimeArtifactManifestSha256: params.plan.target.runtimeArtifactManifestSha256,
  };
  if (params.phase === "cleanup-run") {
    return parseReturnCovenantPhaseRequest({
      ...identity,
      phase: params.phase,
      ...(params.fallback ? { fallback: true } : params.cleanupBindings),
      driverBinding,
    });
  }
  const common = {
    ...identity,
    phase: params.phase,
    caseId: params.casePlan.id,
    form: params.form,
    kind: params.casePlan.kind,
    lifecycleEdge: params.casePlan.lifecycleEdge,
    driverBinding,
  };
  if (params.phase === "prepare") {
    return parseReturnCovenantPhaseRequest({
      ...common,
      databaseProfile: params.casePlan.databaseProfile,
      logicalSessionKey: params.casePlan.logicalSessionKey,
      syntheticChannelKey: params.plan.syntheticChannelKey,
      returnMode: params.casePlan.returnMode,
      expectedEffects: params.casePlan.expectedEffects[params.form],
      settlementWindowMs: params.plan.settlementWindowMs,
    });
  }
  if (!params.caseHandle) {
    throw new Error(`${params.phase} test request requires a case handle`);
  }
  if (params.phase === "dispatch") {
    return parseReturnCovenantPhaseRequest({
      ...common,
      caseHandle: params.caseHandle,
      holdCompletion: true,
    });
  }
  if (params.phase === "cleanup") {
    return parseReturnCovenantPhaseRequest({
      ...common,
      caseHandle: params.caseHandle,
      settlementWindowMs: params.plan.settlementWindowMs,
    });
  }
  if (params.phase === "observe") {
    return parseReturnCovenantPhaseRequest({
      ...common,
      caseHandle: params.caseHandle,
      settlementWindowMs: params.plan.settlementWindowMs,
    });
  }
  if (!params.acceptance) {
    throw new Error(`${params.phase} test request requires acceptance`);
  }
  if (params.phase === "transition") {
    return parseReturnCovenantPhaseRequest({
      ...common,
      caseHandle: params.caseHandle,
      acceptedDispatchReceiptId: params.acceptance.receiptId,
      capturedAuthorityGeneration: params.acceptance.capturedAuthorityGeneration,
      restartBetweenAcceptanceAndRelease: params.casePlan.restartBetweenAcceptanceAndRelease,
    });
  }
  if (!params.transition) {
    throw new Error("release test request requires transition");
  }
  return parseReturnCovenantPhaseRequest({
    ...common,
    caseHandle: params.caseHandle,
    acceptedDispatchReceiptId: params.acceptance.receiptId,
    heldResultId: params.acceptance.heldResultId,
    resultMarker: params.acceptance.resultMarker,
    capturedAuthorityGeneration: params.acceptance.capturedAuthorityGeneration,
    transitionReceiptId: params.transition.receiptId,
  });
}
