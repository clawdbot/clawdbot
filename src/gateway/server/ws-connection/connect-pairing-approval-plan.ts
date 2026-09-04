// Non-interactive pairing approval lanes: which lane (if any) may resolve a
// pairing request before it reaches an operator prompt.
import {
  normalizeSortedUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { ConnectPairingRequiredReason } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { getBoundDeviceBootstrapProfile } from "../../../infra/device-bootstrap.js";
import type { getPairedDevice } from "../../../infra/device-pairing.js";
import {
  resolveBootstrapProfileScopesForRole,
  resolveBootstrapProfileScopesForRoles,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { shouldAutoApproveNodePairingFromTrustedCidrs } from "../../node-pairing-auto-approve.js";
import {
  isControlUiOwnerBootstrapProfile,
  isControlUiOperatorBootstrapProfile,
  isMobileNodeBootstrapConnect,
  isSetupCodeHandoffBootstrapClient,
} from "./connect-device-metadata.js";
import { shouldAllowSilentLocalPairing } from "./handshake-auth-helpers.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

const DEFAULT_TRUSTED_PROXY_DEVICE_AUTO_APPROVE_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
] as const;

function resolveTrustedProxyDeviceAutoApproveScopes(params: {
  requestedScopes: string[];
  hasRequestedScopes: boolean;
  configuredScopes?: string[];
}): string[] {
  const configuredScopes = normalizeSortedUniqueTrimmedStringList(
    params.configuredScopes ?? [...DEFAULT_TRUSTED_PROXY_DEVICE_AUTO_APPROVE_SCOPES],
  );
  if (!params.hasRequestedScopes) {
    return configuredScopes;
  }
  const configured = new Set(configuredScopes);
  const requestedScopes = normalizeSortedUniqueTrimmedStringList(params.requestedScopes);
  // Trusted-proxy Control UI tabs can remain open across upgrades. Grant newly
  // required default UI scopes without widening an explicitly configured cap.
  if (params.configuredScopes === undefined) {
    requestedScopes.push("operator.questions");
  }
  return normalizeSortedUniqueTrimmedStringList(requestedScopes).filter((scope) =>
    configured.has(scope),
  );
}

/** One approval lane per pairing request; exactly one wins, "manual" prompts. */
export type PairingApprovalPlan = {
  /** Request is created silent and immediately self-approved by its lane. */
  silent: boolean;
  localApproval: "silent" | "trusted-cidr" | null;
  trustedProxyAutoApproveScopes: string[] | null;
  trustedProxyUser: string | undefined;
  isTrustedProxySameKeyUpgrade: boolean;
  allowSetupCodeHandoffBootstrapPairing: boolean;
  allowControlUiOwnerBootstrapPairing: boolean;
  bootstrapApprovalProfile: DeviceBootstrapProfile | null;
  bootstrapPairingRoles: string[] | undefined;
  bootstrapPairingScopes: string[] | undefined;
};

type PairingApprovalPlanParams = {
  reason: ConnectPairingRequiredReason;
  existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null;
  state: AuthenticatedGatewayConnect;
  connectParams: GatewayConnectPhaseContext["connectParams"];
  configSnapshot: GatewayConnectPhaseContext["configSnapshot"];
  hasBrowserOriginHeader: boolean;
  reportedClientIp: string | undefined;
  reportedClientIpSource: GatewayConnectPhaseContext["reportedClientIpSource"];
  deviceId: string;
  devicePublicKey: string;
  scopes: string[];
  hasRequestedScopes: boolean;
  connectionScopeCap: (scopes: string[]) => string[];
};

/** Reused at planning and synchronous approval commit so config changes revoke the same policy. */
export function resolveLocalPairingApproval(
  params: Pick<
    PairingApprovalPlanParams,
    | "reason"
    | "existingPairedDevice"
    | "state"
    | "configSnapshot"
    | "scopes"
    | "hasBrowserOriginHeader"
    | "reportedClientIpSource"
    | "reportedClientIp"
  >,
): PairingApprovalPlan["localApproval"] {
  const { reason, existingPairedDevice, state, configSnapshot, scopes } = params;
  const { role, isControlUi, isWebchat, isNativeAppUi, authMethod, pairingLocality } = state;
  const allowSilentLocalPairing =
    !(existingPairedDevice && role !== "operator") &&
    shouldAllowSilentLocalPairing({
      autoApproveLocal: configSnapshot.gateway?.nodes?.pairing?.autoApproveLocal,
      locality: pairingLocality,
      hasBrowserOriginHeader: params.hasBrowserOriginHeader,
      isControlUi,
      isWebchat,
      isNativeAppUi,
      authMethod,
      reason,
    });
  if (allowSilentLocalPairing) {
    return "silent";
  }
  return shouldAutoApproveNodePairingFromTrustedCidrs({
    existingPairedDevice: Boolean(existingPairedDevice),
    role,
    reason,
    scopes,
    hasBrowserOriginHeader: params.hasBrowserOriginHeader,
    isControlUi,
    isWebchat,
    reportedClientIpSource: params.reportedClientIpSource,
    reportedClientIp: params.reportedClientIp,
    autoApproveCidrs: configSnapshot.gateway?.nodes?.pairing?.autoApproveCidrs,
  })
    ? "trusted-cidr"
    : null;
}

export async function resolvePairingApprovalPlan(
  params: PairingApprovalPlanParams,
): Promise<PairingApprovalPlan> {
  const { reason, existingPairedDevice, state, connectParams, configSnapshot, scopes } = params;
  const {
    role,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    authMethod,
    authResult,
    bootstrapTokenCandidate,
  } = state;
  const localApproval = resolveLocalPairingApproval(params);
  const trustedProxyAutoApproveConfig =
    configSnapshot.gateway?.auth?.trustedProxy?.deviceAutoApprove;
  const trustedProxyUser = authResult.user?.trim();
  // A scope upgrade from a device whose paired public key matches the one
  // this connect just proved by signature is the same physical browser
  // behind the SSO proxy — auto-approvable like a first pairing. A key
  // mismatch stays a manual owner decision (possible deviceId squat).
  const isTrustedProxySameKeyUpgrade =
    reason === "scope-upgrade" && existingPairedDevice?.publicKey === params.devicePublicKey;
  const trustedProxyAutoApproveScopes =
    ((reason === "not-paired" && !existingPairedDevice) || isTrustedProxySameKeyUpgrade) &&
    role === "operator" &&
    (isBrowserOperatorUi || isWebchat) &&
    authMethod === "trusted-proxy" &&
    Boolean(trustedProxyUser) &&
    trustedProxyAutoApproveConfig?.enabled === true
      ? params.connectionScopeCap(
          resolveTrustedProxyDeviceAutoApproveScopes({
            requestedScopes: scopes,
            hasRequestedScopes: params.hasRequestedScopes,
            configuredScopes: trustedProxyAutoApproveConfig?.scopes,
          }),
        )
      : null;
  const isSetupCodeMobileNodeConnect = isMobileNodeBootstrapConnect({
    role,
    scopes,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    clientMode: connectParams.client.mode,
  });
  const allowBoundBootstrapProfileLookup =
    (reason === "not-paired" &&
      !existingPairedDevice &&
      (isSetupCodeMobileNodeConnect || (isControlUi && role === "operator"))) ||
    (reason === "scope-upgrade" &&
      Boolean(existingPairedDevice) &&
      (isSetupCodeMobileNodeConnect || (isControlUi && role === "operator")));
  const boundBootstrapProfile =
    authMethod === "bootstrap-token" && bootstrapTokenCandidate && allowBoundBootstrapProfileLookup
      ? await getBoundDeviceBootstrapProfile({
          token: bootstrapTokenCandidate,
          deviceId: params.deviceId,
          publicKey: params.devicePublicKey,
        })
      : null;
  const allowSetupCodeHandoffBootstrapPairing =
    boundBootstrapProfile !== null &&
    isSetupCodeMobileNodeConnect &&
    isSetupCodeHandoffBootstrapClient({
      profile: boundBootstrapProfile,
      client: connectParams.client,
    });
  const setupCodeHandoffBootstrapProfile = allowSetupCodeHandoffBootstrapPairing
    ? boundBootstrapProfile
    : null;
  const allowControlUiOwnerBootstrapPairing =
    reason === "scope-upgrade" &&
    isControlUiOwnerBootstrapProfile({
      profile: boundBootstrapProfile,
      requestedScopes: scopes,
    });
  const allowControlUiOperatorBootstrapPairing =
    (reason === "not-paired" &&
      isControlUiOperatorBootstrapProfile({
        profile: boundBootstrapProfile,
        requestedScopes: scopes,
      })) ||
    allowControlUiOwnerBootstrapPairing;
  const controlUiOperatorBootstrapProfile = allowControlUiOperatorBootstrapPairing
    ? boundBootstrapProfile
    : null;
  // This is the native QR/setup-code onboarding seam. Mobile clients
  // must prove their canonical client id and platform/family metadata
  // agree before the Gateway can skip owner approval and hand off the
  // selected operator profile below. Full mobile setup includes admin;
  // limited setup retains the previous bounded operator scope set.
  const bootstrapPairingRoles = setupCodeHandoffBootstrapProfile
    ? uniqueStrings([role, ...setupCodeHandoffBootstrapProfile.roles])
    : controlUiOperatorBootstrapProfile
      ? ["operator"]
      : undefined;
  const bootstrapPairingScopes = setupCodeHandoffBootstrapProfile
    ? resolveBootstrapProfileScopesForRoles(
        bootstrapPairingRoles ?? [],
        setupCodeHandoffBootstrapProfile.scopes,
        setupCodeHandoffBootstrapProfile.purpose,
      )
    : controlUiOperatorBootstrapProfile
      ? resolveBootstrapProfileScopesForRole(
          "operator",
          controlUiOperatorBootstrapProfile.scopes,
          controlUiOperatorBootstrapProfile.purpose,
        )
      : undefined;
  return {
    // Scope upgrades ride the same silent-local rule as initial pairing:
    // shouldAllowSilentLocalPairing already restricts them to local-grade
    // auth (none/token/password), so identity-proxy and bearer-token rows
    // stay a durable cap while owner-credentialed local clients widen
    // without a prompt they could bypass with a fresh identity anyway.
    silent:
      localApproval !== null ||
      allowSetupCodeHandoffBootstrapPairing ||
      allowControlUiOperatorBootstrapPairing,
    localApproval,
    trustedProxyAutoApproveScopes,
    trustedProxyUser,
    isTrustedProxySameKeyUpgrade,
    allowSetupCodeHandoffBootstrapPairing,
    allowControlUiOwnerBootstrapPairing,
    bootstrapApprovalProfile: setupCodeHandoffBootstrapProfile ?? controlUiOperatorBootstrapProfile,
    bootstrapPairingRoles,
    bootstrapPairingScopes,
  };
}
