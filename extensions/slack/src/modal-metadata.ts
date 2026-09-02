// Slack plugin module implements modal metadata behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type SlackModalPrivateMetadata = {
  sessionKey?: string;
  channelId?: string;
  channelType?: string;
  userId?: string;
  pluginInteractiveData?: string;
};

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
      pluginInteractiveData: normalizeOptionalString(parsed.pluginInteractiveData),
    };
  } catch {
    return {};
  }
}
