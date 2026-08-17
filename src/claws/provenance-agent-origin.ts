import * as installRecordSchema from "./provenance-schema-version.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function decodeClawAgentOwnership(schemaValue: string, payloadJson: string) {
  const schemaVersion = installRecordSchema.parseClawInstallRecordSchemaVersion(schemaValue);
  const payload = JSON.parse(payloadJson) as unknown;
  const adopted = schemaVersion === installRecordSchema.CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION;
  const valid = adopted
    ? typeof payload === "object" &&
      payload !== null &&
      !Array.isArray(payload) &&
      "origin" in payload &&
      payload.origin === "adopted" &&
      "paths" in payload &&
      Array.isArray(payload.paths) &&
      payload.paths.every((path) => typeof path === "string")
    : Array.isArray(payload) && payload.every((path) => typeof path === "string");
  if (!valid) {
    throw new Error(
      `Invalid Claw agent ownership payload for schema ${JSON.stringify(schemaVersion)}.`,
    );
  }
  return {
    schemaVersion,
    origin: adopted ? ("adopted" as const) : ("created" as const),
    paths: adopted ? (payload as { paths: string[] }).paths : (payload as string[]),
  };
}

export function clawAgentOrigin(plan: ClawAddPlan): PersistedClawInstall["agentOrigin"] {
  return plan.actions.some((action) => action.kind === "agent" && action.action === "adopt")
    ? "adopted"
    : "created";
}

export function encodeClawAgentOwnership(
  origin: PersistedClawInstall["agentOrigin"],
  paths: string[],
) {
  return origin === "adopted"
    ? {
        schemaVersion: installRecordSchema.CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
        payload: { origin, paths },
      }
    : { schemaVersion: installRecordSchema.CLAW_INSTALL_RECORD_SCHEMA_VERSION, payload: paths };
}
