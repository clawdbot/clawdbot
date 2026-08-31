import { createHash, createHmac } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { z } from "zod";

export const RETURN_COVENANT_DRIVER_PROTOCOL = "openclaw.k6.return-covenant-fixture-driver.v1";
export const RETURN_COVENANT_DRIVER_READY_SCHEMA = "openclaw.k6.return-covenant-driver-ready.v1";
export const RETURN_COVENANT_DRIVER_ATTESTATION_SCHEMA =
  "openclaw.k6.return-covenant-driver-attestation.v1";
export const RETURN_COVENANT_ROW_ID = "R-CD-RETURN-COVENANT-AUTHORITY";

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^rcv-[0-9a-f]{32}$/u;
const CASE_HANDLE = /^[a-z0-9-]{16,128}$/u;

export const RETURN_COVENANT_CASE_IDS = [
  "allowed-ordinary-new",
  "allowed-ordinary-reset",
  "allowed-provider-fallback",
  "allowed-compaction",
  "allowed-gateway-restart-replay",
  "allowed-session-id-rollover",
  "allowed-late-materialization",
  "forbidden-delete-recreate",
  "forbidden-owner-reassignment",
  "forbidden-member-access-removal",
  "forbidden-restrictive-visibility",
  "forbidden-explicit-revocation",
] as const;

export type ReturnCovenantCaseId = (typeof RETURN_COVENANT_CASE_IDS)[number];
export type ReturnCovenantForm = "typed-tool" | "bracket-token";
export type ReturnCovenantPhase =
  | "prepare"
  | "dispatch"
  | "transition"
  | "release"
  | "observe"
  | "cleanup"
  | "cleanup-run";

const lifecycleByCase = {
  "allowed-ordinary-new": "ordinary-new",
  "allowed-ordinary-reset": "ordinary-reset",
  "allowed-provider-fallback": "provider-fallback",
  "allowed-compaction": "compaction",
  "allowed-gateway-restart-replay": "gateway-restart-replay",
  "allowed-session-id-rollover": "session-id-rollover",
  "allowed-late-materialization": "late-recipient-materialization",
  "forbidden-delete-recreate": "explicit-delete-recreate",
  "forbidden-owner-reassignment": "effective-owner-reassignment",
  "forbidden-member-access-removal": "actual-member-access-removal",
  "forbidden-restrictive-visibility": "restrictive-visibility-change",
  "forbidden-explicit-revocation": "explicit-revocation",
} as const satisfies Record<ReturnCovenantCaseId, string>;

const effectsSchema = z
  .object({
    promptAdoptions: z.number().int().min(0).max(1),
    wakes: z.number().int().min(0).max(1),
    channelDeliveries: z.number().int().min(0).max(1),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.enum(RETURN_COVENANT_CASE_IDS),
    kind: z.enum(["allowed", "forbidden"]),
    lifecycleEdge: z.enum([
      "ordinary-new",
      "ordinary-reset",
      "provider-fallback",
      "compaction",
      "gateway-restart-replay",
      "session-id-rollover",
      "late-recipient-materialization",
      "explicit-delete-recreate",
      "effective-owner-reassignment",
      "actual-member-access-removal",
      "restrictive-visibility-change",
      "explicit-revocation",
    ]),
    returnMode: z.enum(["normal", "silent", "silent-wake", "post-compaction"]),
    logicalSessionKey: z.string().min(1).max(4096),
    databaseProfile: z.enum([
      "fresh-v19",
      "covenant-v18-upgrade",
      "participant-v18-upgrade",
      "idempotent-v19-reopen",
    ]),
    forms: z.tuple([z.literal("typed-tool"), z.literal("bracket-token")]),
    expectedEffects: z
      .object({
        "typed-tool": effectsSchema,
        "bracket-token": effectsSchema,
      })
      .strict(),
    restartBetweenAcceptanceAndRelease: z.boolean(),
    applicability: z.literal("required-if-exposed").optional(),
  })
  .strict();

