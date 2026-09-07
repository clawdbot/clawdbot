// Discord plugin module implements runtime.presence behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { ActionGate } from "openclaw/plugin-sdk/channel-actions";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { DiscordActionConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDefaultDiscordAccountId } from "../accounts.js";
import type { Activity, UpdatePresenceData } from "../internal/gateway.js";
import { getGateway } from "../monitor/gateway-registry.js";

const ACTIVITY_TYPE_MAP = new Map<string, number>([
  ["playing", 0],
  ["streaming", 1],
  ["listening", 2],
  ["watching", 3],
  ["custom", 4],
  ["competing", 5],
]);

const VALID_STATUSES = new Set(["online", "dnd", "idle", "invisible"]);

export async function handleDiscordPresenceAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
  cfg: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  if (action !== "setPresence") {
    throw new Error(`Unknown presence action: ${action}`);
  }

  if (!isActionEnabled("presence", false)) {
    throw new Error("Discord presence changes are disabled.");
  }

  const accountId = readStringParam(params, "accountId") ?? resolveDefaultDiscordAccountId(cfg);
  const gateway = getGateway(accountId);
  if (!gateway) {
    throw new Error(
      `Discord gateway not available for account "${accountId}". The bot may not be connected.`,
    );
  }
  if (!gateway.isConnected) {
    throw new Error(`Discord gateway is not connected for account "${accountId}".`);
  }

  const statusRaw = readStringParam(params, "status") ?? "online";
  if (!VALID_STATUSES.has(statusRaw)) {
    throw new Error(
      `Invalid status "${statusRaw}". Must be one of: ${[...VALID_STATUSES].join(", ")}`,
    );
  }
  const status = statusRaw as UpdatePresenceData["status"];

  const activityTypeRaw = readStringParam(params, "activityType");
  const activityName = readStringParam(params, "activityName");

  const activities: Activity[] = [];

  if (activityTypeRaw || activityName) {
    if (!activityTypeRaw) {
      throw new Error(
        "activityType is required when activityName is provided. " +
          `Valid types: ${[...ACTIVITY_TYPE_MAP.keys()].join(", ")}`,
      );
    }
    const typeNum = ACTIVITY_TYPE_MAP.get(normalizeLowercaseStringOrEmpty(activityTypeRaw));
    if (typeNum === undefined) {
      throw new Error(
        `Invalid activityType "${activityTypeRaw}". Must be one of: ${[...ACTIVITY_TYPE_MAP.keys()].join(", ")}`,
      );
    }

    const activity: Activity = {
      name: activityName ?? "",
      type: typeNum,
    };

    // Streaming URL (Twitch/YouTube). May not render for bots but is the correct payload shape.
    if (typeNum === 1) {
      const url = readStringParam(params, "activityUrl");
      if (url) {
        activity.url = url;
      }
    }

    const state = readStringParam(params, "activityState");
    if (state) {
      activity.state = state;
    }

    activities.push(activity);
  }

  const presenceData: UpdatePresenceData = {
    since: null,
    activities,
    status,
    afk: false,
  };

  gateway.updatePresence(presenceData);

  return jsonResult({
    ok: true,
    status,
    activities: activities.map((a) =>
      Object.assign(
        { type: a.type, name: a.name },
        a.url ? { url: a.url } : {},
        a.state ? { state: a.state } : {},
      ),
    ),
  });
}
