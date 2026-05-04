type PairingCommandAuthParams = {
  channel: string;
  gatewayClientScopes?: readonly string[] | null;
  senderIsOwner?: boolean;
};

type PairingCommandAuthState = {
  isInternalGatewayCaller: boolean;
  isMissingPairingPrivilege: boolean;
  approvalCallerScopes?: readonly string[];
};

const COMMAND_OWNER_PAIRING_SCOPES = ["operator.pairing"] as const;

function isInternalGatewayPairingCaller(params: PairingCommandAuthParams): boolean {
  return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}

export function resolvePairingCommandAuthState(
  params: PairingCommandAuthParams,
): PairingCommandAuthState {
  const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
  if (isInternalGatewayCaller) {
    const approvalCallerScopes = Array.isArray(params.gatewayClientScopes)
      ? params.gatewayClientScopes
      : [];
    const isMissingPairingPrivilege =
      !approvalCallerScopes.includes("operator.pairing") &&
      !approvalCallerScopes.includes("operator.admin");

    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege,
      approvalCallerScopes,
    };
  }

  if (params.senderIsOwner === true) {
    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege: false,
      approvalCallerScopes: COMMAND_OWNER_PAIRING_SCOPES,
    };
  }

  return {
    isInternalGatewayCaller,
    isMissingPairingPrivilege: true,
    approvalCallerScopes: undefined,
  };
}

export function buildMissingPairingScopeReply(): { text: string } {
  return {
    text: "⚠️ This command requires operator.pairing.",
  };
}
