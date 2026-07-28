// Gateway Protocol schema module defines secret-safe Claw lifecycle inventory payloads.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const ClawLifecycleStateSchema = Type.Union([
  Type.Literal("present"),
  Type.Literal("unchanged"),
  Type.Literal("complete"),
  Type.Literal("modified"),
  Type.Literal("missing"),
  Type.Literal("unsafe"),
  Type.Literal("ambiguous"),
  Type.Literal("incomplete"),
  Type.Literal("pending"),
  Type.Literal("failed"),
  Type.Literal("removed"),
]);

const ClawRelationshipSchema = Type.Union([Type.Literal("managed"), Type.Literal("referenced")]);

const ClawOriginSchema = Type.Union([
  Type.Literal("claw-introduced"),
  Type.Literal("pre-existing"),
]);

export const ClawSetupAnswerValueSchema = Type.Union([
  Type.String({ maxLength: 16_384 }),
  Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
  Type.Boolean(),
  Type.Array(Type.String({ maxLength: 256 }), { maxItems: 64 }),
]);

export const ClawSetupAnswersSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 64 }),
  ClawSetupAnswerValueSchema,
  { maxProperties: 64 },
);

const ClawSetupInputCommon = {
  id: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
  required: Type.Optional(Type.Boolean()),
};

const ClawSetupChoiceOptionSchema = closedObject({
  value: Type.String({ minLength: 1, maxLength: 256 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
});

export const ClawSetupInputSchema = Type.Union([
  closedObject({
    ...ClawSetupInputCommon,
    type: Type.Literal("string"),
    default: Type.Optional(Type.String()),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Integer({ minimum: 1 }),
    format: Type.Optional(Type.Union([Type.Literal("timezone"), Type.Literal("language-tag")])),
  }),
  closedObject({
    ...ClawSetupInputCommon,
    type: Type.Literal("multiline"),
    default: Type.Optional(Type.String()),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Integer({ minimum: 1 }),
  }),
  closedObject({
    ...ClawSetupInputCommon,
    type: Type.Literal("integer"),
    default: Type.Optional(Type.Integer()),
    minimum: Type.Optional(Type.Integer()),
    maximum: Type.Optional(Type.Integer()),
  }),
  closedObject({
    ...ClawSetupInputCommon,
    type: Type.Literal("boolean"),
    default: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    ...ClawSetupInputCommon,
    type: Type.Literal("choice"),
    default: Type.Optional(Type.String()),
    options: Type.Array(ClawSetupChoiceOptionSchema, { maxItems: 64 }),
  }),
  closedObject({
    ...ClawSetupInputCommon,
    type: Type.Literal("multiChoice"),
    default: Type.Optional(Type.Array(Type.String())),
    options: Type.Array(ClawSetupChoiceOptionSchema, { maxItems: 64 }),
    minItems: Type.Optional(Type.Integer({ minimum: 0 })),
    maxItems: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
]);

const ClawSetupPreviewSchema = closedObject({
  valid: Type.Boolean(),
  inputs: Type.Array(ClawSetupInputSchema, { maxItems: 64 }),
  providedInputIds: Type.Array(NonEmptyString),
  defaultedInputIds: Type.Array(NonEmptyString),
  missingOptionalInputIds: Type.Array(NonEmptyString),
  seeds: Type.Array(
    closedObject({
      destination: NonEmptyString,
      inputIds: Type.Array(NonEmptyString),
      blocked: Type.Boolean(),
    }),
  ),
  diagnostics: Type.Array(
    closedObject({
      code: NonEmptyString,
      path: NonEmptyString,
      message: NonEmptyString,
    }),
  ),
});

const ClawReadinessPreviewSchema = closedObject({
  ready: Type.Boolean(),
  requirements: Type.Array(
    closedObject({
      kind: Type.Union([Type.Literal("environment"), Type.Literal("oauth")]),
      owner: NonEmptyString,
    }),
  ),
});

export const ClawsStatusParamsSchema = closedObject({
  target: Type.Optional(NonEmptyString),
});

export const ClawsDoctorParamsSchema = closedObject({});

export const ClawResourceStatusSchema = closedObject({
  kind: Type.Union([
    Type.Literal("agent"),
    Type.Literal("workspace-file"),
    Type.Literal("skill"),
    Type.Literal("plugin"),
    Type.Literal("mcp-server"),
    Type.Literal("cron-job"),
  ]),
  id: NonEmptyString,
  state: ClawLifecycleStateSchema,
  relationship: Type.Optional(ClawRelationshipSchema),
  origin: Type.Optional(ClawOriginSchema),
  independentOwner: Type.Optional(Type.Boolean()),
});

export const ClawStatusEntrySchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
  version: NonEmptyString,
  sourceKind: Type.Union([Type.Literal("package"), Type.Literal("development")]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("workspace_ready"),
    Type.Literal("config_committed"),
    Type.Literal("complete"),
    Type.Literal("partial"),
  ]),
  agentState: Type.Union([
    Type.Literal("present"),
    Type.Literal("modified"),
    Type.Literal("missing"),
  ]),
  orphaned: Type.Boolean(),
  addedAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  personalization: Type.Optional(
    closedObject({
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("complete"),
        Type.Literal("partial"),
      ]),
      answers: Type.Array(
        closedObject({
          id: NonEmptyString,
          value: ClawSetupAnswerValueSchema,
          source: Type.Union([Type.Literal("explicit"), Type.Literal("default")]),
        }),
      ),
      seeds: Type.Array(
        closedObject({
          destination: NonEmptyString,
          status: Type.Union([Type.Literal("pending"), Type.Literal("complete")]),
        }),
      ),
      updatePending: Type.Boolean(),
    }),
  ),
  resources: Type.Array(ClawResourceStatusSchema),
});

