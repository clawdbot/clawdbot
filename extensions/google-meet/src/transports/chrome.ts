// Google Meet plugin module implements chrome behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createMeetingRealtimeEngineBindings,
  createLocalMeetingRealtimeAudioTransport,
  createNodeMeetingRealtimeAudioTransport,
  leaveMeetingWithBrowser,
  openMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
  recoverMeetingBrowserTab,
  resolveLocalMeetingBrowserRequest,
  MeetingPlatformAdapter,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingBrowserRequestCaller,
  type MeetingRealtimeAudioEngineHandle,
} from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveTranscriptsConfig } from "openclaw/plugin-sdk/transcripts";
import type { GoogleMeetConfig, GoogleMeetMode } from "../config.js";
import {
  callBrowserProxyOnNode,
  resolveChromeNode,
  type BrowserTab,
} from "./chrome-browser-proxy.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./google-meet-platform-constants.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetTranscriptSnapshot,
} from "./types.js";

type ChromeRealtimeAudioBridgeHandle = MeetingRealtimeAudioEngineHandle & {
  inputCommand: string[];
  outputCommand: string[];
};
type MeetingAudioBackend = "blackhole-2ch" | "pipewire-pulse";
type MeetingAudioRuntime = {
  backend: MeetingAudioBackend;
  deviceLabel: string;
  inputCommand: string[];
  outputCommand: string[];
};

type ChromeNodeRealtimeAudioBridgeHandle = MeetingRealtimeAudioEngineHandle & {
  type: "node-command-pair";
  nodeId: string;
  bridgeId: string;
};

function shouldCaptureCaptions(mode: GoogleMeetMode, fullConfig?: OpenClawConfig): boolean {
  return (
    mode === "transcribe" || !fullConfig || resolveTranscriptsConfig(fullConfig.transcripts).enabled
  );
}

async function prepareGoogleMeetAudioRuntime(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  timeoutMs: number;
}): Promise<MeetingAudioRuntime> {
  const audio = MeetingPlatformAdapter.resolveAudioRuntimeForFormat({
    backend: params.config.chrome.audioBackend,
    bufferBytes: params.config.chrome.audioBufferBytes,
    format: params.config.chrome.audioFormat,
    inputCommand: params.config.chrome.audioInputCommandOverride,
    outputCommand: params.config.chrome.audioOutputCommandOverride,
  });
  await MeetingPlatformAdapter.ensureAudioBackend({
    backend: audio.backend,
    timeoutMs: params.timeoutMs,
    run: async (argv, timeoutMs) => {
      const result = await params.runtime.system.runCommandWithTimeout(argv, { timeoutMs });
      return { ...result, code: result.code ?? 1 };
    },
  });
  return audio;
}

export async function assertGoogleMeetAudioAvailable(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  timeoutMs: number;
}): Promise<void> {
  await prepareGoogleMeetAudioRuntime(params);
}

