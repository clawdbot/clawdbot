/** Direct-local agent audit writer lifecycle shared by CLI entrypoints. */
import { createAuditEventRecorder } from "../audit/audit-recorder.js";
import {
  configureExecutionIdentityAdmissionSink,
  hasExecutionIdentityAdmissionSink,
} from "../audit/execution-identity-admission.js";

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
  const clearSink = configureExecutionIdentityAdmissionSink(recorder.recordExecutionIdentity);
  return async () => {
    clearSink();
    await recorder.stop();
  };
}
