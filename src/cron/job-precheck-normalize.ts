import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronJobPrecheck } from "./types-shared.js";

/** Cap host precheck wall time (matches job-precheck runner). */
const MAX_TIMEOUT_MS = 5 * 60_000;

/** Lightweight structural validation / normalization of a precheck object. */
export function normalizeCronJobPrecheck(value: unknown): CronJobPrecheck | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: caller already narrowed value to a non-null plain object (not array).
  const rec = value as Record<string, unknown>; // SAFETY: plain-object map for precheck fields
  const command = normalizeOptionalString(rec.command);
  if (!command) {
    return undefined;
  }
  const kind = rec.kind === "exec" || rec.kind === undefined ? ("exec" as const) : undefined;
  if (!kind) {
    return undefined;
  }
  // Fail closed: present-but-invalid optional fields must throw so row decode
  // quarantines the job instead of silently coercing to defaults.
  let timeoutMs: number | undefined;
  if (rec.timeoutMs !== undefined && rec.timeoutMs !== null) {
    if (
      typeof rec.timeoutMs !== "number" ||
      !Number.isFinite(rec.timeoutMs) ||
      !Number.isInteger(rec.timeoutMs) ||
      rec.timeoutMs <= 0
    ) {
      throw new Error("precheck.timeoutMs must be a positive integer when set");
    }
    timeoutMs = Math.min(rec.timeoutMs, MAX_TIMEOUT_MS);
  }
  let contract: CronJobPrecheck["contract"] | undefined;
  if (rec.contract !== undefined && rec.contract !== null) {
    if (
      rec.contract !== "exit-code" &&
      rec.contract !== "stdout-prefix" &&
      rec.contract !== "dual"
    ) {
      throw new Error('precheck.contract must be "exit-code", "stdout-prefix", or "dual" when set');
    }
    contract = rec.contract;
  }
  let onError: CronJobPrecheck["onError"] | undefined;
  if (rec.onError !== undefined && rec.onError !== null) {
    if (rec.onError !== "fail" && rec.onError !== "skip") {
      throw new Error('precheck.onError must be "fail" or "skip" when set');
    }
    onError = rec.onError;
  }
  const toIntList = (v: unknown, field: string): number[] | undefined => {
    if (v === undefined || v === null) {
      return undefined;
    }
    if (!Array.isArray(v)) {
      throw new Error(`precheck.${field} must be an array of finite numbers when set`);
    }
    if (v.length === 0) {
      throw new Error(`precheck.${field} must be a non-empty array when set`);
    }
    const nums: number[] = [];
    for (const x of v) {
      // Protocol requires integers; refuse silent truncation of 0.5 → 0 (ClawSweeper P2).
      if (typeof x !== "number" || !Number.isFinite(x) || !Number.isInteger(x)) {
        throw new Error(`precheck.${field} must contain only integers`);
      }
      nums.push(x);
    }
    return nums;
  };
  const workExitCodes = toIntList(rec.workExitCodes, "workExitCodes");
  const noWorkExitCodes = toIntList(rec.noWorkExitCodes, "noWorkExitCodes");
  if (workExitCodes && noWorkExitCodes) {
    const noWork = new Set(noWorkExitCodes);
    const overlap = workExitCodes.filter((code) => noWork.has(code));
    if (overlap.length > 0) {
      throw new Error(
        `precheck.workExitCodes and precheck.noWorkExitCodes must not overlap (shared: ${[...new Set(overlap)].toSorted((a, b) => a - b).join(", ")})`,
      );
    }
  }
  const cwd = normalizeOptionalString(rec.cwd);
  const workStdoutPrefix = normalizeOptionalString(rec.workStdoutPrefix);
  const noWorkStdoutPrefix = normalizeOptionalString(rec.noWorkStdoutPrefix);
  if (workStdoutPrefix && noWorkStdoutPrefix) {
    if (
      workStdoutPrefix === noWorkStdoutPrefix ||
      workStdoutPrefix.startsWith(noWorkStdoutPrefix) ||
      noWorkStdoutPrefix.startsWith(workStdoutPrefix)
    ) {
      throw new Error(
        "precheck.workStdoutPrefix and precheck.noWorkStdoutPrefix must not be equal or prefix-overlapping",
      );
    }
  }
  return {
    kind: "exec",
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(contract ? { contract } : {}),
    ...(onError ? { onError } : {}),
    ...(workExitCodes ? { workExitCodes } : {}),
    ...(noWorkExitCodes ? { noWorkExitCodes } : {}),
    ...(cwd ? { cwd } : {}),
    ...(workStdoutPrefix ? { workStdoutPrefix } : {}),
    ...(noWorkStdoutPrefix ? { noWorkStdoutPrefix } : {}),
  };
}