const planSchema = z
  .object({
    schema: z.literal("openclaw.k6.return-covenant-fixture-input.v1"),
    rowId: z.literal(RETURN_COVENANT_ROW_ID),
    runId: z.string().regex(RUN_ID),
    target: z
      .object({
        candidateSha: z.string().regex(SHA40),
        productTreeSha: z.string().regex(SHA40),
        runtimeBuildSha: z.string().regex(SHA40),
        docsHarnessSha: z.string().regex(SHA40),
        runtimeConfigRelativePath: z.string().min(1),
        runtimeConfigGitBlob: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
        runtimeConfigSha256: z.string().regex(SHA256),
        runtimeArtifactManifestSha256: z.string().regex(SHA256),
      })
      .strict(),
    driver: z
      .object({
        schema: z.literal(RETURN_COVENANT_DRIVER_PROTOCOL),
        ownership: z.literal("product"),
        fixtureCommand: z
          .object({
            status: z.literal("available"),
            relativePath: z.string().min(1),
            sha256: z.string().regex(SHA256),
          })
          .strict(),
        gatewayCommand: z
          .object({
            relativePath: z.string().min(1),
            sha256: z.string().regex(SHA256),
            args: z.tuple([z.literal("gateway")]),
          })
          .strict(),
      })
      .strict(),
    settlementWindowMs: z.number().int().min(1000).max(30_000),
    isolation: z
      .object({
        home: z.literal("temporary-isolated"),
        state: z.literal("temporary-isolated"),
        config: z.literal("temporary-isolated"),
        syntheticData: z.literal(true),
      })
      .strict(),
    syntheticChannelKey: z.string().min(1),
    cases: z.array(caseSchema).length(RETURN_COVENANT_CASE_IDS.length),
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.target.runtimeBuildSha !== plan.target.candidateSha) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target", "runtimeBuildSha"],
        message: "runtime build SHA must equal the candidate SHA",
      });
    }
    if (plan.syntheticChannelKey !== `synthetic:proof:${plan.runId}:channel`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["syntheticChannelKey"],
        message: "synthetic channel key is not derived from the run ID",
      });
    }
    for (const [index, expectedId] of RETURN_COVENANT_CASE_IDS.entries()) {
      const entry = plan.cases[index];
      if (!entry || entry.id !== expectedId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "id"],
          message: `case order must contain ${expectedId}`,
        });
        continue;
      }
      const expectedKind = expectedId.startsWith("allowed-") ? "allowed" : "forbidden";
      if (entry.kind !== expectedKind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "kind"],
          message: `case ${expectedId} must be ${expectedKind}`,
        });
      }
      if (entry.lifecycleEdge !== lifecycleByCase[expectedId]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "lifecycleEdge"],
          message: `case ${expectedId} has the wrong lifecycle edge`,
        });
      }
      if (entry.logicalSessionKey !== `agent:proof:${plan.runId}:${expectedId}`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "logicalSessionKey"],
          message: `case ${expectedId} has a noncanonical logical session key`,
        });
      }
      const expectsRestart = expectedId === "allowed-gateway-restart-replay";
      if (entry.restartBetweenAcceptanceAndRelease !== expectsRestart) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "restartBetweenAcceptanceAndRelease"],
          message: `case ${expectedId} has the wrong restart contract`,
        });
      }
    }
    const profiles = new Set(plan.cases.map((entry) => entry.databaseProfile));
    for (const profile of [
      "fresh-v19",
      "covenant-v18-upgrade",
      "participant-v18-upgrade",
      "idempotent-v19-reopen",
    ] as const) {
      if (!profiles.has(profile)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases"],
          message: `database profile ${profile} is not covered`,
        });
      }
    }
  });

export type ReturnCovenantPlan = z.infer<typeof planSchema>;
export type ReturnCovenantCasePlan = ReturnCovenantPlan["cases"][number];
export type ReturnCovenantEffects = z.infer<typeof effectsSchema>;

const driverBindingSchema = z
  .object({
    attestationSha256: z.string().regex(SHA256),
    challenge: z.string().min(24),
    launchNonceFingerprint: z.string().regex(SHA256),
    processStartFingerprint: z.string().regex(SHA256),
    endpointSocketFingerprint: z.string().regex(SHA256),
    runtimeConfigSha256: z.string().regex(SHA256),
    requestNonce: z.string().regex(SHA256),
  })
  .strict();

const commonCaseRequest = {
  schema: z.literal(RETURN_COVENANT_DRIVER_PROTOCOL),
  runId: z.string().regex(RUN_ID),
  rowId: z.literal(RETURN_COVENANT_ROW_ID),
  caseId: z.enum(RETURN_COVENANT_CASE_IDS),
  form: z.enum(["typed-tool", "bracket-token"]),
  kind: z.enum(["allowed", "forbidden"]),
  lifecycleEdge: caseSchema.shape.lifecycleEdge,
  candidateSha: z.string().regex(SHA40),
  productTreeSha: z.string().regex(SHA40),
  docsHarnessSha: z.string().regex(SHA40),
  runtimeConfigSha256: z.string().regex(SHA256),
  runtimeArtifactManifestSha256: z.string().regex(SHA256),
  driverBinding: driverBindingSchema,
};

