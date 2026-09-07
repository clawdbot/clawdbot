import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { nonEmptyString } from "./crabbox-worker-profile.js";
import type { WarmImageRecord } from "./crabbox-worker-warm-image-store.js";

const CHECKPOINT_ID_PATTERN = /^chk_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export class CrabboxCheckpointCreateError extends Error {
  private readonly notSubmitted?: { provider: string; leaseId: string };

  static wasNotSubmitted(error: unknown, context: { provider: string; id: string }): boolean {
    return (
      error instanceof CrabboxCheckpointCreateError &&
      error.notSubmitted?.provider === context.provider &&
      error.notSubmitted.leaseId === context.id
    );
  }

  constructor(result: SpawnResult) {
    super(crabboxCommandError("checkpoint create", result).message);
    if (
      result.termination !== "exit" ||
      result.code === null ||
      result.code === 0 ||
      result.killed ||
      result.signal !== null ||
      (result.cleanup !== undefined && result.cleanup !== "normal") ||
      result.outputLimitExceeded ||
      result.outputErrorStream ||
      result.stdoutTruncatedBytes ||
      result.stderrTruncatedBytes ||
      result.stdout.length > 4096
    ) {
      return;
    }
    try {
      const record = parseCheckpointJson(result.stdout, "create");
      if (
        Object.keys(record).length === 6 &&
        record.schema === "crabbox.checkpoint.create.failure.v1" &&
        record.outcome === "not_submitted" &&
        record.localReservation === "removed" &&
        typeof record.provider === "string" &&
        typeof record.leaseId === "string" &&
        typeof record.checkpointId === "string" &&
        CHECKPOINT_ID_PATTERN.test(record.checkpointId)
      ) {
        this.notSubmitted = { provider: record.provider, leaseId: record.leaseId };
      }
    } catch {
      // Old, malformed, or incomplete failure output retains capture uncertainty.
    }
  }
}

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
