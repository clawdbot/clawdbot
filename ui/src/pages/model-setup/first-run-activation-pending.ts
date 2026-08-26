import { getSafeLocalStorage } from "../../local-storage.ts";

export const FIRST_RUN_ACTIVATION_RECEIPT_KEY = "openclaw.modelSetup.pendingActivation.v1";

export function hasPendingFirstRunActivation(): boolean {
  try {
    const storage = getSafeLocalStorage();
    return storage !== null && storage.getItem(FIRST_RUN_ACTIVATION_RECEIPT_KEY) !== null;
  } catch {
    return false;
  }
}
