// Tracks session metadata mutations made by command handlers during a turn.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { HandleCommandsParams } from "./commands-types.js";

export type CommandSessionMetadataChange = {
  sessionKey: string;
  agentId?: string;
  reason: "command-metadata";
};

const commandSessionMetadataChanges = new WeakMap<object, CommandSessionMetadataChange[]>();

function addChange(target: object, change: CommandSessionMetadataChange): void {
  const changes = commandSessionMetadataChanges.get(target) ?? [];
  if (
    !changes.some(
      (candidate) =>
        candidate.sessionKey === change.sessionKey &&
        candidate.agentId === change.agentId &&
        candidate.reason === change.reason,
    )
  ) {
    changes.push(change);
  }
  commandSessionMetadataChanges.set(target, changes);
}

export function markCommandSessionMetadataChanged(
  params: Pick<HandleCommandsParams, "agentId" | "ctx" | "rootCtx" | "sessionKey">,
): void {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const change: CommandSessionMetadataChange = {
    sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    reason: "command-metadata",
  };
  const targets = new Set<object>();
  if (params.rootCtx && typeof params.rootCtx === "object") {
    targets.add(params.rootCtx);
  }
  if (params.ctx && typeof params.ctx === "object") {
    targets.add(params.ctx);
  }
  for (const target of targets) {
    addChange(target, change);
  }
}

export function takeCommandSessionMetadataChanges(
  target: object,
): CommandSessionMetadataChange[] | undefined {
  const changes = commandSessionMetadataChanges.get(target);
  commandSessionMetadataChanges.delete(target);
  return changes && changes.length > 0 ? changes : undefined;
}

export function takeCommandSessionMetadataChangesFromTargets(
  targets: Iterable<object>,
): CommandSessionMetadataChange[] | undefined {
  const changes: CommandSessionMetadataChange[] = [];
  const seen = new Set<string>();
  for (const target of new Set(targets)) {
    for (const change of takeCommandSessionMetadataChanges(target) ?? []) {
      const key = JSON.stringify([change.sessionKey, change.agentId ?? null, change.reason]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      changes.push(change);
    }
  }
  return changes.length > 0 ? changes : undefined;
}
