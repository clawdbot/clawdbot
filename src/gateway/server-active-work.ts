// Adapts server-local chat and terminal state to the shared activity inspector.
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import { getSuspensionVisibleCronTaskRunCount } from "../cron/service/active-run-cancellation.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

export function createGatewayServerActiveWorkInspectors(
  context: Pick<
    GatewayRequestContext,
    "chatAbortControllers" | "chatQueuedTurns" | "cron" | "terminalSessions"
  >,
): Partial<GatewayActiveWorkInspectors> {
  return {
    getCronRuns: () =>
      Math.max(getActiveCronJobCount(), getSuspensionVisibleCronTaskRunCount()) +
      (context.cron.getSuspensionBlockerCount?.() ?? 0),
    getChatRuns: () =>
      Array.from(context.chatAbortControllers.values()).filter(
        (entry) => !entry.controller.signal.aborted && entry.registrationCleanupRequested !== true,
      ).length,
    getQueuedTurns: () =>
      Array.from(context.chatQueuedTurns.values()).filter(
        (entry) => !entry.controller.signal.aborted,
      ).length,
    getTerminalPersistence: () =>
      Array.from(context.chatAbortControllers.values()).filter(
        (entry) =>
          entry.controlUiVisible !== false &&
          entry.projectSessionTerminalPersisted !== true &&
          (entry.projectSessionTerminalPending === true ||
            entry.projectSessionTerminalPersistence !== undefined),
      ).length,
    getTerminalSessions: () => context.terminalSessions?.size ?? 0,
  };
}
