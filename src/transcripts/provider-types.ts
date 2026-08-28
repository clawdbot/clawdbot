// Transcript provider contracts for external and manual transcript sources.
import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Public contracts for transcript source providers.
 *
 * Providers can stream live utterances, import post-hoc transcript text, expose
 * status, and stop active sessions using shared session/source descriptors.
 */
/** Supported source families for transcript providers. */
export type TranscriptSourceKind =
  | "live-audio"
  | "live-caption"
  | "posthoc-transcript"
  | "recording-stt";

/** Provider-specific locator for a live, recorded, or imported transcript source. */
export type TranscriptSourceLocator = {
  providerId: string;
  kind?: TranscriptSourceKind;
  accountId?: string;
  guildId?: string;
  channelId?: string;
  meetingUrl?: string;
  threadTs?: string;
  fileId?: string;
  [key: string]: string | undefined;
};

/** Speaker/participant identity attached to an utterance. */
export type TranscriptParticipant = {
  id?: string;
  label: string;
};

/** One captured or imported transcript utterance. */
export type TranscriptUtterance = {
  id?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  speaker?: TranscriptParticipant;
  text: string;
  final?: boolean;
  metadata?: Record<string, unknown>;
};

/** Durable transcript session metadata. */
export type TranscriptSessionDescriptor = {
  sessionId: string;
  title?: string;
  source: TranscriptSourceLocator;
  startedAt: string;
  stoppedAt?: string;
  metadata?: Record<string, unknown>;
};

/** Request passed to providers that can start live transcript capture. */
export type TranscriptStartRequest = {
  cfg?: OpenClawConfig;
  session: TranscriptSessionDescriptor;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
  onUtterance: (utterance: TranscriptUtterance) => void | Promise<void>;
  /**
   * `active: false` permanently ends this exact capture subscription, including
   * replacement or detach; transient transport disconnects must not emit it.
   * Deliver final utterances first. Callback payload ids/source are descriptive;
   * consumers retain their admitted session identity and ownership metadata.
   */
  onStatus?: (status: TranscriptSourceStatus) => void | Promise<void>;
};

/**
 * Result from starting a transcript source provider.
 *
 * Providers retain cleanup ownership until they return `ok: true`. A failed or
 * rejected start must release any partial capture before it settles.
 */
export type TranscriptsStartResult =
  | {
      ok: true;
      session: TranscriptSessionDescriptor;
    }
  | {
      ok: false;
      error: string;
    };

/** Request passed to providers that can stop live transcript capture. */
export type TranscriptStopRequest = {
  cfg?: OpenClawConfig;
  sessionId: string;
  source: TranscriptSourceLocator;
  reason?: string;
};

/** Result from stopping a transcript source provider. */
export type TranscriptsStopResult =
  | {
      ok: true;
      sessionId: string;
      stoppedAt?: string;
    }
  | {
      ok: false;
      error: string;
    };

/** Runtime status reported by transcript source providers. */
export type TranscriptSourceStatus = {
  sessionId?: string;
  active: boolean;
  message?: string;
  source?: TranscriptSourceLocator;
};

/** Request passed to providers that import post-hoc transcript text. */
export type TranscriptImportRequest = {
  cfg?: OpenClawConfig;
  session: TranscriptSessionDescriptor;
  text: string;
  speakerLabel?: string;
};

/** Trusted caller facts projected by core; never accepted from tool arguments. */
export type TranscriptToolCaller =
  | {
      kind: "operator";
      source: "channel-owner" | "local" | "scheduled";
    }
  | {
      kind: "channel";
      channel: string;
      accountId?: string;
      senderId: string;
      groupId?: string;
      groupSpace?: string;
      roleIds: readonly string[];
    };

export type TranscriptToolAction = "import" | "start" | "status" | "stop" | "summarize";

export type TranscriptSourceAccessControl = {
  /** Ingress channel whose trusted account owns this provider's account namespace. */
  channelId: string;
  /** Resolve and validate the canonical account before persistence. */
  resolveAccountId: (params: {
    cfg?: OpenClawConfig;
    source: TranscriptSourceLocator;
  }) => Result<string | undefined, string>;
  /** Apply the provider's native access policy to the resolved source. */
  authorize: (params: {
    action: TranscriptToolAction;
    caller: TranscriptToolCaller;
    cfg?: OpenClawConfig;
    source: TranscriptSourceLocator;
  }) => Promise<Result<void, string>>;
};

/** Provider contract for transcript capture/import integrations. */
export type TranscriptSourceProvider = {
  id: string;
  aliases?: readonly string[];
  /** Closed access contract for providers sharing one inbound channel namespace. */
  accessControl?: TranscriptSourceAccessControl;
  name: string;
  sourceKinds: readonly TranscriptSourceKind[];
  start?: (request: TranscriptStartRequest) => Promise<TranscriptsStartResult>;
  stop?: (request: TranscriptStopRequest) => Promise<TranscriptsStopResult>;
  status?: (
    source: TranscriptSourceLocator,
    cfg?: OpenClawConfig,
  ) => Promise<TranscriptSourceStatus[]>;
  importTranscript?: (request: TranscriptImportRequest) => Promise<TranscriptUtterance[]>;
};
