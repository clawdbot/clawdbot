import { normalizeCronJobPatch } from "../../cron/normalize.js";
import { isRecord } from "../../utils.js";
import {
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  recoverCronObjectFromFlatParams,
} from "./cron-tool-canonicalize.js";

function normalizeStringArrayHint(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed ? [trimmed] : value;
}

function normalizePayloadArrayHints(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  if (Object.hasOwn(value, "toolsAllow")) {
    value.toolsAllow = normalizeStringArrayHint(value.toolsAllow);
  }
  if (Object.hasOwn(value, "fallbacks")) {
    value.fallbacks = normalizeStringArrayHint(value.fallbacks);
  }
}

function hasNestedJob(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

/** Normalizes recoverable cron add/update arguments before provider schema validation. */
export function prepareCronToolArguments(args: unknown): Record<string, unknown> {
  const next = isRecord(args) ? { ...args } : {};
  if (next.action !== "add" && next.action !== "update") {
    return next;
  }
  const nestedJob = hasNestedJob(next.job) ? next.job : undefined;
  if (Object.hasOwn(next, "mode")) {
    throw new Error(
      'Remove the top-level "mode" field and retry. "mode" is only valid for action="wake".',
    );
  }

  for (const key of ["toolsAllow", "fallbacks"] as const) {
    if (Object.hasOwn(next, key)) {
      next[key] = normalizeStringArrayHint(next[key]);
    }
  }

  if (nestedJob) {
    const job = canonicalizeCronToolObject(nestedJob);
    normalizePayloadArrayHints(job.payload);
    next.job = job;
    return next;
  }

  const recovered = recoverCronObjectFromFlatParams(next);
  if (!recovered.found) {
    return next;
  }
  normalizePayloadArrayHints(recovered.value.payload);
  if (next.action === "add" && !hasCronCreateSignal(recovered.value)) {
    return next;
  }
  if (
    next.action === "add" &&
    recovered.value.payload !== undefined &&
    recovered.value.schedule === undefined
  ) {
    throw new Error(
      'cron add requires a schedule: set "at" to an ISO-8601 timestamp, "everyMs" to an interval in milliseconds (5 minutes = 300000), or "expr" to a cron expression (optionally with "tz").',
    );
  }
  if (next.action === "update") {
    const normalizedPatch = normalizeCronJobPatch(recovered.value) ?? recovered.value;
    if (isEmptyRecoveredCronPatch(normalizedPatch)) {
      return next;
    }
  }
  next.job = recovered.value;
  return next;
}
