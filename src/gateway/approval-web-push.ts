// Delivers generic approval notifications to Web Push subscriptions whose
// persisted browser binding still has current approval and visibility access.
import { createHash } from "node:crypto";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasEffectivePairedDeviceRole,
  listDevicePairing,
  type PairedDevice,
} from "../infra/device-pairing.js";
import {
  deleteWebPushApprovalDeliveryTargets,
  listBoundWebPushSubscriptions,
  listTerminalWebPushApprovalDeliveryIds,
  listWebPushApprovalDeliveryTargets,
  prepareWebPushApprovalDeliveries,
  prepareWebPushNotificationSender,
  retainSuccessfulWebPushApprovalDeliveries,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { resolveOperatorRolePolicyForProfile } from "./operator-role-policy.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { isApprovalRecordVisibleToClient } from "./server-methods/approval-record-lookup.js";
import type { GatewayClient } from "./server-methods/types.js";

const OPERATOR_ROLE = "operator";
const WEB_PUSH_APPROVAL_TIMEOUT_MS = 10_000;
const WEB_PUSH_TERMINAL_TTL_SECONDS = 5 * 60;

type CurrentApprovalWebPushTarget = {
  subscription: BoundWebPushSubscription;
  scopes: string[];
  userProfileId: string | null;
};

type PreparedWebPushNotificationSender = Awaited<
  ReturnType<typeof prepareWebPushNotificationSender>
>;

type ApprovalRequestWebPushDelivery = {
  cfg: OpenClawConfig;
  sender: PreparedWebPushNotificationSender;
};

type ApprovalWebPushDeliveryState = {
  requestPushPromise: Promise<ApprovalRequestWebPushDelivery | null>;
};

function approvalWebPushTag(approvalId: string): string {
  return `openclaw-approval-${approvalId}`;
}

function approvalWebPushTopic(approvalId: string): string {
  return createHash("sha256")
    .update(`openclaw-approval:${approvalId}`)
    .digest("base64url")
    .slice(0, 32);
}

function approvalWebPushUrl(cfg: OpenClawConfig, approvalId: string): string {
  const controlUiBasePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  // The receiving PWA owns the service-worker scope, which may differ from the
  // remote Gateway's base path. Keep navigation relative to that PWA scope.
  const approvalPath = `approve/${encodeURIComponent(approvalId)}`;
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  if (!publicOrigin) {
    return approvalPath;
  }
  const gatewayUrl = `${publicOrigin.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:")}${controlUiBasePath}`;
  return `${approvalPath}#${new URLSearchParams({ gatewayUrl })}`;
}

function resolveCurrentApprovalTarget(params: {
  subscription: BoundWebPushSubscription;
  device: PairedDevice | undefined;
  cfg: OpenClawConfig;
}): CurrentApprovalWebPushTarget | null {
  const { device, subscription, cfg } = params;
  if (!device || !hasEffectivePairedDeviceRole(device, OPERATOR_ROLE)) {
    return null;
  }
  const operatorToken = device.tokens?.[OPERATOR_ROLE];
  if (!operatorToken || operatorToken.revokedAtMs) {
    return null;
  }
  const approvedScopes = device.approvedScopes ?? device.scopes;
  if (
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
  if (storedProfileId && !userProfileId) {
    return null;
  }
  if (cfg.gateway?.roles && !userProfileId) {
    // A role boundary cannot recover which owner registered an old profile-less row.
    return null;
  }
  const rolePolicy = userProfileId
    ? resolveOperatorRolePolicyForProfile(userProfileId, cfg)
    : undefined;
  const allowedRoleScopes = rolePolicy ? new Set<string>(rolePolicy.scopes) : null;
  const scopes = allowedRoleScopes
    ? operatorToken.scopes.filter((scope) => allowedRoleScopes.has(scope))
    : [...operatorToken.scopes];
  if (
    !roleScopesAllow({
      role: OPERATOR_ROLE,
      requestedScopes: [APPROVALS_SCOPE, READ_SCOPE],
      allowedScopes: scopes,
    })
  ) {
    return null;
  }
  return { subscription, scopes, userProfileId };
}

function approvalWebPushClient(target: CurrentApprovalWebPushTarget): GatewayClient {
  const userProfileId = target.userProfileId;
  // Visibility owns only the authenticated identity, device, role, and scopes.
  // Complete inert handshake metadata keeps this projection inside the GatewayClient contract.
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        version: "approval-web-push",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      device: {
        id: target.subscription.deviceId,
        publicKey: "approval-web-push",
        signature: "approval-web-push",
        signedAt: 0,
        nonce: "approval-web-push",
      },
      role: OPERATOR_ROLE,
      scopes: target.scopes,
    },
    ...(userProfileId
      ? {
          authenticatedUserProfile: {
            profileId: userProfileId,
            displayName: null,
            hasAvatar: false,
            updatedAt: 0,
          },
        }
      : {}),
  };
}

