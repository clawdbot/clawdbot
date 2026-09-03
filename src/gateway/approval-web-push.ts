// Delivers generic approval notifications to Web Push subscriptions whose
// persisted browser binding still has current approval and visibility access.
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  deleteWebPushApprovalDeliveryTargets,
  listBoundWebPushSubscriptions,
  listTerminalWebPushApprovalDeliveryIds,
  listWebPushApprovalDeliveryTargets,
  prepareWebPushApprovalDeliveries,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { APPROVALS_SCOPE } from "./method-scopes.js";
import { canAccessOperatorApproval } from "./operator-approval-authorization.js";
import { getOperatorApprovalDetailed } from "./operator-approval-store.js";
import { READ_SCOPE } from "./operator-scopes.js";
import {
  canAccessApprovalSession,
  isApprovalRecordVisibleToClient,
} from "./server-methods/approval-record-lookup.js";
import { listCurrentWebPushTargets, webPushTargetClient } from "./web-push-authority.js";

const WEB_PUSH_APPROVAL_TIMEOUT_MS = 10_000;
const WEB_PUSH_TERMINAL_TTL_SECONDS = 5 * 60;

type PreparedWebPushNotificationSender = Awaited<
  ReturnType<typeof prepareWebPushNotificationSender>
>;

type ApprovalRequestWebPushDelivery = {
  record: ExecApprovalRecord<unknown>;
  sender: PreparedWebPushNotificationSender;
};

function approvalPreferences(params: {
  subscription: BoundWebPushSubscription;
  stateDir?: string;
}) {
  const profileId = params.subscription.userProfileId
    ? resolveUserProfileId(params.subscription.userProfileId)
    : undefined;
  const storedUser = profileId
    ? getUserPreferences(
        profileId,
        [WEB_PUSH_USER_PREFERENCES_KEY],
        params.stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } } : {},
      )[WEB_PUSH_USER_PREFERENCES_KEY]
    : undefined;
  return resolveEffectiveWebPushPreferences({
    user: storedUser,
    device: params.subscription.devicePreferences,
  });
}

function approvalNotificationCopy(params: {
  terminal: boolean;
  preferences: ReturnType<typeof approvalPreferences>;
  agentLabel?: string;
}) {
  const label = params.preferences.label ? `${params.preferences.label} · ` : "";
  const agent = params.agentLabel ? ` for ${params.agentLabel}` : "";
  if (params.terminal) {
    return {
      title: `${label}OpenClaw approval updated`,
      body:
        params.preferences.detailLevel === "private"
          ? "This approval is no longer pending."
          : `Approval${agent} is no longer pending.`,
    };
  }
  return {
    title: `${label}OpenClaw approval requested`,
    body:
      params.preferences.detailLevel === "private"
        ? "Open OpenClaw to review this request."
        : `Open OpenClaw to review an approval${agent}.`,
  };
}

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

