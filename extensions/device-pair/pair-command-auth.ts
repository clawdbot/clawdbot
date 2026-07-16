type PairingCommandAuthParams = {
  channel: string;
  gatewayClientScopes?: readonly string[] | null;
};

export type PairingCommandAuthState = {
  isInternalGatewayCaller: boolean;
  isMissingInternalPairingPrivilege: boolean;
  approvalCallerScopes?: readonly string[];
};

function isInternalGatewayPairingCaller(params: PairingCommandAuthParams): boolean {
  return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}

export function resolvePairingCommandAuthState(
  params: PairingCommandAuthParams,
): PairingCommandAuthState {
  const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
  if (!isInternalGatewayCaller) {
    return {
      isInternalGatewayCaller,
      isMissingInternalPairingPrivilege: false,
      approvalCallerScopes: undefined,
    };
  }

  const approvalCallerScopes = Array.isArray(params.gatewayClientScopes)
    ? params.gatewayClientScopes
    : [];
  const isMissingInternalPairingPrivilege =
    !approvalCallerScopes.includes("operator.pairing") &&
    !approvalCallerScopes.includes("operator.admin");

  return {
    isInternalGatewayCaller,
    isMissingInternalPairingPrivilege,
    approvalCallerScopes,
  };
}

export function buildMissingPairingScopeReply(): { text: string } {
  return {
    text: "⚠️ This command requires operator.pairing for internal gateway callers.",
  };
}