export async function launchChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: GoogleMeetMode;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBackend?: MeetingAudioBackend;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
  tab?: GoogleMeetBrowserTab;
}> {
  let audio: MeetingAudioRuntime | undefined;
  const checkRealtimeAudioPrerequisites = async () => {
    if (!MeetingPlatformAdapter.isTalkBackMode(params.mode)) {
      return;
    }
    audio = await prepareGoogleMeetAudioRuntime({
      runtime: params.runtime,
      config: params.config,
      timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
    });

    if (params.config.chrome.audioBridgeHealthCommand) {
      const health = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeHealthCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (health.code !== 0) {
        throw new Error(
          `Chrome audio bridge health check failed: ${health.stderr || health.stdout || health.code}`,
        );
      }
    }
  };

  const startRealtimeAudioBridge = async (): Promise<
    | { type: "external-command" }
    | ({ type: "command-pair" } & ChromeRealtimeAudioBridgeHandle)
    | undefined
  > => {
    if (!MeetingPlatformAdapter.isTalkBackMode(params.mode)) {
      return undefined;
    }
    if (params.config.chrome.audioBridgeCommand) {
      if (params.mode === "agent") {
        throw new Error(
          "Chrome agent mode requires chrome.audioInputCommand and chrome.audioOutputCommand so OpenClaw can run STT and regular TTS directly.",
        );
      }
      const bridge = await params.runtime.system.runCommandWithTimeout(
        params.config.chrome.audioBridgeCommand,
        { timeoutMs: params.config.chrome.joinTimeoutMs },
      );
      if (bridge.code !== 0) {
        throw new Error(
          `failed to start Chrome audio bridge: ${bridge.stderr || bridge.stdout || bridge.code}`,
        );
      }
      return { type: "external-command" };
    }
    if (!params.config.chrome.audioInputCommand || !params.config.chrome.audioOutputCommand) {
      throw new Error(
        "Chrome talk-back mode requires chrome.audioInputCommand and chrome.audioOutputCommand, or chrome.audioBridgeCommand for an external bridge.",
      );
    }
    if (!audio) {
      throw new Error("Google Meet audio backend was not prepared.");
    }
    const transport = createLocalMeetingRealtimeAudioTransport({
      inputCommand: audio.inputCommand,
      outputCommand: audio.outputCommand,
      audioFormat: params.config.chrome.audioFormat,
      bargeInInputCommand: params.config.chrome.bargeInInputCommand,
      bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
      bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
      bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
      logger: params.logger,
      logScope: GOOGLE_MEET_PLATFORM_ADAPTER.logScope,
    });
    const bindings = createMeetingRealtimeEngineBindings({
      platform: GOOGLE_MEET_PLATFORM_ADAPTER,
      ...params,
    });
    const engine =
      params.mode === "agent"
        ? await startMeetingAgentRealtimeEngine({
            config: params.config,
            fullConfig: params.fullConfig,
            runtime: params.runtime,
            platform: bindings.platform,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            transport,
            logger: params.logger,
            consultAgent: bindings.consultAgent,
          })
        : await startMeetingRealtimeEngine({
            config: {
              ...params.config,
              realtime: { ...params.config.realtime, strategy: "bidi" },
            },
            fullConfig: params.fullConfig,
            runtime: params.runtime,
            ...bindings,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            transport,
            logger: params.logger,
          });
    return {
      type: "command-pair",
      inputCommand: audio.inputCommand,
      outputCommand: audio.outputCommand,
      ...engine,
    };
  };

  await checkRealtimeAudioPrerequisites();

  if (!params.config.chrome.launch) {
    const recovered = await recoverMeetingBrowserTab({
      adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
      allowSessionAdoption: true,
      autoJoin: params.config.chrome.autoJoin,
      callBrowser: await resolveLocalMeetingBrowserRequest(params.runtime, "browser-steward"),
      captureCaptions: shouldCaptureCaptions(params.mode, params.fullConfig),
      config: params.config.chrome,
      locationLabel: "in local Chrome",
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.url,
      trackedTargetId: undefined,
    });
    const audioBridge = MeetingPlatformAdapter.isRealtimeRouteReady(params.mode, recovered.browser)
      ? await startRealtimeAudioBridge()
      : undefined;
    return {
      launched: false,
      audioBackend: audio?.backend,
      audioBridge,
      browser: recovered.browser,
      tab: recovered.targetId ? { targetId: recovered.targetId, openedByPlugin: false } : undefined,
    };
  }

  const result = await openMeetingWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: await resolveLocalMeetingBrowserRequest(params.runtime, "browser-steward"),
    config: params.config.chrome,
    session: {
      captureCaptions: shouldCaptureCaptions(params.mode, params.fullConfig),
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      url: params.url,
    },
  });
  const shouldStartRealtimeBridge = MeetingPlatformAdapter.isRealtimeRouteReady(
    params.mode,
    result.browser,
  );
  const audioBridge = shouldStartRealtimeBridge ? await startRealtimeAudioBridge() : undefined;
  return { ...result, audioBackend: audio?.backend, audioBridge };
}

function parseNodeStartResult(raw: unknown): {
  launched?: boolean;
  bridgeId?: string;
  audioBackend?: MeetingAudioBackend;
  audioBridge?: { type?: string; outputGeneration?: boolean };
  browser?: GoogleMeetChromeHealth;
} {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Google Meet node returned an invalid start result.");
  }
  return value as {
    launched?: boolean;
    bridgeId?: string;
    audioBackend?: MeetingAudioBackend;
    audioBridge?: { type?: string; outputGeneration?: boolean };
    browser?: GoogleMeetChromeHealth;
  };
}

