// Resolves transcript source configuration from OpenClaw config.
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";

/**
 * Configuration normalization for transcript capture/import.
 *
 * Raw config can contain optional auto-start provider locators; resolution
 * returns bounded defaults and drops malformed entries before runtime startup.
 */
/** Raw auto-start transcript source entry from config. */
type TranscriptsAutoStartConfig = {
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

/** Normalized auto-start source entry consumed by transcript runtime code. */
export type ResolvedTranscriptsAutoStartConfig = {
  providerId: string;
  sessionId?: string;
  title?: string;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
};

/** Raw transcripts config block. */
export type TranscriptsConfig = {
  enabled?: boolean;
  autoStart?: TranscriptsAutoStartConfig[];
};

/** Resolved transcripts config with defaults applied. */
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
        sessionId: readString(config.sessionId),
        title: readString(config.title),
        accountId: readString(config.accountId),
        guildId: readString(config.guildId),
        channelId: readString(config.channelId),
        meetingUrl: readString(config.meetingUrl),
      };
    })
    .filter((entry): entry is ResolvedTranscriptsAutoStartConfig => entry !== undefined);
}

/** Normalize raw transcripts config into runtime settings. */
export function resolveTranscriptsConfig(raw: unknown): ResolvedTranscriptsConfig {
  const config = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: config.enabled !== false,
    maxUtterances: DEFAULT_TRANSCRIPTS_MAX_UTTERANCES,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
