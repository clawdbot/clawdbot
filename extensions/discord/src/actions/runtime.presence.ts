import type { Activity, UpdatePresenceData } from "@buape/carbon/gateway";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { getGateway } from "../monitor/gateway-registry.js";
import {
  type ActionGate,
  jsonResult,
  readStringParam,
  type DiscordActionConfig,
} from "../runtime-api.js";

const ACTIVITY_TYPE_MAP: Record<string, number> = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  custom: 4,
  competing: 5,
};

const VALID_STATUSES = new Set(["online", "dnd", "idle", "invisible"]);

export async function handleDiscordPresenceAction(
  action: string,
  params: Record<string, unknown>,
  isActionEnabled: ActionGate<DiscordActionConfig>,
): Promise<AgentToolResult<unknown>> {
  if (action !== "setPresence") {
    throw new Error(`Unknown presence action: ${action}`);
  }

  if (!isActionEnabled("presence", false)) {
    throw new Error("Discord presence changes are disabled.");
  }

  const accountId = readStringParam(params, "accountId");
  const gateway = getGateway(accountId);
  if (!gateway) {
    throw new Error(
      `Discord gateway not available${accountId ? ` for account "${accountId}"` : ""}. The bot may not be connected.`,
    );
  }
  if (!gateway.isConnected) {
    throw new Error(
      `Discord gateway is not connected${accountId ? ` for account "${accountId}"` : ""}.`,
    );
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
          `Valid types: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`,
      );
    }
    const typeNum = ACTIVITY_TYPE_MAP[normalizeLowercaseStringOrEmpty(activityTypeRaw)];
    if (typeNum === undefined) {
      throw new Error(
        `Invalid activityType "${activityTypeRaw}". Must be one of: ${Object.keys(ACTIVITY_TYPE_MAP).join(", ")}`,
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
    activities: activities.map((a) => ({
      type: a.type,
      name: a.name,
      ...(a.url ? { url: a.url } : {}),
      ...(a.state ? { state: a.state } : {}),
    })),
  });
}
