// Gateway RPC handlers for safe gateway restart requests and preflight state.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import {
  createSafeGatewayRestartPreflight,
  scheduleSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import { requestGatewayRestartWithSignalAdmission } from "../../infra/restart.js";
import {
  parseTargetedGatewayRestart,
  parseTargetedGatewayRestartIntent,
} from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";

function isRestartRequestParams(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
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
      if (params.safe !== undefined && typeof params.safe !== "boolean") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid safe targeted restart mode"),
        );
        return;
      }
      if (params.safe === true) {
        if (params.restartIntent !== undefined) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "safe targeted restart does not accept intent"),
          );
          return;
        }
        const result = scheduleSafeGatewayRestart({
          reason,
          delayMs: 0,
          skipDeferral: normalizeSkipDeferral(params.skipDeferral),
        });
        respond(true, result);
        return;
      }
      const intent = parseTargetedGatewayRestartIntent(params.restartIntent, reason);
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
    const result = scheduleSafeGatewayRestart({
      reason,
      delayMs: 0,
      skipDeferral: normalizeSkipDeferral(params.skipDeferral),
    });
    respond(true, result);
  },
  // Deprecated compatibility preview for shipped read-only clients. This is
  // restart-specific information, not the atomic fence owned by suspend.prepare.
  "gateway.restart.preflight": async ({ respond }) => {
    respond(true, createSafeGatewayRestartPreflight());
  },
};