async function deliverBoundApprovalWebPush<TPayload>(params: {
  record: ExecApprovalRecord<TPayload>;
  getRuntimeConfig: () => OpenClawConfig;
  stateDir?: string;
}): Promise<ApprovalRequestWebPushDelivery | null> {
  if (params.record.resolvedAtMs !== undefined || params.record.expiresAtMs <= Date.now()) {
    return null;
  }
  const sendWebPushNotifications = await prepareWebPushNotificationSender(params.stateDir);
  const cfg = params.getRuntimeConfig();
  const targets = listCurrentWebPushTargets({
    cfg,
    requiredScopes: [APPROVALS_SCOPE, READ_SCOPE],
    stateDir: params.stateDir,
  });
  const subscriptions = targets.flatMap((target) => {
    const subscription = target.subscription;
    const preferences = approvalPreferences({ subscription, stateDir: params.stateDir });
    const source = isRecord(params.record.request) ? params.record.request : undefined;
    const agentId = normalizeOptionalString(source?.agentId);
    return webPushCategoryEnabled(preferences, "approval-requested") &&
      !isWebPushQuietHours(preferences) &&
      webPushAgentAllowed(preferences, agentId) &&
      isApprovalRecordVisibleToClient({
        record: params.record,
        client: webPushTargetClient(target),
        cfg,
      })
      ? [subscription]
      : [];
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
  const source = isRecord(params.record.request) ? params.record.request : undefined;
  const agentId = normalizeOptionalString(source?.agentId);
  const agentLabel = normalizeWebPushDisplayLabel(agentId);
  const requestGroups = new Map<
    string,
    { copy: ReturnType<typeof approvalNotificationCopy>; subscriptions: BoundWebPushSubscription[] }
  >();
  for (const subscription of subscriptions) {
    const preferences = approvalPreferences({ subscription, stateDir: params.stateDir });
    const copy = approvalNotificationCopy({ terminal: false, preferences, agentLabel });
    const key = JSON.stringify(copy);
    const group = requestGroups.get(key) ?? { copy, subscriptions: [] };
    group.subscriptions.push(subscription);
    requestGroups.set(key, group);
  }
  const results = (
    await Promise.all(
      [...requestGroups.values()].map(({ copy, subscriptions: groupedSubscriptions }) =>
        sendWebPushNotifications({
          subscriptions: groupedSubscriptions,
          payload: {
            ...copy,
            renotify: false,
            tag: approvalWebPushTag(params.record.id),
            url: resolveControlUiWebPushUrl(cfg, `approve/${encodeURIComponent(params.record.id)}`),
          },
          deliveryOptions: {
            TTL: ttlSeconds,
            urgency: "high",
            timeout: WEB_PUSH_APPROVAL_TIMEOUT_MS,
            topic: approvalWebPushTopic(params.record.id),
          },
        }),
      ),
    )
  ).flat();
  const definitelyRejectedSubscriptionIds = results
    .filter((result) => !result.ok && result.statusCode !== undefined)
    .map((result) => result.subscriptionId);
  deleteWebPushApprovalDeliveryTargets({
    approvalId: params.record.id,
    subscriptionIds: definitelyRejectedSubscriptionIds,
    stateDir: params.stateDir,
  });
  const possibleDeliverySubscriptionIds = new Set(
    results
      .filter((result) => result.ok || result.statusCode === undefined)
      .map((result) => result.subscriptionId),
  );
  return possibleDeliverySubscriptionIds.size > 0
    ? { record: params.record, sender: sendWebPushNotifications }
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
      const cfg = params.getRuntimeConfig();
      const currentTargets = listCurrentWebPushTargets({
        cfg,
        requiredScopes: [APPROVALS_SCOPE, READ_SCOPE],
        stateDir: params.stateDir,
      });
      const currentTargetsBySubscriptionId = new Map(
        currentTargets.map((target) => [target.subscription.subscriptionId, target]),
      );
      // Pairing and transport preparation may await. Read durable targets only
      // afterwards so revoked or rebound recipients cannot reach network I/O.
      const subscriptions = listWebPushApprovalDeliveryTargets({
        approvalId: approval.id,
        stateDir: params.stateDir,
      });
      if (subscriptions.length === 0) {
        return;
      }
      const durableLookup = requestDelivery
        ? null
        : getOperatorApprovalDetailed({
            id: approval.id,
            databaseOptions: params.stateDir
              ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } }
              : undefined,
          });
      const durableRecord = durableLookup?.outcome === "found" ? durableLookup.record : null;
      const terminalGroups = new Map<
        string,
        {
          copy: ReturnType<typeof approvalNotificationCopy>;
          subscriptions: BoundWebPushSubscription[];
        }
      >();
      const suppressedSubscriptionIds: string[] = [];
      for (const subscription of subscriptions) {
        const target = currentTargetsBySubscriptionId.get(subscription.subscriptionId);
        const client = target ? webPushTargetClient(target) : null;
        const visible = requestDelivery
          ? Boolean(
              client &&
              isApprovalRecordVisibleToClient({
                record: requestDelivery.record,
                client,
                cfg,
              }),
            )
          : Boolean(
              client &&
              durableRecord &&
              canAccessOperatorApproval({
                client,
                binding: { reviewerDeviceIds: durableRecord.reviewerDeviceIds },
              }) &&
              canAccessApprovalSession({
                cfg,
                client,
                sessionKey: durableRecord.source.sessionKey,
                agentId: durableRecord.source.agentId,
              }),
            );
        const preferences = approvalPreferences({ subscription, stateDir: params.stateDir });
        if (!visible) {
          suppressedSubscriptionIds.push(subscription.subscriptionId);
          continue;
        }
        const copy = approvalNotificationCopy({ terminal: true, preferences });
        const key = JSON.stringify(copy);
        const group = terminalGroups.get(key) ?? { copy, subscriptions: [] };
        group.subscriptions.push(subscription);
        terminalGroups.set(key, group);
      }
      const results = (
        await Promise.all(
          [...terminalGroups.values()].map(({ copy, subscriptions: groupedSubscriptions }) =>
            sender({
              subscriptions: groupedSubscriptions,
              payload: {
                ...copy,
                renotify: false,
                tag: approvalWebPushTag(approval.id),
                url: resolveControlUiWebPushUrl(cfg, `approve/${encodeURIComponent(approval.id)}`),
              },
              deliveryOptions: {
                TTL: WEB_PUSH_TERMINAL_TTL_SECONDS,
                urgency: "high",
                timeout: WEB_PUSH_APPROVAL_TIMEOUT_MS,
                topic: approvalWebPushTopic(approval.id),
              },
            }),
          ),
        )
      ).flat();
      const successfulSubscriptionIds = results
        .filter((result) => result.ok)
        .map((result) => result.subscriptionId);
      deleteWebPushApprovalDeliveryTargets({
        approvalId: approval.id,
        subscriptionIds: [...successfulSubscriptionIds, ...suppressedSubscriptionIds],
        stateDir: params.stateDir,
      });
      const completedSubscriptionCount =
        successfulSubscriptionIds.length + suppressedSubscriptionIds.length;
      if (completedSubscriptionCount < subscriptions.length) {
        params.log?.warn?.(
          `approval Web Push terminal replacement reached ${successfulSubscriptionIds.length}/${subscriptions.length - suppressedSubscriptionIds.length} eligible browsers approvalId=${approval.id}`,
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
          getRuntimeConfig: params.getRuntimeConfig,
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
      let afterApprovalId: string | undefined;
      let throughApprovalId: string | undefined;
      do {
        const page = listTerminalWebPushApprovalDeliveryIds({
          stateDir: params.stateDir,
          ...(afterApprovalId ? { afterApprovalId } : {}),
          ...(throughApprovalId ? { throughApprovalId } : {}),
        });
        throughApprovalId = page.throughApprovalId ?? undefined;
        for (const approvalId of page.approvalIds) {
          await handleTerminal({ id: approvalId });
        }
        afterApprovalId = page.nextAfterApprovalId ?? undefined;
      } while (afterApprovalId);
    },
  };
}
