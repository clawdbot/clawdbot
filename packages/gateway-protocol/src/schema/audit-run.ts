// Versioned exact-execution identity and run-discovery projections.
import { type Static, Type } from "typebox";
import { closedObject } from "./closed-object.js";

const ExecutionIdentityRefSchema = Type.String({ minLength: 1, maxLength: 256 });
const ExecutionIdentityDisplayLabelSchema = Type.String({ maxLength: 128 });
const ExecutionIdentityEvidenceStateSchema = Type.Union([
  Type.Literal("present"),
  Type.Literal("absent"),
  Type.Literal("unknown"),
  Type.Literal("unsupported"),
]);
const ExecutionIdentityContextCoverageStateSchema = Type.Union([
  Type.Literal("attribution-only"),
  Type.Literal("unattributed"),
  Type.Literal("unknown"),
  Type.Literal("unsupported"),
]);
const ExecutionIdentityDecisionCoverageStateSchema = Type.Union([
  Type.Literal("enforced"),
  Type.Literal("attribution-only"),
  Type.Literal("unattributed"),
  Type.Literal("unknown"),
  Type.Literal("unsupported"),
]);
const ExecutionIdentityRefArraySchema = Type.Array(ExecutionIdentityRefSchema, { maxItems: 16 });

const ExecutionIdentityPrincipalKindSchema = Type.Union([
  Type.Literal("person"),
  Type.Literal("agent"),
  Type.Literal("service"),
  Type.Literal("schedule"),
  Type.Literal("webhook"),
  Type.Literal("system"),
  Type.Literal("local-account"),
  Type.Literal("runtime"),
]);

export const PrincipalRefV1Schema = closedObject({
  kind: ExecutionIdentityPrincipalKindSchema,
  domainRef: ExecutionIdentityRefSchema,
  principalRef: ExecutionIdentityRefSchema,
  displayLabel: Type.Optional(ExecutionIdentityDisplayLabelSchema),
});

const PrincipalFactV1Schema = closedObject({
  principal: PrincipalRefV1Schema,
  state: ExecutionIdentityEvidenceStateSchema,
});

const SponsorFactV1Schema = closedObject({
  principal: PrincipalRefV1Schema,
  relationshipRef: Type.Optional(ExecutionIdentityRefSchema),
  state: ExecutionIdentityEvidenceStateSchema,
});

const AssuranceKindSchema = Type.Union([
  Type.Literal("durable-profile"),
  Type.Literal("trusted-proxy"),
  Type.Literal("tailscale-whois"),
  Type.Literal("device-proof"),
  Type.Literal("channel-admission"),
  Type.Literal("local-process"),
  Type.Literal("spawn-lineage"),
  Type.Literal("worker-admission"),
  Type.Literal("runtime-binding"),
  Type.Literal("other"),
]);

const AssuranceEvidenceV1Schema = closedObject({
  kind: AssuranceKindSchema,
  evidenceRef: ExecutionIdentityRefSchema,
  strength: Type.Union([
    Type.Literal("self-asserted"),
    Type.Literal("boundary-verified"),
    Type.Literal("cryptographic"),
  ]),
});

const ExecutionIdentityIngressKindSchema = Type.Union([
  Type.Literal("local-cli"),
  Type.Literal("gateway-client"),
  Type.Literal("channel"),
  Type.Literal("api"),
  Type.Literal("schedule"),
  Type.Literal("webhook"),
  Type.Literal("task"),
  Type.Literal("subagent"),
  Type.Literal("acp"),
  Type.Literal("worker"),
  Type.Literal("plugin"),
  Type.Literal("recovery"),
  Type.Literal("system"),
]);

const ExecutionIdentityRuntimeKindSchema = Type.Union([
  Type.Literal("gateway"),
  Type.Literal("embedded"),
  Type.Literal("worker"),
  Type.Literal("plugin-harness"),
  Type.Literal("acp"),
]);

