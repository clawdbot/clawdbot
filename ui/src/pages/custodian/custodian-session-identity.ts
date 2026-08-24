import type { ApplicationGateway } from "../../app/context.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const CUSTODIAN_SESSION_STORAGE_KEY = "openclaw.custodian.session.v1";

function isStoredCustodianSessionId(value: string | null): value is string {
  return value !== null && value.length <= 512 && value.trim().length > 0;
}

export function createCustodianSessionId(): string {
  return `control-ui-onboarding-${generateUUID()}`;
}

export function persistCustodianSessionId(sessionId: string): void {
  try {
    getSafeLocalStorage()?.setItem(CUSTODIAN_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Storage can be blocked independently of the rest of the Control UI.
  }
}

/**
 * Restore the persisted companion session id, or mint and persist a fresh one.
 * `restored` marks a rejoin candidate: the id may address a live Gateway
 * session whose queue can hold an in-flight turn from a previous page.
 */
export function loadCustodianSessionId(): { sessionId: string; restored: boolean } {
  let stored: string | null = null;
  try {
    stored = getSafeLocalStorage()?.getItem(CUSTODIAN_SESSION_STORAGE_KEY) ?? null;
  } catch {
    // Fall through to a process-local id when storage is unavailable.
  }
  if (isStoredCustodianSessionId(stored)) {
    return { sessionId: stored, restored: true };
  }
  const sessionId = createCustodianSessionId();
  persistCustodianSessionId(sessionId);
  return { sessionId, restored: false };
}

export class CustodianSessionOwner {
  private lastDeviceToken = "";

  key(gateway: ApplicationGateway | null): string {
    if (!gateway) {
      return "";
    }
    const { gatewayUrl, token, password, bootstrapToken } = gateway.connection;
    const auth = gateway.snapshot.hello?.auth;
    if (auth) {
      this.lastDeviceToken = auth.deviceToken ?? "";
    }
    return JSON.stringify([gatewayUrl, token, password, bootstrapToken, this.lastDeviceToken]);
  }
}
