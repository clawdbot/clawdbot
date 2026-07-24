import type { SystemRunExecutionContext } from "./invoke-system-run-denial.js";
import type { ExecFinishedEventParams, ExecFinishedResult } from "./invoke-types.js";

export async function sendSystemRunCompleted(
  opts: {
    sendExecFinishedEvent: (params: ExecFinishedEventParams) => Promise<void>;
    sendInvokeResult: (result: { ok: true; payloadJSON: string }) => Promise<void>;
  },
  execution: SystemRunExecutionContext,
  result: ExecFinishedResult,
  payloadJSON: string,
) {
  await opts.sendExecFinishedEvent({
    sessionKey: execution.sessionKey,
    runId: execution.runId,
    commandText: execution.commandText,
    result,
    suppressNotifyOnExit: execution.suppressNotifyOnExit,
  });
  await opts.sendInvokeResult({
    ok: true,
    payloadJSON,
  });
}