export async function leaveChromeMeet(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  meetingSessionId: string;
  meetingUrl: string;
  tab: GoogleMeetBrowserTab;
}): Promise<{ left: boolean; note: string }> {
  return await leaveMeetingWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: await resolveLocalMeetingBrowserRequest(params.runtime, "browser-steward"),
    launch: params.config.chrome.launch,
    meetingSessionId: params.meetingSessionId,
    meetingUrl: params.meetingUrl,
    tab: params.tab,
    timeoutMs: params.config.chrome.joinTimeoutMs,
  });
}

export async function readChromeMeetTranscript(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  finalize?: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  tab: GoogleMeetBrowserTab;
}): Promise<GoogleMeetTranscriptSnapshot> {
  return await readMeetingTranscriptWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: await resolveLocalMeetingBrowserRequest(params.runtime, "browser-steward"),
    finalize: params.finalize === true,
    meetingUrl: params.meetingUrl,
    meetingSessionId: params.meetingSessionId,
    tab: params.tab,
    timeoutMs: Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000),
  });
}

export async function readChromeMeetTranscriptOnNode(params: {
  runtime: PluginRuntime;
  nodeId?: string;
  config: GoogleMeetConfig;
  finalize?: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  tab: GoogleMeetBrowserTab;
}): Promise<GoogleMeetTranscriptSnapshot> {
  const nodeId =
    params.nodeId ??
    (await resolveChromeNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
    }));
  const timeoutMs = Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000);
  return await readMeetingTranscriptWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: async (request) =>
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      }),
    finalize: params.finalize === true,
    meetingUrl: params.meetingUrl,
    meetingSessionId: params.meetingSessionId,
    tab: params.tab,
    timeoutMs,
  });
}

export async function leaveChromeMeetOnNode(params: {
  runtime: PluginRuntime;
  nodeId?: string;
  config: GoogleMeetConfig;
  meetingSessionId: string;
  meetingUrl: string;
  tab: GoogleMeetBrowserTab;
}): Promise<{ left: boolean; note: string }> {
  const nodeId =
    params.nodeId ??
    (await resolveChromeNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
    }));
  return await leaveMeetingWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser: async (request) =>
      await callBrowserProxyOnNode({
        runtime: params.runtime,
        nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      }),
    launch: params.config.chrome.launch,
    meetingSessionId: params.meetingSessionId,
    meetingUrl: params.meetingUrl,
    tab: params.tab,
    timeoutMs: params.config.chrome.joinTimeoutMs,
  });
}

async function openMeetWithBrowserProxy(params: {
  runtime: PluginRuntime;
  nodeId: string;
  config: GoogleMeetConfig;
  captureCaptions: boolean;
  mode: GoogleMeetMode;
  meetingSessionId: string;
  url: string;
}): Promise<{ launched: boolean; browser?: GoogleMeetChromeHealth; tab?: GoogleMeetBrowserTab }> {
  const callBrowser: MeetingBrowserRequestCaller = async (request) =>
    await callBrowserProxyOnNode({
      runtime: params.runtime,
      nodeId: params.nodeId,
      method: request.method,
      path: request.path,
      body: request.body,
      timeoutMs: request.timeoutMs,
    });
  if (!params.config.chrome.launch) {
    const recovered = await recoverMeetingBrowserTab({
      adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
      allowSessionAdoption: true,
      autoJoin: params.config.chrome.autoJoin,
      callBrowser,
      captureCaptions: params.captureCaptions,
      config: params.config.chrome,
      locationLabel: "on the selected Chrome node",
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.url,
      trackedTargetId: undefined,
    });
    return {
      launched: false,
      browser: recovered.browser,
      tab: recovered.targetId ? { targetId: recovered.targetId, openedByPlugin: false } : undefined,
    };
  }
  return await openMeetingWithBrowser({
    adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
    callBrowser,
    config: params.config.chrome,
    session: {
      captureCaptions: params.captureCaptions,
      mode: params.mode,
      meetingSessionId: params.meetingSessionId,
      url: params.url,
    },
  });
}

