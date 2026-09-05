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

function rejectTopLevelMode(): never {
  throw new Error(
    'Remove the top-level "mode" field and retry. "mode" is only valid for action="wake".',
  );
}

// Schedule ambiguity is rejected here; a wrong schedule fails invisibly.
// Payload conflicts (message/text, toolsAllow) are deliberately NOT
// rejected because their result is visible on the created job and
// harmless to recover by documented precedence, and rejecting them would cost
// the less capable LLM tolerance this flat contract exists to provide.
// Per-kind schedule contract. `allowed[0]` is the defining field required by
// the Gateway's complete discriminated union; `inputs` includes flat aliases.
const FLAT_SCHEDULE_FIELDS_BY_KIND: Record<
  string,
  { inputs: readonly string[]; allowed: readonly string[] }
> = {
  at: { inputs: ["at", "atMs"], allowed: ["at"] },
  every: { inputs: ["everyMs", "every"], allowed: ["everyMs", "anchorMs"] },
  cron: { inputs: ["expr", "cron"], allowed: ["expr", "tz", "staggerMs"] },
  "on-exit": { inputs: [], allowed: ["command", "cwd"] },
  stream: { inputs: [], allowed: ["command", "cwd", "mode", "match", "batchMs", "maxBatchBytes"] },
};

function assertFlatContractInvariants(
  action: "add" | "update",
  next: Record<string, unknown>,
  recovered: Record<string, unknown>,
): void {
  const schedules = Object.values(FLAT_SCHEDULE_FIELDS_BY_KIND)
    .flatMap((entry) => entry.inputs)
    .filter((key) => next[key] !== undefined);
  if (schedules.length > 1) {
    throw new Error(
      `A cron ${action} takes exactly one schedule field; received ${schedules.join(", ")}. Use "at" (one-shot ISO-8601), "everyMs" (interval), or "expr" (cron expression).`,
    );
  }
  const schedule = isRecord(recovered.schedule) ? recovered.schedule : undefined;
  const kind = typeof schedule?.kind === "string" ? schedule.kind : undefined;
  const contract = kind ? FLAT_SCHEDULE_FIELDS_BY_KIND[kind] : undefined;
  const mismatched = contract
    ? Object.values(FLAT_SCHEDULE_FIELDS_BY_KIND)
        .flatMap((entry) => entry.allowed)
        .filter((key) => schedule?.[key] !== undefined && !contract.allowed.includes(key))
    : [];
  if (contract && mismatched.length > 0) {
    throw new Error(
      `A cron ${action} with "kind": "${kind}" cannot also set ${mismatched.join(", ")}. Use ${contract.allowed[0]}, or drop "kind".`,
    );
  }
  if (action === "update" && schedule && Object.keys(schedule).length > 0) {
    if (!kind) {
      throw new Error(
        `A cron update schedule must be complete; received ${Object.keys(schedule).join(", ")} without a schedule kind. Send the whole schedule: "at" (one-shot ISO-8601), "everyMs" (interval), or "expr" (cron expression, optionally with "tz").`,
      );
    }
    const required = contract?.allowed[0];
    if (required && schedule[required] === undefined) {
      throw new Error(
        `A cron update with "kind": "${kind}" must also send "${required}"; a partial schedule change is rejected by the Gateway. Send the complete schedule.`,
      );
    }
  }
  if (
    action === "add" &&
    next.tz !== undefined &&
    next.expr === undefined &&
    next.cron === undefined
  ) {
    throw new Error('"tz" is only valid alongside "expr"; add a cron expression or drop "tz".');
  }
}

/** Normalizes recoverable cron add/update arguments before provider schema validation. */
export function prepareCronToolArguments(args: unknown): Record<string, unknown> {
  const next = isRecord(args) ? { ...args } : {};
  if (next.action !== "add" && next.action !== "update") {
    return next;
  }
  const nestedJob = hasNestedJob(next.job) ? next.job : undefined;
  const hasTopLevelMode = Object.hasOwn(next, "mode");
  if (nestedJob && hasTopLevelMode) {
    rejectTopLevelMode();
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
  if (hasTopLevelMode) {
    const schedule = isRecord(recovered.value.schedule) ? recovered.value.schedule : undefined;
    if (schedule?.kind !== "stream") {
      rejectTopLevelMode();
    }
    // `mode` is already copied into the recovered stream schedule. Remove the
    // wake-only top-level field before provider validation sees its wake enum.
    delete next.mode;
  }

  assertFlatContractInvariants(next.action, next, recovered.value);

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
