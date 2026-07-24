import type { NodeHostClient } from "./client.js";
import type { ExecEventPayload } from "./invoke-types.js";

type SystemRunDeniedReason =
  | "security=deny"
  | "approval-required"
  | "approval-state-write-failed"
  | "allowlist-miss"
  | "denylist-hit"
  | "execution-plan-miss"
  | "companion-unavailable"
  | "permission:screenRecording";

export type SystemRunExecutionContext = {
  sessionKey: string;
  runId: string;
  commandText: string;
  suppressNotifyOnExit: boolean;
};

export function normalizeDeniedReason(reason: string | null | undefined): SystemRunDeniedReason {
  switch (reason) {
    case "security=deny":
    case "approval-required":
    case "allowlist-miss":
    case "denylist-hit":
    case "execution-plan-miss":
    case "companion-unavailable":
    case "permission:screenRecording":
      return reason;
    default:
      return "approval-required";
  }
}

export async function sendSystemRunDenied(
  opts: {
    client: NodeHostClient;
    sendNodeEvent: (client: NodeHostClient, event: string, payload: unknown) => Promise<void>;
    buildExecEventPayload: (payload: ExecEventPayload) => ExecEventPayload;
    sendInvokeResult: (result: {
      ok: false;
      error: { code: "UNAVAILABLE"; message: string };
    }) => Promise<void>;
  },
  execution: SystemRunExecutionContext,
  params: {
    reason: SystemRunDeniedReason;
    message: string;
  },
) {
  await opts.sendNodeEvent(
    opts.client,
    "exec.denied",
    opts.buildExecEventPayload({
      sessionKey: execution.sessionKey,
      runId: execution.runId,
      host: "node",
      command: execution.commandText,
      reason: params.reason,
      suppressNotifyOnExit: execution.suppressNotifyOnExit,
    }),
  );
  await opts.sendInvokeResult({
    ok: false,
    error: { code: "UNAVAILABLE", message: params.message },
  });
}
