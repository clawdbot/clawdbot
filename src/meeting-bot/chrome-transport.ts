import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
import { resolveTranscriptsConfig } from "../transcripts/config.js";
import type { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import { openMeetingWithBrowser, recoverMeetingBrowserTab } from "./browser-controller.js";
import { callMeetingBrowserProxyOnNode, resolveMeetingBrowserNode } from "./browser-node.js";
import { resolveLocalMeetingBrowserRequest } from "./browser-request.js";
import {
  leaveMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
} from "./browser-session-control.js";
import type {
  MeetingBrowserJoinSession,
  MeetingBrowserRequestCaller,
  MeetingPlatformAdapter,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import type { startMeetingAgentRealtimeEngine } from "./realtime-agent-engine.js";
import type {
  startMeetingRealtimeEngine,
  MeetingRealtimeAudioEngineHandle,
  MeetingRealtimeEngineConfig,
} from "./realtime-engine.js";
import type { createLocalMeetingRealtimeAudioTransport } from "./realtime-local-audio-transport.js";
import type { createNodeMeetingRealtimeAudioTransport } from "./realtime-node-audio-transport.js";
import type {
  MeetingBrowserHealth,
  MeetingBrowserTab,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

type MeetingChromeTransportConfig = MeetingRealtimeEngineConfig & {
  chrome: MeetingRealtimeEngineConfig["chrome"] & {
    audioInputCommand: string[];
    audioOutputCommand: string[];
    autoJoin: boolean;
    bargeInCooldownMs: number;
    bargeInInputCommand?: string[];
    bargeInPeakThreshold: number;
    bargeInRmsThreshold: number;
    browserProfile?: string;
    guestName: string;
    joinTimeoutMs: number;
    launch: boolean;
    reuseExistingTab: boolean;
    waitForInCallMs: number;
  };
  chromeNode: { node?: string };
  realtime: MeetingRealtimeEngineConfig["realtime"] & {
    agentId?: string;
    toolPolicy: Parameters<
      typeof createMeetingRealtimeEngineBindings
    >[0]["config"]["realtime"]["toolPolicy"];
  };
};

type MeetingBrowserNodeAdapter = Pick<
  MeetingPlatformAdapter<unknown, string, MeetingBrowserHealth, MeetingTranscriptSnapshot>,
  "displayName" | "nodeCommandName" | "nodeConfigPath"
>;

type MeetingChromeTransportOptions<
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
> = {
  browserNodeAdapter: MeetingBrowserNodeAdapter;
  isRealtimeRouteReady(mode: Mode, health: Health | undefined): boolean;
  isTalkBackMode(mode: Mode): boolean;
  meetingLabel: string;
  nodeCommandName: string;
  outputMentionsAudioDevice(output: string): boolean;
  platform: MeetingPlatformAdapter<MeetingBrowserJoinSession<Mode>, Mode, Health, Transcript> &
    MeetingPlatformRuntimeMetadata;
  preserveTrackedBrowserOnEngineFailure: boolean;
  runtime: {
    createBindings: typeof createMeetingRealtimeEngineBindings;
    createLocalAudioTransport: typeof createLocalMeetingRealtimeAudioTransport;
    createNodeAudioTransport: typeof createNodeMeetingRealtimeAudioTransport;
    startAgentRealtimeEngine: typeof startMeetingAgentRealtimeEngine;
    startRealtimeEngine: typeof startMeetingRealtimeEngine;
  };
  systemProfilerCommand: string;
};

export function createMeetingChromeTransport<
  Config extends MeetingChromeTransportConfig,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
>(options: MeetingChromeTransportOptions<Mode, Health, Transcript>) {
  type LocalAudioBridge = MeetingRealtimeAudioEngineHandle & {
    type: "command-pair";
  };

  type NodeAudioBridge = MeetingRealtimeAudioEngineHandle & {
    type: "node-command-pair";
    nodeId: string;
    bridgeId: string;
  };

  async function openOrRecoverMeeting(params: {
    callBrowser: MeetingBrowserRequestCaller;
    config: Config;
    fullConfig: OpenClawConfig;
    meetingSessionId: string;
    mode: Mode;
    trackedTargetId?: string;
    url: string;
    locationLabel: string;
  }) {
    const captureCaptions =
      params.mode === "transcribe" ||
      resolveTranscriptsConfig(params.fullConfig.transcripts).enabled;
    if (params.config.chrome.launch) {
      return await openMeetingWithBrowser({
        adapter: options.platform,
        callBrowser: params.callBrowser,
        config: params.config.chrome,
        session: {
          captureCaptions,
          meetingSessionId: params.meetingSessionId,
          mode: params.mode,
          url: params.url,
        },
      });
    }
    const recovered = await recoverMeetingBrowserTab({
      adapter: options.platform,
      allowSessionAdoption: true,
      autoJoin: params.config.chrome.autoJoin,
      callBrowser: params.callBrowser,
      captureCaptions,
      config: params.config.chrome,
      locationLabel: params.locationLabel,
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      requestedMeetingUrl: params.url,
      trackedMeetingUrl: params.url,
      trackedTargetId: params.trackedTargetId,
    });
    return {
      launched: false,
      browser: recovered.browser,
      tab: recovered.targetId ? { targetId: recovered.targetId, openedByPlugin: false } : undefined,
    };
  }

  async function rollbackBrowserJoin(params: {
    callBrowser: MeetingBrowserRequestCaller;
    config: Config;
    logger: RuntimeLogger;
    meetingSessionId: string;
    tab?: MeetingBrowserTab;
    url: string;
  }) {
    if (!params.tab) {
      return;
    }
    const result = await leaveMeetingWithBrowser({
      adapter: options.platform,
      callBrowser: params.callBrowser,
      launch: true,
      meetingSessionId: params.meetingSessionId,
      meetingUrl: params.url,
      tab: params.tab,
      timeoutMs: params.config.chrome.joinTimeoutMs,
    }).catch((error: unknown) => ({
      left: false,
      note: error instanceof Error ? error.message : String(error),
    }));
    if (!result.left) {
      params.logger.warn(
        `${options.platform.logScope} browser rollback after realtime startup failure did not complete: ${result.note}`,
      );
    }
  }

  async function assertAudioDeviceAvailable(params: {
    runtime: PluginRuntime;
    timeoutMs: number;
  }): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error(`${options.meetingLabel} talk-back with BlackHole 2ch is macOS-only`);
    }
    const result = await params.runtime.system.runCommandWithTimeout(
      [options.systemProfilerCommand, "SPAudioDataType"],
      { timeoutMs: params.timeoutMs },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.code !== 0 || !options.outputMentionsAudioDevice(output)) {
      const hint =
        params.runtime.system.formatNativeDependencyHint?.({
          packageName: "BlackHole 2ch",
          downloadCommand: "brew install blackhole-2ch",
        }) ?? "";
      throw new Error(
        ["BlackHole 2ch audio device not found.", "Install BlackHole 2ch and SoX.", hint]
          .filter(Boolean)
          .join(" "),
      );
    }
  }

  async function startLocalAudioBridge(params: {
    runtime: PluginRuntime;
    config: Config;
    fullConfig: OpenClawConfig;
    meetingSessionId: string;
    requesterSessionKey?: string;
    mode: Mode;
    logger: RuntimeLogger;
  }): Promise<LocalAudioBridge | undefined> {
    if (!options.isTalkBackMode(params.mode)) {
      return undefined;
    }
    const transport = options.runtime.createLocalAudioTransport({
      inputCommand: params.config.chrome.audioInputCommand,
      outputCommand: params.config.chrome.audioOutputCommand,
      audioFormat: params.config.chrome.audioFormat,
      bargeInInputCommand: params.config.chrome.bargeInInputCommand,
      bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
      bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
      bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
      logger: params.logger,
      logScope: options.platform.logScope,
    });
    const bindings = options.runtime.createBindings({
      platform: options.platform,
      ...params,
    });
    try {
      const engine =
        params.mode === "agent"
          ? await options.runtime.startAgentRealtimeEngine({
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
          : await options.runtime.startRealtimeEngine({
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
      return { type: "command-pair", ...engine };
    } catch (error) {
      await transport.dispose().catch(() => {});
      throw error;
    }
  }

  async function launchInChrome(params: {
    runtime: PluginRuntime;
    config: Config;
    fullConfig: OpenClawConfig;
    meetingSessionId: string;
    requesterSessionKey?: string;
    mode: Mode;
    trackedTargetId?: string;
    url: string;
    logger: RuntimeLogger;
  }): Promise<{
    launched: boolean;
    audioBridge?: LocalAudioBridge;
    browser?: Health;
    tab?: MeetingBrowserTab;
  }> {
    if (options.isTalkBackMode(params.mode)) {
      await assertAudioDeviceAvailable({
        runtime: params.runtime,
        timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
      });
    }
    const callBrowser = await resolveLocalMeetingBrowserRequest(params.runtime);
    const result = await openOrRecoverMeeting({
      callBrowser,
      config: params.config,
      fullConfig: params.fullConfig,
      locationLabel: "in local Chrome",
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      trackedTargetId: params.trackedTargetId,
      url: params.url,
    });
    if (!options.isRealtimeRouteReady(params.mode, result.browser)) {
      return result;
    }
    try {
      return { ...result, audioBridge: await startLocalAudioBridge(params) };
    } catch (error) {
      if (!options.preserveTrackedBrowserOnEngineFailure || !params.trackedTargetId) {
        await rollbackBrowserJoin({
          callBrowser,
          config: params.config,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          tab: result.tab,
          url: params.url,
        });
      }
      throw error;
    }
  }

  async function resolveChromeNode(params: {
    runtime: PluginRuntime;
    requestedNode?: string;
  }): Promise<string> {
    return await resolveMeetingBrowserNode({
      ...params,
      adapter: options.browserNodeAdapter,
    });
  }

  async function callNodeBrowser(params: {
    runtime: PluginRuntime;
    nodeId: string;
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    timeoutMs: number;
  }) {
    return await callMeetingBrowserProxyOnNode({
      ...params,
      adapter: options.browserNodeAdapter,
    });
  }

  type MeetingNodeStartResult = {
    launched?: boolean;
    bridgeId?: string;
    audioBridge?: { type?: string };
    browser?: Health;
  };

  function parseNodeStartResult(raw: unknown): MeetingNodeStartResult {
    const value =
      raw && typeof raw === "object" && "payload" in raw
        ? (raw as { payload?: unknown }).payload
        : raw;
    if (!value || typeof value !== "object") {
      throw new Error(`${options.meetingLabel} node returned an invalid start result.`);
    }
    return value as MeetingNodeStartResult;
  }

  async function launchOnNode(params: {
    runtime: PluginRuntime;
    config: Config;
    fullConfig: OpenClawConfig;
    meetingSessionId: string;
    requesterSessionKey?: string;
    mode: Mode;
    trackedTargetId?: string;
    url: string;
    logger: RuntimeLogger;
  }): Promise<{
    nodeId: string;
    launched: boolean;
    audioBridge?: NodeAudioBridge;
    browser?: Health;
    tab?: MeetingBrowserTab;
  }> {
    const nodeId = await resolveChromeNode({
      runtime: params.runtime,
      requestedNode: params.config.chromeNode.node,
    });
    try {
      await params.runtime.nodes.invoke({
        nodeId,
        command: options.nodeCommandName,
        params: { action: "stopByUrl", url: params.url, mode: params.mode },
        timeoutMs: 5_000,
      });
    } catch (error) {
      params.logger.debug?.(
        `${options.platform.logScope} node bridge cleanup ignored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const callBrowser: MeetingBrowserRequestCaller = async (request) =>
      await callNodeBrowser({
        runtime: params.runtime,
        nodeId,
        method: request.method,
        path: request.path,
        body: request.body,
        timeoutMs: request.timeoutMs,
      });
    const browser = await openOrRecoverMeeting({
      callBrowser,
      config: params.config,
      fullConfig: params.fullConfig,
      locationLabel: "on the selected Chrome node",
      meetingSessionId: params.meetingSessionId,
      mode: params.mode,
      trackedTargetId: params.trackedTargetId,
      url: params.url,
    });
    if (!options.isRealtimeRouteReady(params.mode, browser.browser)) {
      return {
        nodeId,
        launched: browser.launched,
        browser: browser.browser,
        tab: browser.tab,
      };
    }
    try {
      const raw = await params.runtime.nodes.invoke({
        nodeId,
        command: options.nodeCommandName,
        params: {
          action: "start",
          url: params.url,
          mode: params.mode,
          launch: false,
          browserProfile: params.config.chrome.browserProfile,
          joinTimeoutMs: params.config.chrome.joinTimeoutMs,
          audioInputCommand: params.config.chrome.audioInputCommand,
          audioOutputCommand: params.config.chrome.audioOutputCommand,
        },
        timeoutMs: addTimerTimeoutGraceMs(params.config.chrome.joinTimeoutMs) ?? 1,
      });
      const result = parseNodeStartResult(raw);
      if (result.audioBridge?.type !== "node-command-pair") {
        return {
          nodeId,
          launched: browser.launched || result.launched === true,
          browser: browser.browser ?? result.browser,
          tab: browser.tab,
        };
      }
      if (!result.bridgeId) {
        throw new Error(`${options.meetingLabel} node did not return an audio bridge id.`);
      }
      const transport = options.runtime.createNodeAudioTransport({
        runtime: params.runtime,
        nodeId,
        bridgeId: result.bridgeId,
        audioFormat: params.config.chrome.audioFormat,
        logger: params.logger,
        commandName: options.nodeCommandName,
        logScope: options.platform.logScope,
        logPrefix: params.mode === "agent" ? "node agent" : "node",
      });
      const bindings = options.runtime.createBindings({
        platform: options.platform,
        ...params,
      });
      let engine: MeetingRealtimeAudioEngineHandle;
      try {
        engine =
          params.mode === "agent"
            ? await options.runtime.startAgentRealtimeEngine({
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
            : await options.runtime.startRealtimeEngine({
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
                talkSessionId: `${options.platform.id}:${params.meetingSessionId}:${result.bridgeId}:node-realtime`,
                talkContext: { nodeId, bridgeId: result.bridgeId },
                transport,
                logger: params.logger,
              });
      } catch (error) {
        await transport.dispose().catch(() => {});
        throw error;
      }
      return {
        nodeId,
        launched: browser.launched || result.launched === true,
        audioBridge: {
          type: "node-command-pair",
          nodeId,
          bridgeId: result.bridgeId,
          ...engine,
        },
        browser: browser.browser ?? result.browser,
        tab: browser.tab,
      };
    } catch (error) {
      await params.runtime.nodes
        .invoke({
          nodeId,
          command: options.nodeCommandName,
          params: { action: "stopByUrl", url: params.url, mode: params.mode },
          timeoutMs: 5_000,
        })
        .catch(() => {});
      if (!options.preserveTrackedBrowserOnEngineFailure || !params.trackedTargetId) {
        await rollbackBrowserJoin({
          callBrowser,
          config: params.config,
          logger: params.logger,
          meetingSessionId: params.meetingSessionId,
          tab: browser.tab,
          url: params.url,
        });
      }
      throw error;
    }
  }

  async function recoverCurrentTab(params: {
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
  }) {
    const nodeId =
      params.transport === "chrome-node"
        ? (params.nodeId ??
          (await resolveChromeNode({
            runtime: params.runtime,
            requestedNode: params.config.chromeNode.node,
          })))
        : undefined;
    return {
      transport: params.transport,
      ...(nodeId ? { nodeId } : {}),
      ...(await recoverMeetingBrowserTab({
        adapter: options.platform,
        callBrowser: nodeId
          ? async (request) =>
              await callNodeBrowser({
                runtime: params.runtime,
                nodeId,
                method: request.method,
                path: request.path,
                body: request.body,
                timeoutMs: request.timeoutMs,
              })
          : await resolveLocalMeetingBrowserRequest(params.runtime),
        captureCaptions:
          params.mode === "transcribe" ||
          resolveTranscriptsConfig(params.fullConfig?.transcripts).enabled,
        config: params.config.chrome,
        locationLabel: nodeId ? "on the selected Chrome node" : "in local Chrome",
        meetingSessionId: params.meetingSessionId,
        mode: params.mode,
        readOnly: params.readOnly,
        requestedMeetingUrl: params.url,
        trackedMeetingUrl: params.trackedMeetingUrl,
        trackedTargetId: params.trackedTargetId,
        timeoutMs: params.timeoutMs,
      })),
    };
  }

  async function leaveInBrowser(params: {
    runtime: PluginRuntime;
    config: Config;
    meetingSessionId: string;
    meetingUrl: string;
    nodeId?: string;
    tab: MeetingBrowserTab;
  }) {
    const nodeId = params.nodeId;
    return await leaveMeetingWithBrowser({
      adapter: options.platform,
      callBrowser: nodeId
        ? async (request) =>
            await callNodeBrowser({
              runtime: params.runtime,
              nodeId,
              method: request.method,
              path: request.path,
              body: request.body,
              timeoutMs: request.timeoutMs,
            })
        : await resolveLocalMeetingBrowserRequest(params.runtime),
      launch: params.config.chrome.launch || !params.tab.openedByPlugin,
      meetingSessionId: params.meetingSessionId,
      meetingUrl: params.meetingUrl,
      tab: params.tab,
      timeoutMs: params.config.chrome.joinTimeoutMs,
    });
  }

  async function readTranscript(params: {
    runtime: PluginRuntime;
    config: Config;
    finalize?: boolean;
    meetingUrl: string;
    meetingSessionId: string;
    nodeId?: string;
    tab: MeetingBrowserTab;
  }): Promise<Transcript> {
    const nodeId = params.nodeId;
    return await readMeetingTranscriptWithBrowser({
      adapter: options.platform,
      callBrowser: nodeId
        ? async (request) =>
            await callNodeBrowser({
              runtime: params.runtime,
              nodeId,
              method: request.method,
              path: request.path,
              body: request.body,
              timeoutMs: request.timeoutMs,
            })
        : await resolveLocalMeetingBrowserRequest(params.runtime),
      finalize: params.finalize === true,
      meetingUrl: params.meetingUrl,
      meetingSessionId: params.meetingSessionId,
      tab: params.tab,
      timeoutMs: Math.min(Math.max(1_000, params.config.chrome.joinTimeoutMs), 10_000),
    });
  }
  return {
    assertAudioDeviceAvailable,
    launchInChrome,
    launchOnNode,
    leaveInBrowser,
    readTranscript,
    recoverCurrentTab,
  };
}
