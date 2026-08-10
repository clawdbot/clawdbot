import type { AgentCommandRunAccountingSnapshot } from "./run-accounting.types.js";

const snapshots = new WeakMap<object, AgentCommandRunAccountingSnapshot>();

function snapshotTarget(target: unknown): object | undefined {
  return (typeof target === "object" && target !== null) || typeof target === "function"
    ? target
    : undefined;
}

export function bindAgentCommandRunAccounting(
  target: unknown,
  snapshot: AgentCommandRunAccountingSnapshot,
): boolean {
  const key = snapshotTarget(target);
  if (!key || snapshots.has(key)) {
    return false;
  }
  snapshots.set(key, structuredClone(snapshot));
  return true;
}

export function bindAgentCommandRunAccountingOnce(
  target: unknown,
  snapshot: AgentCommandRunAccountingSnapshot,
): void {
  if (!snapshotTarget(target)) {
    return;
  }
  if (!bindAgentCommandRunAccounting(target, snapshot)) {
    throw new Error("agent command accounting target was already bound");
  }
}

export function resolveAgentCommandRunAccounting(
  target: unknown,
): AgentCommandRunAccountingSnapshot | undefined {
  const key = snapshotTarget(target);
  const snapshot = key ? snapshots.get(key) : undefined;
  return snapshot ? structuredClone(snapshot) : undefined;
}

export function takeAgentCommandRunAccounting(
  target: unknown,
): AgentCommandRunAccountingSnapshot | undefined {
  const key = snapshotTarget(target);
  if (!key) {
    return undefined;
  }
  const snapshot = snapshots.get(key);
  if (!snapshot) {
    return undefined;
  }
  const cloned = structuredClone(snapshot);
  snapshots.delete(key);
  return cloned;
}
