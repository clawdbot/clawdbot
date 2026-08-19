// Gateway WebSocket device pairing resolves approvals, metadata upgrades, and device tokens.
import {
  normalizeSortedUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  type ConnectPairingRequiredReason,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import { getBoundDeviceBootstrapProfile } from "../../../infra/device-bootstrap.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
} from "../../../infra/device-pairing-approval.js";
import {
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "../../../infra/device-pairing.js";
import {
  resolveBootstrapProfileScopesForRole,
  resolveBootstrapProfileScopesForRoles,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { isBrowserCopilotClient } from "../../../utils/message-channel.js";
import { pruneSupersededSilentPairingsAfterApproval } from "../../device-pairing-prune.js";
import { normalizeNodeHostCompatibilityMetadata } from "../../node-legacy-protocol-filter.js";
import { shouldAutoApproveNodePairingFromTrustedCidrs } from "../../node-pairing-auto-approve.js";
import { normalizeChromeExtensionOrigin } from "../../origin-check.js";
import { formatForLog } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import { applyConnectionScopeCap } from "./connect-admission.js";
import {
  isControlUiOwnerBootstrapProfile,
  isControlUiOperatorBootstrapProfile,
  isMobileNodeBootstrapConnect,
  isSetupCodeHandoffBootstrapClient,
  pairedDeviceAllowsBootstrapProfile,
  resolvePairedAccessScopes,
} from "./connect-device-metadata.js";
import { issueGatewayConnectDeviceTokens } from "./connect-device-tokens.js";
import { authorizeExistingGatewayDevice } from "./connect-existing-device.js";
import { startGatewayNodePairingSshApproval } from "./connect-node-pairing-ssh.js";
import { shouldAllowSilentLocalPairing } from "./handshake-auth-helpers.js";
import type {
  AuthenticatedGatewayConnect,
  DeviceAuthorizedGatewayConnect,
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
type PairingApprovalPlan = {
  /** Request is created silent and immediately self-approved by its lane. */
  silent: boolean;
  allowSilentLocalPairing: boolean;
  allowTrustedProxyDeviceAutoApproval: boolean;
  isTrustedProxySameKeyUpgrade: boolean;
  allowSetupCodeHandoffBootstrapPairing: boolean;
  allowControlUiOwnerBootstrapPairing: boolean;
  bootstrapApprovalProfile: DeviceBootstrapProfile | null;
  bootstrapPairingRoles: string[] | undefined;
  bootstrapPairingScopes: string[] | undefined;
};

/**
 * Resolve which non-interactive approval lane (if any) may resolve a pairing
 * request before it ever reaches an operator prompt. Keeping every lane's
 * eligibility in one place is what makes a silent policy/caller contradiction
 * (the removed scope-upgrade veto) visible in review.
 */
async function resolvePairingApprovalPlan(params: {
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
}): Promise<PairingApprovalPlan> {
  const { reason, existingPairedDevice, state, configSnapshot, scopes } = params;
  const { connectParams } = params;
  const {
    role,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
    authMethod,
    authResult,
    bootstrapTokenCandidate,
    pairingLocality,
  } = state;
  const allowSilentExistingNonOperatorPairing = !(existingPairedDevice && role !== "operator");
  const allowSilentLocalPairing =
    allowSilentExistingNonOperatorPairing &&
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
  const allowSilentTrustedCidrsNodePairing = shouldAutoApproveNodePairingFromTrustedCidrs({
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
  });
  const trustedProxyAutoApproveConfig =
    configSnapshot.gateway?.auth?.trustedProxy?.deviceAutoApprove;
  const trustedProxyUser = authResult.user?.trim();
  // A scope upgrade from a device whose paired public key matches the one
  // this connect just proved by signature is the same physical browser
  // behind the SSO proxy — auto-approvable like a first pairing. A key
  // mismatch stays a manual owner decision (possible deviceId squat).
  const isTrustedProxySameKeyUpgrade =
    reason === "scope-upgrade" && existingPairedDevice?.publicKey === params.devicePublicKey;
  const allowTrustedProxyDeviceAutoApproval =
    ((reason === "not-paired" && !existingPairedDevice) || isTrustedProxySameKeyUpgrade) &&
    role === "operator" &&
    (isBrowserOperatorUi || isWebchat) &&
    authMethod === "trusted-proxy" &&
    Boolean(trustedProxyUser) &&
    trustedProxyAutoApproveConfig?.enabled === true;
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
      allowSilentLocalPairing ||
      allowSilentTrustedCidrsNodePairing ||
      allowSetupCodeHandoffBootstrapPairing ||
      allowControlUiOperatorBootstrapPairing,
    allowSilentLocalPairing,
    allowTrustedProxyDeviceAutoApproval,
    isTrustedProxySameKeyUpgrade,
    allowSetupCodeHandoffBootstrapPairing,
    allowControlUiOwnerBootstrapPairing,
    bootstrapApprovalProfile: setupCodeHandoffBootstrapProfile ?? controlUiOperatorBootstrapProfile,
    bootstrapPairingRoles,
    bootstrapPairingScopes,
  };
}

export async function authorizeGatewayConnectDevice(
  context: GatewayConnectPhaseContext,
  state: AuthenticatedGatewayConnect,
): Promise<DeviceAuthorizedGatewayConnect | undefined> {
  const {
    connId,
    buildRequestContext,
    close,
    send,
    setHandshakeState,
    setCloseCause,
    logGateway,
    requestOrigin,
  } = context.handler;
  const {
    frame,
    connectParams,
    configSnapshot,
    reportedClientIp,
    reportedClientIpSource,
    hasBrowserOriginHeader,
  } = context;
  let { scopes } = state;
  let { handoffBootstrapProfile } = state;
  const {
    role,
    device,
    devicePublicKey,
    authMethod,
    authResult,
    hasRequestedScopes,
    skipLocalBackendSelfPairing,
    controlUiPairingKind,
  } = state;
  let hasServerApprovedDeviceTokenBaseline = false;
  let pairedClientId: string | undefined;
  let pairedBrowserOrigin: string | undefined;
  // Canonicalize protocol-v3 desktop aliases before pairing persistence and comparison.
  connectParams.client = normalizeNodeHostCompatibilityMetadata(connectParams.client);
  const browserCopilotOrigin = isBrowserCopilotClient(connectParams.client)
    ? normalizeChromeExtensionOrigin(requestOrigin)
    : undefined;
  if (device && devicePublicKey) {
    const formatAuditList = (items: string[] | undefined): string => {
      const normalized = normalizeSortedUniqueTrimmedStringList(items);
      return normalized.length > 0 ? normalized.join(",") : "<none>";
    };
    const logUpgradeAudit = (
      reason: "role-upgrade" | "scope-upgrade",
      currentRoles: string[] | undefined,
      currentScopes: string[] | undefined,
    ) => {
      logGateway.warn(
        `security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`,
      );
    };
    const clientPairingMetadata = {
      displayName: connectParams.client.displayName,
      platform: connectParams.client.platform,
      deviceFamily: connectParams.client.deviceFamily,
      clientId: connectParams.client.id,
      clientMode: connectParams.client.mode,
      ...(browserCopilotOrigin ? { browserOrigin: browserCopilotOrigin } : {}),
      role,
      scopes,
      remoteIp: reportedClientIp,
    };
    const clientAccessMetadata = {
      displayName: connectParams.client.displayName,
      remoteIp: reportedClientIp,
      lastSeenAtMs: Date.now(),
      lastSeenReason: "connect",
    };
    const requirePairing = async (
      reason: ConnectPairingRequiredReason,
      existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null = null,
    ) => {
      const pairingStateAllowsRequestedAccess = (
        pairedCandidate: Awaited<ReturnType<typeof getPairedDevice>>,
      ): boolean => {
        if (!pairedCandidate || pairedCandidate.publicKey !== devicePublicKey) {
          return false;
        }
        if (!hasEffectivePairedDeviceRole(pairedCandidate, role)) {
          return false;
        }
        if (scopes.length === 0) {
          return true;
        }
        const pairedScopes = resolvePairedAccessScopes(pairedCandidate);
        if (pairedScopes.length === 0) {
          return false;
        }
        return roleScopesAllow({
          role,
          requestedScopes: scopes,
          allowedScopes: pairedScopes,
        });
      };
      const plan = await resolvePairingApprovalPlan({
        reason,
        existingPairedDevice,
        state,
        connectParams,
        configSnapshot,
        hasBrowserOriginHeader,
        reportedClientIp,
        reportedClientIpSource,
        deviceId: device.id,
        devicePublicKey,
        scopes,
      });
      const pairing = await requestDevicePairing({
        deviceId: device.id,
        publicKey: devicePublicKey,
        ...clientPairingMetadata,
        scopes,
        ...(plan.bootstrapPairingRoles
          ? {
              roles: plan.bootstrapPairingRoles,
              scopes: plan.bootstrapPairingScopes ?? [],
            }
          : {}),
        silent: plan.silent,
      });
      const trustedProxyAutoApproveConfig =
        configSnapshot.gateway?.auth?.trustedProxy?.deviceAutoApprove;
      const trustedProxyUser = authResult.user?.trim();
      const trustedProxyAutoApproveScopes =
        plan.allowTrustedProxyDeviceAutoApproval &&
        (pairing.request.isRepair !== true || plan.isTrustedProxySameKeyUpgrade)
          ? applyConnectionScopeCap({
              scopes: resolveTrustedProxyDeviceAutoApproveScopes({
                requestedScopes: scopes,
                hasRequestedScopes,
                configuredScopes: trustedProxyAutoApproveConfig?.scopes,
              }),
              upgradeReq: context.handler.upgradeReq,
            })
          : null;
      const requestContext = buildRequestContext();
      // A replacement request obsoletes older pending requestIds; tell approval
      // UIs so they drop the stale prompts instead of stacking alerts forever.
      const supersededResolvedAt = Date.now();
      for (const superseded of pairing.superseded ?? []) {
        requestContext.broadcast(
          "device.pair.resolved",
          {
            requestId: superseded.requestId,
            deviceId: superseded.deviceId,
            decision: "rejected",
            ts: supersededResolvedAt,
          },
          { dropIfSlow: true },
        );
      }
      let approved: Awaited<ReturnType<typeof approveDevicePairing>> | undefined;
      let resolvedByConcurrentApproval = false;
      let recoveryRequestId: string | undefined;
      const resolveLivePendingRequestId = async (): Promise<string | undefined> => {
        const pendingList = await listDevicePairing();
        const exactPending = pendingList.pending.find(
          (pending) => pending.requestId === pairing.request.requestId,
        );
        if (exactPending) {
          return exactPending.requestId;
        }
        const replacementPending = pendingList.pending.find(
          (pending) => pending.deviceId === device.id && pending.publicKey === devicePublicKey,
        );
        return replacementPending?.requestId;
      };
      const inlineApprovalAttempted =
        trustedProxyAutoApproveScopes !== null || pairing.request.silent === true;
      if (inlineApprovalAttempted) {
        approved =
          trustedProxyAutoApproveScopes !== null
            ? await approveDevicePairing(pairing.request.requestId, {
                callerScopes: trustedProxyAutoApproveScopes,
                accessMetadata: clientAccessMetadata,
                approvedVia: "trusted-proxy",
                autoApproveNewDeviceScopes: trustedProxyAutoApproveScopes,
              })
            : plan.bootstrapApprovalProfile
              ? await approveBootstrapDevicePairing(
                  pairing.request.requestId,
                  plan.bootstrapApprovalProfile,
                  { accessMetadata: clientAccessMetadata },
                )
              : await approveDevicePairing(pairing.request.requestId, {
                  // A silent self-grant's authority is locality plus proven
                  // local-grade auth, not the requested scope list. Approval
                  // merges the existing row's scopes back in, so the caller
                  // set must cover requested plus already-held — nothing new.
                  callerScopes: uniqueStrings([
                    ...scopes,
                    ...(existingPairedDevice
                      ? resolvePairedAccessScopes(existingPairedDevice)
                      : []),
                  ]),
                  accessMetadata: clientAccessMetadata,
                  // Same-host local approvals are prune-eligible "silent";
                  // trusted-CIDR approvals cross hosts and must never be
                  // auto-pruned, so they carry their own provenance.
                  approvedVia: plan.allowSilentLocalPairing ? "silent" : "trusted-cidr",
                });
        if (approved?.status === "approved") {
          if (trustedProxyAutoApproveScopes !== null) {
            scopes = trustedProxyAutoApproveScopes;
            connectParams.scopes = scopes;
          }
          if (plan.bootstrapApprovalProfile) {
            handoffBootstrapProfile = plan.bootstrapApprovalProfile;
          }
          if (trustedProxyAutoApproveScopes !== null && trustedProxyUser) {
            logGateway.warn(
              `security audit: trusted-proxy browser device auto-approved user=${formatForLog(trustedProxyUser)} device=${formatForLog(approved.device.deviceId.slice(0, 12))} scopes=${formatAuditList(scopes)}`,
            );
          } else {
            logGateway.info(
              `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
            );
          }
          requestContext.broadcast(
            "device.pair.resolved",
            {
              requestId: pairing.request.requestId,
              deviceId: approved.device.deviceId,
              decision: "approved",
              ts: Date.now(),
            },
            { dropIfSlow: true },
          );
          if (!plan.allowSetupCodeHandoffBootstrapPairing) {
            // Best-effort retirement of stale silent siblings; a prune
            // failure must never fail the fresh device's handshake.
            try {
              await pruneSupersededSilentPairingsAfterApproval({
                deviceId: approved.device.deviceId,
                context: requestContext,
              });
            } catch (error) {
              logGateway.warn(
                `device pairing prune failed device=${approved.device.deviceId} error=${String(error)}`,
              );
            }
          }
        } else {
          // A concurrent connection approved this device first, so this
          // invocation never replaces `scopes` with the trusted-proxy cap.
          // That is safe: pairingStateAllowsRequestedAccess gates continuation
          // on roleScopesAllow(scopes ⊆ device-granted scopes), so the session
          // can never exceed what the device was actually approved for.
          const pairedAfterConcurrentApproval = await getPairedDevice(device.id);
          resolvedByConcurrentApproval = plan.bootstrapApprovalProfile
            ? pairedDeviceAllowsBootstrapProfile({
                device: pairedAfterConcurrentApproval,
                devicePublicKey,
                profile: plan.bootstrapApprovalProfile,
              })
            : pairingStateAllowsRequestedAccess(pairedAfterConcurrentApproval);
          let requestStillPending = false;
          if (!resolvedByConcurrentApproval) {
            recoveryRequestId = await resolveLivePendingRequestId();
            requestStillPending = recoveryRequestId === pairing.request.requestId;
          }
          if (requestStillPending) {
            requestContext.broadcast("device.pair.requested", pairing.request, {
              dropIfSlow: true,
            });
          }
        }
      } else if (pairing.created) {
        requestContext.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
      }
      // SSH verification runs detached: this connection still closes with
      // pairing-required, and the node retry loop picks up the approval.
      const sshVerifyStarted = startGatewayNodePairingSshApproval({
        context,
        state: { ...state, scopes, handoffBootstrapProfile },
        pairing,
        existingPairedDevice,
        devicePublicKey,
        clientAccessMetadata,
        reason,
      });
      // Re-resolve: another connection may have superseded/approved the request since we created it
      recoveryRequestId = await resolveLivePendingRequestId();
      const pairingResolved =
        inlineApprovalAttempted &&
        (approved?.status === "approved" || resolvedByConcurrentApproval);
      if (!pairingResolved) {
        const exposeApprovedAccess = existingPairedDevice?.publicKey === devicePublicKey;
        const approvedRoles = exposeApprovedAccess
          ? listApprovedPairedDeviceRoles(existingPairedDevice)
          : [];
        const approvedScopes = exposeApprovedAccess
          ? resolvePairedAccessScopes(existingPairedDevice)
          : [];
        const retryAfterBootstrapPairingApproval =
          authMethod === "bootstrap-token" &&
          reason === "not-paired" &&
          role === "node" &&
          scopes.length === 0 &&
          !existingPairedDevice;
        // Keep the node retrying while a detached approval can still land
        // (bootstrap redemption or a running ssh-verify probe); default
        // pairing-required behavior pauses the client reconnect loop.
        const retryWhileDetachedApprovalPending =
          retryAfterBootstrapPairingApproval || sshVerifyStarted;
        const pairingErrorDetails = buildPairingConnectErrorDetails({
          reason,
          requestId: recoveryRequestId,
          ...(retryWhileDetachedApprovalPending
            ? {
                recommendedNextStep: "wait_then_retry",
                retryable: true,
                pauseReconnect: false,
              }
            : {}),
          deviceId: device.id,
          requestedRole: role,
          requestedScopes: scopes,
          ...(approvedRoles.length > 0 ? { approvedRoles } : {}),
          ...(approvedScopes.length > 0 ? { approvedScopes } : {}),
        });
        const pairingErrorMessage = buildPairingConnectErrorMessage(reason);
        setHandshakeState("failed");
        setCloseCause("pairing-required", {
          deviceId: device.id,
          ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}),
          reason,
        });
        send({
          type: "res",
          id: frame.id,
          ok: false,
          error: errorShape(ErrorCodes.NOT_PAIRED, pairingErrorMessage, {
            details: pairingErrorDetails,
          }),
        });
        close(
          1008,
          truncateCloseReason(
            buildPairingConnectCloseReason({
              reason,
              requestId: recoveryRequestId,
            }),
          ),
        );
        return false;
      }
      return true;
    };

    const paired = await getPairedDevice(device.id);
    const isPaired = paired?.publicKey === devicePublicKey;
    const pairingRecordDoesNotAuthorizeSession =
      skipLocalBackendSelfPairing || controlUiPairingKind === "auth-none";
    if (pairingRecordDoesNotAuthorizeSession) {
      if (isPaired) {
        // Locality plus auth mode authorizes this session; the pairing row only
        // bounds durable grants and owns last-seen diagnostics. Reapplying its
        // scope cap here would make an unrelated narrow row deny local access.
        pairedClientId = paired.clientId;
        pairedBrowserOrigin = paired.browserOrigin;
        hasServerApprovedDeviceTokenBaseline = true;
        await updatePairedDeviceMetadata(device.id, clientAccessMetadata);
      } else if (
        controlUiPairingKind === "auth-none" ||
        (skipLocalBackendSelfPairing && authMethod !== "device-token")
      ) {
        hasServerApprovedDeviceTokenBaseline = true;
      }
    } else if (!isPaired) {
      if (controlUiPairingKind === null) {
        const ok = await requirePairing("not-paired", paired);
        if (!ok) {
          return undefined;
        }
        const approvedDevice = await getPairedDevice(device.id);
        pairedClientId =
          approvedDevice?.publicKey === devicePublicKey ? approvedDevice.clientId : undefined;
        pairedBrowserOrigin =
          approvedDevice?.publicKey === devicePublicKey ? approvedDevice.browserOrigin : undefined;
        hasServerApprovedDeviceTokenBaseline = true;
      } else {
        hasServerApprovedDeviceTokenBaseline = true;
      }
    } else {
      pairedClientId = paired.clientId;
      pairedBrowserOrigin = paired.browserOrigin;
      hasServerApprovedDeviceTokenBaseline = true;
      const existingDevice = await authorizeExistingGatewayDevice({
        context,
        state: { ...state, scopes, handoffBootstrapProfile },
        paired,
        devicePublicKey,
        clientAccessMetadata,
        handoffBootstrapProfile,
        requirePairing,
        logUpgradeAudit,
      });
      if (!existingDevice.ok) {
        return undefined;
      }
      handoffBootstrapProfile = existingDevice.handoffBootstrapProfile;
    }
  }

  const browserCopilotIdentityMismatch =
    pairedClientId !== connectParams.client.id &&
    (isBrowserCopilotClient(connectParams.client) ||
      isBrowserCopilotClient({ id: pairedClientId }));
  const browserCopilotOriginMismatch =
    isBrowserCopilotClient(connectParams.client) &&
    (!pairedBrowserOrigin || !browserCopilotOrigin || pairedBrowserOrigin !== browserCopilotOrigin);
  if (browserCopilotIdentityMismatch || browserCopilotOriginMismatch) {
    const message = "browser copilot requires a dedicated paired device identity";
    setHandshakeState("failed");
    send({
      type: "res",
      id: frame.id,
      ok: false,
      error: errorShape(ErrorCodes.NOT_PAIRED, message),
    });
    close(1008, truncateCloseReason(message));
    return undefined;
  }

  const { deviceToken, bootstrapDeviceTokens } = await issueGatewayConnectDeviceTokens({
    state: { ...state, scopes, handoffBootstrapProfile },
    scopes,
    hasApprovedDeviceBaseline: hasServerApprovedDeviceTokenBaseline,
  });

  return {
    ...state,
    scopes,
    handoffBootstrapProfile,
    deviceToken,
    bootstrapDeviceTokens,
  };
}
