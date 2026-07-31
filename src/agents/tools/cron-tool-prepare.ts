import { normalizeCronJobPatch } from "../../cron/normalize.js";
import { isRecord } from "../../utils.js";
import {
  assertNoStrayCronScheduleAliasFields,
  canonicalizeCronToolObject,
  hasCronCreateSignal,
  isEmptyRecoveredCronPatch,
  mergeCronObjectWithFlatParams,
  recoverCronObjectFromFlatParams,
} from "./cron-tool-canonicalize.js";

function normalizeFlatStringArrayArgument(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  return trimmed ? [trimmed] : [];
}

function normalizeCronPayloadArrayHints(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  if (Object.hasOwn(value, "toolsAllow")) {
    value.toolsAllow = normalizeFlatStringArrayArgument(value.toolsAllow);
  }
  if (Object.hasOwn(value, "fallbacks")) {
    value.fallbacks = normalizeFlatStringArrayArgument(value.fallbacks);
  }
}

function recoverCronWriteArguments(params: {
  next: Record<string, unknown>;
  action: "add" | "update";
  nestedName: "job" | "patch";
}): { recovered: boolean; hadNested: boolean } {
  const synthetic = recoverCronObjectFromFlatParams(params.next);
  const nestedRaw = params.next[params.nestedName];
  const nested = isRecord(nestedRaw) ? canonicalizeCronToolObject(nestedRaw) : undefined;
  const hadNested = Boolean(nested && Object.keys(nested).length > 0);

  if (hadNested && nested && synthetic.found) {
    params.next[params.nestedName] = mergeCronObjectWithFlatParams({
      action: params.action,
      nestedName: params.nestedName,
      nested,
      flat: synthetic.value,
    });
  } else if (
    params.action === "update" &&
    synthetic.found &&
    isEmptyRecoveredCronPatch(synthetic.value)
  ) {
    delete params.next[params.nestedName];
  } else if (synthetic.found) {
    params.next[params.nestedName] = synthetic.value;
  } else if (nested) {
    params.next[params.nestedName] = nested;
  }

  for (const key of synthetic.consumedKeys) {
    delete params.next[key];
  }
  return { recovered: synthetic.found, hadNested };
}

export function prepareCronToolArguments(args: unknown): Record<string, unknown> {
  const next = isRecord(args) ? { ...args } : {};

  if (next.action === "add") {
    // The shared flat schema needs nullable update clears. On add, null means
    // inherit the default, so omit it before synthesizing the create payload.
    for (const key of ["model", "fallbacks", "toolsAllow"] as const) {
      if (next[key] === null) {
        delete next[key];
      }
    }
  }

  if (Object.hasOwn(next, "toolsAllow")) {
    next.toolsAllow = normalizeFlatStringArrayArgument(next.toolsAllow);
  }
  if (Object.hasOwn(next, "fallbacks")) {
    next.fallbacks = normalizeFlatStringArrayArgument(next.fallbacks);
  }

  if (isRecord(next.job)) {
    normalizeCronPayloadArrayHints(next.job.payload);
  }
  if (isRecord(next.patch)) {
    normalizeCronPayloadArrayHints(next.patch.payload);
  }

  if (next.action === "add" || next.action === "update") {
    assertNoStrayCronScheduleAliasFields(next);
  }

  if (next.action === "add") {
    const recovery = recoverCronWriteArguments({ next, action: "add", nestedName: "job" });
    if (
      recovery.recovered &&
      !recovery.hadNested &&
      isRecord(next.job) &&
      !hasCronCreateSignal(next.job)
    ) {
      delete next.job;
    }
  }

  if (next.action === "update") {
    const recovery = recoverCronWriteArguments({ next, action: "update", nestedName: "patch" });
    if (recovery.recovered && !recovery.hadNested && isRecord(next.patch)) {
      const normalizedPatch = normalizeCronJobPatch(next.patch) ?? next.patch;
      if (isEmptyRecoveredCronPatch(normalizedPatch)) {
        delete next.patch;
      }
    }
  }

  return next;
}