const prepareRequestSchema = z
  .object({
    ...commonCaseRequest,
    phase: z.literal("prepare"),
    databaseProfile: caseSchema.shape.databaseProfile,
    logicalSessionKey: z.string().min(1).max(4096),
    syntheticChannelKey: z.string().min(1),
    returnMode: caseSchema.shape.returnMode,
    expectedEffects: effectsSchema,
    settlementWindowMs: z.number().int().min(1000).max(30_000),
  })
  .strict();

const dispatchRequestSchema = z
  .object({
    ...commonCaseRequest,
    phase: z.literal("dispatch"),
    caseHandle: z.string().regex(CASE_HANDLE),
    holdCompletion: z.literal(true),
  })
  .strict();

const transitionRequestSchema = z
  .object({
    ...commonCaseRequest,
    phase: z.literal("transition"),
    caseHandle: z.string().regex(CASE_HANDLE),
    acceptedDispatchReceiptId: z.string().min(8),
    capturedAuthorityGeneration: z.string().uuid(),
    restartBetweenAcceptanceAndRelease: z.boolean(),
  })
  .strict();

const releaseRequestSchema = z
  .object({
    ...commonCaseRequest,
    phase: z.literal("release"),
    caseHandle: z.string().regex(CASE_HANDLE),
    acceptedDispatchReceiptId: z.string().min(8),
    heldResultId: z.string().min(8),
    resultMarker: z.string().min(24),
    capturedAuthorityGeneration: z.string().uuid(),
    transitionReceiptId: z.string().min(8),
  })
  .strict();

const observeRequestSchema = z
  .object({
    ...commonCaseRequest,
    phase: z.literal("observe"),
    caseHandle: z.string().regex(CASE_HANDLE),
    settlementWindowMs: z.number().int().min(1000).max(30_000),
  })
  .strict();

const cleanupRequestSchema = z
  .object({
    ...commonCaseRequest,
    phase: z.literal("cleanup"),
    caseHandle: z.string().regex(CASE_HANDLE),
    settlementWindowMs: z.number().int().min(1000).max(30_000),
  })
  .strict();

const cleanupRunRequestSchema = z
  .object({
    schema: z.literal(RETURN_COVENANT_DRIVER_PROTOCOL),
    runId: z.string().regex(RUN_ID),
    rowId: z.literal(RETURN_COVENANT_ROW_ID),
    phase: z.literal("cleanup-run"),
    candidateSha: z.string().regex(SHA40),
    productTreeSha: z.string().regex(SHA40),
    docsHarnessSha: z.string().regex(SHA40),
    runtimeConfigSha256: z.string().regex(SHA256),
    runtimeArtifactManifestSha256: z.string().regex(SHA256),
    fallback: z.literal(true).optional(),
    observationSetSha256: z.string().regex(SHA256).optional(),
    phaseChainSha256: z.string().regex(SHA256).optional(),
    driverAttestationSha256: z.string().regex(SHA256).optional(),
    driverBinding: driverBindingSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const evidenceBindingCount = [
      request.observationSetSha256,
      request.phaseChainSha256,
      request.driverAttestationSha256,
    ].filter(Boolean).length;
    if (request.fallback === true ? evidenceBindingCount !== 0 : evidenceBindingCount !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cleanup-run must be either fallback or fully evidence-bound",
      });
    }
  });

const phaseRequestSchema = z.discriminatedUnion("phase", [
  prepareRequestSchema,
  dispatchRequestSchema,
  transitionRequestSchema,
  releaseRequestSchema,
  observeRequestSchema,
  cleanupRequestSchema,
  cleanupRunRequestSchema,
]);

export type ReturnCovenantPhaseRequest = z.infer<typeof phaseRequestSchema>;
export type ReturnCovenantCaseRequest = Exclude<
  ReturnCovenantPhaseRequest,
  { phase: "cleanup-run" }
>;

