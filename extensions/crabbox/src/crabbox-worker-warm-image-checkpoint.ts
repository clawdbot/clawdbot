import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { nonEmptyString } from "./crabbox-worker-profile.js";
import type { WarmImageRecord } from "./crabbox-worker-warm-image-store.js";

const CHECKPOINT_ID_PATTERN = /^chk_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export function parseCheckpointJson(stdout: string, action: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Crabbox checkpoint ${action} returned invalid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Crabbox checkpoint ${action} returned an invalid record`);
  }
  return parsed;
}

export function parseCreatedCheckpoint(
  stdout: string,
  leaseId: string,
): Pick<WarmImageRecord, "checkpointId" | "kind" | "state"> {
  const record = parseCheckpointJson(stdout, "create");
  const checkpointId = nonEmptyString(record.id);
  const kind = nonEmptyString(record.kind);
  const nativeState = isRecord(record.native) ? nonEmptyString(record.native.state) : undefined;
  if (
    !checkpointId ||
    !CHECKPOINT_ID_PATTERN.test(checkpointId) ||
    !kind ||
    record.leaseId !== leaseId ||
    !nativeState
  ) {
    throw new Error("Crabbox checkpoint create returned an invalid native checkpoint");
  }
  return { checkpointId, kind, state: nativeState === "available" ? "available" : "pending" };
}

export function parseCheckpointAvailability(stdout: string): "available" | "pending" | "missing" {
  const record = parseCheckpointJson(stdout, "inspect");
  if (!nonEmptyString(record.localState) || !nonEmptyString(record.nextAction)) {
    throw new Error("Crabbox checkpoint inspect returned an invalid verification record");
  }
  if (record.providerState === undefined || record.providerState === "missing") {
    return "missing";
  }
  if (typeof record.providerState !== "string") {
    throw new Error("Crabbox checkpoint inspect returned an invalid provider state");
  }
  // Provider states are native (for example Machine0 ACTIVE); verified fork actions
  // carry readiness. Docker reports available/delete, so retain that positive state.
  return record.providerState === "available" ||
    record.nextAction === "fork_or_delete" ||
    record.nextAction === "fork_restore_or_delete"
    ? "available"
    : "pending";
}
