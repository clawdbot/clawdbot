import type { ConnectPairingRequiredReason } from "../../packages/gateway-protocol/src/connect-error-details.js";
import "./status.command.js";

type TestApi = {
  resolvePairingRecoveryContext(params: {
    error?: string | null;
    closeReason?: string | null;
    details?: unknown;
  }): {
    requestId: string | null;
    reason: ConnectPairingRequiredReason | null;
    remediationHint: string | null;
  } | null;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.statusCommandTestApi")
  ] as TestApi;
}

export const resolvePairingRecoveryContext: TestApi["resolvePairingRecoveryContext"] = (params) =>
  getTestApi().resolvePairingRecoveryContext(params);
