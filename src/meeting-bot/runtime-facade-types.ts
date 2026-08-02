import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import type {
  MeetingBrowserJoinSession,
  MeetingPlatformAdapter,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type { MeetingPluginConfig } from "./plugin-config.js";
import type { MeetingProbeContext } from "./runtime-probes.js";
import type {
  MeetingSessionRuntime,
  MeetingSessionRuntimeHandles,
  MeetingSessionRuntimeMessages,
} from "./session-runtime.js";
import type {
  MeetingBrowserCandidateTab,
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingPluginChromeHealth,
  MeetingPluginJoinRequest,
  MeetingPluginSession,
  MeetingResolvedJoin,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

export type MeetingRuntimeParams<Config extends MeetingPluginConfig> = {
  config: Config;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
};

type MeetingRuntimePlatform<
  Mode extends string,
  Health extends MeetingBrowserHealth,
> = MeetingPlatformAdapter<
  MeetingBrowserJoinSession<Mode>,
  Mode,
  Health,
  MeetingTranscriptSnapshot
> &
  MeetingPlatformRuntimeMetadata;

export type MeetingRuntimeAudioBridge<Health extends MeetingBrowserHealth> =
  MeetingSessionRuntimeHandles<Health> & {
    providerId?: string;
    type: "command-pair" | "node-command-pair";
  };

type MeetingRuntimeLaunchResult<Health extends MeetingBrowserHealth> = {
  launched: boolean;
  audioBridge?: MeetingRuntimeAudioBridge<Health>;
  browser?: Health;
  nodeId?: string;
  tab?: MeetingBrowserTab;
};

type MeetingRuntimeLaunchParams<Config extends MeetingPluginConfig, Mode extends string> = {
  runtime: PluginRuntime;
  config: Config;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: Mode;
  trackedTargetId?: string;
  url: string;
  logger: RuntimeLogger;
};

type MeetingRuntimeTransport<
  Config extends MeetingPluginConfig,
  Mode extends string,
  Health extends MeetingBrowserHealth,
> = {
  launchInChrome(
    params: MeetingRuntimeLaunchParams<Config, Mode>,
  ): Promise<MeetingRuntimeLaunchResult<Health>>;
  launchOnNode(
    params: MeetingRuntimeLaunchParams<Config, Mode>,
  ): Promise<MeetingRuntimeLaunchResult<Health> & { nodeId: string }>;
  leaveInBrowser(params: {
    runtime: PluginRuntime;
    config: Config;
    meetingSessionId: string;
    meetingUrl: string;
    nodeId?: string;
    tab: MeetingBrowserTab;
  }): Promise<{ left: boolean; note: string }>;
  readTranscript(params: {
    runtime: PluginRuntime;
    config: Config;
    finalize?: boolean;
    meetingUrl: string;
    meetingSessionId: string;
    nodeId?: string;
    tab: MeetingBrowserTab;
  }): Promise<MeetingTranscriptSnapshot>;
  recoverCurrentTab(params: {
    runtime: PluginRuntime;
    config: Config;
    fullConfig?: OpenClawConfig;
    meetingSessionId?: string;
    mode: Mode;
    nodeId?: string;
    readOnly?: boolean;
    trackedMeetingUrl?: string;
    trackedTargetId?: string;
    transport: "chrome" | "chrome-node";
    timeoutMs?: number;
    url?: string;
  }): Promise<{
    browser?: Health;
    found: boolean;
    message: string;
    tab?: MeetingBrowserCandidateTab;
  }>;
};

type MeetingRuntimeManualActionReason<Health extends MeetingBrowserHealth> = NonNullable<
  Health["manualAction"]
>["reason"];
export type MeetingRuntimeSpeechBlockedReason<Health extends MeetingBrowserHealth> = NonNullable<
  Health["speechBlockedReason"]
>;

export type MeetingRuntimeSession<
  Transport extends string,
  Mode extends string,
  Health extends MeetingBrowserHealth,
> = MeetingPluginSession<Transport, Mode, Health>;
export type MeetingRuntimeRequest<
  Transport extends string,
  Mode extends string,
> = MeetingPluginJoinRequest<Transport, Mode>;

export type MeetingRuntimeProbeResults = {
  setup: unknown;
  listening: unknown;
  speech: unknown;
};

export type MeetingRuntimeOwner<
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingBrowserHealth,
> = MeetingSessionRuntime<
  MeetingRuntimeSession<Transport, Mode, Health>,
  MeetingRuntimeRequest<Transport, Mode>,
  Transport,
  Mode,
  Health,
  MeetingBrowserTab,
  MeetingRuntimeManualActionReason<Health>,
  MeetingRuntimeSpeechBlockedReason<Health>
>;

type MeetingRuntimeFacadeInstance<
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
  Results extends MeetingRuntimeProbeResults,
> = Pick<
  MeetingRuntimeOwner<Transport, Mode, Health>,
  | "join"
  | "leave"
  | "speak"
  | "startTranscriptSource"
  | "status"
  | "stopTranscriptSource"
  | "transcript"
> & {
  list(): MeetingRuntimeSession<Transport, Mode, Health>[];
  ownsSession(agentId: string, sessionId: string): boolean;
  setupStatus(options?: { mode?: Mode; transport?: Transport }): Promise<Results["setup"]>;
  statusForAgent(
    agentId: string,
    sessionId?: string,
  ): Promise<{
    found: boolean;
    session?: MeetingRuntimeSession<Transport, Mode, Health>;
    sessions?: MeetingRuntimeSession<Transport, Mode, Health>[];
  }>;
  testListen(request: MeetingRuntimeRequest<Transport, Mode>): Promise<Results["listening"]>;
  testSpeech(request: MeetingRuntimeRequest<Transport, Mode>): Promise<Results["speech"]>;
};

export type MeetingRuntimeFacadeConstructor<
  Config extends MeetingPluginConfig,
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
  Results extends MeetingRuntimeProbeResults,
> = new (
  params: MeetingRuntimeParams<Config>,
) => MeetingRuntimeFacadeInstance<Transport, Mode, Health, Results>;

export type MeetingRuntimeHookContext<
  Session extends MeetingPluginSession<Transport, Mode, Health>,
  Request extends MeetingPluginJoinRequest<Transport, Mode>,
  Transport extends string,
  Mode extends string,
  Health extends MeetingBrowserHealth,
> = {
  deleteRequesterSessionKey(sessionId: string): void;
  endSession(sessionId: string, options?: { keepBrowserTab?: boolean }): Promise<void>;
  noteSession(session: Session, note: string): void;
  refreshBrowserHealth(
    session: Session,
    options?: { force?: boolean; readOnly?: boolean },
  ): Promise<void>;
  resolvedJoin(request: Request): MeetingResolvedJoin<Transport, Mode>;
};

type MeetingRuntimeHooks<
  Session extends MeetingPluginSession<Transport, Mode, Health>,
  Request extends MeetingPluginJoinRequest<Transport, Mode>,
  Transport extends string,
  Mode extends string,
  Health extends MeetingBrowserHealth,
> = {
  afterStatusRefresh?(
    session: Session,
    context: MeetingRuntimeHookContext<Session, Request, Transport, Mode, Health>,
  ): Promise<void>;
  afterAudioBridgeAttached?(session: Session): void;
  isAudioBridgeActive?(session: Session): boolean;
  isAwaitingAdmission?(session: Session): boolean;
  normalizeJoinRequest?(
    request: Request,
    context: MeetingRuntimeHookContext<Session, Request, Transport, Mode, Health>,
  ): Request;
  recordBrowserRecoveryFailure?(
    session: Session,
    failure: { kind: "missing" | "error"; message: string },
  ): void;
  refreshReusableSession?(
    session: Session,
    request: Request,
    context: MeetingRuntimeHookContext<Session, Request, Transport, Mode, Health>,
  ): Promise<{ keepBrowserTab: boolean } | void>;
  validateLaunchResult?(result: MeetingRuntimeLaunchResult<Health>): void;
};

type MeetingRuntimeMessages<Health extends MeetingBrowserHealth> = {
  browserReadinessFailed?(error: string): string;
  durableTranscripts: { providerId: string; providerName: string };
  joined: {
    local: string;
    node: string;
    transcribe: string;
    waiting: string;
  };
  leaveFailed(error: string): string;
  noTrackedTab: string;
  sessionRuntime: MeetingSessionRuntimeMessages<MeetingRuntimeSpeechBlockedReason<Health>>;
  sharedTab: string;
};

type MeetingRuntimeProbeContext<
  Config extends MeetingPluginConfig & { defaultMode: Mode },
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
> = MeetingProbeContext<
  Config,
  Mode,
  Transport,
  Health,
  MeetingRuntimeSession<Transport, Mode, Health>,
  MeetingRuntimeRequest<Transport, Mode>
>;

export type MeetingRuntimeFacadeOptions<
  Config extends MeetingPluginConfig & { defaultMode: Mode },
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
  Results extends MeetingRuntimeProbeResults,
> = {
  hooks?: MeetingRuntimeHooks<
    MeetingRuntimeSession<Transport, Mode, Health>,
    MeetingRuntimeRequest<Transport, Mode>,
    Transport,
    Mode,
    Health
  >;
  messages: MeetingRuntimeMessages<Health>;
  platform: MeetingRuntimePlatform<Mode, Health>;
  probes: {
    setupStatus(
      params: MeetingRuntimeParams<Config> & {
        options?: { mode?: Mode; transport?: Transport };
      },
    ): Promise<Results["setup"]>;
    testListening(
      context: MeetingRuntimeProbeContext<Config, Transport, Mode, Health>,
      request: MeetingRuntimeRequest<Transport, Mode>,
    ): Promise<Results["listening"]>;
    testSpeech(
      context: MeetingRuntimeProbeContext<Config, Transport, Mode, Health>,
      request: MeetingRuntimeRequest<Transport, Mode>,
    ): Promise<Results["speech"]>;
  };
  transport: MeetingRuntimeTransport<Config, Mode, Health>;
};
