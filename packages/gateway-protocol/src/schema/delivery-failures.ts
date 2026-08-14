import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

const DeliveryFailureIdSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const DeliveryFailureQueueNameSchema = Type.String({ minLength: 1, maxLength: 256 });

export const DeliveryFailureResubmitReasonSchema = Type.Union([
  Type.Literal("not_found"),
  Type.Literal("not_failed"),
  Type.Literal("legacy_unknown"),
  Type.Literal("compacted"),
  Type.Literal("owner_managed"),
  Type.Literal("ambiguous"),
  Type.Literal("fenced"),
  Type.Literal("missing_payload"),
  Type.Literal("missing_media"),
  Type.Literal("ownership_changed"),
  Type.Literal("migration_namespace"),
  Type.Literal("unsupported_queue"),
  Type.Literal("ambiguous_queue"),
]);

export const DeliveryFailureResubmitParamsSchema = closedObject({
  id: DeliveryFailureIdSchema,
  queueName: Type.Optional(DeliveryFailureQueueNameSchema),
});

export const DeliveryFailureResubmitSuccessResultSchema = closedObject({
  ok: Type.Literal(true),
  queueName: DeliveryFailureQueueNameSchema,
  disposition: Type.Union([
    Type.Literal("scheduled"),
    Type.Literal("queued_for_startup"),
    Type.Literal("queued_for_recovery"),
  ]),
});

export const DeliveryFailureResubmitRefusedResultSchema = closedObject({
  ok: Type.Literal(false),
  queueName: Type.Optional(DeliveryFailureQueueNameSchema),
  reason: DeliveryFailureResubmitReasonSchema,
});

export const DeliveryFailureResubmitResultSchema = Type.Union([
  DeliveryFailureResubmitSuccessResultSchema,
  DeliveryFailureResubmitRefusedResultSchema,
]);

export type DeliveryFailureResubmitReason = Static<typeof DeliveryFailureResubmitReasonSchema>;
export type DeliveryFailureResubmitParams = Static<typeof DeliveryFailureResubmitParamsSchema>;
export type DeliveryFailureResubmitResult = Static<typeof DeliveryFailureResubmitResultSchema>;
