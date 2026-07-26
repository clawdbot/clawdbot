import type { GatewayConnectAuthSelection } from "@openclaw/gateway-client/browser";
import { loadDeviceAuthToken, peekStoredDeviceIdentityId } from "../lib/nodes/index.ts";

const CONTROL_UI_OPERATOR_ROLE = "operator";

export function storedDeviceTokenScopesAllowRead(role: string, scopes: readonly string[]): boolean {
  return (
    role !== CONTROL_UI_OPERATOR_ROLE ||
    scopes.includes("operator.read") ||
    scopes.includes("operator.write") ||
    scopes.includes("operator.admin")
  );
}

/** True when the next browser connect would present a usable stored credential. */
export function hasStoredGatewayAuth(params: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}): boolean {
  if (params.token?.trim() || params.password?.trim()) {
    return true;
  }
  // Insecure contexts skip device identity, so their stored token is unusable.
  if (typeof crypto === "undefined" || !crypto.subtle) {
    return false;
  }
  const deviceId = peekStoredDeviceIdentityId();
  if (!deviceId) {
    return false;
  }
  const storedEntry = loadDeviceAuthToken({
    deviceId,
    gatewayUrl: params.gatewayUrl,
    role: CONTROL_UI_OPERATOR_ROLE,
  });
  return Boolean(
    storedEntry && storedDeviceTokenScopesAllowRead(CONTROL_UI_OPERATOR_ROLE, storedEntry.scopes),
  );
}

export function gatewayRecoveryScopeMaterial(
  selected: GatewayConnectAuthSelection,
): string | undefined {
  return selected.authDeviceToken ?? selected.resolvedDeviceToken ?? selected.authToken;
}

async function deriveRecoveryScope(scopeMaterial: string | undefined): Promise<string> {
  if (!scopeMaterial || typeof crypto === "undefined" || !crypto.subtle) {
    return "";
  }
  try {
    // Recovery records contain the unsent task. Bind them to the exact
    // credential without persisting that credential in browser storage.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scopeMaterial));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return "";
  }
}

export class GatewayRecoveryScopeTracker {
  scope = "";
  ready = false;
  private generation = 0;

  begin(generation: number) {
    this.generation = generation;
    this.ready = false;
  }

  async resolve(params: {
    generation: number;
    scopeMaterial?: string;
    isConnected: () => boolean;
  }): Promise<boolean> {
    const scope = await deriveRecoveryScope(params.scopeMaterial);
    if (params.generation !== this.generation || !params.isConnected()) {
      return false;
    }
    this.scope = scope;
    this.ready = true;
    return true;
  }
}