export const ClawsStatusResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayStatus.v1"),
  records: Type.Array(ClawStatusEntrySchema),
  summary: closedObject({
    claws: Type.Integer({ minimum: 0 }),
    healthy: Type.Integer({ minimum: 0 }),
    attention: Type.Integer({ minimum: 0 }),
    managed: Type.Integer({ minimum: 0 }),
    referenced: Type.Integer({ minimum: 0 }),
  }),
});

export const ClawDoctorFindingSchema = closedObject({
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: NonEmptyString,
  path: Type.Optional(NonEmptyString),
  requirement: Type.Optional(NonEmptyString),
  fixHint: Type.Optional(NonEmptyString),
});

export const ClawsDoctorResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayDoctor.v1"),
  findings: Type.Array(ClawDoctorFindingSchema),
  summary: closedObject({
    info: Type.Integer({ minimum: 0 }),
    warnings: Type.Integer({ minimum: 0 }),
    errors: Type.Integer({ minimum: 0 }),
  }),
});

const ClawCatalogCoordinateSchema = closedObject({
  packageName: NonEmptyString,
  version: NonEmptyString,
});

export const ClawsCatalogSearchParamsSchema = closedObject({
  query: NonEmptyString,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const ClawsCatalogDetailParamsSchema = closedObject({
  packageName: NonEmptyString,
  version: Type.Optional(NonEmptyString),
});

export const ClawCatalogEntrySchema = closedObject({
  packageName: NonEmptyString,
  displayName: NonEmptyString,
  summary: Type.Optional(NonEmptyString),
  channel: Type.Union([
    Type.Literal("official"),
    Type.Literal("community"),
    Type.Literal("private"),
  ]),
  official: Type.Boolean(),
  latestVersion: Type.Optional(NonEmptyString),
  downloads: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
});

export const ClawsCatalogSearchResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsCatalogSearch.v1"),
  entries: Type.Array(ClawCatalogEntrySchema),
});

export const ClawCatalogDetailSchema = closedObject({
  packageName: NonEmptyString,
  displayName: NonEmptyString,
  summary: Type.Optional(NonEmptyString),
  channel: Type.Union([
    Type.Literal("official"),
    Type.Literal("community"),
    Type.Literal("private"),
  ]),
  official: Type.Boolean(),
  version: NonEmptyString,
  agentName: Type.Optional(NonEmptyString),
  agentDescription: Type.Optional(NonEmptyString),
  workspaceFiles: Type.Integer({ minimum: 0 }),
  skills: Type.Integer({ minimum: 0 }),
  plugins: Type.Integer({ minimum: 0 }),
  mcpServers: Type.Integer({ minimum: 0 }),
  scheduledJobs: Type.Integer({ minimum: 0 }),
  scanStatus: Type.Optional(NonEmptyString),
});

export const ClawsCatalogDetailResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsCatalogDetail.v1"),
  detail: ClawCatalogDetailSchema,
});

export const ClawsAddPlanParamsSchema = closedObject({
  source: ClawCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
  answers: Type.Optional(ClawSetupAnswersSchema),
});

export const ClawsAddApplyParamsSchema = closedObject({
  source: ClawCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
  answers: Type.Optional(ClawSetupAnswersSchema),
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
});

export const ClawsUpdatePlanParamsSchema = closedObject({
  target: NonEmptyString,
  source: Type.Optional(ClawCatalogCoordinateSchema),
  answers: Type.Optional(ClawSetupAnswersSchema),
});

export const ClawsUpdateApplyParamsSchema = closedObject({
  target: NonEmptyString,
  source: Type.Optional(ClawCatalogCoordinateSchema),
  answers: Type.Optional(ClawSetupAnswersSchema),
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
});

export const ClawsRemovePlanParamsSchema = closedObject({
  target: NonEmptyString,
  removeUnused: Type.Optional(Type.Boolean()),
});

