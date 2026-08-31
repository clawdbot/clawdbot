import { normalizeOptionalString } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import {
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";

export const NOTIFICATION_TTL_MS = 5 * 60 * 1_000;
type NotificationPreferences = ReturnType<typeof resolveEffectiveWebPushPreferences>;

export type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  tag: string;
};

export function resolveEventNotification(
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
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
  if (event === "chat" && value.state === "final" && opts?.agentRunCompleted) {
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

export function notificationAllowed(
  preferences: NotificationPreferences,
  category: WebPushNotificationCategory,
  agentId?: string | null,
): boolean {
  return (
    webPushCategoryEnabled(preferences, category) &&
    !isWebPushQuietHours(preferences) &&
    webPushAgentAllowed(preferences, agentId)
  );
}

function boundedCopy(title: string, body: string) {
  return { title: truncateUtf16Safe(title, 160), body: truncateUtf16Safe(body, 320) };
}

export function renderEventNotification(
  notification: EventNotification,
  preferences: NotificationPreferences,
  agentId?: string,
) {
  const prefix = preferences.label ? `${preferences.label} · ` : "";
  const agentLabel = normalizeWebPushDisplayLabel(agentId);
  const body =
    preferences.detailLevel === "private"
      ? notification.body
      : (notification.identifiedBody ??
        (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
  return boundedCopy(`${prefix}${notification.title}`, body);
}

export function renderApprovalNotification(params: {
  terminal: boolean;
  preferences: NotificationPreferences;
  agentLabel?: string;
}) {
  const label = params.preferences.label ? `${params.preferences.label} · ` : "";
  const agent = params.agentLabel ? ` for ${params.agentLabel}` : "";
  return params.terminal
    ? boundedCopy(
        `${label}OpenClaw approval updated`,
        params.preferences.detailLevel === "private"
          ? "This approval is no longer pending."
          : `Approval${agent} is no longer pending.`,
      )
    : boundedCopy(
        `${label}OpenClaw approval requested`,
        params.preferences.detailLevel === "private"
          ? "Open OpenClaw to review this request."
          : `Open OpenClaw to review an approval${agent}.`,
      );
}

export function approvalNotificationTag(id: string): string {
  return `openclaw-approval-${id}`;
}

export function eventNotificationPath(
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
): string {
  const value = isRecord(payload) ? payload : {};
  if (event === "question.requested") {
    const id = normalizeOptionalString(value.id);
    if (id && id.length <= 128) {
      return `/ask/${encodeURIComponent(id)}`;
    }
  }
  if (event === "task") {
    return "/tasks";
  }
  if (event === "cron") {
    return "/automations";
  }
  const sessionKey = opts?.sessionKeys?.[0] ?? normalizeOptionalString(value.sessionKey);
  const path = sessionKey
    ? buildControlUiSessionPath({
        namespace: "chat",
        sessionKey,
        exactKey: true,
        fallbackAgentId: opts?.agentId ?? normalizeOptionalString(value.agentId),
      })
    : null;
  // Events without one bounded navigable session open the session catalog.
  return path && path.length <= 1024 ? path : "/sessions";
}
