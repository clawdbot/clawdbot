import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { resolveEffectiveWebPushPreferences } from "../infra/push-web-preferences.js";
import {
  listBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import type { NativeNotificationRegistry } from "./native-notifications.js";
import {
  notificationAllowed,
  renderEventNotification,
  resolveEventNotification,
  eventNotificationPath,
  NOTIFICATION_TTL_MS,
} from "./notification-presentation.js";
import { READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { listCurrentWebPushTargets, webPushTargetClient } from "./web-push-authority.js";
import { webPushNotificationUrl } from "./web-push-navigation.js";

function eventCopyForTarget(params: {
  notification: NonNullable<ReturnType<typeof resolveEventNotification>>;
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>;
  client: GatewayWsClient;
  cfg: OpenClawConfig;
  event: string;
  payload: unknown;
  opts?: GatewayBroadcastOpts;
  agentId?: string;
}) {
  const { notification, preferences, client, cfg, event, payload, opts, agentId } = params;
  const sessionKeys = opts?.sessionKeys ?? [];
  if (
    !notificationAllowed(preferences, notification.category, agentId) ||
    (cfg.gateway?.roles && sessionKeys.length === 0) ||
    (sessionKeys.length > 0 &&
      !canReceiveSessionEvent({
        cfg,
        client,
        sessionKeys,
        agentId,
        event,
        payload,
      }))
  ) {
    return null;
  }
  return renderEventNotification(notification, preferences, agentId);
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: { warn?: (message: string) => void };
  stateDir?: string;
  nativeNotifications?: NativeNotificationRegistry;
}) {
  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventNotification(event, payload, opts);
      if (!notification) {
        return;
      }
      const requiredScopes =
        notification.category === "agent-question" ? [READ_SCOPE, QUESTIONS_SCOPE] : [READ_SCOPE];
      const agentId = normalizeOptionalString(
        opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
      );
      const path = eventNotificationPath(event, payload, opts);
      void (async () => {
        const native = params.nativeNotifications;
        const nativeTargets = native?.targets(requiredScopes) ?? [];
        const nativeCfg = nativeTargets.length > 0 ? params.getRuntimeConfig() : {};
        for (const target of nativeTargets) {
          const copy = eventCopyForTarget({
            notification,
            preferences: target.preferences,
            client: target.visibilityClient,
            cfg: nativeCfg,
            event,
            payload,
            opts,
            agentId,
          });
          if (copy) {
            native?.send(target, {
              action: "show",
              alert: true,
              ...copy,
              id: notification.tag,
              category: notification.category,
              path,
              expiresAtMs: Date.now() + NOTIFICATION_TTL_MS,
            });
          }
        }
        if (listBoundWebPushSubscriptions(params.stateDir).length === 0) {
          return;
        }
        const sender = await prepareWebPushNotificationSender(params.stateDir);
        const cfg = params.getRuntimeConfig();
        const targets = listCurrentWebPushTargets({
          cfg,
          requiredScopes,
          stateDir: params.stateDir,
        });
        const groups = new Map<
          string,
          { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
        >();
        for (const target of targets) {
          const subscription = target.subscription;
          const copy = eventCopyForTarget({
            notification,
            preferences: target.preferences,
            client: webPushTargetClient(target),
            cfg,
            event,
            payload,
            opts,
            agentId,
          });
          if (!copy) {
            continue;
          }
          const { title, body } = copy;
          const key = JSON.stringify({ title, body });
          const group = groups.get(key) ?? { title, body, subscriptions: [] };
          group.subscriptions.push(subscription);
          groups.set(key, group);
        }
        const topic = createHash("sha256")
          .update(notification.tag)
          .digest("base64url")
          .slice(0, 32);
        await Promise.all(
          [...groups.values()].map((group) =>
            sender({
              subscriptions: group.subscriptions,
              payload: {
                title: group.title,
                body: group.body,
                tag: notification.tag,
                url: webPushNotificationUrl(cfg, path),
                renotify: false,
              },
              deliveryOptions: {
                TTL: NOTIFICATION_TTL_MS / 1_000,
                urgency: notification.category.includes("failed") ? "high" : "normal",
                topic,
              },
            }),
          ),
        );
      })().catch((error: unknown) => {
        params.log?.warn?.(`event Web Push delivery failed event=${event}: ${String(error)}`);
      });
    },
  };
}
