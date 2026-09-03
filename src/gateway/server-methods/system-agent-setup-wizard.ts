import { activateGatewaySetupInference } from "./system-agent-execution.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
import { gatewayWizardStepRuntime, startGatewayWizardSession } from "./wizard-session-start.js";

export async function startSetupActivationWizard(params: {
  sessionId: string;
  activation: Pick<
    Parameters<typeof activateGatewaySetupInference>[0],
    "kind" | "agentId" | "modelRef" | "authChoice" | "apiKey" | "workspace"
  >;
  timeoutMs: number;
  context: GatewayRequestContext;
  respond: RespondFn;
  ownerConnId?: string;
}) {
  await startGatewayWizardSession({
    context: params.context,
    respond: params.respond,
    sessionId: params.sessionId,
    ownerConnId: params.ownerConnId,
    timeoutMs: params.timeoutMs,
    run: async (prompter, signal, runnerSession) => {
      const result = await activateGatewaySetupInference({
        ...params.activation,
        surface: "gateway",
        runtime: gatewayWizardStepRuntime,
        prompter,
        signal,
        isCancelled: () => signal.aborted,
        beforePersistentEffect: () => runnerSession.lockCancellation(),
        onCommitStarted: () => runnerSession.lockCancellation(),
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      runnerSession.setModelActivation({
        modelRef: result.modelRef,
        ...(result.gatewayRestartRequired ? { gatewayRestartRequired: true } : {}),
      });
    },
  });
}
