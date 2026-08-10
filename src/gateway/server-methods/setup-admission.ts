import { resolveStateDir } from "../../config/paths.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE } from "../../infra/file-lock.js";
import { withSetupMigrationTargetLock } from "../../wizard/setup.migration-snapshot.js";

export const SETUP_ADMISSION_BUSY_MESSAGE =
  "OpenClaw setup is already in progress; try again when it finishes.";

let wizardSessionInProgress = false;

export class SetupAdmissionBusyError extends Error {}

export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  let admitted = false;
  const admittedTask = async () => {
    admitted = true;
    return await task();
  };
  try {
    return await withSetupMigrationTargetLock(resolveStateDir(), admittedTask, { wait: false });
  } catch (error) {
    if (!admitted && (error as { code?: unknown }).code === FILE_LOCK_TIMEOUT_ERROR_CODE) {
      throw new SetupAdmissionBusyError(SETUP_ADMISSION_BUSY_MESSAGE);
    }
    throw error;
  }
}

export async function createAdmittedWizardSession<T extends { whenSettled(): Promise<unknown> }>(
  createSession: () => T,
  lockSetupTarget = true,
): Promise<T | undefined> {
  if (wizardSessionInProgress) {
    return undefined;
  }
  wizardSessionInProgress = true;
  const releaseSession = () => {
    wizardSessionInProgress = false;
  };
  try {
    const session = lockSetupTarget
      ? await new Promise<T>((resolve, reject) => {
          void runExclusiveSystemAgentSetupActivation(async () => {
            const createdSession = createSession();
            resolve(createdSession);
            await createdSession.whenSettled();
          }).catch(reject);
        })
      : createSession();
    void session.whenSettled().then(releaseSession, releaseSession);
    return session;
  } catch (error) {
    releaseSession();
    if (error instanceof SetupAdmissionBusyError) {
      return undefined;
    }
    throw error;
  }
}
