export type MeetingNotesAutoStartConfig = {
  enabled: boolean;
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type MeetingNotesConfig = {
  enabled: boolean;
  maxUtterances: number;
  autoStart: MeetingNotesAutoStartConfig[];
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveAutoStart(raw: unknown): MeetingNotesAutoStartConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry): MeetingNotesAutoStartConfig | undefined => {
      const config = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const providerId = readString(config.providerId);
      if (!providerId) {
        return undefined;
      }
      return {
        providerId,
        enabled: config.enabled !== false,
        sessionId: readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is MeetingNotesAutoStartConfig => entry !== undefined);
}

export function resolveMeetingNotesConfig(raw: unknown): MeetingNotesConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const maxUtterances =
    typeof config.maxUtterances === "number" && Number.isFinite(config.maxUtterances)
      ? Math.max(1, Math.min(10_000, Math.floor(config.maxUtterances)))
      : 2_000;
  return {
    enabled: config.enabled !== false,
    maxUtterances,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
