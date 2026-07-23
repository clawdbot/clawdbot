import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  callMeetingBrowserProxyOnNode,
  createLocalMeetingRealtimeAudioTransport,
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  leaveMeetingWithBrowser,
  openMeetingWithBrowser,
  readMeetingTranscriptWithBrowser,
  recoverMeetingBrowserTab,
  resolveLocalMeetingBrowserRequest,
  resolveMeetingBrowserNode,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingBrowserRequestCaller,
  type MeetingRealtimeAudioEngineHandle,
} from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { TeamsMeetingsConfig, TeamsMeetingsMode } from "../config.js";
import {
  TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND,
  outputMentionsBlackHole2ch,
} from "./chrome-audio-device.js";
import {
  TEAMS_MEETINGS_PLATFORM_ADAPTER,
  isTeamsMeetingsRealtimeRouteReady,
  isTeamsMeetingsTalkBackMode,
} from "./teams-meetings-platform-adapter.js";
import {
  TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
  TEAMS_MEETINGS_NODE_COMMAND,
} from "./teams-meetings-platform-constants.js";
import type {
  TeamsMeetingsBrowserTab,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsTranscriptSnapshot,
} from "./types.js";

type LocalAudioBridge = MeetingRealtimeAudioEngineHandle & {
  type: "command-pair";
};

type NodeAudioBridge = MeetingRealtimeAudioEngineHandle & {
  type: "node-command-pair";
  nodeId: string;
  bridgeId: string;
};

