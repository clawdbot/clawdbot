import type { RuntimeLogger } from "../plugins/runtime/types.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingSessionRecord,
  MeetingResolvedJoin,
  MeetingTranscriptSnapshot,
} from "./session-types.js";
import type { MeetingDurableTranscriptsOptions } from "./transcripts-bridge.js";

export type MeetingSessionRuntimeHandles<THealth extends MeetingBrowserHealth> = {
  stop?: () => Promise<void>;
  speak?: (instructions?: string) => void;
  getHealth?: () => Partial<THealth>;
};

/** One session's cleanup capability and any setup that can still produce resources. */
export type MeetingSessionCleanupOwner = {
  stop?: () => Promise<void>;
  recovery?: Promise<void>;
};

export type MeetingBrowserSessionView<
  THealth extends MeetingBrowserHealth,
  TTab extends MeetingBrowserTab,
> = {
  launched: boolean;
  nodeId?: string;
  tab?: TTab;
  health?: THealth;
  hasAudioBridge: boolean;
};

export type MeetingSessionRuntimeJoinContext<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth,
  TTab extends MeetingBrowserTab,
> = {
  attachRuntimeHandles(session: TSession, handles: MeetingSessionRuntimeHandles<THealth>): void;
  inheritedBrowserTab(params: {
    session: TSession;
    transport: TTransport;
    nodeId?: string;
    meetingUrl: string;
    tab?: TTab;
  }): TTab | undefined;
};

export type MeetingSessionRuntimeMessages<TSpeechBlockedReason extends string> = {
  previousBrowserLeaveFailed: string;
  reassignedSessionNote: string;
  reusedSessionNote: string;
  replacementBrowserLeaveFailed: string;
  speechBlockedFallback: string;
  speech: {
    audioBridgeUnavailable: string;
    browserUnverified: string;
    microphoneMuted: string;
    microphoneMutedReason: TSpeechBlockedReason;
    notInCall: string;
    notInCallReason: TSpeechBlockedReason;
    browserUnverifiedReason: TSpeechBlockedReason;
    audioBridgeUnavailableReason: TSpeechBlockedReason;
  };
};

export type MeetingSessionRuntimeOptions<
  TSession extends MeetingSessionRecord<TTransport, TMode>,
  TRequest,
  TTransport extends string,
  TMode extends string,
  THealth extends MeetingBrowserHealth<TManualReason, TSpeechBlockedReason>,
  TTab extends MeetingBrowserTab,
  TManualReason extends string,
  TSpeechBlockedReason extends string,
> = {
  logger: RuntimeLogger;
  logScope: string;
  formatError(error: unknown): string;
  messages: MeetingSessionRuntimeMessages<TSpeechBlockedReason>;
  reuseExistingBrowserTab: boolean;
  waitForInCallMs: number;
  joinTimeoutMs: number;
  transientSpeechBlockedReasons: ReadonlySet<TSpeechBlockedReason>;
  resolveJoin(request: TRequest): MeetingResolvedJoin<TTransport, TMode>;
  createSession(params: {
    request: TRequest;
    resolved: MeetingResolvedJoin<TTransport, TMode>;
    createdAt: string;
  }): TSession;
  resolveSpeechInstructions(request: TRequest): string | undefined;
  isBrowserTransport(transport: TTransport): boolean;
  isTalkBackMode(mode: TMode): boolean;
  isTranscribeMode(mode: TMode): boolean;
  sameMeetingUrl(left: string | undefined, right: string | undefined): boolean;
  normalizeMeetingUrlForReuse(url: string): string | undefined;
  getBrowser(session: TSession): MeetingBrowserSessionView<THealth, TTab> | undefined;
  setBrowserTab(session: TSession, tab: TTab | undefined): void;
  setBrowserHealth(session: TSession, health: THealth | undefined): void;
  joinTransport(params: {
    request: TRequest;
    session: TSession;
    context: MeetingSessionRuntimeJoinContext<TSession, TTransport, TMode, THealth, TTab>;
  }): Promise<{ delegatedSpoken?: boolean }>;
  releaseBrowserTab(session: TSession): Promise<boolean | undefined>;
  refreshBrowserHealth(
    session: TSession,
    options?: { force?: boolean; readOnly?: boolean },
  ): Promise<void>;
  refreshStatus(session: TSession): Promise<void>;
  refreshReusableSession(
    session: TSession,
    request: TRequest,
    resolved: MeetingResolvedJoin<TTransport, TMode>,
  ): Promise<{ keepBrowserTab: boolean } | void>;
  ensureRealtimeBridge(
    session: TSession,
    onCleanupReady: (stop: () => Promise<void>) => Promise<void>,
  ): Promise<MeetingSessionRuntimeHandles<THealth> | undefined>;
  captureTranscript(
    session: TSession,
    options?: { finalize?: boolean },
  ): Promise<MeetingTranscriptSnapshot | undefined>;
  speakViaTransport(
    session: TSession,
    instructions?: string,
  ): Promise<{ handled: boolean; spoken: boolean } | undefined>;
  defaultSpeechInstructions?: string;
  durableTranscripts?: MeetingDurableTranscriptsOptions;
};

export type MeetingSessionLeaveResult<TSession> = {
  found: boolean;
  session?: TSession;
  browserLeft?: boolean;
};