export const ExecutionIdentityContextV1Schema = closedObject({
  schemaVersion: Type.Literal(1),
  contextId: ExecutionIdentityRefSchema,
  executionId: ExecutionIdentityRefSchema,
  runId: ExecutionIdentityRefSchema,
  createdAt: Type.Integer({ minimum: 0 }),
  trustDomain: closedObject({
    kind: Type.Literal("gateway-cell"),
    domainRef: ExecutionIdentityRefSchema,
    state: ExecutionIdentityEvidenceStateSchema,
  }),
  invoker: closedObject({
    principal: Type.Optional(PrincipalRefV1Schema),
    state: ExecutionIdentityEvidenceStateSchema,
  }),
  ingress: closedObject({
    kind: ExecutionIdentityIngressKindSchema,
    sourceRef: Type.Optional(ExecutionIdentityRefSchema),
    boundary: ExecutionIdentityRefSchema,
    state: ExecutionIdentityEvidenceStateSchema,
  }),
  agentPrincipal: PrincipalRefV1Schema,
  agentDefinition: closedObject({
    definitionRef: ExecutionIdentityRefSchema,
    revisionRef: Type.Optional(ExecutionIdentityRefSchema),
    state: ExecutionIdentityEvidenceStateSchema,
  }),
  runtimeInstance: closedObject({
    runtimeRef: ExecutionIdentityRefSchema,
    kind: ExecutionIdentityRuntimeKindSchema,
    state: ExecutionIdentityEvidenceStateSchema,
  }),
  representedSubject: Type.Optional(PrincipalFactV1Schema),
  sponsor: Type.Optional(SponsorFactV1Schema),
  applicableGrants: Type.Array(
    closedObject({
      grantRef: ExecutionIdentityRefSchema,
      state: ExecutionIdentityEvidenceStateSchema,
    }),
    { maxItems: 16 },
  ),
  assurance: Type.Array(AssuranceEvidenceV1Schema, { maxItems: 16 }),
  lineage: Type.Optional(
    closedObject({
      parentContextId: Type.Optional(ExecutionIdentityRefSchema),
      parentExecutionId: Type.Optional(ExecutionIdentityRefSchema),
      parentRunId: Type.Optional(ExecutionIdentityRefSchema),
      parentAgentPrincipal: Type.Optional(PrincipalRefV1Schema),
      delegationRef: Type.Optional(ExecutionIdentityRefSchema),
      depth: Type.Integer({ minimum: 0, maximum: 64 }),
    }),
  ),
  coverageState: ExecutionIdentityContextCoverageStateSchema,
  missingEvidence: ExecutionIdentityRefArraySchema,
});

const ExecutionIdentityRemediationV1Schema = closedObject({
  code: ExecutionIdentityRefSchema,
  text: Type.String({ minLength: 1, maxLength: 512 }),
});

export const DecisionReceiptV1Schema = closedObject({
  schemaVersion: Type.Literal(1),
  receiptId: ExecutionIdentityRefSchema,
  contextId: ExecutionIdentityRefSchema,
  executionId: ExecutionIdentityRefSchema,
  runId: ExecutionIdentityRefSchema,
  actionId: Type.Optional(ExecutionIdentityRefSchema),
  occurredAt: Type.Integer({ minimum: 0 }),
  action: closedObject({
    family: ExecutionIdentityRefSchema,
    operation: ExecutionIdentityRefSchema,
    resourceRef: Type.Optional(ExecutionIdentityRefSchema),
    targetRef: Type.Optional(ExecutionIdentityRefSchema),
    summary: Type.Optional(Type.String({ maxLength: 512 })),
  }),
  decision: closedObject({
    outcome: Type.Union([
      Type.Literal("allowed"),
      Type.Literal("denied"),
      Type.Literal("not-applicable"),
      Type.Literal("unknown"),
    ]),
    reasonCode: ExecutionIdentityRefSchema,
  }),
  enforcement: closedObject({
    coverageState: ExecutionIdentityDecisionCoverageStateSchema,
    evaluatorRef: Type.Optional(ExecutionIdentityRefSchema),
    policyRefs: ExecutionIdentityRefArraySchema,
    grantRefs: ExecutionIdentityRefArraySchema,
    contextFieldsUsed: ExecutionIdentityRefArraySchema,
  }),
  source: closedObject({
    owner: ExecutionIdentityRefSchema,
    recordRef: ExecutionIdentityRefSchema,
    decisionBoundary: ExecutionIdentityRefSchema,
  }),
  missingEvidence: ExecutionIdentityRefArraySchema,
  remediation: Type.Array(ExecutionIdentityRemediationV1Schema, { maxItems: 8 }),
});

const DecisionReceiptDisplayProvenanceV1Schema = Type.Union([
  closedObject({
    state: Type.Literal("verified"),
    producer: Type.Union([
      Type.Literal("run-admission"),
      Type.Literal("operator-approval"),
      Type.Literal("message-delivery"),
    ]),
  }),
  closedObject({ state: Type.Literal("unverified") }),
]);

export const DecisionReceiptDisplayV1Schema = closedObject({
  schemaVersion: Type.Literal(1),
  selectorId: ExecutionIdentityRefSchema,
  occurredAt: Type.Integer({ minimum: 0 }),
  action: closedObject({
    family: ExecutionIdentityRefSchema,
    operation: ExecutionIdentityRefSchema,
    summary: Type.Optional(Type.String({ maxLength: 512 })),
  }),
  decision: closedObject({
    outcome: Type.Union([
      Type.Literal("allowed"),
      Type.Literal("denied"),
      Type.Literal("not-applicable"),
      Type.Literal("unknown"),
    ]),
    reasonCode: ExecutionIdentityRefSchema,
  }),
  enforcement: closedObject({
    coverageState: ExecutionIdentityDecisionCoverageStateSchema,
    policyCount: Type.Integer({ minimum: 0, maximum: 16 }),
    grantCount: Type.Integer({ minimum: 0, maximum: 16 }),
    contextFieldsUsed: ExecutionIdentityRefArraySchema,
  }),
  provenance: DecisionReceiptDisplayProvenanceV1Schema,
  missingEvidence: ExecutionIdentityRefArraySchema,
  remediation: Type.Array(ExecutionIdentityRemediationV1Schema, { maxItems: 8 }),
});

