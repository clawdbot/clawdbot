import type { Command } from "commander";
import type { OpenClawPluginApi } from "../plugins/plugin-api.types.js";
import type { OpenClawPluginCliRootCommandDescriptor } from "../plugins/plugin-registration.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import {
  createMeetingChromeTransport,
  type MeetingChromeTransportConfig,
  type MeetingChromeTransportOptions,
} from "./chrome-transport.js";
import { createMeetingConfiguredNodeHost } from "./configured-node-host.js";
import { isMeetingRealtimeRouteReady, isMeetingTalkBackMode } from "./meeting-modes.js";
import { createMeetingBrowserNodeInvokePolicy } from "./node-invoke-policy.js";
import type { MeetingPluginConfig } from "./plugin-config.js";
import {
  createMeetingPluginEntryOptions,
  type MeetingJoinRequest,
  type MeetingPluginConfig as MeetingEntryConfig,
  type MeetingPluginEntryOptions,
  type MeetingPluginRuntime,
} from "./plugin-entry.js";
import { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import { startMeetingRealtimeEngine } from "./realtime-engine.js";
import { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";
import { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";
import type { MeetingProbeContext } from "./runtime-probes.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingPluginChromeHealth,
  MeetingPluginJoinRequest,
  MeetingPluginJoinResult,
  MeetingPluginSession,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

type MeetingPluginShellPlatform = {
  browserLabel: string;
  displayName: string;
  id: string;
  nodeCommandName: string;
  session: { idPrefix: string };
  urls: {
    validateAndNormalize(input: unknown): string;
    normalizeForReuse(url: string | undefined): string | undefined;
  };
};

type MeetingPluginNodeHostOptions = {
  browserPageName: string;
  defaultAudioInputCommand: readonly string[];
  defaultAudioOutputCommand: readonly string[];
  meetingLabel: string;
  platform: MeetingPluginShellPlatform;
  sharePrerequisiteDeadline: boolean;
};

export function createMeetingPluginNodeHostHandler(options: MeetingPluginNodeHostOptions) {
  const platform = options.platform;
  return createMeetingConfiguredNodeHost({
    ...options,
    commandName: platform.nodeCommandName,
    displayName: platform.displayName,
    browserLabel: platform.browserLabel,
    bridgeIdPrefix: `${platform.session.idPrefix}_node_`,
    talkBackModes: new Set(["agent", "bidi"]),
    agentMode: "agent",
    defaultAudio: {
      backend: "auto",
      bufferBytes: 4_096,
      format: "pcm16-24khz",
    },
    normalizeUrl: (value) => platform.urls.validateAndNormalize(value),
    normalizeMeetingKey: (value) => platform.urls.normalizeForReuse(value),
    browser: {
      application: "Google Chrome",
      buildProfileArgs: (profile) => ["--args", `--profile-directory=${profile}`],
      openedStatus: "chrome-opened",
      openedNotes: [
        `${options.browserPageName} page control is handled by OpenClaw browser automation when using chrome-node.`,
      ],
    },
  });
}

export function createMeetingPluginNodeInvokePolicy(
  config: { chrome: Parameters<typeof createMeetingBrowserNodeInvokePolicy>[0]["start"] },
  options: { deniedCode: string; platform: MeetingPluginShellPlatform },
) {
  const platform = options.platform;
  return createMeetingBrowserNodeInvokePolicy({
    commandName: platform.nodeCommandName,
    displayName: platform.displayName,
    deniedCode: options.deniedCode,
    supportedModes: new Set(["agent", "bidi", "transcribe"]),
    normalizeUrl: (value) => platform.urls.validateAndNormalize(value),
    useConfiguredSetupCommands: true,
    start: config.chrome,
  });
}

export function createMeetingChromeRuntimeBindings() {
  return {
    createBindings: createMeetingRealtimeEngineBindings,
    createLocalAudioTransport: createLocalMeetingRealtimeAudioTransport,
    createNodeAudioTransport: createNodeMeetingRealtimeAudioTransport,
    startAgentRealtimeEngine: startMeetingAgentRealtimeEngine,
    startRealtimeEngine: startMeetingRealtimeEngine,
  };
}

export function createMeetingPluginChromeTransport<
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(
  options: Omit<
    MeetingChromeTransportOptions<Mode, Health, Transcript>,
    "browserNodeAdapter" | "isRealtimeRouteReady" | "isTalkBackMode" | "nodeCommandName"
  >,
) {
  return createMeetingChromeTransport<MeetingChromeTransportConfig, Mode, Health, Transcript>({
    ...options,
    browserNodeAdapter: options.platform,
    isRealtimeRouteReady: isMeetingRealtimeRouteReady,
    isTalkBackMode: isMeetingTalkBackMode,
    nodeCommandName: options.platform.nodeCommandName,
  });
}

type MeetingPluginShellEntryOptions<
  Config extends MeetingEntryConfig,
  Request extends MeetingJoinRequest,
  Runtime extends MeetingPluginRuntime<Request>,
> = Omit<
  MeetingPluginEntryOptions<Config, Request, Runtime>,
  | "cap"
  | "createRuntime"
  | "description"
  | "disabledMessage"
  | "gatewayMethodPrefix"
  | "id"
  | "name"
  | "nodeCommand"
  | "normalizeUrl"
  | "registerCli"
  | "toolDescription"
  | "toolLabel"
  | "toolName"
  | "transcriptSource"
  | "unknownActionMessage"
> & {
  cli: {
    descriptor: OpenClawPluginCliRootCommandDescriptor;
    load(): Promise<(params: { program: Command; config: Config }) => void>;
  };
  browserGuestLabel: string;
  platform: MeetingPluginShellPlatform;
  runtime: new (params: {
    config: Config;
    fullConfig: OpenClawPluginApi["config"];
    logger: OpenClawPluginApi["logger"];
    runtime: OpenClawPluginApi["runtime"];
  }) => Runtime;
  transcriptSource: { aliases?: readonly string[]; id: string };
};

export function createMeetingPluginShellEntry<
  Config extends MeetingEntryConfig,
  Request extends MeetingJoinRequest,
  Runtime extends MeetingPluginRuntime<Request>,
>(options: MeetingPluginShellEntryOptions<Config, Request, Runtime>) {
  const id = options.platform.id;
  const methodPrefix = id.replaceAll("-", "");
  const toolName = id.replaceAll("-", "_");
  const loadCli = createLazyRuntimeModule(() => options.cli.load());
  return createMeetingPluginEntryOptions<Config, Request, Runtime>({
    ...options,
    id,
    name: options.platform.displayName,
    cap: id,
    description: `Join ${options.platform.displayName} as a Chrome browser guest`,
    disabledMessage: `${options.platform.displayName} plugin disabled in plugin config`,
    gatewayMethodPrefix: methodPrefix,
    nodeCommand: options.platform.nodeCommandName,
    normalizeUrl: (value) => options.platform.urls.validateAndNormalize(value),
    toolDescription: `Join and manage ${options.browserGuestLabel} browser guests. Guest admission, tenant sign-in, and media permissions may require manual action in the OpenClaw Chrome profile.`,
    toolLabel: options.platform.displayName,
    toolName,
    transcriptSource: { ...options.transcriptSource, name: options.platform.displayName },
    unknownActionMessage: `unknown ${toolName} action`,
    createRuntime: ({ api, config }) =>
      new options.runtime({
        config,
        fullConfig: api.config,
        runtime: api.runtime,
        logger: api.logger,
      }),
    registerCli: (api, config) => {
      api.registerCli(async ({ program }) => (await loadCli())({ program, config }), {
        commands: [options.cli.descriptor.name],
        // Share the metadata descriptor so help and runtime output policy cannot drift.
        descriptors: [options.cli.descriptor],
      });
    },
  });
}

export function createMeetingPluginTypes<
  Config extends MeetingPluginConfig,
  Transport extends string,
  Mode extends string,
  ManualReason extends string,
  SpeechBlockedReason extends string,
  ExtraHealth extends object = object,
>() {
  type Health = MeetingPluginChromeHealth<ManualReason, SpeechBlockedReason> & ExtraHealth;
  type Request = MeetingPluginJoinRequest<Transport, Mode>;
  type Session = MeetingPluginSession<Transport, Mode, Health>;
  return null as unknown as {
    BrowserTab: MeetingBrowserTab;
    ChromeHealth: Health;
    JoinRequest: Request;
    JoinResult: MeetingPluginJoinResult<Session>;
    ProbeContext: MeetingProbeContext<
      Config & { defaultMode: Mode },
      Mode,
      Transport,
      Health,
      Session,
      Request
    >;
    Session: Session;
    TranscriptSnapshot: MeetingTranscriptSnapshot;
  };
}
