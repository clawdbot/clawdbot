import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  isWebPushQuietHours,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  listBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { listCurrentWebPushTargets, webPushTargetClient } from "./web-push-authority.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
};

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\p{Cc}+/gu, " ").trim();
  return normalized ? normalized.slice(0, 80) : undefined;
}

function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = safeLabel(value.id) ?? "pending";
    return {
      category: "agent-question",
      title: "OpenClaw needs an answer",
      body: "An agent has a question for you.",
      tag: `openclaw-question-${id}`,
    };
  }
  if (event === "chat" && value.state === "final") {
    const runId = safeLabel(value.runId) ?? "finished";
    return {
      category: "agent-finished",
      title: "OpenClaw agent finished",
      body: "An agent completed its response.",
      tag: `openclaw-agent-finished-${runId}`,
    };
  }
  if (event === "task" && value.action === "upserted") {
    const task = isRecord(value.task) ? value.task : null;
    if (task?.status !== "failed" && task?.status !== "timed_out") {
      return null;
    }
    const taskId = safeLabel(task.id) ?? "failed";
    const taskTitle = safeLabel(task.title);
    return {
      category: "background-task-failed",
      title: "OpenClaw background task failed",
      body: "A background task needs attention.",
      ...(taskTitle ? { identifiedBody: `${taskTitle} needs attention.` } : {}),
      tag: `openclaw-task-failed-${taskId}`,
    };
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    const job = isRecord(value.job) ? value.job : null;
    const jobId = safeLabel(value.jobId) ?? "failed";
    const jobName = safeLabel(job?.name);
    return {
      category: "scheduled-task-failed",
      title: "OpenClaw scheduled task failed",
      body: "A scheduled task needs attention.",
      ...(jobName ? { identifiedBody: `${jobName} needs attention.` } : {}),
      tag: `openclaw-cron-failed-${jobId}`,
    };
  }
  return null;
}

function preferenceFor(subscription: BoundWebPushSubscription, stateDir?: string) {
  const profileId = subscription.userProfileId
    ? resolveUserProfileId(subscription.userProfileId)
    : undefined;
  const user = profileId
    ? getUserPreferences(
        profileId,
        [WEB_PUSH_USER_PREFERENCES_KEY],
        stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {},
      )[WEB_PUSH_USER_PREFERENCES_KEY]
    : undefined;
  return resolveEffectiveWebPushPreferences({ user, device: subscription.devicePreferences });
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: { warn?: (message: string) => void };
  stateDir?: string;
}) {
  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (!notification) {
        return;
      }
      void (async () => {
        if (listBoundWebPushSubscriptions(params.stateDir).length === 0) {
          return;
        }
        const sender = await prepareWebPushNotificationSender(params.stateDir);
        const cfg = params.getRuntimeConfig();
        const targets = listCurrentWebPushTargets({
          cfg,
          requiredScopes: [READ_SCOPE],
          stateDir: params.stateDir,
        });
        const agentId = normalizeOptionalString(
          opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
        );
        const groups = new Map<
          string,
          { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
        >();
        for (const target of targets) {
          const subscription = target.subscription;
          if (
            notification.category === "agent-question" &&
            !target.scopes.includes(QUESTIONS_SCOPE)
          ) {
            continue;
          }
          const preferences = preferenceFor(subscription, params.stateDir);
          if (
            !webPushCategoryEnabled(preferences, notification.category) ||
            isWebPushQuietHours(preferences) ||
            !webPushAgentAllowed(preferences, agentId)
          ) {
            continue;
          }
          const sessionKeys = opts?.sessionKeys ?? [];
          if (
            sessionKeys.length > 0 &&
            !canReceiveSessionEvent({
              cfg,
              client: webPushTargetClient(target),
              sessionKeys,
              ...(agentId ? { agentId } : {}),
              event,
              payload,
            })
          ) {
            continue;
          }
          if (cfg.gateway?.roles && sessionKeys.length === 0) {
            // Multi-user events without an authoritative session owner are not broadcast offline.
            continue;
          }
          const prefix = preferences.label ? `${preferences.label} · ` : "";
          const title = `${prefix}${notification.title}`;
          const body =
            preferences.detailLevel === "private"
              ? notification.body
              : (notification.identifiedBody ??
                (agentId ? `${agentId}: ${notification.body}` : notification.body));
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
                renotify: false,
              },
              deliveryOptions: {
                TTL: EVENT_PUSH_TTL_SECONDS,
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
