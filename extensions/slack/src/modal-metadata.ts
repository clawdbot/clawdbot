import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type SlackModalPrivateMetadata = {
  sessionKey?: string;
  channelId?: string;
  channelType?: string;
  userId?: string;
};

const SLACK_PRIVATE_METADATA_MAX = 3000;

export function parseSlackModalPrivateMetadata(raw: unknown): SlackModalPrivateMetadata {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sessionKey: normalizeOptionalString(parsed.sessionKey),
      channelId: normalizeOptionalString(parsed.channelId),
      channelType: normalizeOptionalString(parsed.channelType),
      userId: normalizeOptionalString(parsed.userId),
    };
  } catch {
    return {};
  }
}

export function encodeSlackModalPrivateMetadata(input: SlackModalPrivateMetadata): string {
  const payload: SlackModalPrivateMetadata = {
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.channelType ? { channelType: input.channelType } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > SLACK_PRIVATE_METADATA_MAX) {
    throw new Error(
      `Slack modal private_metadata cannot exceed ${SLACK_PRIVATE_METADATA_MAX} chars`,
    );
  }
  return encoded;
}
