import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronFailureAlert, CronFailureAlertPatch } from "../types.js";

export function mergeCronFailureAlert(
  existing: CronFailureAlert | false | undefined,
  patch: CronFailureAlertPatch | false | null | undefined,
): CronFailureAlert | false | undefined {
  if (patch === false) {
    return false;
  }
  if (patch === null) {
    return undefined;
  }
  if (patch === undefined) {
    return existing;
  }
  const base = existing === false || existing === undefined ? {} : existing;
  const next: CronFailureAlert = { ...base };

  if ("after" in patch) {
    const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
    next.after = after > 0 ? Math.floor(after) : undefined;
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("cooldownMs" in patch) {
    const cooldownMs =
      typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)
        ? patch.cooldownMs
        : -1;
    next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : undefined;
  }
  if ("includeSkipped" in patch) {
    next.includeSkipped =
      typeof patch.includeSkipped === "boolean" ? patch.includeSkipped : undefined;
  }
  if ("mode" in patch) {
    const mode = normalizeOptionalString(patch.mode) ?? "";
    next.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
  }
  if ("accountId" in patch) {
    const accountId = normalizeOptionalString(patch.accountId) ?? "";
    next.accountId = accountId ? accountId : undefined;
  }

  return next;
}