export const ClawsRemoveApplyParamsSchema = closedObject({
  target: NonEmptyString,
  removeUnused: Type.Optional(Type.Boolean()),
  planIntegrity: NonEmptyString,
});

export const ClawsConfigurePlanParamsSchema = closedObject({
  target: NonEmptyString,
  answers: Type.Optional(ClawSetupAnswersSchema),
  clearAnswers: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64, uniqueItems: true }),
  ),
  regenerateSeeds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 64 }),
  ),
});

export const ClawsConfigureApplyParamsSchema = closedObject({
  target: NonEmptyString,
  answers: Type.Optional(ClawSetupAnswersSchema),
  clearAnswers: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 64, uniqueItems: true }),
  ),
  regenerateSeeds: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 64 }),
  ),
  planIntegrity: NonEmptyString,
});

export const ClawLifecyclePlanResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayPlan.v1"),
  operation: Type.Union([
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("configure"),
    Type.Literal("remove"),
  ]),
  planIntegrity: NonEmptyString,
  target: closedObject({
    agentId: Type.Optional(NonEmptyString),
    name: Type.Optional(NonEmptyString),
    currentVersion: Type.Optional(NonEmptyString),
    targetVersion: Type.Optional(NonEmptyString),
  }),
  actions: Type.Array(
    closedObject({
      kind: NonEmptyString,
      id: NonEmptyString,
      action: NonEmptyString,
      blocked: Type.Boolean(),
      reason: Type.Optional(NonEmptyString),
    }),
  ),
  capabilities: Type.Array(
    closedObject({
      kind: NonEmptyString,
      id: NonEmptyString,
      action: NonEmptyString,
      reason: NonEmptyString,
    }),
  ),
  blockers: Type.Array(
    closedObject({
      code: NonEmptyString,
      path: NonEmptyString,
      message: NonEmptyString,
    }),
  ),
  trustWarning: Type.Optional(NonEmptyString),
  riskAcknowledgementRequired: Type.Boolean(),
  setup: Type.Optional(ClawSetupPreviewSchema),
  readiness: Type.Optional(ClawReadinessPreviewSchema),
});

export const ClawLifecycleApplyResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayApply.v1"),
  operation: Type.Union([
    Type.Literal("add"),
    Type.Literal("update"),
    Type.Literal("configure"),
    Type.Literal("remove"),
  ]),
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
  agentId: NonEmptyString,
  message: NonEmptyString,
});

export type ClawsStatusParams = Static<typeof ClawsStatusParamsSchema>;
export type ClawsDoctorParams = Static<typeof ClawsDoctorParamsSchema>;
export type ClawResourceStatus = Static<typeof ClawResourceStatusSchema>;
export type ClawStatusEntry = Static<typeof ClawStatusEntrySchema>;
export type ClawsStatusResult = Static<typeof ClawsStatusResultSchema>;
export type ClawDoctorFinding = Static<typeof ClawDoctorFindingSchema>;
export type ClawsDoctorResult = Static<typeof ClawsDoctorResultSchema>;
export type ClawsCatalogSearchParams = Static<typeof ClawsCatalogSearchParamsSchema>;
export type ClawsCatalogDetailParams = Static<typeof ClawsCatalogDetailParamsSchema>;
export type ClawCatalogEntry = Static<typeof ClawCatalogEntrySchema>;
export type ClawsCatalogSearchResult = Static<typeof ClawsCatalogSearchResultSchema>;
export type ClawCatalogDetail = Static<typeof ClawCatalogDetailSchema>;
export type ClawsCatalogDetailResult = Static<typeof ClawsCatalogDetailResultSchema>;
export type ClawsAddPlanParams = Static<typeof ClawsAddPlanParamsSchema>;
export type ClawsAddApplyParams = Static<typeof ClawsAddApplyParamsSchema>;
export type ClawsConfigurePlanParams = Static<typeof ClawsConfigurePlanParamsSchema>;
export type ClawsConfigureApplyParams = Static<typeof ClawsConfigureApplyParamsSchema>;
export type ClawsUpdatePlanParams = Static<typeof ClawsUpdatePlanParamsSchema>;
export type ClawsUpdateApplyParams = Static<typeof ClawsUpdateApplyParamsSchema>;
export type ClawsRemovePlanParams = Static<typeof ClawsRemovePlanParamsSchema>;
export type ClawsRemoveApplyParams = Static<typeof ClawsRemoveApplyParamsSchema>;
export type ClawLifecyclePlanResult = Static<typeof ClawLifecyclePlanResultSchema>;
export type ClawLifecycleApplyResult = Static<typeof ClawLifecycleApplyResultSchema>;
export type ClawSetupAnswerValue = Static<typeof ClawSetupAnswerValueSchema>;
export type ClawSetupAnswers = Static<typeof ClawSetupAnswersSchema>;
export type ClawSetupInput = Static<typeof ClawSetupInputSchema>;