const attestationSchema = z
  .object({
    schema: z.literal(RETURN_COVENANT_DRIVER_ATTESTATION_SCHEMA),
    runId: z.string().regex(RUN_ID),
    rowId: z.literal(RETURN_COVENANT_ROW_ID),
    candidateSha: z.string().regex(SHA40),
    productTreeSha: z.string().regex(SHA40),
    runtimeBuildSha: z.string().regex(SHA40),
    docsHarnessSha: z.string().regex(SHA40),
    runtimeConfigSha256: z.string().regex(SHA256),
    attestationSha256: z.string().regex(SHA256),
    launchNonceFingerprint: z.string().regex(SHA256),
    phaseChallenge: z.string().min(24),
    phaseKeyFingerprint: z.string().regex(SHA256),
    process: z
      .object({
        startFingerprint: z.string().regex(SHA256),
        endpointSocketFingerprint: z.string().regex(SHA256),
      })
      .passthrough(),
    gatewayCommand: z.object({ sha256: z.string().regex(SHA256) }).passthrough(),
    isolation: z.object({ processGroupId: z.number().int().min(2) }).passthrough(),
  })
  .passthrough();

export type ReturnCovenantDriverAttestation = z.infer<typeof attestationSchema>;

export type ReturnCovenantDriverArgs = {
  cleanupDraftPath: string;
  planPath: string;
  readyPath: string;
};

export class ReturnCovenantProtocolError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ReturnCovenantProtocolError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function parseReturnCovenantDriverArgs(argv: readonly string[]): ReturnCovenantDriverArgs {
  if (argv.length !== 8) {
    throw new ReturnCovenantProtocolError(
      "invalid-arguments",
      "expected --contract, --plan, --ready, and --cleanup-draft",
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || values.has(flag)) {
      throw new ReturnCovenantProtocolError("invalid-arguments", "driver arguments are malformed");
    }
    values.set(flag, value);
  }
  const expected = ["--cleanup-draft", "--contract", "--plan", "--ready"];
  if (
    values.size !== expected.length ||
    expected.some((flag) => !values.has(flag)) ||
    values.get("--contract") !== RETURN_COVENANT_DRIVER_PROTOCOL
  ) {
    throw new ReturnCovenantProtocolError("invalid-arguments", "driver contract is incomplete");
  }
  return {
    cleanupDraftPath: values.get("--cleanup-draft")!,
    planPath: values.get("--plan")!,
    readyPath: values.get("--ready")!,
  };
}

