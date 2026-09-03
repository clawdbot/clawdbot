import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { WizardSession } from "../../wizard/session.js";
import { createAdmittedWizardSession, respondSetupAdmissionBusy } from "./setup-admission.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type WizardRunner = ConstructorParameters<typeof WizardSession>[0];

/**
 * Wizard steps run inside the Gateway process, so a plugin or setup step calling
 * `exit` would take the daemon down with it. Fail the step instead.
 */
export const gatewayWizardStepRuntime: RuntimeEnv = {
  ...defaultRuntime,
  exit: (code: number | undefined): never => {
    throw new Error(`wizard step exited with code ${String(code)}`);
  },
};

/** Admit, register, and acknowledge one remote wizard before its first interactive step. */
export async function startGatewayWizardSession(params: {
  context: GatewayRequestContext;
  respond: RespondFn;
  sessionId?: string;
  ownerConnId?: string;
  timeoutMs: number;
  run: WizardRunner;
}): Promise<{ session: WizardSession; sessionId: string } | null> {
  if (params.sessionId && params.context.wizardSessions.has(params.sessionId)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
    );
    return null;
  }
  const session = await createAdmittedWizardSession(
    () => new WizardSession(params.run, { timeoutMs: params.timeoutMs }),
  );
  if (!session) {
    respondSetupAdmissionBusy(params.respond);
    return null;
  }
  const sessionId = params.context.trackWizardSession(
    session,
    params.ownerConnId,
    params.sessionId,
  );
  if (!sessionId) {
    session.cancel();
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "wizard session already exists"),
    );
    return null;
  }
  params.respond(true, { sessionId, done: false, status: "running" }, undefined);
  return { session, sessionId };
}
