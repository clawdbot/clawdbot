/** Direct-local agent audit writer lifecycle shared by CLI entrypoints. */
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import {
  configureExecutionIdentityAdmissionSink,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";

/** Own one direct-process writer unless a surrounding runtime already owns it. */
export function startAgentLocalAuditWriter(
  options: { stateDir?: string } = {},
): (() => Promise<void>) | undefined {
  if (hasExecutionIdentityAdmissionSink()) {
    return undefined;
  }
  const recorder = createAuditEventRecorder({
    messageMode: "off",
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
  });
  const clearAdmissionSink = configureExecutionIdentityAdmissionSink(
    recorder.recordExecutionIdentity,
  );
  const clearDecisionWorkSink = configureExecutionDecisionWorkSink(
    recorder.recordExecutionDecisionWork,
  );
  const clearRuntimeActionSink = configureRuntimeActionDecisionSink(
    recorder.recordExecutionDecision,
  );
  return async () => {
    clearRuntimeActionSink();
    clearDecisionWorkSink();
    clearAdmissionSink();
    await recorder.stop();
  };
}
