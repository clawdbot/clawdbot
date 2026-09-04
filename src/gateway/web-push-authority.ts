import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPairedDevicesReadOnly } from "../infra/device-pairing-store-readonly.js";
import { hasEffectivePairedDeviceRole, type PairedDevice } from "../infra/device-pairing.js";
import { listBoundWebPushSubscriptions, type BoundWebPushSubscription } from "../infra/push-web.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";

const OPERATOR_ROLE = "operator";

export type CurrentWebPushTarget = {
  subscription: BoundWebPushSubscription;
  scopes: string[];
  userProfileId: string | null;
};

function resolveCurrentWebPushTarget(params: {
  subscription: BoundWebPushSubscription;
  device: PairedDevice | undefined;
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  visibilityScopes?: readonly string[];
}): CurrentWebPushTarget | null {
  const { device, subscription, cfg } = params;
  if (!device || !hasEffectivePairedDeviceRole(device, OPERATOR_ROLE)) {
    return null;
  }
  const operatorToken = device.tokens?.[OPERATOR_ROLE];
  const approvedScopes = device.approvedScopes ?? device.scopes;
  if (
    !operatorToken ||
    operatorToken.revokedAtMs ||
    !approvedScopes ||
    !roleScopesAllow({
      role: OPERATOR_ROLE,
      requestedScopes: operatorToken.scopes,
      allowedScopes: approvedScopes,
    })
  ) {
    return null;
  }

  const storedProfileId = subscription.userProfileId;
  const userProfileId = storedProfileId ? (resolveUserProfileId(storedProfileId) ?? null) : null;
  if ((storedProfileId && !userProfileId) || (cfg.gateway?.roles && !userProfileId)) {
    return null;
  }
  const rolePolicy = userProfileId
    ? resolveOperatorRolePolicyForProfile(userProfileId, cfg)
    : undefined;
  if (cfg.gateway?.roles && !rolePolicy) {
    return null;
  }
  const scopesAllowed = (requestedScopes: readonly string[]) =>
    roleScopesAllow({
      role: OPERATOR_ROLE,
      requestedScopes,
      allowedScopes: operatorToken.scopes,
    }) &&
    (!rolePolicy ||
      roleScopesAllow({
        role: OPERATOR_ROLE,
        requestedScopes,
        allowedScopes: rolePolicy.scopes,
      }));
  if (!scopesAllowed(params.requiredScopes)) {
    return null;
  }
  // Only targeted callers request extra visibility. Both current authorities must
  // grant it; generic pushes retain their deliberately narrow required scopes.
  const visibilityScopes = rolePolicy
    ? (params.visibilityScopes ?? []).filter((scope) => scopesAllowed([scope]))
    : [];
  return {
    subscription,
    scopes: [...new Set([...params.requiredScopes, ...visibilityScopes])],
    userProfileId,
  };
}

/** Reads every mutable authority fact in the caller's network-I/O continuation. */
export function listCurrentWebPushTargets(params: {
  cfg: OpenClawConfig;
  requiredScopes: readonly string[];
  visibilityScopes?: readonly string[];
  stateDir?: string;
}): CurrentWebPushTarget[] {
  const pairedByDeviceId = new Map(
    listPairedDevicesReadOnly(params.stateDir).map((device) => [device.deviceId, device]),
  );
  return listBoundWebPushSubscriptions(params.stateDir).flatMap((subscription) => {
    const target = resolveCurrentWebPushTarget({
      subscription,
      device: pairedByDeviceId.get(subscription.deviceId),
      cfg: params.cfg,
      requiredScopes: params.requiredScopes,
      visibilityScopes: params.visibilityScopes,
    });
    return target ? [target] : [];
  });
}

export function webPushTargetClient(target: CurrentWebPushTarget): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "web-push",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      device: {
        id: target.subscription.deviceId,
        publicKey: "web-push",
        signature: "web-push",
        signedAt: 0,
        nonce: "web-push",
      },
      role: OPERATOR_ROLE,
      scopes: target.scopes,
    },
    ...(target.userProfileId
      ? {
          authenticatedUserProfile: {
            profileId: target.userProfileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 0,
          },
        }
      : {}),
  };
}
