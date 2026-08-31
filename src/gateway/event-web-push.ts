import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryDeliveryMode,
} from "../infra/push-web-preferences.js";
import {
  listBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
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

function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = normalizeWebPushDisplayLabel(value.id) ?? "pending";
    return {
      category: "agent-question",
      title: "OpenClaw needs an answer",
      body: "An agent has a question for you.",
      tag: `openclaw-question-${id}`,
    };
  }
  if (
    event === "chat" &&
    value.state === "final" &&
    !isTranscriptOnlyOpenClawAssistantMessage(value.message)
  ) {
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "finished";
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
    const taskId = normalizeWebPushDisplayLabel(task.id) ?? "failed";
    const taskTitle = normalizeWebPushDisplayLabel(task.title);
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
    const jobId = normalizeWebPushDisplayLabel(value.jobId) ?? "failed";
    const jobName = normalizeWebPushDisplayLabel(job?.name);
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

function eventNotificationUrl(
  cfg: OpenClawConfig,
  sessionKeys: readonly string[],
  agentId?: string,
): string | undefined {
  if (sessionKeys.length !== 1) {
    return undefined;
  }
  const path = buildControlUiSessionPath({
    namespace: "chat",
    sessionKey: sessionKeys[0] ?? "",
    fallbackAgentId: agentId,
    exactKey: true,
  });
  if (!path) {
    return undefined;
  }
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  if (!publicOrigin) {
    return path.slice(1);
  }
  const controlUiBasePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const gatewayUrl = `${publicOrigin.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:")}${controlUiBasePath}`;
  return `${path.slice(1)}#${new URLSearchParams({ gatewayUrl })}`;
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
          requiredScopes:
            notification.category === "agent-question"
              ? [READ_SCOPE, QUESTIONS_SCOPE]
              : [READ_SCOPE],
          stateDir: params.stateDir,
        });
        const agentId = normalizeOptionalString(
          opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
        );
        const agentLabel = normalizeWebPushDisplayLabel(agentId);
        const sessionKeys = opts?.sessionKeys ?? [];
        const url = eventNotificationUrl(cfg, sessionKeys, agentId);
        const groups = new Map<
          string,
          {
            title: string;
            body: string;
            focusPolicy: "always" | "unfocused";
            subscriptions: BoundWebPushSubscription[];
          }
        >();
        for (const target of targets) {
          const subscription = target.subscription;
          const preferences = preferenceFor(subscription, params.stateDir);
          const deliveryMode = webPushCategoryDeliveryMode(preferences, notification.category);
          if (
            deliveryMode === "never" ||
            isWebPushQuietHours(preferences) ||
            !webPushAgentAllowed(preferences, agentId)
          ) {
            continue;
          }
          const focusPolicy = deliveryMode === "unfocused" ? "unfocused" : "always";
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
                (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
          const key = JSON.stringify({ title, body, focusPolicy });
          const group = groups.get(key);
          if (group) {
            group.subscriptions.push(subscription);
          } else {
            groups.set(key, { title, body, focusPolicy, subscriptions: [subscription] });
          }
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
                focusPolicy: group.focusPolicy,
                ...(url ? { url } : {}),
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
