// Gateway RPC handlers for safe gateway restart requests and preflight state.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import {
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { requestGatewayRestartWithSignalAdmission } from "../../infra/restart.js";
import type { GatewayRequestHandlers } from "./types.js";

function isRestartRequestParams(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeReason(value: unknown): string | undefined {
  // Restart reasons are operator-visible log context, not payload storage.
  // Trim and cap them before passing through to the coordinator.
  return typeof value === "string" && value.trim()
    ? truncateUtf16Safe(value.trim(), 200)
    : undefined;
}

function normalizeSkipDeferral(value: unknown): boolean {
  // Only an explicit boolean may bypass deferral; truthy strings from loose
  // clients must not skip the safe-restart preflight queue.
  return value === true;
}

type TargetedGatewayRestart = {
  pid: number;
  ownerId: string;
  port: number;
};

function parseTargetedGatewayRestart(value: unknown): TargetedGatewayRestart | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const target = value as { pid?: unknown; ownerId?: unknown; port?: unknown };
  if (
    typeof target.pid !== "number" ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    typeof target.ownerId !== "string" ||
    !target.ownerId.trim() ||
    typeof target.port !== "number" ||
    !Number.isInteger(target.port) ||
    target.port <= 0 ||
    target.port > 65_535
  ) {
    return null;
  }
  return {
    pid: target.pid,
    ownerId: target.ownerId.trim(),
    port: target.port,
  };
}

function parseTargetedRestartIntent(
  value: unknown,
  reason: string | undefined,
): GatewayRestartIntent | null {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    return null;
  }
  const raw = (value ?? {}) as { force?: unknown; waitMs?: unknown };
  const force = raw.force === true;
  const waitMs =
    typeof raw.waitMs === "number" &&
    Number.isSafeInteger(raw.waitMs) &&
    raw.waitMs >= 0 &&
    raw.waitMs <= MAX_TIMER_TIMEOUT_MS
      ? raw.waitMs
      : undefined;
  if (
    (raw.force !== undefined && typeof raw.force !== "boolean") ||
    (raw.waitMs !== undefined && waitMs === undefined) ||
    (force && waitMs !== undefined)
  ) {
    return null;
  }
  return {
    ...(reason ? { reason } : {}),
    ...(force ? { force: true } : {}),
    ...(waitMs !== undefined ? { waitMs } : {}),
  };
}

/** Gateway request handlers for safe restart coordination. */
export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart.request": async ({ respond, params }) => {
    if (!isRestartRequestParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid gateway.restart.request params"),
      );
      return;
    }
    const reason = normalizeReason(params.reason);
    const target = parseTargetedGatewayRestart(params.target);
    if (target === null) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid targeted gateway restart"),
      );
      return;
    }
    if (target) {
      const intent = parseTargetedRestartIntent(params.restartIntent, reason);
      if (!intent) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid targeted gateway restart intent"),
        );
        return;
      }
      const activeLock = await readActiveGatewayLockIdentity().catch(() => undefined);
      if (
        !activeLock ||
        activeLock.pid !== process.pid ||
        activeLock.pid !== target.pid ||
        activeLock.ownerId !== target.ownerId ||
        activeLock.port !== target.port
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "target gateway no longer owns the active lock"),
        );
        return;
      }
      const result = requestGatewayRestartWithSignalAdmission(reason, intent);
      if (result.status === "failed") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "target gateway restart delivery failed"),
        );
        return;
      }
      respond(true, {
        ok: true,
        status: result.status,
        pid: process.pid,
      });
      return;
    }
    const result = requestSafeGatewayRestart({
      reason,
      delayMs: 0,
      skipDeferral: normalizeSkipDeferral(params.skipDeferral),
    });
    respond(true, result);
  },
  "gateway.restart.preflight": async ({ respond }) => {
    respond(true, createSafeGatewayRestartPreflight());
  },
};
