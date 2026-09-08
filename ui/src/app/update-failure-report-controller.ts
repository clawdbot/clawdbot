/** Owns replay-safe Control UI execution around the lazy report consent flow. */
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import type { SubmittedUpdateReport } from "./update-failure-report.ts";

type ReportResult = SubmittedUpdateReport | { message: string; status: "error" };

export function canReportUpdateFailure(snapshot: ApplicationGatewaySnapshot): boolean {
  // Browser clients use their authenticated owner profile; internal system
  // callers remain authorized only by the Gateway's server-side guard.
  return (
    snapshot.selfUser?.id === GATEWAY_OWNER_PROFILE_ID &&
    canCallGatewayMethod(snapshot, "update.report", "operator.admin", {
      requireAdvertisement: false,
    })
  );
}

export function createUpdateFailureReportController(params: {
  getClient: () => GatewayBrowserClient | null;
  isCurrent: (attemptId: string, client: GatewayBrowserClient) => boolean;
  setBusy: (busy: boolean) => void;
  setResult: (attemptId: string, result: ReportResult) => void;
}) {
  let generation = 0;
  let activeGeneration: number | null = null;

  const invalidate = () => {
    generation += 1;
    activeGeneration = null;
  };

  return {
    invalidate,
    async report(attemptId: string): Promise<void> {
      const client = params.getClient();
      if (!client || activeGeneration !== null || !params.isCurrent(attemptId, client)) {
        return;
      }
      const currentGeneration = ++generation;
      activeGeneration = currentGeneration;
      const isCurrent = () =>
        activeGeneration === currentGeneration &&
        generation === currentGeneration &&
        params.isCurrent(attemptId, client);
      params.setBusy(true);
      try {
        const { reportUpdateFailure } = await import("./update-failure-report.ts");
        const result = await reportUpdateFailure({ attemptId, client, isCurrent });
        if (result && isCurrent()) {
          params.setResult(attemptId, result);
        }
      } catch (error) {
        if (isCurrent()) {
          params.setResult(attemptId, { status: "error", message: formatUiError(error) });
        }
      } finally {
        if (activeGeneration === currentGeneration) {
          activeGeneration = null;
          params.setBusy(false);
        }
      }
    },
  };
}
