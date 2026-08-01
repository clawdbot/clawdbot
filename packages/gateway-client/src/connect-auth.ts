import type { ConnectParams } from "@openclaw/gateway-protocol";
import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
  readConnectErrorRecoveryAdvice,
} from "@openclaw/gateway-protocol/connect-error-details";

export type GatewayConnectAuthSelection = {
  authToken?: string;
  authBootstrapToken?: string;
  authDeviceToken?: string;
  authPassword?: string;
  authApprovalRuntimeToken?: string;
  authAgentRuntimeIdentityToken?: string;
  signatureToken?: string;
  resolvedDeviceToken?: string;
  storedToken?: string;
  storedScopes?: string[];
  usingStoredDeviceToken?: boolean;
};

function normalized(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function selectGatewayConnectAuth(params: {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
  approvalRuntimeToken?: string;
  agentRuntimeIdentityToken?: string;
  storedToken?: string;
  storedScopes?: string[];
  pendingDeviceTokenRetry?: boolean;
  trustedDeviceTokenRetry?: boolean;
  preferBootstrapToken?: boolean;
}): GatewayConnectAuthSelection {
  const authToken = normalized(params.token);
  const bootstrapToken = normalized(params.bootstrapToken);
  const explicitDeviceToken = normalized(params.deviceToken);
  const authPassword = normalized(params.password);
  const storedToken = normalized(params.storedToken);
  const stored = { storedToken, storedScopes: params.storedScopes };
  if (params.preferBootstrapToken && bootstrapToken) {
    return { authBootstrapToken: bootstrapToken, authPassword, ...stored };
  }
  const useRetryToken =
    params.pendingDeviceTokenRetry === true &&
    !explicitDeviceToken &&
    Boolean(authToken && storedToken && params.trustedDeviceTokenRetry);
  const resolvedDeviceToken =
    explicitDeviceToken ??
    (useRetryToken || (!(authToken || authPassword) && (!bootstrapToken || storedToken))
      ? storedToken
      : undefined);
  const usingStoredDeviceToken =
    Boolean(resolvedDeviceToken && !explicitDeviceToken && storedToken) &&
    resolvedDeviceToken === storedToken;
  const selectedToken = authToken ?? resolvedDeviceToken;
  const authBootstrapToken =
    !authToken && !resolvedDeviceToken && !authPassword ? bootstrapToken : undefined;
  return {
    authToken: selectedToken,
    authBootstrapToken,
    authDeviceToken: useRetryToken ? storedToken : undefined,
    authPassword,
    authApprovalRuntimeToken: normalized(params.approvalRuntimeToken),
    authAgentRuntimeIdentityToken: normalized(params.agentRuntimeIdentityToken),
    signatureToken: selectedToken ?? authBootstrapToken,
    resolvedDeviceToken,
    usingStoredDeviceToken,
    ...stored,
  };
}

export function buildGatewayConnectAuth(
  selected: GatewayConnectAuthSelection,
): ConnectParams["auth"] {
  const auth: NonNullable<ConnectParams["auth"]> = {
    token: selected.authToken,
    bootstrapToken: selected.authBootstrapToken,
    deviceToken: selected.authDeviceToken ?? selected.resolvedDeviceToken,
    password: selected.authPassword,
    approvalRuntimeToken: selected.authApprovalRuntimeToken,
    agentRuntimeIdentityToken: selected.authAgentRuntimeIdentityToken,
  };
  return Object.values(auth).some(Boolean) ? auth : undefined;
}

export function resolveGatewayConnectScopes(params: {
  requestedScopes?: string[];
  usingStoredDeviceToken?: boolean;
  storedScopes?: string[];
  defaultScopes: readonly string[];
}): string[] {
  return (
    params.requestedScopes ??
    (params.usingStoredDeviceToken && params.storedScopes?.length
      ? params.storedScopes
      : [...params.defaultScopes])
  );
}

export function shouldRetryGatewayWithDeviceToken(params: {
  retryBudgetUsed: boolean;
  currentDeviceToken?: string;
  explicitToken?: string;
  storedToken?: string;
  trustedEndpoint: boolean;
  canRetryWithDeviceTokenHint?: boolean;
  errorDetails?: unknown;
}): boolean {
  if (
    params.retryBudgetUsed ||
    params.currentDeviceToken ||
    !params.explicitToken ||
    !params.storedToken ||
    !params.trustedEndpoint
  ) {
    return false;
  }
  const advice = readConnectErrorRecoveryAdvice(params.errorDetails);
  return (
    params.canRetryWithDeviceTokenHint === true ||
    advice.canRetryWithDeviceToken === true ||
    advice.recommendedNextStep === "retry_with_device_token" ||
    readConnectErrorDetailCode(params.errorDetails) === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH
  );
}
