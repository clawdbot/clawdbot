export const SETUP_ADMISSION_BUSY_MESSAGE =
  "OpenClaw setup is already in progress; try again when it finishes.";

let setupAdmissionInProgress = false;

export class SetupAdmissionBusyError extends Error {}

/** Acquire the process-wide setup mutation lease without queueing. */
export function tryAcquireSetupAdmission(): (() => void) | undefined {
  if (setupAdmissionInProgress) {
    return undefined;
  }
  setupAdmissionInProgress = true;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    setupAdmissionInProgress = false;
  };
}

/** Build a setup session and hold its acquired lease until the runner settles. */
export function createAdmittedSetupSession<T extends { whenSettled(): Promise<unknown> }>(
  releaseAdmission: () => void,
  createSession: () => T,
): T {
  try {
    const session = createSession();
    void session.whenSettled().then(releaseAdmission, releaseAdmission);
    return session;
  } catch (error) {
    releaseAdmission();
    throw error;
  }
}

/** Admit one setup mutation without queueing work past a caller timeout. */
export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  const release = tryAcquireSetupAdmission();
  if (!release) {
    throw new SetupAdmissionBusyError(SETUP_ADMISSION_BUSY_MESSAGE);
  }
  try {
    return await task();
  } finally {
    release();
  }
}
