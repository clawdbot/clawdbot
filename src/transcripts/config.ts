import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";

type TranscriptsAutoStartConfig = {
  providerId: string;
  whenOccupied?: boolean;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type ResolvedTranscriptsAutoStartConfig = {
  providerId: string;
  whenOccupied: boolean;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

export type TranscriptsConfig = {
  enabled?: boolean;
  autoStart?: TranscriptsAutoStartConfig[];
};

type ResolvedTranscriptsConfig = {
  enabled: boolean;
  maxUtterances: number;
  autoStart: ResolvedTranscriptsAutoStartConfig[];
};

const DEFAULT_TRANSCRIPTS_MAX_UTTERANCES = 2_000;

function resolveAutoStart(raw: unknown): ResolvedTranscriptsAutoStartConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry): ResolvedTranscriptsAutoStartConfig | undefined => {
      const config = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const providerId = readString(config.providerId);
      if (!providerId) {
        return undefined;
      }
      return {
        providerId,
        whenOccupied: config.whenOccupied === true,
        sessionId: config.whenOccupied === true ? undefined : readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is ResolvedTranscriptsAutoStartConfig => entry !== undefined);
}

export function resolveTranscriptsConfig(raw: unknown): ResolvedTranscriptsConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: config.enabled !== false,
    maxUtterances: DEFAULT_TRANSCRIPTS_MAX_UTTERANCES,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
