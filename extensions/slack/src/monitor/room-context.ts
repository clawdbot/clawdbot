// Slack plugin module implements room context behavior.
import { buildChannelMetadata } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function resolveSlackRoomContextHints(params: {
  isRoomish: boolean;
  channelInfo?: { topic?: string; purpose?: string };
  channelConfig?: { systemPrompt?: string | null } | null;
}): {
  channelMetadata?: ReturnType<typeof buildChannelMetadata>;
  groupSystemPrompt?: string;
} {
  const channelMetadata = params.isRoomish
    ? buildChannelMetadata({
        source: "slack",
        label: "Slack channel description",
        entries: [params.channelInfo?.topic, params.channelInfo?.purpose],
      })
    : undefined;

  const systemPromptParts = [
    params.isRoomish ? (normalizeOptionalString(params.channelConfig?.systemPrompt) ?? null) : null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;

  return {
    channelMetadata,
    groupSystemPrompt,
  };
}
