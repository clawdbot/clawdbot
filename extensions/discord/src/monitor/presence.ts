import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Activity, UpdatePresenceData } from "../internal/gateway.js";

const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";

type DiscordPresenceConfig = Pick<
  DiscordAccountConfig,
  "activity" | "status" | "activityType" | "activityUrl"
>;

export function resolveDiscordPresenceUpdate(
  config: DiscordPresenceConfig,
): UpdatePresenceData | null {
  const activityText = normalizeOptionalString(config.activity) ?? "";
  const status = normalizeOptionalString(config.status) ?? "";
  const activityType = config.activityType;
  const activityUrl = normalizeOptionalString(config.activityUrl) ?? "";

  const hasActivity = Boolean(activityText);
  const hasStatus = Boolean(status);

  if (!hasActivity && !hasStatus) {
    return { since: null, activities: [], status: "online", afk: false };
  }

  const activities: Activity[] = [];

  if (hasActivity) {
    const resolvedType = activityType ?? DEFAULT_CUSTOM_ACTIVITY_TYPE;
    const activity: Activity =
      resolvedType === DEFAULT_CUSTOM_ACTIVITY_TYPE
        ? { name: CUSTOM_STATUS_NAME, type: resolvedType, state: activityText }
        : { name: activityText, type: resolvedType };

    if (resolvedType === 1 && activityUrl) {
      activity.url = activityUrl;
    }

    activities.push(activity);
  }

  return {
    since: null,
    activities,
    status: (status || "online") as UpdatePresenceData["status"],
    afk: false,
  };
}