export async function recoverCurrentMeetTab(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig?: OpenClawConfig;
  mode?: GoogleMeetMode;
  readOnly?: boolean;
  trackedMeetingUrl?: string;
  trackedTargetId?: string;
  url?: string;
}): Promise<{
  transport: "chrome";
  nodeId?: undefined;
  found: boolean;
  targetId?: string;
  tab?: BrowserTab;
  browser?: GoogleMeetChromeHealth;
  message: string;
}> {
  return {
    transport: "chrome",
    ...(await recoverMeetingBrowserTab({
      adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
      callBrowser: await resolveLocalMeetingBrowserRequest(params.runtime, "browser-steward"),
      captureCaptions: shouldCaptureCaptions(params.mode ?? "bidi", params.fullConfig),
      config: params.config.chrome,
      locationLabel: "in local Chrome",
      mode: params.mode ?? "bidi",
      readOnly: params.readOnly,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.trackedMeetingUrl,
      trackedTargetId: params.trackedTargetId,
    })),
  };
}

export async function recoverCurrentMeetTabOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig?: OpenClawConfig;
  mode?: GoogleMeetMode;
  readOnly?: boolean;
  trackedMeetingUrl?: string;
  trackedTargetId?: string;
  url?: string;
}): Promise<{
  transport: "chrome-node";
  nodeId: string;
  found: boolean;
  targetId?: string;
  tab?: BrowserTab;
  browser?: GoogleMeetChromeHealth;
  message: string;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  return {
    transport: "chrome-node",
    nodeId,
    ...(await recoverMeetingBrowserTab({
      adapter: GOOGLE_MEET_PLATFORM_ADAPTER,
      callBrowser: async (request) =>
        await callBrowserProxyOnNode({
          runtime: params.runtime,
          nodeId,
          method: request.method,
          path: request.path,
          body: request.body,
          timeoutMs: request.timeoutMs,
        }),
      captureCaptions: shouldCaptureCaptions(params.mode ?? "bidi", params.fullConfig),
      config: params.config.chrome,
      locationLabel: "on the selected Chrome node",
      mode: params.mode ?? "bidi",
      readOnly: params.readOnly,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.trackedMeetingUrl,
      trackedTargetId: params.trackedTargetId,
    })),
  };
}

