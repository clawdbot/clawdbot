import {
  createSafeGatewayRestartPreflight,
  requestSafeGatewayRestart,
} from "../../infra/restart-coordinator.js";
import type { GatewayRequestHandlers } from "./types.js";

function normalizeReason(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined;
}

function normalizeSkipDeferral(value: unknown): boolean {
  return value === true;
}

export const restartHandlers: GatewayRequestHandlers = {
  "gateway.restart.request": async ({ respond, params }) => {
    const result = requestSafeGatewayRestart({
      reason: normalizeReason(params.reason),
      delayMs: 0,
      skipDeferral: normalizeSkipDeferral(params.skipDeferral),
    });
    respond(true, result);
  },
  "gateway.restart.preflight": async ({ respond }) => {
    respond(true, createSafeGatewayRestartPreflight());
  },
};
