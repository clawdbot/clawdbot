import type { SessionEntry } from "./types.js";

const MAX_TERMINAL_RUN_IDS = 64;

function normalizeRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Keeps a bounded durable set of client runs that must never execute again. */
function normalizeRestartRecoveryTerminalRunIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const runIds: string[] = [];
  for (const item of value) {
    const runId = normalizeRunId(item);
    if (!runId) {
      continue;
    }
    const previousIndex = runIds.indexOf(runId);
    if (previousIndex >= 0) {
      runIds.splice(previousIndex, 1);
    }
    runIds.push(runId);
  }
  const bounded = runIds.slice(-MAX_TERMINAL_RUN_IDS);
  return bounded.length > 0 ? bounded : undefined;
}

type RestartRecoveryNormalizedField =
  | "restartRecoveryDeliveryRequestFingerprint"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryTerminalRunIds";

function sameOptionalStringArray(left: unknown, right: string[] | undefined): boolean {
  if (!Array.isArray(left) || !right) {
    return left === undefined && right === undefined;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Normalizes restart-claim fields while preserving an already-canonical array identity. */
export function normalizeRestartRecoveryEntryFields(
  entry: SessionEntry,
  assign: (key: RestartRecoveryNormalizedField, value: string | string[] | undefined) => void,
): void {
  assign(
    "restartRecoveryDeliveryRequestFingerprint",
    normalizeRunId(entry.restartRecoveryDeliveryRequestFingerprint),
  );
  assign("restartRecoveryDeliveryRunId", normalizeRunId(entry.restartRecoveryDeliveryRunId));
  assign(
    "restartRecoveryDeliverySourceRunId",
    normalizeRunId(entry.restartRecoveryDeliverySourceRunId),
  );
  const terminalRunIds = normalizeRestartRecoveryTerminalRunIds(
    entry.restartRecoveryTerminalRunIds,
  );
  assign(
    "restartRecoveryTerminalRunIds",
    sameOptionalStringArray(entry.restartRecoveryTerminalRunIds, terminalRunIds)
      ? entry.restartRecoveryTerminalRunIds
      : terminalRunIds,
  );
}

/** Appends new terminal ids without refreshing or evicting existing members. */
export function mergeRestartRecoveryTerminalRunIds(
  current: unknown,
  appended: unknown,
): string[] | undefined {
  const currentRunIds = normalizeRestartRecoveryTerminalRunIds(current) ?? [];
  const currentSet = new Set(currentRunIds);
  const appendedRunIds = (normalizeRestartRecoveryTerminalRunIds(appended) ?? []).filter(
    (runId) => !currentSet.has(runId),
  );
  return normalizeRestartRecoveryTerminalRunIds([...currentRunIds, ...appendedRunIds]);
}

export function hasRestartRecoveryTerminalRun(
  entry: SessionEntry | undefined,
  runId: string,
): boolean {
  return (
    normalizeRestartRecoveryTerminalRunIds(entry?.restartRecoveryTerminalRunIds)?.includes(
      runId,
    ) === true
  );
}

/** Clears exact active ownership and optionally records its client source as terminal. */
export function buildRestartRecoveryClaimCleanupPatch(params: {
  entry: SessionEntry;
  recordTerminalSource: boolean;
  terminalSourceRunId?: string;
}): Partial<SessionEntry> {
  const sourceRunId =
    normalizeRunId(params.terminalSourceRunId) ??
    normalizeRunId(params.entry.restartRecoveryDeliverySourceRunId);
  const terminalRunIds =
    params.recordTerminalSource && sourceRunId
      ? mergeRestartRecoveryTerminalRunIds(params.entry.restartRecoveryTerminalRunIds, [
          sourceRunId,
        ])
      : undefined;
  return {
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    ...(terminalRunIds ? { restartRecoveryTerminalRunIds: terminalRunIds } : {}),
  };
}
