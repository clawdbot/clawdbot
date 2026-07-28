import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../../../infra/device-pairing.js";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  resolveBootstrapProfileScopesForRole,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { normalizeDeviceMetadataForAuth } from "../../device-auth.js";

export function resolvePairedAccessScopes(
  device: Pick<PairedDevice, "approvedScopes" | "scopes"> | null | undefined,
): string[] {
  const scopes = Array.isArray(device?.approvedScopes)
    ? device.approvedScopes
    : Array.isArray(device?.scopes)
      ? device.scopes
      : [];
  return normalizeSortedUniqueTrimmedStringList(scopes);
}

export function isSetupCodeMobileBootstrapClient(client: {
  id?: string;
  platform?: string;
  deviceFamily?: string;
}): boolean {
  const platform = normalizeDeviceMetadataForAuth(client.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(client.deviceFamily);
  if (client.id === GATEWAY_CLIENT_IDS.ANDROID_APP) {
    return /^android(?:\s|$)/u.test(platform) && deviceFamily === "android";
  }
  if (client.id === GATEWAY_CLIENT_IDS.IOS_APP) {
    return /^(?:ios|ipados)(?:\s|$)/u.test(platform) && /^(?:iphone|ipad|ios)$/u.test(deviceFamily);
  }
  return false;
}

export function isControlUiOperatorBootstrapProfile(params: {
  profile: DeviceBootstrapProfile | null;
  requestedScopes: readonly string[];
}): params is { profile: DeviceBootstrapProfile; requestedScopes: readonly string[] } {
  const { profile, requestedScopes } = params;
  if (!profile || profile.purpose !== "control-ui") {
    return false;
  }
  if (profile.roles.length !== 1 || profile.roles[0] !== "operator") {
    return false;
  }
  if (
    !profile.scopes.every((scope) =>
      (BOOTSTRAP_HANDOFF_OPERATOR_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    return false;
  }
  return roleScopesAllow({
    role: "operator",
    requestedScopes,
    allowedScopes: profile.scopes,
  });
}

export function isMobileNodeBootstrapConnect(params: {
  role: string;
  scopes: readonly string[];
  isControlUi: boolean;
  isBrowserOperatorUi: boolean;
  isWebchat: boolean;
  clientMode?: string;
}): boolean {
  return (
    params.role === "node" &&
    params.scopes.length === 0 &&
    !params.isControlUi &&
    !params.isBrowserOperatorUi &&
    !params.isWebchat &&
    params.clientMode === GATEWAY_CLIENT_MODES.NODE
  );
}

function pairedDeviceAllowsBootstrapRole(params: {
  device: PairedDevice;
  profile: DeviceBootstrapProfile;
  role: string;
}): boolean {
  return (
    hasEffectivePairedDeviceRole(params.device, params.role) &&
    roleScopesAllow({
      role: params.role,
      requestedScopes: resolveBootstrapProfileScopesForRole(
        params.role,
        params.profile.scopes,
        params.profile.purpose,
      ),
      allowedScopes: resolvePairedAccessScopes(params.device),
    })
  );
}

export function pairedDeviceAllowsBootstrapProfile(params: {
  device: PairedDevice | null | undefined;
  devicePublicKey: string;
  profile: DeviceBootstrapProfile;
}): boolean {
  const device = params.device;
  return Boolean(
    device &&
    device.publicKey === params.devicePublicKey &&
    params.profile.roles.every((role) =>
      pairedDeviceAllowsBootstrapRole({ device, profile: params.profile, role }),
    ),
  );
}

export function pairedDeviceAllowsBootstrapOperator(params: {
  device: PairedDevice | null | undefined;
  devicePublicKey: string;
  profile: DeviceBootstrapProfile;
}): boolean {
  const device = params.device;
  return Boolean(
    device &&
    device.publicKey === params.devicePublicKey &&
    pairedDeviceAllowsBootstrapRole({ device, profile: params.profile, role: "operator" }),
  );
}

export function resolvePinnedClientMetadata(params: {
  clientId?: string;
  clientMode?: string;
  claimedPlatform?: string;
  claimedDeviceFamily?: string;
  pairedPlatform?: string;
  pairedDeviceFamily?: string;
}): {
  platformMismatch: boolean;
  deviceFamilyMismatch: boolean;
  pinnedPlatform?: string;
  pinnedDeviceFamily?: string;
  refreshPairedPlatform?: string;
} {
  function normalizeLegacyNodeHostPlatformPin(value: string): string {
    switch (value) {
      case "darwin":
      case "macos":
        return "macos";
      case "win32":
      case "windows":
        return "windows";
      default:
        return value;
    }
  }

  function resolveNativeAppPlatformFamily(
    clientId: string | undefined,
    value: string,
  ): string | undefined {
    if (clientId === GATEWAY_CLIENT_IDS.IOS_APP && /^(?:ios|ipados)(?:\s|$)/.test(value)) {
      return "ios-family";
    }
    if (clientId === GATEWAY_CLIENT_IDS.ANDROID_APP && /^android(?:\s|$)/.test(value)) {
      return "android";
    }
    if (clientId === GATEWAY_CLIENT_IDS.MACOS_APP && /^macos \d+(?:\.\d+){0,2}$/.test(value)) {
      return "macos";
    }
    return undefined;
  }

  const claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
  const claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
  const pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
  const pairedDeviceFamily = normalizeDeviceMetadataForAuth(params.pairedDeviceFamily);
  const hasPinnedPlatform = pairedPlatform !== "";
  const hasPinnedDeviceFamily = pairedDeviceFamily !== "";
  const isLegacyNodeHostPlatformPin =
    params.clientId === GATEWAY_CLIENT_IDS.NODE_HOST &&
    params.clientMode === GATEWAY_CLIENT_MODES.NODE &&
    hasPinnedPlatform &&
    claimedPlatform !== "" &&
    normalizeLegacyNodeHostPlatformPin(claimedPlatform) ===
      normalizeLegacyNodeHostPlatformPin(pairedPlatform);
  const isNodeHostUsingMacAppPlatformPin =
    params.clientId === GATEWAY_CLIENT_IDS.NODE_HOST &&
    params.clientMode === GATEWAY_CLIENT_MODES.NODE &&
    (claimedPlatform === "darwin" || claimedPlatform === "macos") &&
    /^macos \d+(?:\.\d+){0,2}$/.test(pairedPlatform);
  const claimedNativeAppPlatformFamily = resolveNativeAppPlatformFamily(
    params.clientId,
    claimedPlatform,
  );
  const pairedNativeAppPlatformFamily = resolveNativeAppPlatformFamily(
    params.clientId,
    pairedPlatform,
  );
  const isNativeAppPlatformVersionRefresh =
    hasPinnedPlatform &&
    claimedPlatform !== "" &&
    claimedPlatform !== pairedPlatform &&
    ((claimedNativeAppPlatformFamily !== undefined &&
      claimedNativeAppPlatformFamily === pairedNativeAppPlatformFamily) ||
      (params.clientId === GATEWAY_CLIENT_IDS.MACOS_APP &&
        claimedNativeAppPlatformFamily === "macos" &&
        (pairedPlatform === "darwin" || pairedPlatform === "macos")));
  const platformMismatch =
    hasPinnedPlatform &&
    claimedPlatform !== pairedPlatform &&
    !isLegacyNodeHostPlatformPin &&
    !isNodeHostUsingMacAppPlatformPin &&
    !isNativeAppPlatformVersionRefresh;
  const deviceFamilyMismatch = hasPinnedDeviceFamily && claimedDeviceFamily !== pairedDeviceFamily;
  const pinnedPlatform =
    claimedPlatform === pairedPlatform
      ? params.pairedPlatform
      : isLegacyNodeHostPlatformPin
        ? normalizeLegacyNodeHostPlatformPin(pairedPlatform)
        : isNodeHostUsingMacAppPlatformPin
          ? params.pairedPlatform
          : isNativeAppPlatformVersionRefresh
            ? params.claimedPlatform
            : undefined;
  return {
    platformMismatch,
    deviceFamilyMismatch,
    pinnedPlatform: hasPinnedPlatform ? pinnedPlatform : undefined,
    pinnedDeviceFamily: hasPinnedDeviceFamily ? params.pairedDeviceFamily : undefined,
    ...(isNativeAppPlatformVersionRefresh ? { refreshPairedPlatform: params.claimedPlatform } : {}),
  };
}
