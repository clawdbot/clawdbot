// Slack plugin module normalizes Agent View active-context entities.

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEntity(value: unknown): SlackAppContextEntity | undefined {
  const entity = asRecord(value);
  const type = trimmedString(entity?.type);
  if (!entity || !type) {
    return undefined;
  }
  const teamId = trimmedString(entity.team_id);
  if (
    type === "slack#/types/channel_id" ||
    type === "slack#/types/canvas_id" ||
    type === "slack#/types/list_id"
  ) {
    const entityValue = trimmedString(entity.value);
    return entityValue
      ? { type, value: entityValue, ...(teamId ? { team_id: teamId } : {}) }
      : undefined;
  }
  if (type !== "slack#/types/message_context") {
    return undefined;
  }
  const message = asRecord(entity.value);
  const channelId = trimmedString(message?.channel_id);
  const messageTs = trimmedString(message?.message_ts);
  return channelId && messageTs
    ? {
        type,
        value: { channel_id: channelId, message_ts: messageTs },
        ...(teamId ? { team_id: teamId } : {}),
      }
    : undefined;
}

export function isSlackAppContext(value: unknown): value is SlackAppContext {
  return Boolean(asRecord(value));
}

export function normalizeSlackAppContextEntities(value: unknown): SlackAppContextEntity[] {
  const context = asRecord(value);
  if (!Array.isArray(context?.entities)) {
    return [];
  }
  return context.entities.flatMap((entity) => {
    const normalized = normalizeEntity(entity);
    return normalized ? [normalized] : [];
  });
}