export async function launchChromeMeetOnNode(params: {
  runtime: PluginRuntime;
  config: GoogleMeetConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: GoogleMeetMode;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBackend?: MeetingAudioBackend;
  audioBridge?:
    | { type: "external-command" }
    | ({ type: "node-command-pair" } & ChromeNodeRealtimeAudioBridgeHandle);
  browser?: GoogleMeetChromeHealth;
  tab?: GoogleMeetBrowserTab;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  try {
    await params.runtime.nodes.invoke({
      nodeId,
      command: GOOGLE_MEET_NODE_COMMAND,
      params: {
        action: "stopByUrl",
        url: params.url,
        mode: params.mode,
      },
      timeoutMs: 5_000,
    });
  } catch (error) {
    params.logger.debug?.(
      `[google-meet] node bridge cleanup before join ignored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const setup = MeetingPlatformAdapter.isTalkBackMode(params.mode)
    ? parseNodeStartResult(
        await params.runtime.nodes.invoke({
          nodeId,
          command: GOOGLE_MEET_NODE_COMMAND,
          params: {
            action: "setup",
            audioBackend: params.config.chrome.audioBackend,
            audioFormat: params.config.chrome.audioFormat,
            audioBufferBytes: params.config.chrome.audioBufferBytes,
            ...(params.config.chrome.audioInputCommandOverride
              ? { audioInputCommand: params.config.chrome.audioInputCommandOverride }
              : {}),
            ...(params.config.chrome.audioOutputCommandOverride
              ? { audioOutputCommand: params.config.chrome.audioOutputCommandOverride }
              : {}),
          },
          timeoutMs: 12_000,
        }),
      )
    : undefined;
  const browserControl = await openMeetWithBrowserProxy({
    runtime: params.runtime,
    nodeId,
    config: params.config,
    captureCaptions: shouldCaptureCaptions(params.mode, params.fullConfig),
    mode: params.mode,
    meetingSessionId: params.meetingSessionId,
    url: params.url,
  });
  // launch:false explicitly delegates call state to an already-open session.
  // Browser-managed joins require explicit unmuted health before node audio starts.
  if (
    MeetingPlatformAdapter.isTalkBackMode(params.mode) &&
    !MeetingPlatformAdapter.isRealtimeRouteReady(params.mode, browserControl.browser)
  ) {
    return {
      nodeId,
      launched: browserControl.launched,
      audioBackend: setup?.audioBackend,
      browser: browserControl.browser,
      tab: browserControl.tab,
    };
  }
  const raw = await params.runtime.nodes.invoke({
    nodeId,
    command: GOOGLE_MEET_NODE_COMMAND,
    params: {
      action: "start",
      url: params.url,
      mode: params.mode,
      launch: false,
      browserProfile: params.config.chrome.browserProfile,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      audioBackend: params.config.chrome.audioBackend,
      audioFormat: params.config.chrome.audioFormat,
      audioBufferBytes: params.config.chrome.audioBufferBytes,
      ...(params.config.chrome.audioInputCommandOverride
        ? { audioInputCommand: params.config.chrome.audioInputCommandOverride }
        : {}),
      ...(params.config.chrome.audioOutputCommandOverride
        ? { audioOutputCommand: params.config.chrome.audioOutputCommandOverride }
        : {}),
      audioBridgeCommand: params.config.chrome.audioBridgeCommand,
      audioBridgeHealthCommand: params.config.chrome.audioBridgeHealthCommand,
    },
    timeoutMs: addTimerTimeoutGraceMs(params.config.chrome.joinTimeoutMs) ?? 1,
  });
  const result = parseNodeStartResult(raw);
  if (result.audioBridge?.type === "node-command-pair") {
    if (!result.bridgeId) {
      throw new Error("Google Meet node did not return an audio bridge id.");
    }
    const transport = createNodeMeetingRealtimeAudioTransport({
      runtime: params.runtime,
      nodeId,
      bridgeId: result.bridgeId,
      audioFormat: params.config.chrome.audioFormat,
      logger: params.logger,
      commandName: GOOGLE_MEET_NODE_COMMAND,
      logScope: GOOGLE_MEET_PLATFORM_ADAPTER.logScope,
      logPrefix: params.mode === "agent" ? "node agent" : "node",
    });
    Reflect.set(
      transport,
      Symbol.for("openclaw.internal.meeting-node-output-generation.v1"),
      result.audioBridge.outputGeneration === true,
    );
    const bindings = createMeetingRealtimeEngineBindings({
      platform: GOOGLE_MEET_PLATFORM_ADAPTER,
      ...params,
    });
    const engine =
      params.mode === "agent"
        ? await startMeetingAgentRealtimeEngine({
            config: params.config,
            fullConfig: params.fullConfig,
            runtime: params.runtime,
            platform: bindings.platform,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            logPrefix: "node",
            transport,
            logger: params.logger,
            consultAgent: bindings.consultAgent,
          })
        : await startMeetingRealtimeEngine({
            config: {
              ...params.config,
              realtime: { ...params.config.realtime, strategy: "bidi" },
            },
            fullConfig: params.fullConfig,
            runtime: params.runtime,
            ...bindings,
            meetingSessionId: params.meetingSessionId,
            requesterSessionKey: params.requesterSessionKey,
            logPrefix: "node",
            talkSessionId: `google-meet:${params.meetingSessionId}:${result.bridgeId}:node-realtime`,
            talkContext: { nodeId, bridgeId: result.bridgeId },
            transport,
            logger: params.logger,
          });
    const bridge: ChromeNodeRealtimeAudioBridgeHandle = {
      type: "node-command-pair",
      nodeId,
      bridgeId: result.bridgeId,
      ...engine,
    };
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBackend: result.audioBackend ?? setup?.audioBackend,
      audioBridge: bridge,
      browser: browserControl.browser ?? result.browser,
      tab: browserControl.tab,
    };
  }
  if (result.audioBridge?.type === "external-command") {
    return {
      nodeId,
      launched: browserControl.launched || result.launched === true,
      audioBackend: result.audioBackend ?? setup?.audioBackend,
      audioBridge: { type: "external-command" },
      browser: browserControl.browser ?? result.browser,
      tab: browserControl.tab,
    };
  }
  return {
    nodeId,
    launched: browserControl.launched || result.launched === true,
    audioBackend: result.audioBackend ?? setup?.audioBackend,
    browser: browserControl.browser ?? result.browser,
    tab: browserControl.tab,
  };
}
