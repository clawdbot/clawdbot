// Device Pair plugin module implements pair command auth behavior.
type PairingCommandAuthParams = {
  channel: string;
  gatewayClientScopes?: readonly string[] | null;
  senderIsOwner?: boolean;
};

type PairingCommandAuthState = {
  isInternalGatewayCaller: boolean;
  isMissingPairingPrivilege: boolean;
  isMissingSetupHandoffPrivilege: boolean;
  approvalCallerScopes?: readonly string[];
};

const COMMAND_OWNER_PAIRING_SCOPES = ["operator.pairing"] as const;
const PAIRING_SCOPE = "operator.pairing";
const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";

function isInternalGatewayPairingCaller(params: PairingCommandAuthParams): boolean {
  return params.channel === "webchat" || Array.isArray(params.gatewayClientScopes);
}

function hasPairingPrivilege(scopes: readonly string[]): boolean {
  return scopes.includes(PAIRING_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

function hasSetupHandoffPrivilege(scopes: readonly string[]): boolean {
  return scopes.includes(TALK_SECRETS_SCOPE) || scopes.includes(ADMIN_SCOPE);
}

export function resolvePairingCommandAuthState(
  params: PairingCommandAuthParams,
): PairingCommandAuthState {
  const isInternalGatewayCaller = isInternalGatewayPairingCaller(params);
  if (isInternalGatewayCaller) {
    const approvalCallerScopes = Array.isArray(params.gatewayClientScopes)
      ? params.gatewayClientScopes
      : [];
    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege: !hasPairingPrivilege(approvalCallerScopes),
      isMissingSetupHandoffPrivilege: !hasSetupHandoffPrivilege(approvalCallerScopes),
      approvalCallerScopes,
    };
  }

  if (params.senderIsOwner === true) {
    return {
      isInternalGatewayCaller,
      isMissingPairingPrivilege: false,
      isMissingSetupHandoffPrivilege: false,
      approvalCallerScopes: COMMAND_OWNER_PAIRING_SCOPES,
    };
  }

  return {
    isInternalGatewayCaller,
    isMissingPairingPrivilege: true,
    isMissingSetupHandoffPrivilege: true,
    approvalCallerScopes: undefined,
  };
}

export function buildMissingPairingScopeReply(): { text: string } {
  return {
    text: "⚠️ This command requires operator.pairing.",
  };
}

export function buildMissingSetupHandoffScopeReply(): { text: string } {
  return {
    text: "⚠️ Setup code handoff includes Talk secrets and requires operator.talk.secrets.",
  };
}
