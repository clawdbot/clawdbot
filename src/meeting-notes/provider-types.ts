import type { OpenClawConfig } from "../config/types.openclaw.js";

export type MeetingNotesSourceKind =
  | "live-audio"
  | "live-caption"
  | "posthoc-transcript"
  | "recording-stt";

export type MeetingNotesSourceLocator = {
  providerId: string;
  kind?: MeetingNotesSourceKind;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
  threadTs?: string;
  fileId?: string;
  [key: string]: string | undefined;
};

export type MeetingNotesParticipant = {
  id?: string;
  label: string;
};

export type MeetingNotesUtterance = {
  id?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  speaker?: MeetingNotesParticipant;
  text: string;
  final?: boolean;
  metadata?: Record<string, unknown>;
};

export type MeetingNotesSessionDescriptor = {
  sessionId: string;
  title?: string;
  source: MeetingNotesSourceLocator;
  startedAt: string;
  stoppedAt?: string;
  metadata?: Record<string, unknown>;
};

export type MeetingNotesStartRequest = {
  cfg?: OpenClawConfig;
  session: MeetingNotesSessionDescriptor;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
  onUtterance: (utterance: MeetingNotesUtterance) => void | Promise<void>;
  onStatus?: (status: MeetingNotesSourceStatus) => void | Promise<void>;
};

export type MeetingNotesStartResult =
  | {
      ok: true;
      session: MeetingNotesSessionDescriptor;
    }
  | {
      ok: false;
      error: string;
    };

export type MeetingNotesStopRequest = {
  cfg?: OpenClawConfig;
  sessionId: string;
  source: MeetingNotesSourceLocator;
  reason?: string;
};

export type MeetingNotesStopResult =
  | {
      ok: true;
      sessionId: string;
      stoppedAt?: string;
    }
  | {
      ok: false;
      error: string;
    };

export type MeetingNotesSourceStatus = {
  sessionId?: string;
  active: boolean;
  message?: string;
  source?: MeetingNotesSourceLocator;
};

export type MeetingNotesImportRequest = {
  cfg?: OpenClawConfig;
  session: MeetingNotesSessionDescriptor;
  text: string;
  speakerLabel?: string;
};

export type MeetingNotesSourceProviderPlugin = {
  id: string;
  aliases?: readonly string[];
  name: string;
  sourceKinds: readonly MeetingNotesSourceKind[];
  start?: (request: MeetingNotesStartRequest) => Promise<MeetingNotesStartResult>;
  stop?: (request: MeetingNotesStopRequest) => Promise<MeetingNotesStopResult>;
  status?: (
    source: MeetingNotesSourceLocator,
    cfg?: OpenClawConfig,
  ) => Promise<MeetingNotesSourceStatus[]>;
  importTranscript?: (request: MeetingNotesImportRequest) => Promise<MeetingNotesUtterance[]>;
};
