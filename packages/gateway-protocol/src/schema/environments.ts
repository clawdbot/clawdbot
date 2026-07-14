// Gateway Protocol schema module defines protocol validation shapes.
import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Environment inventory protocol schemas.
 *
 * Environments are runtime targets such as local hosts, VMs, or remote workers;
 * this schema layer only describes their gateway-visible status summary.
 */
/** Runtime availability state for an environment target. */
export const EnvironmentStatusSchema = Type.String({
  enum: ["available", "unavailable", "starting", "stopping", "error"],
});

/** Durable lifecycle states for plugin-provisioned worker environments. */
export const WorkerEnvironmentStateSchema = Type.Union([
  Type.Literal("requested"),
  Type.Literal("provisioning"),
  Type.Literal("bootstrapping"),
  Type.Literal("ready"),
  Type.Literal("attached"),
  Type.Literal("idle"),
  Type.Literal("draining"),
  Type.Literal("destroying"),
  Type.Literal("destroyed"),
  Type.Literal("failed"),
  Type.Literal("orphaned"),
]);

/** Process-local SSH tunnel connectivity for a worker environment. */
export const WorkerTunnelStatusSchema = Type.Union([
  Type.Literal("stopped"),
  Type.Literal("connecting"),
  Type.Literal("connected"),
  Type.Literal("reconnecting"),
]);

/** Worker-only lifecycle metadata layered onto the existing environment projection. */
export const WorkerEnvironmentMetadataSchema = closedObject({
  providerId: NonEmptyString,
  leaseId: Type.Optional(NonEmptyString),
  state: WorkerEnvironmentStateSchema,
  ageMs: Type.Integer({ minimum: 0 }),
  idleMs: Type.Optional(Type.Integer({ minimum: 0 })),
  attachedSessionIds: Type.Array(NonEmptyString),
  tunnelStatus: WorkerTunnelStatusSchema,
});

function createEnvironmentSummarySchema() {
  return closedObject({
    id: NonEmptyString,
    type: NonEmptyString,
    label: Type.Optional(NonEmptyString),
    status: EnvironmentStatusSchema,
    capabilities: Type.Optional(Type.Array(NonEmptyString)),
    worker: Type.Optional(WorkerEnvironmentMetadataSchema),
  });
}

/** Public environment summary shown in listings and status responses. */
export const EnvironmentSummarySchema = createEnvironmentSummarySchema();

/** Empty request payload for listing known environments. */
export const EnvironmentsListParamsSchema = closedObject({});

/** List response containing all gateway-visible environment summaries. */
export const EnvironmentsListResultSchema = closedObject({
  environments: Type.Array(EnvironmentSummarySchema),
});

/** Status lookup request for one environment id. */
export const EnvironmentsStatusParamsSchema = closedObject({ environmentId: NonEmptyString });

/** Status lookup result for one environment id. */
export const EnvironmentsStatusResultSchema = createEnvironmentSummarySchema();

/** Creates a worker environment from one configured provider profile. */
export const EnvironmentsCreateParamsSchema = closedObject({
  profileId: NonEmptyString,
  idempotencyKey: NonEmptyString,
});

/** Create result uses the same public summary shape as list and status. */
export const EnvironmentsCreateResultSchema = createEnvironmentSummarySchema();

/** Destroys one durable worker environment by its gateway-owned id. */
export const EnvironmentsDestroyParamsSchema = closedObject({ environmentId: NonEmptyString });

/** Destroy result exposes the terminal worker lifecycle state. */
export const EnvironmentsDestroyResultSchema = createEnvironmentSummarySchema();

export type EnvironmentStatus = Static<typeof EnvironmentStatusSchema>;
export type WorkerEnvironmentState = Static<typeof WorkerEnvironmentStateSchema>;
export type WorkerTunnelStatus = Static<typeof WorkerTunnelStatusSchema>;
export type WorkerEnvironmentMetadata = Static<typeof WorkerEnvironmentMetadataSchema>;
export type EnvironmentSummary = Static<typeof EnvironmentSummarySchema>;
export type EnvironmentsCreateParams = Static<typeof EnvironmentsCreateParamsSchema>;
export type EnvironmentsCreateResult = Static<typeof EnvironmentsCreateResultSchema>;
export type EnvironmentsDestroyParams = Static<typeof EnvironmentsDestroyParamsSchema>;
export type EnvironmentsDestroyResult = Static<typeof EnvironmentsDestroyResultSchema>;
export type EnvironmentsListParams = Static<typeof EnvironmentsListParamsSchema>;
export type EnvironmentsListResult = Static<typeof EnvironmentsListResultSchema>;
export type EnvironmentsStatusParams = Static<typeof EnvironmentsStatusParamsSchema>;
export type EnvironmentsStatusResult = Static<typeof EnvironmentsStatusResultSchema>;
