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
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  requestDevicePairing,
} from "../../../infra/device-pairing.js";
import {
  isMobilePairingSetupBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
  resolveBootstrapProfileScopesForRoles,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { pruneSupersededSilentPairingsAfterApproval } from "../../device-pairing-prune.js";
import { shouldAutoApproveNodePairingFromTrustedCidrs } from "../../node-pairing-auto-approve.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  isControlUiOperatorBootstrapProfile,
  isMobileNodeBootstrapConnect,
  isSetupCodeMobileBootstrapClient,
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

export async function authorizeGatewayConnectDevice(
  context: GatewayConnectPhaseContext,
  state: AuthenticatedGatewayConnect,
): Promise<DeviceAuthorizedGatewayConnect | undefined> {
  const { connId, buildRequestContext, close, send, setHandshakeState, setCloseCause, logGateway } =
    context.handler;
  const {
    frame,
    connectParams,
    configSnapshot,
    reportedClientIp,
    reportedClientIpSource,
    hasBrowserOriginHeader,
  } = context;
  const { scopes } = state;
  let { handoffBootstrapProfile } = state;
  const {
    role,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
    device,
    devicePublicKey,
    authMethod,
    bootstrapTokenCandidate,
    pairingLocality,
    skipLocalBackendSelfPairing,
    skipControlUiPairingForDevice,
  } = state;
  let hasServerApprovedDeviceTokenBaseline = false;
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
      const allowSilentExistingNonOperatorPairing = !(existingPairedDevice && role !== "operator");
      const allowSilentLocalPairing =
        allowSilentExistingNonOperatorPairing &&
        shouldAllowSilentLocalPairing({
          locality: pairingLocality,
          hasBrowserOriginHeader,
          isControlUi,
          isWebchat,
          isNativeAppUi,
          reason,
        });
      const allowSilentTrustedCidrsNodePairing = shouldAutoApproveNodePairingFromTrustedCidrs({
        existingPairedDevice: Boolean(existingPairedDevice),
        role,
        reason,
        scopes,
        hasBrowserOriginHeader,
        isControlUi,
        isWebchat,
        reportedClientIpSource,
        reportedClientIp,
        autoApproveCidrs: configSnapshot.gateway?.nodes?.pairing?.autoApproveCidrs,
      });
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
          isSetupCodeMobileNodeConnect);
      const boundBootstrapProfile =
        authMethod === "bootstrap-token" &&
        bootstrapTokenCandidate &&
        allowBoundBootstrapProfileLookup
          ? await getBoundDeviceBootstrapProfile({
              token: bootstrapTokenCandidate,
              deviceId: device.id,
              publicKey: devicePublicKey,
            })
          : null;
      const allowSetupCodeMobileBootstrapPairing =
        boundBootstrapProfile !== null &&
        isMobilePairingSetupBootstrapProfile(boundBootstrapProfile) &&
        isSetupCodeMobileNodeConnect &&
        isSetupCodeMobileBootstrapClient(connectParams.client);
      const setupCodeMobileBootstrapProfile = allowSetupCodeMobileBootstrapPairing
        ? boundBootstrapProfile
        : null;
      const allowControlUiOperatorBootstrapPairing = isControlUiOperatorBootstrapProfile({
        profile: boundBootstrapProfile,
        requestedScopes: scopes,
      });
      const controlUiOperatorBootstrapProfile = allowControlUiOperatorBootstrapPairing
        ? boundBootstrapProfile
        : null;
      // This is the native QR/setup-code onboarding seam. Mobile clients
      // must prove their canonical client id and platform/family metadata
      // agree before the Gateway can skip owner approval and hand off the
      // selected operator profile below. Full mobile setup includes admin;
      // limited setup retains the previous bounded operator scope set.
      const bootstrapPairingRoles = setupCodeMobileBootstrapProfile
        ? uniqueStrings([role, ...setupCodeMobileBootstrapProfile.roles])
        : controlUiOperatorBootstrapProfile
          ? ["operator"]
          : undefined;
      const bootstrapPairingScopes = setupCodeMobileBootstrapProfile
        ? resolveBootstrapProfileScopesForRoles(
            bootstrapPairingRoles ?? [],
            setupCodeMobileBootstrapProfile.scopes,
            setupCodeMobileBootstrapProfile.purpose,
          )
        : controlUiOperatorBootstrapProfile
          ? resolveBootstrapProfileScopesForRole(
              "operator",
              controlUiOperatorBootstrapProfile.scopes,
              controlUiOperatorBootstrapProfile.purpose,
            )
          : undefined;
      const bootstrapApprovalProfile =
        setupCodeMobileBootstrapProfile ?? controlUiOperatorBootstrapProfile;
      const pairing = await requestDevicePairing({
        deviceId: device.id,
        publicKey: devicePublicKey,
        ...clientPairingMetadata,
        ...(bootstrapPairingRoles
          ? {
              roles: bootstrapPairingRoles,
              scopes: bootstrapPairingScopes ?? [],
            }
          : {}),
        silent:
          reason === "scope-upgrade" && !allowSetupCodeMobileBootstrapPairing
            ? false
            : allowSilentLocalPairing ||
              allowSilentTrustedCidrsNodePairing ||
              allowSetupCodeMobileBootstrapPairing ||
              allowControlUiOperatorBootstrapPairing,
      });
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
      if (pairing.request.silent === true) {
        approved = bootstrapApprovalProfile
          ? await approveBootstrapDevicePairing(
              pairing.request.requestId,
              bootstrapApprovalProfile,
              { accessMetadata: clientAccessMetadata },
            )
          : await approveDevicePairing(pairing.request.requestId, {
              callerScopes: scopes,
              accessMetadata: clientAccessMetadata,
              // Same-host local approvals are prune-eligible "silent";
              // trusted-CIDR approvals cross hosts and must never be
              // auto-pruned, so they carry their own provenance.
              approvedVia: allowSilentLocalPairing ? "silent" : "trusted-cidr",
            });
        if (approved?.status === "approved") {
          if (bootstrapApprovalProfile) {
            handoffBootstrapProfile = bootstrapApprovalProfile;
          }
          logGateway.info(
            `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
          );
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
          if (!(allowSetupCodeMobileBootstrapPairing && boundBootstrapProfile)) {
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
          const pairedAfterConcurrentApproval = await getPairedDevice(device.id);
          resolvedByConcurrentApproval = bootstrapApprovalProfile
            ? pairedDeviceAllowsBootstrapProfile({
                device: pairedAfterConcurrentApproval,
                devicePublicKey,
                profile: bootstrapApprovalProfile,
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
      if (
        !(
          pairing.request.silent === true &&
          (approved?.status === "approved" || resolvedByConcurrentApproval)
        )
      ) {
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
    if (!isPaired) {
      if (!(skipLocalBackendSelfPairing || skipControlUiPairingForDevice)) {
        const ok = await requirePairing("not-paired", paired);
        if (!ok) {
          return undefined;
        }
        hasServerApprovedDeviceTokenBaseline = true;
      } else if (
        skipControlUiPairingForDevice ||
        (skipLocalBackendSelfPairing && authMethod !== "device-token")
      ) {
        hasServerApprovedDeviceTokenBaseline = true;
      }
    } else {
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
