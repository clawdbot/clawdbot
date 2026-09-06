import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { defaultRuntime } from "../../runtime.js";
import { WizardSession } from "../../wizard/session.js";
import { createAdmittedWizardSession, respondSetupAdmissionBusy } from "./setup-admission.js";
import { activateGatewaySetupInference } from "./system-agent-execution.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export function rejectExistingSetupWizardSession(params: {
  sessionId: string;
  context: GatewayRequestContext;
  respond: RespondFn;
}): boolean {
  if (!params.context.wizardSessions.has(params.sessionId)) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
  );
  return true;
}

export async function startSetupActivationWizard(params: {
  sessionId: string;
  activation: Pick<
    Parameters<typeof activateGatewaySetupInference>[0],
    "kind" | "agentId" | "modelRef" | "authChoice" | "apiKey" | "workspace"
  >;
  timeoutMs: number;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  if (rejectExistingSetupWizardSession(params)) {
    return;
  }
  const session = await createAdmittedWizardSession(
    () =>
      new WizardSession(
        async (prompter, signal, runnerSession) => {
          const result = await activateGatewaySetupInference({
            ...params.activation,
            surface: "gateway",
            runtime: {
              ...defaultRuntime,
              exit: (code: number | undefined): never => {
                throw new Error(`setup step exited with code ${String(code)}`);
              },
            },
            prompter,
            signal,
            isCancelled: () => signal.aborted,
            beforePersistentEffect: () => runnerSession.lockCancellation(),
            onCommitStarted: () => runnerSession.lockCancellation(),
          });
          if (!result.ok) {
            if (result.disposition === "rejected-before-promotion") {
              runnerSession.setActivationRejection({
                disposition: result.disposition,
                status: result.status,
              });
            }
            throw new Error(result.error);
          }
          runnerSession.setModelActivation({
            modelRef: result.modelRef,
            ...(result.gatewayRestartRequired ? { gatewayRestartRequired: true } : {}),
          });
        },
        { timeoutMs: params.timeoutMs },
      ),
  );
  if (!session) {
    respondSetupAdmissionBusy(params.respond);
    return;
  }
  params.context.wizardSessions.set(params.sessionId, session);
  // Return ownership before any prompt so cancellation survives a lost start reply.
  params.respond(true, { sessionId: params.sessionId, done: false, status: "running" }, undefined);
}
