import { isRecord } from "@openclaw/normalization-core/record-coerce";
import * as installRecordSchema from "./provenance-schema-version.js";
import type { ClawAgentOrigin } from "./provenance-schema-version.js";
import type { ClawAddPlan } from "./types.js";

function ownedPathList(payload: unknown): string[] | undefined {
  return Array.isArray(payload) && payload.every((path) => typeof path === "string")
    ? payload
    : undefined;
}

function adoptedOwnedPathList(payload: unknown): string[] | undefined {
  if (!isRecord(payload) || Array.isArray(payload)) {
    return undefined;
  }
  return payload.origin === "adopted" ? ownedPathList(payload.paths) : undefined;
}

export function decodeClawAgentOwnership(schemaValue: string, payloadJson: string) {
  const schemaVersion = installRecordSchema.parseClawInstallRecordSchemaVersion(schemaValue);
  const payload = JSON.parse(payloadJson) as unknown;
  const adopted = schemaVersion === installRecordSchema.CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION;
  const paths = adopted ? adoptedOwnedPathList(payload) : ownedPathList(payload);
  if (!paths) {
    throw new Error(
      `Invalid Claw agent ownership payload for schema ${JSON.stringify(schemaVersion)}.`,
    );
  }
  return { schemaVersion, origin: adopted ? ("adopted" as const) : ("created" as const), paths };
}

export function clawAgentOrigin(plan: ClawAddPlan): ClawAgentOrigin {
  return plan.actions.some((action) => action.kind === "agent" && action.action === "adopt")
    ? "adopted"
    : "created";
}

export function encodeClawAgentOwnership(origin: ClawAgentOrigin, paths: string[]) {
  return origin === "adopted"
    ? {
        schemaVersion: installRecordSchema.CLAW_ADOPTED_INSTALL_RECORD_SCHEMA_VERSION,
        payload: { origin, paths },
      }
    : { schemaVersion: installRecordSchema.CLAW_INSTALL_RECORD_SCHEMA_VERSION, payload: paths };
}
