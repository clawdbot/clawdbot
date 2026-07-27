// Builds restart sentinel payloads for update handoff reporting.
import {
  buildRestartSuccessContinuation,
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
} from "./restart-sentinel.js";
import type { UpdateRunResult } from "./update-runner.js";

// Update restart sentinel payloads carry update result details across a process
// restart so the next gateway can report completion or failure.
/** Metadata needed to route update restart continuation messages. */
export type UpdateRestartSentinelMeta = {
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  threadId?: string;
  handoffId?: string;
  note?: string | null;
  continuationMessage?: string | null;
};

/** Build the restart sentinel payload written after update runs. */
export function buildUpdateRestartSentinelPayload(params: {
  result: UpdateRunResult;
  meta: UpdateRestartSentinelMeta;
  nowMs?: number;
}): RestartSentinelPayload {
  const { result, meta } = params;
  const continuation =
    result.status === "ok"
      ? buildRestartSuccessContinuation({
          sessionKey: meta.sessionKey,
          continuationMessage: meta.continuationMessage,
        })
      : null;
  return {
    kind: "update",
    status: result.status,
    ts: params.nowMs ?? Date.now(),
    ...(meta.sessionKey ? { sessionKey: meta.sessionKey } : {}),
    ...(meta.deliveryContext ? { deliveryContext: meta.deliveryContext } : {}),
    ...(meta.threadId ? { threadId: meta.threadId } : {}),
    message: meta.note ?? null,
    ...(continuation ? { continuation } : {}),
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: result.mode,
      ...(result.root ? { root: result.root } : {}),
      ...(meta.handoffId ? { handoffId: meta.handoffId } : {}),
      before: result.before ?? null,
      after: result.after ?? null,
      steps: result.steps.map((step) => ({
        name: step.name,
        command: step.command,
        cwd: step.cwd,
        durationMs: step.durationMs,
        log: {
          stdoutTail: step.stdoutTail ?? null,
          stderrTail: step.stderrTail ?? null,
          exitCode: step.exitCode ?? null,
        },
      })),
      reason: result.reason ?? null,
      durationMs: result.durationMs,
    },
  };
}
