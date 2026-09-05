import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
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
  listBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { getUserPreferences } from "../state/user-preferences.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import {
  listCurrentWebPushTargets,
  webPushTargetClient,
  type CurrentWebPushTarget,
} from "./web-push-authority.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;
const defaultLog = createSubsystemLogger("gateway/web-push");

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
};

export type HumanMentionWebPush = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel?: string;
  sessionTitle?: string;
  isCurrent: () => boolean;
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

function preferenceFor(target: CurrentWebPushTarget, stateDir?: string) {
  const profileId = target.userProfileId;
  const user = profileId
    ? getUserPreferences(
        profileId,
        [WEB_PUSH_USER_PREFERENCES_KEY],
        stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {},
      )[WEB_PUSH_USER_PREFERENCES_KEY]
    : undefined;
  return resolveEffectiveWebPushPreferences({
    user,
    device: target.subscription.devicePreferences,
  });
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: Pick<SubsystemLogger, "warn">;
  stateDir?: string;
}) {
  const log = params.log ?? defaultLog;
  const deliver = (
    notification: EventNotification,
    event: string,
    payload?: unknown,
    opts?: GatewayBroadcastOpts,
    mention?: HumanMentionWebPush,
  ): void => {
    void (async () => {
      if (listBoundWebPushSubscriptions(params.stateDir).length === 0) {
        return;
      }
      const sender = await prepareWebPushNotificationSender(params.stateDir);
      const cfg = params.getRuntimeConfig();
      const recipientProfileId = mention && resolveUserProfileId(mention.recipientProfileId);
      if (mention && !recipientProfileId) {
        return;
      }
      const sessionPath = mention
        ? buildControlUiSessionPath({
            namespace: "chat",
            sessionKey: mention.sessionKey,
            fallbackAgentId: mention.agentId,
            mainKey: cfg.session?.mainKey,
            exactKey: true,
          })
        : undefined;
      if (mention && !sessionPath) {
        return;
      }
      const url = sessionPath ? resolveControlUiWebPushUrl(cfg, sessionPath.slice(1)) : undefined;
      const targets = listCurrentWebPushTargets({
        cfg,
        requiredScopes:
          notification.category === "agent-question" ? [READ_SCOPE, QUESTIONS_SCOPE] : [READ_SCOPE],
        ...(mention ? { visibilityScopes: [ADMIN_SCOPE] } : {}),
        stateDir: params.stateDir,
      });
      const agentId = normalizeOptionalString(
        opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
      );
      const agentLabel = normalizeWebPushDisplayLabel(agentId);
      const groups = new Map<
        string,
        { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
      >();
      for (const target of targets) {
        if (mention && target.userProfileId !== recipientProfileId) {
          continue;
        }
        const preferences = preferenceFor(target, params.stateDir);
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
              (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
        const key = JSON.stringify({ title, body });
        const group = groups.get(key) ?? { title, body, subscriptions: [] };
        group.subscriptions.push(target.subscription);
        groups.set(key, group);
      }
      // The mention owner fences dismissal, expiry, session replacement and Gateway
      // teardown after preparation. No awaited work may separate it from the send.
      if (mention && !mention.isCurrent()) {
        return;
      }
      const topic = createHash("sha256").update(notification.tag).digest("base64url").slice(0, 32);
      const results = (
        await Promise.all(
          [...groups.values()].map((group) =>
            sender({
              subscriptions: group.subscriptions,
              payload: {
                title: group.title,
                body: group.body,
                tag: notification.tag,
                renotify: false,
                ...(url ? { url } : {}),
              },
              deliveryOptions: {
                TTL: EVENT_PUSH_TTL_SECONDS,
                urgency: notification.category.includes("failed") ? "high" : "normal",
                topic,
              },
            }),
          ),
        )
      ).flat();
      const failed = results.filter((result) => !result.ok).length;
      if (failed > 0) {
        log.warn("event Web Push delivery failed", {
          category: notification.category,
          attempted: results.length,
          failed,
        });
      }
    })().catch(() => {
      // Transport failures can contain endpoints and payload bytes; log only the closed category.
      log.warn("event Web Push delivery could not complete", { category: notification.category });
    });
  };

  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (notification) {
        deliver(notification, event, payload, opts);
      }
    },
    deliverMention(this: void, mention: HumanMentionWebPush): void {
      const senderLabel = normalizeWebPushDisplayLabel(mention.senderLabel) ?? "Someone";
      const sessionTitle = normalizeWebPushDisplayLabel(mention.sessionTitle);
      const id = createHash("sha256").update(mention.id).digest("base64url");
      deliver(
        {
          category: "human-mentioned",
          title: "OpenClaw mention",
          body: "Someone mentioned you in a conversation.",
          identifiedBody: `${senderLabel} mentioned you${sessionTitle ? ` in ${sessionTitle}` : ""}.`,
          tag: `openclaw-mention-${id}`,
        },
        "human-mentioned",
        undefined,
        { agentId: mention.agentId, sessionKeys: [mention.sessionKey] },
        mention,
      );
    },
  };
}
