import type { ScopeUpgradeResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserDeviceTokenStore } from "./browser-device-auth.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";

export type ScopeUpgradeBinding = {
  clientId: string;
  deviceId: string;
  role: string;
};

export type ScopeUpgradeOutcome =
  | { status: "approved"; requestId: string; scopes: string[] }
  | { status: "rejected" | "expired"; requestId: string };

export type ScopeUpgradeOptions = {
  binding: ScopeUpgradeBinding;
  scopes: readonly string[];
  onPending?: (requestId: string) => void;
};

type UpgradeOperation = {
  controller: AbortController;
  promise: Promise<ScopeUpgradeOutcome>;
  requestId?: string;
};

type UpgradeRequester = (
  method: string,
  params?: unknown,
  options?: GatewayProtocolRequestOptions,
) => Promise<unknown>;

function readRequestId(value: unknown): string {
  const requestId =
    value && typeof value === "object" && "requestId" in value
      ? (value as { requestId?: unknown }).requestId
      : undefined;
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new Error("gateway returned an invalid scope upgrade request id");
  }
  return requestId;
}

function readUpgradeResult(value: unknown, requestId: string): ScopeUpgradeResult {
  if (!value || typeof value !== "object") {
    throw new Error("gateway returned an invalid scope upgrade result");
  }
  const result = value as {
    status?: unknown;
    requestId?: unknown;
    deviceToken?: unknown;
    scopes?: unknown;
  };
  if (result.requestId !== requestId) {
    throw new Error("gateway returned a mismatched scope upgrade result");
  }
  if (result.status === "rejected" || result.status === "expired") {
    return { status: result.status, requestId };
  }
  const deviceToken =
    result.status === "approved" && typeof result.deviceToken === "string"
      ? result.deviceToken.trim()
      : "";
  const rawScopes =
    result.status === "approved" && Array.isArray(result.scopes) ? result.scopes : [];
  if (
    !deviceToken ||
    rawScopes.length === 0 ||
    rawScopes.some((scope) => typeof scope !== "string" || !scope.trim())
  ) {
    throw new Error("gateway returned invalid approved scope upgrade credentials");
  }
  const scopes = rawScopes as string[];
  return { status: "approved", requestId, deviceToken, scopes };
}

/** Runs one browser device scope upgrade and owns rotated-token persistence. */
export class GatewayScopeUpgrade {
  private active?: UpgradeOperation;

  constructor(
    private readonly deps: {
      request: UpgradeRequester;
      tokenStore: GatewayBrowserDeviceTokenStore;
      reconnect: () => void;
    },
  ) {}

  requestScopeUpgrade(options: ScopeUpgradeOptions): Promise<ScopeUpgradeOutcome> {
    if (this.active) {
      if (this.active.requestId) {
        options.onPending?.(this.active.requestId);
      }
      return this.active.promise;
    }
    const controller = new AbortController();
    const operation = { controller } as UpgradeOperation;
    const promise = this.runUpgrade(operation, options).finally(() => {
      if (this.active === operation) {
        this.active = undefined;
      }
    });
    operation.promise = promise;
    this.active = operation;
    return promise;
  }

  cancelScopeUpgrade(): void {
    const operation = this.active;
    this.active = undefined;
    operation?.controller.abort();
  }

  private async runUpgrade(
    operation: UpgradeOperation,
    options: ScopeUpgradeOptions,
  ): Promise<ScopeUpgradeOutcome> {
    const registration = await this.deps.request(
      "device.scopes.requestUpgrade",
      { scopes: [...options.scopes] },
      { signal: operation.controller.signal },
    );
    const requestId = readRequestId(registration);
    operation.requestId = requestId;
    options.onPending?.(requestId);
    const result = readUpgradeResult(
      await this.deps.request(
        "device.scopes.waitUpgrade",
        { requestId },
        { timeoutMs: null, signal: operation.controller.signal },
      ),
      requestId,
    );
    if (result.status !== "approved") {
      return result;
    }
    await this.deps.tokenStore.store({
      clientId: options.binding.clientId,
      deviceId: options.binding.deviceId,
      role: options.binding.role,
      token: result.deviceToken,
      scopes: result.scopes,
    });
    this.deps.reconnect();
    return { status: "approved", requestId, scopes: result.scopes };
  }
}
