// Gateway Protocol schema shapes for cron creation responses.
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { CronJobSchema } from "./cron.js";

/** User-visible dry-run delivery route label/detail. */
export const CronDeliveryPreviewSchema = closedObject({
  label: Type.String(),
  detail: Type.String(),
});

/** Delivery route previews keyed by cron job id. */
export const CronDeliveryPreviewsSchema = Type.Record(Type.String(), CronDeliveryPreviewSchema);

/** Successful declaration-key convergence result. */
export const CronDeclarativeAddResultSchema = closedObject({
  created: Type.Boolean(),
  updated: Type.Optional(Type.Boolean()),
  job: CronJobSchema,
  deliveryPreviews: CronDeliveryPreviewsSchema,
});

/** Successful imperative create result with its creation-time delivery route preview. */
export const CronImperativeAddResultSchema = closedObject({
  ...CronJobSchema.properties,
  deliveryPreviews: CronDeliveryPreviewsSchema,
});

/** Successful result from imperative create or declaration-key convergence. */
export const CronAddResultSchema = Type.Union([
  CronImperativeAddResultSchema,
  CronDeclarativeAddResultSchema,
]);
