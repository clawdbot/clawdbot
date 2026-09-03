import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type {
  WebPushDetailLevel,
  WebPushDevicePreferences,
  WebPushNotificationCategory,
  WebPushNotificationPreferences,
} from "../../packages/gateway-protocol/src/schema/push.js";
import { sanitizeExecApprovalDisplayText } from "./exec-approval-text-sanitize.js";

export const WEB_PUSH_USER_PREFERENCES_KEY = "notifications.web.v1";

export function normalizeWebPushDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  // Redact and escape before truncation; raw IDs still own filtering and authorization.
  return truncateUtf16Safe(sanitizeExecApprovalDisplayText(value.trim()), 80) || undefined;
}

const DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES: WebPushNotificationPreferences = {
  categories: {
    approvalRequested: true,
    agentFinished: false,
    agentQuestion: false,
    scheduledTaskFailed: false,
    backgroundTaskFailed: false,
  },
  detailLevel: "private",
  quietHours: {
    enabled: false,
    startMinute: 22 * 60,
    endMinute: 7 * 60,
    timeZone: "UTC",
  },
  agentIds: [],
};

const CATEGORY_KEYS = [
  "approvalRequested",
  "agentFinished",
  "agentQuestion",
  "scheduledTaskFailed",
  "backgroundTaskFailed",
] as const;

type CategoryKey = (typeof CATEGORY_KEYS)[number];

const CATEGORY_TO_KEY: Record<WebPushNotificationCategory, CategoryKey> = {
  "approval-requested": "approvalRequested",
  "agent-finished": "agentFinished",
  "agent-question": "agentQuestion",
  "scheduled-task-failed": "scheduledTaskFailed",
  "background-task-failed": "backgroundTaskFailed",
};

function detailLevel(value: unknown): WebPushDetailLevel | undefined {
  return value === "private" || value === "identified" || value === "detailed" ? value : undefined;
}

function normalizeAgentIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= 128),
    ),
  ].slice(0, 128);
}

function normalizeQuietHours(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const startMinute = value.startMinute;
  const endMinute = value.endMinute;
  const timeZone = typeof value.timeZone === "string" ? value.timeZone.trim() : "";
  if (
    typeof value.enabled !== "boolean" ||
    !Number.isInteger(startMinute) ||
    !Number.isInteger(endMinute) ||
    Number(startMinute) < 0 ||
    Number(startMinute) > 1439 ||
    Number(endMinute) < 0 ||
    Number(endMinute) > 1439 ||
    !timeZone ||
    timeZone.length > 128
  ) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    return undefined;
  }
  return {
    enabled: value.enabled,
    startMinute: Number(startMinute),
    endMinute: Number(endMinute),
    timeZone,
  };
}

function normalizeCategoryDefaults(value: unknown): WebPushNotificationPreferences["categories"] {
  const source = isRecord(value) ? value : {};
  const categories = Object.fromEntries(
    CATEGORY_KEYS.map((key) => [
      key,
      typeof source[key] === "boolean"
        ? source[key]
        : DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES.categories[key],
    ]),
  );
  // SAFETY: CATEGORY_KEYS exhaustively enumerates every required category boolean.
  return categories as WebPushNotificationPreferences["categories"];
}

export function normalizeWebPushNotificationPreferences(
  value: unknown,
): WebPushNotificationPreferences {
  const source = isRecord(value) ? value : {};
  return {
    categories: normalizeCategoryDefaults(source.categories),
    detailLevel:
      detailLevel(source.detailLevel) ?? DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES.detailLevel,
    quietHours:
      normalizeQuietHours(source.quietHours) ??
      DEFAULT_WEB_PUSH_NOTIFICATION_PREFERENCES.quietHours,
    agentIds: normalizeAgentIds(source.agentIds) ?? [],
  };
}

export function normalizeWebPushDevicePreferences(value: unknown): WebPushDevicePreferences {
  const source = isRecord(value) ? value : {};
  const categorySource = isRecord(source.categories) ? source.categories : undefined;
  const categories = categorySource
    ? Object.fromEntries(
        CATEGORY_KEYS.flatMap((key) =>
          typeof categorySource[key] === "boolean" ? [[key, categorySource[key]]] : [],
        ),
      )
    : undefined;
  const normalizedDetailLevel = detailLevel(source.detailLevel);
  const normalizedQuietHours = normalizeQuietHours(source.quietHours);
  const normalizedAgentIds = normalizeAgentIds(source.agentIds);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    label: normalizeWebPushDisplayLabel(source.label) ?? "",
    ...(categories && Object.keys(categories).length > 0 ? { categories } : {}),
    ...(normalizedDetailLevel ? { detailLevel: normalizedDetailLevel } : {}),
    ...(normalizedQuietHours ? { quietHours: normalizedQuietHours } : {}),
    ...(normalizedAgentIds ? { agentIds: normalizedAgentIds } : {}),
  };
}

export function resolveEffectiveWebPushPreferences(params: {
  user?: unknown;
  device?: unknown;
}): WebPushNotificationPreferences & { enabled: boolean; label: string } {
  const user = normalizeWebPushNotificationPreferences(params.user);
  const device = normalizeWebPushDevicePreferences(params.device);
  return {
    enabled: device.enabled,
    label: device.label,
    categories: { ...user.categories, ...device.categories },
    detailLevel: device.detailLevel ?? user.detailLevel,
    quietHours: device.quietHours ?? user.quietHours,
    agentIds: device.agentIds ?? user.agentIds,
  };
}

export function webPushCategoryEnabled(
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>,
  category: WebPushNotificationCategory,
): boolean {
  const key = CATEGORY_TO_KEY[category];
  return key !== undefined && preferences.enabled && preferences.categories[key];
}

export function isWebPushQuietHours(
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>,
  nowMs = Date.now(),
): boolean {
  const quiet = preferences.quietHours;
  if (!quiet.enabled || quiet.startMinute === quiet.endMinute) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: quiet.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(nowMs);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  return quiet.startMinute < quiet.endMinute
    ? current >= quiet.startMinute && current < quiet.endMinute
    : current >= quiet.startMinute || current < quiet.endMinute;
}

export function webPushAgentAllowed(
  preferences: ReturnType<typeof resolveEffectiveWebPushPreferences>,
  agentId?: string | null,
): boolean {
  return (
    preferences.agentIds.length === 0 || Boolean(agentId && preferences.agentIds.includes(agentId))
  );
}
