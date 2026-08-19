import { isDeepStrictEqual } from "node:util";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const ABSENT = Symbol("workboard-compensation-absent");

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) && record[key] !== undefined ? record[key] : ABSENT;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(canonicalValue(left), canonicalValue(right));
}

function stableId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function hasOnlyStableIds(values: unknown[]): boolean {
  return values.every((value) => stableId(value) !== undefined);
}

function insertRestoredValues(
  current: unknown[],
  restored: unknown[],
  reference: unknown[],
): unknown[] {
  const result = [...current];
  for (const value of restored.toReversed()) {
    const referenceIndex = reference.findIndex((entry) => stableId(entry) === stableId(value));
    const nextId = reference
      .slice(referenceIndex + 1)
      .map(stableId)
      .find((id) => id !== undefined && result.some((entry) => stableId(entry) === id));
    const nextIndex = nextId ? result.findIndex((entry) => stableId(entry) === nextId) : -1;
    result.splice(nextIndex >= 0 ? nextIndex : result.length, 0, value);
  }
  return result;
}

function rollbackStableIdArray(before: unknown[], after: unknown[], current: unknown[]): unknown[] {
  const beforeById = new Map(before.map((value) => [stableId(value)!, value]));
  const afterById = new Map(after.map((value) => [stableId(value)!, value]));
  const currentIds = new Set(current.map((value) => stableId(value)!));
  const merged = current.flatMap((currentValue) => {
    const id = stableId(currentValue)!;
    const beforeValue = beforeById.get(id);
    const afterValue = afterById.get(id);
    if (beforeValue === undefined && afterValue !== undefined) {
      return sameValue(currentValue, afterValue) ? [] : [currentValue];
    }
    if (beforeValue !== undefined && afterValue !== undefined) {
      const value = rollbackValue(beforeValue, afterValue, currentValue);
      return value === ABSENT ? [] : [value];
    }
    return [currentValue];
  });
  const restored = before.filter((value) => {
    const id = stableId(value)!;
    return !afterById.has(id) && !currentIds.has(id);
  });
  return insertRestoredValues(merged, restored, before);
}

function rollbackRecord(
  before: unknown,
  after: unknown,
  current: Record<string, unknown>,
): unknown {
  const beforeRecord = isRecord(before) ? before : {};
  const afterRecord = isRecord(after) ? after : {};
  const keys = new Set([
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord),
    ...Object.keys(current),
  ]);
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const value = rollbackValue(
      recordValue(beforeRecord, key),
      recordValue(afterRecord, key),
      recordValue(current, key),
    );
    if (value !== ABSENT) {
      merged[key] = value;
    }
  }
  return before === ABSENT && Object.keys(merged).length === 0 ? ABSENT : merged;
}

function rollbackValue(before: unknown, after: unknown, current: unknown): unknown {
  if (sameValue(before, after)) {
    return current;
  }
  if (sameValue(current, after)) {
    return before;
  }
  if (current === ABSENT) {
    return ABSENT;
  }
  if (
    Array.isArray(current) &&
    (Array.isArray(before) || before === ABSENT) &&
    (Array.isArray(after) || after === ABSENT)
  ) {
    const beforeArray = Array.isArray(before) ? before : [];
    const afterArray = Array.isArray(after) ? after : [];
    return hasOnlyStableIds([...beforeArray, ...afterArray, ...current])
      ? rollbackStableIdArray(beforeArray, afterArray, current)
      : current;
  }
  if (
    isRecord(current) &&
    (isRecord(before) || before === ABSENT) &&
    (isRecord(after) || after === ABSENT)
  ) {
    return rollbackRecord(before, after, current);
  }
  return current;
}

export function invertWorkboardCardMutation(
  before: WorkboardCard,
  after: WorkboardCard,
  current: WorkboardCard,
): WorkboardCard {
  const merged = rollbackValue(before, after, current);
  if (!isRecord(merged)) {
    throw new Error("workboard card compensation produced an invalid card");
  }
  // SAFETY: recursive rollback starts from three valid card states and preserves the card identity.
  return { ...merged, id: current.id, updatedAt: current.updatedAt } as WorkboardCard;
}

export function sameWorkboardCardState(left: WorkboardCard, right: WorkboardCard): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftState } = left;
  const { updatedAt: _rightUpdatedAt, ...rightState } = right;
  return sameValue(leftState, rightState);
}

export function invertWorkboardWorkspaceMutation(
  before: WorkboardCard,
  after: WorkboardCard,
  current: WorkboardCard,
): WorkboardCard {
  const merged = invertWorkboardCardMutation(before, after, current);
  const afterAutomation = after.metadata?.automation;
  const currentAutomation = current.metadata?.automation;
  if (sameValue(currentAutomation?.workspace, afterAutomation?.workspace)) {
    return merged;
  }
  // Workspace and its authority are one host-owned unit. A same-field host edit
  // wins whole instead of inheriting a hybrid of source and materialized fields.
  const automation = { ...merged.metadata?.automation };
  if (currentAutomation?.workspace) {
    automation.workspace = currentAutomation.workspace;
  } else {
    delete automation.workspace;
  }
  if (currentAutomation?.workspaceAccess) {
    automation.workspaceAccess = currentAutomation.workspaceAccess;
  } else {
    delete automation.workspaceAccess;
  }
  const metadata = { ...merged.metadata };
  if (Object.keys(automation).length > 0) {
    metadata.automation = automation;
  } else {
    delete metadata.automation;
  }
  if (Object.keys(metadata).length > 0) {
    return { ...merged, metadata };
  }
  const withoutMetadata = { ...merged };
  delete withoutMetadata.metadata;
  return withoutMetadata;
}
