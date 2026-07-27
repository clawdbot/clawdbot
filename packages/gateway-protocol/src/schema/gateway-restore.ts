// Gateway Protocol schemas for observing restored admission.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const RestoreTokenSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$",
});
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const RetryAfterMsSchema = Type.Integer({ minimum: 0, maximum: 2_147_483_647 });

const RestoredAdmissionIdentityFields = {
  runtimeLineage: RestoreTokenSchema,
  lifecycleOwnerGeneration: RestoreTokenSchema,
  destinationRuntimeGeneration: RestoreTokenSchema,
  restoreOperationId: RestoreTokenSchema,
  destinationOwner: RestoreTokenSchema,
  admissionIdentity: RestoreTokenSchema,
  recoveryPointId: Sha256Schema,
  acceptanceSetId: Sha256Schema,
  restoreReceiptIdentity: Sha256Schema,
};

export const GatewayRestoreStatusParamsSchema = closedObject({
  restoreOperationId: RestoreTokenSchema,
});

export const GatewayRestoreStatusNotRestoredResultSchema = closedObject({
  status: Type.Literal("not-restored"),
});

export const GatewayRestoreStatusHeldResultSchema = closedObject({
  status: Type.Literal("held"),
  reason: Type.Union([
    Type.Literal("scheduler-reconciliation"),
    Type.Literal("owner-readiness"),
    Type.Literal("ready-commit"),
  ]),
  retryAfterMs: RetryAfterMsSchema,
  ...RestoredAdmissionIdentityFields,
});

export const GatewayRestoreStatusReadyResultSchema = closedObject({
  status: Type.Literal("ready"),
  ...RestoredAdmissionIdentityFields,
  schedulerIdentity: Sha256Schema,
  ownerReadinessIdentity: Sha256Schema,
  readinessIdentity: Sha256Schema,
});

export const GatewayRestoreStatusResultSchema = Type.Union([
  GatewayRestoreStatusNotRestoredResultSchema,
  GatewayRestoreStatusHeldResultSchema,
  GatewayRestoreStatusReadyResultSchema,
]);

export type GatewayRestoreStatusParams = Static<typeof GatewayRestoreStatusParamsSchema>;
export type GatewayRestoreStatusResult = Static<typeof GatewayRestoreStatusResultSchema>;
