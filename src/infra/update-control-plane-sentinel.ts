// Persists update-control-plane sentinel files used by updater coordination.
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  markUpdateRestartSentinelFailure,
  writeRestartSentinel,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
} from "./update-restart-sentinel-payload.js";
import type { UpdateRunResult } from "./update-runner.js";

// Control-plane update sentinel helpers preserve update metadata while a
// managed service handoff waits for restart health to complete.
export const CONTROL_PLANE_UPDATE_SENTINEL_META_ENV = "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META";
export const CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
export const CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";

const CONTROL_PLANE_UPDATE_PENDING_REASONS = new Set<string>([
  CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
  CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
]);

export type ControlPlaneUpdateSentinelMetaFile = {
  version: 1;
  meta: UpdateRestartSentinelMeta;
};

/** Convert an update result into the restart-health-pending sentinel result. */
export function buildControlPlaneUpdateRestartHealthPendingResult(
  result: UpdateRunResult,
): UpdateRunResult {
  return {
    status: "skipped",
    mode: result.mode,
    ...(result.root ? { root: result.root } : {}),
    reason: CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
    ...(result.before ? { before: result.before } : {}),
    ...(result.after ? { after: result.after } : {}),
    steps: result.steps,
    durationMs: result.durationMs,
  };
}

/** Return true when an update sentinel represents an in-progress control-plane restart. */
export function isPendingControlPlaneUpdateRestartSentinel(
  payload: RestartSentinelPayload,
): boolean {
  const reason = payload.stats?.reason;
  return (
    payload.kind === "update" &&
    payload.status === "skipped" &&
    typeof reason === "string" &&
    CONTROL_PLANE_UPDATE_PENDING_REASONS.has(reason)
  );
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeMeta(value: unknown): UpdateRestartSentinelMeta | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionKey = normalizeText(value.sessionKey);
  const threadId = normalizeText(value.threadId);
  const handoffId = normalizeText(value.handoffId);
  const channel = isRecord(value.deliveryContext)
    ? normalizeText(value.deliveryContext.channel)
    : undefined;
  const to = isRecord(value.deliveryContext) ? normalizeText(value.deliveryContext.to) : undefined;
  const accountId = isRecord(value.deliveryContext)
    ? normalizeText(value.deliveryContext.accountId)
    : undefined;
  const deliveryContext =
    channel || to || accountId
      ? {
          ...(channel ? { channel } : {}),
          ...(to ? { to } : {}),
          ...(accountId ? { accountId } : {}),
        }
      : undefined;
  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(threadId ? { threadId } : {}),
    ...(handoffId ? { handoffId } : {}),
    note: typeof value.note === "string" ? value.note : null,
    continuationMessage:
      typeof value.continuationMessage === "string" ? value.continuationMessage : null,
  };
}

/** Read update sentinel routing metadata from the configured handoff file. */
export async function readControlPlaneUpdateSentinelMeta(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRestartSentinelMeta | null> {
  const filePath = env[CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]?.trim();
  if (!filePath) {
    return null;
  }
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      return null;
    }
    return normalizeMeta(parsed.meta);
  } catch {
    return null;
  }
}

/** Write an update restart sentinel with control-plane routing metadata. */
export async function writeControlPlaneUpdateRestartSentinel(params: {
  result: UpdateRunResult;
  meta: UpdateRestartSentinelMeta;
}): Promise<void> {
  await writeRestartSentinel(
    buildUpdateRestartSentinelPayload({
      result: params.result,
      meta: params.meta,
    }),
  );
}

/** Mark the pending update restart sentinel as failed. */
export async function markControlPlaneUpdateRestartSentinelFailure(
  reason: string,
): Promise<RestartSentinelPayload | null> {
  return (await markUpdateRestartSentinelFailure(reason))?.payload ?? null;
}
