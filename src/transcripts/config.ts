// Resolves transcript source configuration from OpenClaw config.
import { normalizeOptionalString as readString } from "@openclaw/normalization-core/string-coerce";

/**
 * Configuration normalization for transcript capture/import.
 *
 * Raw config can contain optional auto-start provider locators; resolution
 * returns bounded defaults and drops malformed entries before runtime startup.
 */
/** Raw auto-start transcript source entry from config. */
export type TranscriptsAutoStartConfig = {
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
  maxUtterances?: number;
  autoStart?: TranscriptsAutoStartConfig[];
};

/** Resolved transcripts config with defaults applied. */
export type ResolvedTranscriptsConfig = {
  enabled: boolean;
  maxUtterances: number;
  autoStart: ResolvedTranscriptsAutoStartConfig[];
};

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
  const maxUtterances =
    typeof config.maxUtterances === "number" && Number.isFinite(config.maxUtterances)
      ? Math.max(1, Math.min(10_000, Math.floor(config.maxUtterances)))
      : 2_000;
  return {
    enabled: config.enabled === true,
    maxUtterances,
    autoStart: resolveAutoStart(config.autoStart),
  };
}