export function parseReturnCovenantPlan(value: unknown): ReturnCovenantPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReturnCovenantProtocolError(
      "invalid-plan",
      `return-covenant plan rejected: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseReturnCovenantPhaseRequest(value: unknown): ReturnCovenantPhaseRequest {
  const parsed = phaseRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReturnCovenantProtocolError(
      "invalid-request",
      `return-covenant phase request rejected: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function parseReturnCovenantDriverAttestation(
  value: unknown,
): ReturnCovenantDriverAttestation {
  const parsed = attestationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReturnCovenantProtocolError(
      "invalid-attestation",
      `return-covenant driver attestation rejected: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function sha256ReturnCovenant(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertRequestIdentity(
  request: ReturnCovenantPhaseRequest,
  plan: ReturnCovenantPlan,
): void {
  if (
    request.runId !== plan.runId ||
    request.rowId !== plan.rowId ||
    request.candidateSha !== plan.target.candidateSha ||
    request.productTreeSha !== plan.target.productTreeSha ||
    request.docsHarnessSha !== plan.target.docsHarnessSha ||
    request.runtimeConfigSha256 !== plan.target.runtimeConfigSha256 ||
    request.runtimeArtifactManifestSha256 !== plan.target.runtimeArtifactManifestSha256
  ) {
    throw new ReturnCovenantProtocolError(
      "identity-mismatch",
      "phase request identity does not match the frozen plan",
    );
  }
  if (request.phase === "cleanup-run") {
    return;
  }
  const plannedCase = plan.cases.find((entry) => entry.id === request.caseId);
  if (
    !plannedCase ||
    request.kind !== plannedCase.kind ||
    request.lifecycleEdge !== plannedCase.lifecycleEdge ||
    !plannedCase.forms.includes(request.form)
  ) {
    throw new ReturnCovenantProtocolError(
      "case-mismatch",
      "phase request does not match its planned case",
    );
  }
  if (
    request.phase === "prepare" &&
    (request.databaseProfile !== plannedCase.databaseProfile ||
      request.logicalSessionKey !== plannedCase.logicalSessionKey ||
      request.syntheticChannelKey !== plan.syntheticChannelKey ||
      request.returnMode !== plannedCase.returnMode ||
      request.settlementWindowMs !== plan.settlementWindowMs ||
      stableStringify(request.expectedEffects) !==
        stableStringify(plannedCase.expectedEffects[request.form]))
  ) {
    throw new ReturnCovenantProtocolError(
      "case-mismatch",
      "prepare request differs from the frozen case",
    );
  }
}

export function authorizeReturnCovenantPhaseRequest(params: {
  attestation: ReturnCovenantDriverAttestation;
  launchNonce: string;
  phaseSigningKey: string;
  plan: ReturnCovenantPlan;
  request: ReturnCovenantPhaseRequest;
  seenRequestNonces: Set<string>;
}): void {
  const { attestation, launchNonce, phaseSigningKey, plan, request, seenRequestNonces } = params;
  assertRequestIdentity(request, plan);
  if (
    attestation.runId !== plan.runId ||
    attestation.rowId !== plan.rowId ||
    attestation.candidateSha !== plan.target.candidateSha ||
    attestation.productTreeSha !== plan.target.productTreeSha ||
    attestation.runtimeBuildSha !== plan.target.runtimeBuildSha ||
    attestation.docsHarnessSha !== plan.target.docsHarnessSha ||
    attestation.runtimeConfigSha256 !== plan.target.runtimeConfigSha256 ||
    attestation.gatewayCommand.sha256 !== plan.driver.gatewayCommand.sha256 ||
    attestation.phaseChallenge !== launchNonce ||
    attestation.launchNonceFingerprint !== sha256ReturnCovenant(launchNonce) ||
    attestation.phaseKeyFingerprint !== sha256ReturnCovenant(phaseSigningKey)
  ) {
    throw new ReturnCovenantProtocolError(
      "attestation-mismatch",
      "trusted launcher attestation does not match this product run",
      409,
    );
  }
  const binding = request.driverBinding;
  if (
    binding.attestationSha256 !== attestation.attestationSha256 ||
    binding.challenge !== launchNonce ||
    binding.launchNonceFingerprint !== attestation.launchNonceFingerprint ||
    binding.processStartFingerprint !== attestation.process.startFingerprint ||
    binding.endpointSocketFingerprint !== attestation.process.endpointSocketFingerprint ||
    binding.runtimeConfigSha256 !== plan.target.runtimeConfigSha256
  ) {
    throw new ReturnCovenantProtocolError(
      "phase-proof-mismatch",
      "phase request does not possess the launcher challenge",
      409,
    );
  }
  if (seenRequestNonces.has(binding.requestNonce)) {
    throw new ReturnCovenantProtocolError(
      "phase-replay",
      "phase request nonce was already consumed",
      409,
    );
  }
  seenRequestNonces.add(binding.requestNonce);
}

function receiptForPhase(phase: ReturnCovenantPhase, payload: Record<string, unknown>): unknown {
  switch (phase) {
    case "prepare":
      return { prepare: payload.prepare, observation: payload.observation ?? null };
    case "dispatch":
      return payload.acceptance;
    case "transition":
      return payload.transition;
    case "release":
      return payload.release;
    case "observe":
      return { settled: payload.settled === true, observation: payload.observation ?? null };
    case "cleanup":
      return payload.cleanup;
    case "cleanup-run":
      return payload.cleanupRun;
    default:
      return phase satisfies never;
  }
}

export function buildSignedReturnCovenantPhaseResponse(params: {
  attestation: ReturnCovenantDriverAttestation;
  payload: Record<string, unknown>;
  phaseSigningKey: string;
  request: ReturnCovenantPhaseRequest;
}): Record<string, unknown> {
  const { attestation, payload, phaseSigningKey, request } = params;
  const receiptSha256 = sha256ReturnCovenant(
    stableStringify(receiptForPhase(request.phase, payload)),
  );
  const binding = {
    phase: request.phase,
    requestNonce: request.driverBinding.requestNonce,
    receiptSha256,
    attestationSha256: attestation.attestationSha256,
    launchNonceFingerprint: attestation.launchNonceFingerprint,
    processStartFingerprint: attestation.process.startFingerprint,
    endpointSocketFingerprint: attestation.process.endpointSocketFingerprint,
    runtimeConfigSha256: attestation.runtimeConfigSha256,
  };
  return {
    schema: RETURN_COVENANT_DRIVER_PROTOCOL,
    phase: request.phase,
    ok: true,
    ...payload,
    driverBinding: {
      ...binding,
      signature: createHmac("sha256", phaseSigningKey)
        .update(stableStringify(binding))
        .digest("hex"),
    },
  };
}