async function openOrRecoverTeamsMeeting(params: {
  callBrowser: MeetingBrowserRequestCaller;
  config: TeamsMeetingsConfig;
  meetingSessionId: string;
  mode: TeamsMeetingsMode;
  trackedTargetId?: string;
  url: string;
  locationLabel: string;
}) {
  if (params.config.chrome.launch) {
    return await openMeetingWithBrowser({
      adapter: TEAMS_MEETINGS_PLATFORM_ADAPTER,
      callBrowser: params.callBrowser,
      config: params.config.chrome,
      session: {
        meetingSessionId: params.meetingSessionId,
        mode: params.mode,
        url: params.url,
      },
    });
  }
  const recovered = await recoverMeetingBrowserTab({
    adapter: TEAMS_MEETINGS_PLATFORM_ADAPTER,
    allowSessionAdoption: true,
    autoJoin: params.config.chrome.autoJoin,
    callBrowser: params.callBrowser,
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

async function rollbackTeamsBrowserJoin(params: {
  callBrowser: MeetingBrowserRequestCaller;
  config: TeamsMeetingsConfig;
  logger: RuntimeLogger;
  meetingSessionId: string;
  tab?: TeamsMeetingsBrowserTab;
  url: string;
}) {
  if (!params.tab) {
    return;
  }
  const result = await leaveMeetingWithBrowser({
    adapter: TEAMS_MEETINGS_PLATFORM_ADAPTER,
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
      `${TEAMS_MEETINGS_PLATFORM_ADAPTER.logScope} browser rollback after realtime startup failure did not complete: ${result.note}`,
    );
  }
}

export async function assertBlackHole2chAvailable(params: {
  runtime: PluginRuntime;
  timeoutMs: number;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Microsoft Teams meeting talk-back with BlackHole 2ch is macOS-only");
  }
  const result = await params.runtime.system.runCommandWithTimeout(
    [TEAMS_MEETINGS_SYSTEM_PROFILER_COMMAND, "SPAudioDataType"],
    { timeoutMs: params.timeoutMs },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.code !== 0 || !outputMentionsBlackHole2ch(output)) {
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
  config: TeamsMeetingsConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: TeamsMeetingsMode;
  logger: RuntimeLogger;
}): Promise<LocalAudioBridge | undefined> {
  if (!isTeamsMeetingsTalkBackMode(params.mode)) {
    return undefined;
  }
  const transport = createLocalMeetingRealtimeAudioTransport({
    inputCommand: params.config.chrome.audioInputCommand,
    outputCommand: params.config.chrome.audioOutputCommand,
    bargeInInputCommand: params.config.chrome.bargeInInputCommand,
    bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
    bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
    bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
    logger: params.logger,
    logScope: TEAMS_MEETINGS_PLATFORM_ADAPTER.logScope,
  });
  const bindings = createMeetingRealtimeEngineBindings({
    platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
    ...params,
  });
  try {
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
    return { type: "command-pair", ...engine };
  } catch (error) {
    await transport.dispose().catch(() => {});
    throw error;
  }
}

export async function launchTeamsMeetingInChrome(params: {
  runtime: PluginRuntime;
  config: TeamsMeetingsConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: TeamsMeetingsMode;
  trackedTargetId?: string;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  launched: boolean;
  audioBridge?: LocalAudioBridge;
  browser?: TeamsMeetingsChromeHealth;
  tab?: TeamsMeetingsBrowserTab;
}> {
  if (isTeamsMeetingsTalkBackMode(params.mode)) {
    await assertBlackHole2chAvailable({
      runtime: params.runtime,
      timeoutMs: Math.min(params.config.chrome.joinTimeoutMs, 10_000),
    });
  }
  const callBrowser = await resolveLocalMeetingBrowserRequest(params.runtime);
  const result = await openOrRecoverTeamsMeeting({
    callBrowser,
    config: params.config,
    locationLabel: "in local Chrome",
    meetingSessionId: params.meetingSessionId,
    mode: params.mode,
    trackedTargetId: params.trackedTargetId,
    url: params.url,
  });
  if (!isTeamsMeetingsRealtimeRouteReady(params.mode, result.browser)) {
    return result;
  }
  try {
    return { ...result, audioBridge: await startLocalAudioBridge(params) };
  } catch (error) {
    await rollbackTeamsBrowserJoin({
      callBrowser,
      config: params.config,
      logger: params.logger,
      meetingSessionId: params.meetingSessionId,
      tab: result.tab,
      url: params.url,
    });
    throw error;
  }
}

async function resolveChromeNode(params: {
  runtime: PluginRuntime;
  requestedNode?: string;
}): Promise<string> {
  return await resolveMeetingBrowserNode({
    ...params,
    adapter: TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
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
    adapter: TEAMS_MEETINGS_BROWSER_NODE_ADAPTER,
  });
}

type TeamsMeetingsNodeStartResult = {
  launched?: boolean;
  bridgeId?: string;
  audioBridge?: { type?: string };
  browser?: TeamsMeetingsChromeHealth;
};

function parseNodeStartResult(raw: unknown): TeamsMeetingsNodeStartResult {
  const value =
    raw && typeof raw === "object" && "payload" in raw
      ? (raw as { payload?: unknown }).payload
      : raw;
  if (!value || typeof value !== "object") {
    throw new Error("Microsoft Teams meeting node returned an invalid start result.");
  }
  return value as TeamsMeetingsNodeStartResult;
}

export async function launchTeamsMeetingOnNode(params: {
  runtime: PluginRuntime;
  config: TeamsMeetingsConfig;
  fullConfig: OpenClawConfig;
  meetingSessionId: string;
  requesterSessionKey?: string;
  mode: TeamsMeetingsMode;
  trackedTargetId?: string;
  url: string;
  logger: RuntimeLogger;
}): Promise<{
  nodeId: string;
  launched: boolean;
  audioBridge?: NodeAudioBridge;
  browser?: TeamsMeetingsChromeHealth;
  tab?: TeamsMeetingsBrowserTab;
}> {
  const nodeId = await resolveChromeNode({
    runtime: params.runtime,
    requestedNode: params.config.chromeNode.node,
  });
  try {
    await params.runtime.nodes.invoke({
      nodeId,
      command: TEAMS_MEETINGS_NODE_COMMAND,
      params: { action: "stopByUrl", url: params.url, mode: params.mode },
      timeoutMs: 5_000,
    });
  } catch (error) {
    params.logger.debug?.(
      `${TEAMS_MEETINGS_PLATFORM_ADAPTER.logScope} node bridge cleanup ignored: ${
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
  const browser = await openOrRecoverTeamsMeeting({
    callBrowser,
    config: params.config,
    locationLabel: "on the selected Chrome node",
    meetingSessionId: params.meetingSessionId,
    mode: params.mode,
    trackedTargetId: params.trackedTargetId,
    url: params.url,
  });
  if (!isTeamsMeetingsRealtimeRouteReady(params.mode, browser.browser)) {
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
      command: TEAMS_MEETINGS_NODE_COMMAND,
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
      throw new Error("Microsoft Teams meeting node did not return an audio bridge id.");
    }
    const transport = createNodeMeetingRealtimeAudioTransport({
      runtime: params.runtime,
      nodeId,
      bridgeId: result.bridgeId,
      logger: params.logger,
      commandName: TEAMS_MEETINGS_NODE_COMMAND,
      logScope: TEAMS_MEETINGS_PLATFORM_ADAPTER.logScope,
      logPrefix: params.mode === "agent" ? "node agent" : "node",
    });
    const bindings = createMeetingRealtimeEngineBindings({
      platform: TEAMS_MEETINGS_PLATFORM_ADAPTER,
      ...params,
    });
    let engine: MeetingRealtimeAudioEngineHandle;
    try {
      engine =
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
              talkSessionId: `teams-meetings:${params.meetingSessionId}:${result.bridgeId}:node-realtime`,
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
        command: TEAMS_MEETINGS_NODE_COMMAND,
        params: { action: "stopByUrl", url: params.url, mode: params.mode },
        timeoutMs: 5_000,
      })
      .catch(() => {});
    await rollbackTeamsBrowserJoin({
      callBrowser,
      config: params.config,
      logger: params.logger,
      meetingSessionId: params.meetingSessionId,
      tab: browser.tab,
      url: params.url,
    });
    throw error;
  }
}

export async function recoverCurrentTeamsMeetingTab(params: {
  runtime: PluginRuntime;
  config: TeamsMeetingsConfig;
  meetingSessionId?: string;
  mode: TeamsMeetingsMode;
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
      adapter: TEAMS_MEETINGS_PLATFORM_ADAPTER,
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

export async function leaveTeamsMeetingInBrowser(params: {
  runtime: PluginRuntime;
  config: TeamsMeetingsConfig;
  meetingSessionId: string;
  meetingUrl: string;
  nodeId?: string;
  tab: TeamsMeetingsBrowserTab;
}) {
  const nodeId = params.nodeId;
  return await leaveMeetingWithBrowser({
    adapter: TEAMS_MEETINGS_PLATFORM_ADAPTER,
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

export async function readTeamsMeetingTranscript(params: {
  runtime: PluginRuntime;
  config: TeamsMeetingsConfig;
  finalize?: boolean;
  meetingUrl: string;
  meetingSessionId: string;
  nodeId?: string;
  tab: TeamsMeetingsBrowserTab;
}): Promise<TeamsMeetingsTranscriptSnapshot> {
  const nodeId = params.nodeId;
  return await readMeetingTranscriptWithBrowser({
    adapter: TEAMS_MEETINGS_PLATFORM_ADAPTER,
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