async function deliverBoundApprovalWebPush<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  cfg: OpenClawConfig;
  stateDir?: string;
}): Promise<ApprovalRequestWebPushDelivery | null> {
  if (params.record.resolvedAtMs !== undefined || params.record.expiresAtMs <= Date.now()) {
    return null;
  }
  const sendWebPushNotifications = await prepareWebPushNotificationSender(params.stateDir);
  const pairing = await listDevicePairing();
  const pairedByDeviceId = new Map(pairing.paired.map((device) => [device.deviceId, device]));
  // Transport preparation may await module and key loading. Re-read both
  // binding and authority after it so no async gap remains before network I/O.
  const subscriptions = listBoundWebPushSubscriptions(params.stateDir).filter((subscription) => {
    const target = resolveCurrentApprovalTarget({
      subscription,
      device: pairedByDeviceId.get(subscription.deviceId),
      cfg: params.cfg,
    });
    return Boolean(
      target &&
      isApprovalRecordVisibleToClient({
        record: params.record,
        client: approvalWebPushClient(target),
        cfg: params.cfg,
      }),
    );
  });
  if (subscriptions.length === 0) {
    return null;
  }

  // Transport and pairing preparation await. Terminal state and TTL belong to
  // the approval owner, so reread them with no async gap before network I/O.
  const now = Date.now();
  if (params.record.resolvedAtMs !== undefined || params.record.expiresAtMs <= now) {
    return null;
  }
  // Persist the conservative may-have-received set with no async gap before
  // network I/O. Definite failures are removed after the push service replies.
  if (
    !prepareWebPushApprovalDeliveries({
      approvalId: params.record.id,
      subscriptions,
      preparedAtMs: now,
      stateDir: params.stateDir,
    })
  ) {
    return null;
  }
  const ttlSeconds = Math.ceil((params.record.expiresAtMs - now) / 1_000);
  const results = await sendWebPushNotifications({
    subscriptions,
    payload: {
      title: "OpenClaw approval requested",
      body: "Open OpenClaw to review this request.",
      renotify: false,
      tag: approvalWebPushTag(params.record.id),
      url: approvalWebPushUrl(params.cfg, params.record.id),
    },
    // Approval prompts expire quickly and should not surface after the decision window.
    deliveryOptions: {
      TTL: ttlSeconds,
      urgency: "high",
      timeout: WEB_PUSH_APPROVAL_TIMEOUT_MS,
      topic: approvalWebPushTopic(params.record.id),
    },
  });
  const deliveredSubscriptionIds = new Set(
    results.filter((result) => result.ok).map((result) => result.subscriptionId),
  );
  retainSuccessfulWebPushApprovalDeliveries({
    approvalId: params.record.id,
    successfulSubscriptionIds: [...deliveredSubscriptionIds],
    stateDir: params.stateDir,
  });
  return deliveredSubscriptionIds.size > 0
    ? { cfg: params.cfg, sender: sendWebPushNotifications }
    : null;
}

