import lockfile from "proper-lockfile";

const MAX_LOCK_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 20;

export function acquireLockSyncWithRetry(path: string): () => void {
  for (let attempt = 1; ; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === MAX_LOCK_ATTEMPTS) {
        throw error;
      }
    }

    const start = Date.now();
    while (Date.now() - start < LOCK_RETRY_DELAY_MS) {
      // proper-lockfile rejects sync retries; preserve the bounded sync storage contract.
    }
  }
}
