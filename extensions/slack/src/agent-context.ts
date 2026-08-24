// Slack plugin module normalizes Agent View active-context entities.
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type SlackAppContext = {
  entities?: unknown;
};

type SlackAppContextEntity =
  | {
      type: "slack#/types/channel_id" | "slack#/types/canvas_id" | "slack#/types/list_id";
      value: string;
      team_id?: string;
    }
  | {
      type: "slack#/types/message_context";
      value: {
        channel_id: string;
        message_ts: string;
      };
      team_id?: string;
    };

function normalizeEntity(value: unknown): SlackAppContextEntity | undefined {
  const entity = asOptionalRecord(value);
  const type = normalizeOptionalString(entity?.type);
  if (!entity || !type) {
    return undefined;
  }
  const teamId = normalizeOptionalString(entity.team_id);
  if (
    type === "slack#/types/channel_id" ||
    type === "slack#/types/canvas_id" ||
    type === "slack#/types/list_id"
  ) {
    const entityValue = normalizeOptionalString(entity.value);
    return entityValue
      ? { type, value: entityValue, ...(teamId ? { team_id: teamId } : {}) }
      : undefined;
  }
  if (type !== "slack#/types/message_context") {
    return undefined;
  }
  const message = asOptionalRecord(entity.value);
  const channelId = normalizeOptionalString(message?.channel_id);
  const messageTs = normalizeOptionalString(message?.message_ts);
  return channelId && messageTs
    ? {
        type,
        value: { channel_id: channelId, message_ts: messageTs },
        ...(teamId ? { team_id: teamId } : {}),
      }
    : undefined;
}

export function isSlackAppContext(value: unknown): value is SlackAppContext {
  return Boolean(asOptionalRecord(value));
}

export function normalizeSlackAppContextEntities(value: unknown): SlackAppContextEntity[] {
  const context = asOptionalRecord(value);
  if (!Array.isArray(context?.entities)) {
    return [];
  }
  return context.entities.flatMap((entity) => {
    const normalized = normalizeEntity(entity);
    return normalized ? [normalized] : [];
  });
}