export const AuditRunIdentityPresentV1Schema = closedObject({
  state: Type.Literal("present"),
  context: ExecutionIdentityContextV1Schema,
});

export const AuditRunIdentityUnknownV1Schema = closedObject({
  state: Type.Literal("unknown"),
  reasonCode: ExecutionIdentityRefSchema,
  missingEvidence: ExecutionIdentityRefArraySchema,
  remediation: Type.Array(ExecutionIdentityRemediationV1Schema, { maxItems: 8 }),
});

export const AuditRunIdentityUnsupportedV1Schema = closedObject({
  state: Type.Literal("unsupported"),
  reasonCode: ExecutionIdentityRefSchema,
  missingEvidence: ExecutionIdentityRefArraySchema,
  remediation: Type.Array(ExecutionIdentityRemediationV1Schema, { maxItems: 8 }),
});

export const AuditRunIdentityAmbiguousV1Schema = closedObject({
  state: Type.Literal("ambiguous"),
  reasonCode: ExecutionIdentityRefSchema,
  candidates: Type.Array(
    closedObject({
      executionId: ExecutionIdentityRefSchema,
      contextId: ExecutionIdentityRefSchema,
      createdAt: Type.Integer({ minimum: 0 }),
    }),
    { maxItems: 50 },
  ),
  missingEvidence: ExecutionIdentityRefArraySchema,
  remediation: Type.Array(ExecutionIdentityRemediationV1Schema, { maxItems: 8 }),
});

export const AuditRunIdentityV1Schema = Type.Union([
  AuditRunIdentityPresentV1Schema,
  AuditRunIdentityUnknownV1Schema,
  AuditRunIdentityUnsupportedV1Schema,
  AuditRunIdentityAmbiguousV1Schema,
]);

const AuditRunDecisionPageParams = {
  decisionCursor: Type.Optional(ExecutionIdentityRefSchema),
  decisionLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};

export const AuditRunInspectParamsSchema = Type.Object(
  {
    runId: Type.Optional(ExecutionIdentityRefSchema),
    executionId: Type.Optional(ExecutionIdentityRefSchema),
    executionCursor: Type.Optional(ExecutionIdentityRefSchema),
    executionLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    ...AuditRunDecisionPageParams,
  },
  {
    additionalProperties: false,
    // Keep exact selection and run discovery mutually exclusive in the exported
    // wire schema so generated clients cannot construct server-rejected requests.
    oneOf: [
      { required: ["runId"], not: { required: ["executionId"] } },
      {
        required: ["executionId"],
        not: {
          anyOf: [
            { required: ["runId"] },
            { required: ["executionCursor"] },
            { required: ["executionLimit"] },
          ],
        },
      },
    ],
  },
);

export const AuditRunInspectResultSchema = closedObject({
  schemaVersion: Type.Literal(1),
  run: closedObject({
    runId: Type.Optional(ExecutionIdentityRefSchema),
    executionId: Type.Optional(ExecutionIdentityRefSchema),
    status: Type.Union([Type.Literal("known"), Type.Literal("unknown")]),
  }),
  identity: AuditRunIdentityV1Schema,
  decisionDisplays: Type.Array(DecisionReceiptDisplayV1Schema, { maxItems: 100 }),
  coverage: closedObject({
    state: ExecutionIdentityDecisionCoverageStateSchema,
    missingEvidence: ExecutionIdentityRefArraySchema,
  }),
  nextDecisionCursor: Type.Optional(ExecutionIdentityRefSchema),
  nextExecutionCursor: Type.Optional(ExecutionIdentityRefSchema),
});

export type PrincipalRefV1 = Static<typeof PrincipalRefV1Schema>;
export type ExecutionIdentityContextV1 = Static<typeof ExecutionIdentityContextV1Schema>;
export type DecisionReceiptV1 = Static<typeof DecisionReceiptV1Schema>;
export type DecisionReceiptDisplayV1 = Static<typeof DecisionReceiptDisplayV1Schema>;
export type AuditRunIdentityV1 = Static<typeof AuditRunIdentityV1Schema>;
type AuditRunDecisionPage = {
  decisionCursor?: string;
  decisionLimit?: number;
};
export type AuditRunInspectParams =
  | (AuditRunDecisionPage & {
      runId: string;
      executionId?: never;
      executionCursor?: string;
      executionLimit?: number;
    })
  | (AuditRunDecisionPage & {
      executionId: string;
      runId?: never;
      executionCursor?: never;
      executionLimit?: never;
    });
export type AuditRunInspectResult = Static<typeof AuditRunInspectResultSchema>;
