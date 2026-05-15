import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
  CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON,
} from "../infra/update-control-plane-sentinel.js";

type Formatter = (value: string) => string;

function readReason(payload: RestartSentinelPayload): string | null {
  const reason = payload.stats?.reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

function readAfterVersion(payload: RestartSentinelPayload): string | null {
  const version = payload.stats?.after?.version;
  return typeof version === "string" && version.trim().length > 0 ? version : null;
}

export function formatUpdateRestartStatusValue(
  payload: RestartSentinelPayload | null | undefined,
  opts: {
    ok?: Formatter;
    warn?: Formatter;
    muted?: Formatter;
    nowMs?: number;
    formatTimeAgo?: (ageMs: number) => string;
  } = {},
): string | null {
  if (!payload || payload.kind !== "update") {
    return null;
  }

  const age =
    opts.formatTimeAgo && Number.isFinite(payload.ts)
      ? ` · ${opts.formatTimeAgo(Math.max(0, (opts.nowMs ?? Date.now()) - payload.ts))}`
      : "";
  const reason = readReason(payload);
  const warn = opts.warn ?? ((value: string) => value);
  const ok = opts.ok ?? ((value: string) => value);
  const muted = opts.muted ?? ((value: string) => value);

  if (payload.status === "error") {
    return warn(
      `failed · ${reason ?? "restart failed"} · run openclaw gateway status --deep${age}`,
    );
  }

  if (payload.status === "skipped") {
    if (reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON) {
      return warn(`handoff running · gateway restart pending · run openclaw update status${age}`);
    }
    if (reason === CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON) {
      return warn(`restart pending health verification · run openclaw gateway status --deep${age}`);
    }
    return muted(`skipped · ${reason ?? "restart skipped"}${age}`);
  }

  const version = readAfterVersion(payload);
  return ok(`verified${version ? ` · gateway ${version}` : ""}${age}`);
}

export function formatUpdateRestartActionLines(
  payload: RestartSentinelPayload | null | undefined,
): string[] {
  if (!payload || payload.kind !== "update") {
    return [];
  }
  if (payload.status === "error") {
    return [
      "Update restart failed; run openclaw gateway status --deep.",
      "If the service is down, run openclaw gateway restart or openclaw gateway install --force.",
    ];
  }
  const reason = readReason(payload);
  if (
    payload.status === "skipped" &&
    (reason === CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON ||
      reason === CONTROL_PLANE_UPDATE_RESTART_HEALTH_PENDING_REASON)
  ) {
    return [
      "Update restart is still pending; run openclaw update status --json for handoff state.",
      "If it stays pending, run openclaw gateway status --deep.",
    ];
  }
  return [];
}
