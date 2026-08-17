import {
  CRITICAL_APPLY_CONTRACT_VERSION,
  CRITICAL_APPLY_TERMINALS,
  type CriticalApplySideEffectCounters,
  type CriticalApplyTransaction,
} from "./contracts.js";

export const CRITICAL_APPLY_ZERO_SIDE_EFFECT_ERROR =
  "Critical Apply transaction must keep all side-effect counters at zero for a contract/schema-only boundary.";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function hasOnlyZeroCriticalApplySideEffects(
  counters: CriticalApplySideEffectCounters,
): boolean {
  return Object.values(counters).every((value) => value === 0);
}

export function assertOnlyZeroCriticalApplySideEffects(
  counters: CriticalApplySideEffectCounters,
): void {
  if (!hasOnlyZeroCriticalApplySideEffects(counters)) {
    throw new Error(CRITICAL_APPLY_ZERO_SIDE_EFFECT_ERROR);
  }
}

export function validateCriticalApplyTransactionShape(
  transaction: CriticalApplyTransaction,
): string[] {
  const errors: string[] = [];
  if (transaction.schema !== CRITICAL_APPLY_CONTRACT_VERSION) {
    errors.push("schema must be critical_apply.transaction.v1");
  }
  if (!isNonEmptyString(transaction.id)) {
    errors.push("id is required");
  }
  if (transaction.disabledByDefault !== true) {
    errors.push("disabledByDefault must be true");
  }
  if (!CRITICAL_APPLY_TERMINALS.includes(transaction.terminal)) {
    errors.push("terminal must be PASS, HOLD, FAIL, or ABORT");
  }
  if (!isNonEmptyString(transaction.sourceAuthority.repo)) {
    errors.push("sourceAuthority.repo is required");
  }
  if (!isNonEmptyString(transaction.sourceAuthority.commit)) {
    errors.push("sourceAuthority.commit is required");
  }
  if (!isNonEmptyString(transaction.sourceAuthority.tree)) {
    errors.push("sourceAuthority.tree is required");
  }
  if (!isNonEmptyString(transaction.targetAuthority.targetRoot)) {
    errors.push("targetAuthority.targetRoot is required");
  }
  if (!isNonEmptyString(transaction.restorePoint.path)) {
    errors.push("restorePoint.path is required");
  }
  if (!isNonEmptyString(transaction.restorePoint.sha256)) {
    errors.push("restorePoint.sha256 is required");
  }
  if (!isNonEmptyString(transaction.rollbackPlanPath)) {
    errors.push("rollbackPlanPath is required");
  }
  if (!isNonEmptyString(transaction.maintenanceLockPath)) {
    errors.push("maintenanceLockPath is required");
  }
  if (!isNonEmptyString(transaction.precheckReceiptPath)) {
    errors.push("precheckReceiptPath is required");
  }
  if (!isNonEmptyString(transaction.postcheckReceiptPath)) {
    errors.push("postcheckReceiptPath is required");
  }
  if (!isNonEmptyString(transaction.watcher.id)) {
    errors.push("watcher.id is required");
  }
  for (const [key, value] of Object.entries(transaction.sideEffects)) {
    if (!isNonNegativeInteger(value)) {
      errors.push(`sideEffects.${key} must be a non-negative integer`);
    }
  }
  if (!hasOnlyZeroCriticalApplySideEffects(transaction.sideEffects)) {
    errors.push(CRITICAL_APPLY_ZERO_SIDE_EFFECT_ERROR);
  }
  return errors;
}

export function assertValidCriticalApplyTransactionShape(
  transaction: CriticalApplyTransaction,
): void {
  const errors = validateCriticalApplyTransactionShape(transaction);
  if (errors.length > 0) {
    throw new Error(`Invalid Critical Apply transaction: ${errors.join("; ")}`);
  }
}
