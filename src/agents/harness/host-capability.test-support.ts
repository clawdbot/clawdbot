import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../admitted-run-context.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";

type HostAttempt = Parameters<typeof createAgentHarnessHostCapabilities>[0]["attempt"];

type AdmittedHostCapabilityTestFixture = Readonly<{
  admittedRunContext: AdmittedRunContext;
  hostCapabilities: ReturnType<typeof createAgentHarnessHostCapabilities>["capabilities"];
  closeHost: () => void;
  closeAdmission: () => void;
}>;

/** Creates the same admitted authority and closure-bound host used by a real harness attempt. */
export async function createAdmittedHostCapabilityTestFixture(
  attempt: Omit<HostAttempt, "admittedRunContext">,
): Promise<AdmittedHostCapabilityTestFixture> {
  const admission = prepareAgentRunAdmission({
    cfg: attempt.config ?? {},
    facts: {
      runId: attempt.runId,
      agentId: attempt.agentId ?? "main",
      ingress: { kind: "system", boundary: "host-capability-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", `harness-${attempt.runId}`);
  const host = createAgentHarnessHostCapabilities({
    attempt: { ...attempt, admittedRunContext },
    pluginId: "codex",
  });
  return {
    admittedRunContext,
    hostCapabilities: host.capabilities,
    closeHost: host.close,
    closeAdmission: admission.close,
  };
}