/** Retains successful request targets so terminal state replaces their tagged alert. */
export function createApprovalWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: { warn?: (message: string) => void };
  stateDir?: string;
}) {
  const deliveriesByApprovalId = new Map<string, ApprovalWebPushDeliveryState>();
  const terminalDeliveriesByApprovalId = new Map<string, Promise<void>>();

  const handleTerminal = (approval: { id: string }): Promise<void> => {
    const active = terminalDeliveriesByApprovalId.get(approval.id);
    if (active) {
      return active;
    }
    const terminalDelivery = (async () => {
      const deliveryState = deliveriesByApprovalId.get(approval.id);
      deliveriesByApprovalId.delete(approval.id);
      const requestDelivery = deliveryState ? await deliveryState.requestPushPromise : null;
      const sender =
        requestDelivery?.sender ?? (await prepareWebPushNotificationSender(params.stateDir));
      // Transport preparation may await module/key loading. Re-read and compare
      // the mutable subscription binding afterwards with no async gap before send.
      const subscriptions = listWebPushApprovalDeliveryTargets({
        approvalId: approval.id,
        stateDir: params.stateDir,
      });
      if (subscriptions.length === 0) {
        return;
      }
      const cfg = requestDelivery?.cfg ?? params.getRuntimeConfig();
      const results = await sender({
        subscriptions,
        payload: {
          title: "OpenClaw approval updated",
          body: "This approval is no longer pending.",
          renotify: false,
          tag: approvalWebPushTag(approval.id),
          url: approvalWebPushUrl(cfg, approval.id),
        },
        // A terminal replacement stays visible per Push API requirements while
        // the shared topic collapses any queued request notification.
        deliveryOptions: {
          TTL: WEB_PUSH_TERMINAL_TTL_SECONDS,
          urgency: "high",
          timeout: WEB_PUSH_APPROVAL_TIMEOUT_MS,
          topic: approvalWebPushTopic(approval.id),
        },
      });
      const successfulSubscriptionIds = results
        .filter((result) => result.ok)
        .map((result) => result.subscriptionId);
      deleteWebPushApprovalDeliveryTargets({
        approvalId: approval.id,
        subscriptionIds: successfulSubscriptionIds,
        stateDir: params.stateDir,
      });
      if (successfulSubscriptionIds.length < subscriptions.length) {
        params.log?.warn?.(
          `approval Web Push terminal replacement reached ${successfulSubscriptionIds.length}/${subscriptions.length} browsers approvalId=${approval.id}`,
        );
      }
    })();
    terminalDeliveriesByApprovalId.set(approval.id, terminalDelivery);
    const releaseTerminalDelivery = () => {
      if (terminalDeliveriesByApprovalId.get(approval.id) === terminalDelivery) {
        terminalDeliveriesByApprovalId.delete(approval.id);
      }
    };
    void terminalDelivery.then(releaseTerminalDelivery, releaseTerminalDelivery);
    return terminalDelivery;
  };

  return {
    /** Sends a request notification only when at least one browser has a durable binding. */
    handleRequested<TPayload>(record: ExecApprovalRecord<TPayload>): boolean | Promise<boolean> {
      if (listBoundWebPushSubscriptions(params.stateDir).length === 0) {
        return false;
      }
      const deliveryState: ApprovalWebPushDeliveryState = {
        requestPushPromise: deliverBoundApprovalWebPush({
          record,
          cfg: params.getRuntimeConfig(),
          stateDir: params.stateDir,
        }),
      };
      deliveriesByApprovalId.set(record.id, deliveryState);
      return deliveryState.requestPushPromise.then(
        (delivery) => {
          if (!delivery && deliveriesByApprovalId.get(record.id) === deliveryState) {
            deliveriesByApprovalId.delete(record.id);
          }
          return Boolean(delivery);
        },
        (error: unknown) => {
          if (deliveriesByApprovalId.get(record.id) === deliveryState) {
            deliveriesByApprovalId.delete(record.id);
          }
          throw error;
        },
      );
    },

    handleResolved: handleTerminal,
    handleExpired: handleTerminal,
    async recoverTerminalDeliveries(): Promise<void> {
      const { approvalIds, truncated } = listTerminalWebPushApprovalDeliveryIds(params.stateDir);
      if (truncated) {
        params.log?.warn?.(
          "approval Web Push terminal recovery reached its 1024-approval startup bound",
        );
      }
      for (const approvalId of approvalIds) {
        await handleTerminal({ id: approvalId });
      }
    },
  };
}
