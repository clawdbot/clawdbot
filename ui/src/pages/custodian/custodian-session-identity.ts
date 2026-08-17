import type { ApplicationGateway } from "../../app/context.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const CUSTODIAN_SESSION_STORAGE_KEY = "openclaw.custodian.session.v1";

function isStoredCustodianSessionId(value: string | null): value is string {
  return value !== null && value.length <= 512 && value.trim().length > 0;
}

export function createCustodianSessionId(): string {
  if (typeof crypto.randomUUID === "function") {
    return `control-ui-onboarding-${crypto.randomUUID()}`;
  }
  const suffix = [...crypto.getRandomValues(new Uint32Array(4))]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
  return `control-ui-onboarding-${suffix}`;
}

export function persistCustodianSessionId(sessionId: string): void {
  try {
    getSafeLocalStorage()?.setItem(CUSTODIAN_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // Storage can be blocked independently of the rest of the Control UI.
  }
}

export function loadCustodianSessionId(): string {
  let stored: string | null = null;
  try {
    stored = getSafeLocalStorage()?.getItem(CUSTODIAN_SESSION_STORAGE_KEY) ?? null;
  } catch {
    // Fall through to a process-local id when storage is unavailable.
  }
  if (isStoredCustodianSessionId(stored)) {
    return stored;
  }
  const sessionId = createCustodianSessionId();
  persistCustodianSessionId(sessionId);
  return sessionId;
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
