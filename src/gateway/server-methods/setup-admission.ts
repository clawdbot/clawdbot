import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  getGatewayRestartDrainSignal,
  retainGatewayRootWorkAdmissionContinuation,
} from "../../process/gateway-work-admission.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../shared/async-work-scope.js";
import type { WizardSession } from "../../wizard/session.js";
import {
  SetupTargetLockedError,
  withSetupMigrationTargetLock,
} from "../../wizard/setup.migration-snapshot.js";
import type { RespondFn } from "./types.js";

const SETUP_ADMISSION_BUSY_MESSAGE =
  "OpenClaw setup is already in progress; try again when it finishes.";

let wizardSessionInProgress = false;
const wizardSessionAdmissionSettlements = new WeakMap<object, Promise<unknown>>();

export class SetupAdmissionBusyError extends Error {}

/** Only admission failures may promise that no setup task or session began. */
export function respondSetupAdmissionBusy(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, SETUP_ADMISSION_BUSY_MESSAGE, {
      retryable: true,
      details: { code: GatewayErrorDetailCodes.SETUP_ADMISSION_BUSY },
    }),
  );
}

export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  let admitted = false;
  const admittedTask = async () => {
    admitted = true;
    return await task();
  };
  try {
    return await withSetupMigrationTargetLock(resolveStateDir(), admittedTask);
  } catch (error) {
    if (!admitted && error instanceof SetupTargetLockedError) {
      throw new SetupAdmissionBusyError(SETUP_ADMISSION_BUSY_MESSAGE);
    }
    throw error;
  }
}

/** Resolves after both the wizard runner and its setup-target admission have settled. */
export function whenAdmittedWizardSessionSettled(session: {
  whenSettled(): Promise<unknown>;
}): Promise<unknown> {
  return wizardSessionAdmissionSettlements.get(session) ?? session.whenSettled();
}

export async function createAdmittedWizardSession(
  createSession: () => WizardSession,
  lockSetupTarget = true,
): Promise<WizardSession | undefined> {
  if (wizardSessionInProgress) {
    return undefined;
  }
  wizardSessionInProgress = true;
  // Capture this generation before target-lock acquisition can yield or reset.
  const gatewaySignal = getAsyncWorkSignal();
  const drainSignal = getGatewayRestartDrainSignal();
  const signal = gatewaySignal ? AbortSignal.any([gatewaySignal, drainSignal]) : drainSignal;
  let removeCloseListener: (() => void) | undefined;
  let releaseGatewayWork: (() => void) | null = null;
  const releaseSession = () => {
    removeCloseListener?.();
    releaseGatewayWork?.();
    wizardSessionInProgress = false;
  };
  try {
    const create = () => {
      signal.throwIfAborted();
      const session = createSession();
      const close = () =>
        session.close(
          new Error("Gateway is shutting down; restart it before continuing setup.", {
            cause: signal.reason,
          }),
        );
      signal.addEventListener("abort", close, { once: true });
      removeCloseListener = () => signal.removeEventListener("abort", close);
      // Construction can commit or close the Gateway before the listener exists.
      if (signal.aborted) {
        close();
      }
      return session;
    };
    let admissionSettled: Promise<unknown> | undefined;
    const session = lockSetupTarget
      ? await new Promise<WizardSession>((resolve, reject) => {
          admissionSettled = runExclusiveSystemAgentSetupActivation(async () => {
            const createdSession = create();
            resolve(createdSession);
            await createdSession.whenSettled();
          });
          void admissionSettled.catch(reject);
        })
      : create();
    const settled = trackAsyncWork(() => admissionSettled ?? session.whenSettled());
    wizardSessionAdmissionSettlements.set(session, settled);
    // The runner outlives its start RPC and inherits that request's admission.
    // Keep the root live so later prompts and post-auth probes remain subordinate work.
    releaseGatewayWork = retainGatewayRootWorkAdmissionContinuation();
    void settled.then(releaseSession, releaseSession);
    return session;
  } catch (error) {
    releaseSession();
    if (error instanceof SetupAdmissionBusyError) {
      return undefined;
    }
    throw error;
  }
}
