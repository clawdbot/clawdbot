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

const EnvironmentTrustSchema = Type.String({
  enum: ["persistent", "disposable"],
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

/** Closed app ids a worker desktop may advertise and launch. */
export const WorkerDesktopAppIdSchema = Type.Union([
  Type.Literal("browser"),
  Type.Literal("terminal"),
]);

/** Actionable issue attached only to runtime targets that need operator intervention. */
export const RuntimeTargetIssueSchema = closedObject({
  code: Type.Literal("update-required"),
  action: Type.Literal("update-and-reconnect"),
  updateCommand: Type.Literal("openclaw update"),
  headlessReconnectCommand: Type.Literal("openclaw node restart"),
});

const NodeWorkerBundleStatusSchema = Type.Union([
  closedObject({ status: Type.Literal("installed"), version: NonEmptyString }),
  closedObject({ status: Type.Literal("missing") }),
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
  error: Type.Optional(NonEmptyString),
  desktop: Type.Optional(Type.Boolean()),
  desktopApps: Type.Optional(
    Type.Array(WorkerDesktopAppIdSchema, { maxItems: 8, uniqueItems: true }),
  ),
});

function createEnvironmentSummarySchema() {
  return closedObject({
    id: NonEmptyString,
    type: NonEmptyString,
    label: Type.Optional(NonEmptyString),
    status: EnvironmentStatusSchema,
    platform: Type.Optional(NonEmptyString),
    sessionHost: Type.Optional(Type.Boolean()),
    workerBundle: Type.Optional(NodeWorkerBundleStatusSchema),
    lastConnectedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastDisconnectedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastSeenAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastSeenReason: Type.Optional(NonEmptyString),
    trust: Type.Optional(EnvironmentTrustSchema),
    capabilities: Type.Optional(Type.Array(NonEmptyString)),
    desktop: Type.Optional(Type.Boolean()),
    issues: Type.Optional(Type.Array(RuntimeTargetIssueSchema, { minItems: 1, maxItems: 8 })),
    worker: Type.Optional(WorkerEnvironmentMetadataSchema),
  });
}

/** Public environment summary shown in listings and status responses. */
export const EnvironmentSummarySchema = createEnvironmentSummarySchema();

/** Empty request payload for listing known environments. */
export const EnvironmentsListParamsSchema = closedObject({});

/** Provider-authored machine choice for one configured worker profile. */
export const WorkerMachineOptionSchema = closedObject({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  default: Type.Optional(Type.Boolean()),
  // CPU, memory, and price stay absent until providers expose authoritative values.
});

export const WorkerMachineOptionsSchema = Type.Array(WorkerMachineOptionSchema, {
  minItems: 1,
  maxItems: 32,
});

/** Configured worker target exposed without provider settings or credentials. */
const WorkerEnvironmentProfileSummarySchema = closedObject({
  id: NonEmptyString,
  providerId: NonEmptyString,
  trust: Type.Optional(EnvironmentTrustSchema),
  machines: Type.Optional(WorkerMachineOptionsSchema),
});

/** List response containing all gateway-visible environment summaries. */
export const EnvironmentsListResultSchema = closedObject({
  environments: Type.Array(EnvironmentSummarySchema),
  profiles: Type.Optional(Type.Array(WorkerEnvironmentProfileSummarySchema)),
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
export const EnvironmentsDestroyParamsSchema = closedObject({
  environmentId: NonEmptyString,
  force: Type.Optional(Type.Boolean()),
});

/** Destroy result exposes the terminal worker lifecycle state. */
export const EnvironmentsDestroyResultSchema = createEnvironmentSummarySchema();

export const WorkerDesktopObserveParamsSchema = closedObject({
  environmentId: NonEmptyString,
  control: Type.Optional(Type.Boolean()),
});

// Transport is an open enum-string; future transports may add split streamPath/controlPath
// fields additively without replacing the phase-1 RFB contract.
export const WorkerDesktopObserveResultSchema = closedObject({
  transport: Type.String({ enum: ["rfb"] }),
  wsPath: NonEmptyString,
  expiresAtMs: Type.Integer({ minimum: 0 }),
  control: Type.Boolean(),
  vncPassword: Type.Optional(NonEmptyString),
});

export const WorkerDesktopLaunchParamsSchema = closedObject({
  environmentId: NonEmptyString,
  app: WorkerDesktopAppIdSchema,
});

export const WorkerDesktopLaunchResultSchema = closedObject({
  app: WorkerDesktopAppIdSchema,
  status: Type.Literal("ready"),
});

export type EnvironmentStatus = Static<typeof EnvironmentStatusSchema>;
export type WorkerEnvironmentState = Static<typeof WorkerEnvironmentStateSchema>;
export type WorkerTunnelStatus = Static<typeof WorkerTunnelStatusSchema>;
export type WorkerDesktopAppId = Static<typeof WorkerDesktopAppIdSchema>;
export type RuntimeTargetIssue = Static<typeof RuntimeTargetIssueSchema>;
export type WorkerEnvironmentMetadata = Static<typeof WorkerEnvironmentMetadataSchema>;
export type WorkerMachineOption = Static<typeof WorkerMachineOptionSchema>;
export type EnvironmentSummary = Static<typeof EnvironmentSummarySchema>;
export type EnvironmentsCreateParams = Static<typeof EnvironmentsCreateParamsSchema>;
export type EnvironmentsCreateResult = Static<typeof EnvironmentsCreateResultSchema>;
export type EnvironmentsDestroyParams = Static<typeof EnvironmentsDestroyParamsSchema>;
export type EnvironmentsDestroyResult = Static<typeof EnvironmentsDestroyResultSchema>;
export type EnvironmentsListParams = Static<typeof EnvironmentsListParamsSchema>;
export type EnvironmentsListResult = Static<typeof EnvironmentsListResultSchema>;
export type EnvironmentsStatusParams = Static<typeof EnvironmentsStatusParamsSchema>;
export type EnvironmentsStatusResult = Static<typeof EnvironmentsStatusResultSchema>;
export type WorkerDesktopObserveParams = Static<typeof WorkerDesktopObserveParamsSchema>;
export type WorkerDesktopObserveResult = Static<typeof WorkerDesktopObserveResultSchema>;
export type WorkerDesktopLaunchParams = Static<typeof WorkerDesktopLaunchParamsSchema>;
export type WorkerDesktopLaunchResult = Static<typeof WorkerDesktopLaunchResultSchema>;
