import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  MeetingSessionRuntime,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { TeamsMeetingsConfig, TeamsMeetingsMode, TeamsMeetingsTransport } from "./config.js";
import {
  testTeamsMeetingListening,
  testTeamsMeetingSpeech,
  type TeamsMeetingsProbeContext,
} from "./runtime-probes.js";
import { createTeamsMeetingsSession } from "./runtime-session.js";
import { getTeamsMeetingsSetupStatus } from "./runtime-setup.js";
import {
  launchTeamsMeetingInChrome,
  launchTeamsMeetingOnNode,
  leaveTeamsMeetingInBrowser,
  readTeamsMeetingTranscript,
  recoverCurrentTeamsMeetingTab,
} from "./transports/chrome.js";
import {
  TEAMS_MEETINGS_PLATFORM_ADAPTER,
  isTeamsMeetingsRealtimeRouteReady,
  isTeamsMeetingsTalkBackMode,
} from "./transports/teams-meetings-platform-adapter.js";
import type {
  TeamsMeetingsBrowserTab,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsJoinRequest,
  TeamsMeetingsJoinResult,
  TeamsMeetingsSession,
} from "./transports/types.js";

type ManualActionReason = NonNullable<TeamsMeetingsChromeHealth["manualActionReason"]>;
type SpeechBlockedReason = NonNullable<TeamsMeetingsChromeHealth["speechBlockedReason"]>;
type SessionRuntime = MeetingSessionRuntime<
  TeamsMeetingsSession,
  TeamsMeetingsJoinRequest,
  TeamsMeetingsTransport,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsBrowserTab,
  ManualActionReason,
  SpeechBlockedReason
>;
type JoinContext = MeetingSessionRuntimeJoinContext<
  TeamsMeetingsSession,
  TeamsMeetingsTransport,
  TeamsMeetingsMode,
  TeamsMeetingsChromeHealth,
  TeamsMeetingsBrowserTab
>;
type LaunchResult =
  | Awaited<ReturnType<typeof launchTeamsMeetingInChrome>>
  | Awaited<ReturnType<typeof launchTeamsMeetingOnNode>>;
type AudioBridge = NonNullable<LaunchResult["audioBridge"]>;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveTransport(
  request: TeamsMeetingsJoinRequest,
  config: TeamsMeetingsConfig,
): TeamsMeetingsTransport {
  return request.transport ?? (config.chromeNode.node ? "chrome-node" : "chrome");
}

function withSessionAgentConfig(config: TeamsMeetingsConfig, agentId: string): TeamsMeetingsConfig {
  return config.realtime.agentId === agentId
    ? config
    : { ...config, realtime: { ...config.realtime, agentId } };
}

function noteSession(session: TeamsMeetingsSession, note: string): void {
  session.notes = [...session.notes.filter((item) => item !== note), note];
}

export class TeamsMeetingsRuntime {
  readonly #sessions: SessionRuntime;
  readonly #requesterSessionKeys = new Map<string, string>();

  constructor(
    private readonly params: {
      config: TeamsMeetingsConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {
    this.#sessions = new MeetingSessionRuntime({
      logger: params.logger,
      logScope: TEAMS_MEETINGS_PLATFORM_ADAPTER.logScope,
      formatError: formatErrorMessage,
      reuseExistingBrowserTab: params.config.chrome.reuseExistingTab,
      waitForInCallMs: params.config.chrome.waitForInCallMs,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      defaultSpeechInstructions: params.config.realtime.introMessage,
      transientSpeechBlockedReasons: new Set<SpeechBlockedReason>([
        "not-in-call",
        "browser-unverified",
        "teams-microphone-muted",
      ]),
      messages: {
        previousBrowserLeaveFailed:
          "Could not leave the previous Teams meeting tab before reassignment.",
        reassignedSessionNote:
          "Ended before the same Teams meeting tab was reassigned to another agent.",
        reusedSessionNote: "Reused existing active Microsoft Teams meeting session.",
        replacementBrowserLeaveFailed:
          "Could not leave the previous Teams meeting tab before reassignment.",
        speechBlockedFallback: "Realtime speech blocked until Microsoft Teams is ready.",
        speech: {
          audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
          browserUnverified: "Microsoft Teams browser state has not been verified yet.",
          manualActionFallback:
            "Resolve the Microsoft Teams browser prompt before asking OpenClaw to speak.",
          microphoneMuted: "Turn on the OpenClaw Teams microphone before asking OpenClaw to speak.",
          microphoneMutedReason: "teams-microphone-muted",
          notInCall: "Microsoft Teams has not reported that the browser guest is in the call.",
          notInCallReason: "not-in-call",
          browserUnverifiedReason: "browser-unverified",
          audioBridgeUnavailableReason: "audio-bridge-unavailable",
        },
      },
      resolveJoin: (request) => ({
        url: TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(request.url),
        transport: resolveTransport(request, params.config),
        mode: request.mode ?? params.config.defaultMode,
        agentId: normalizeAgentId(request.agentId ?? params.config.realtime.agentId),
      }),
      createSession: ({ request, resolved, createdAt }) => {
        const session = createTeamsMeetingsSession({ config: params.config, resolved, createdAt });
        if (request.requesterSessionKey) {
          this.#requesterSessionKeys.set(session.id, request.requesterSessionKey);
        }
        return session;
      },
      resolveSpeechInstructions: (request) =>
        request.message ?? params.config.realtime.introMessage,
      isBrowserTransport: () => true,
      isTalkBackMode: isTeamsMeetingsTalkBackMode,
      isTranscribeMode: (mode) => mode === "transcribe",
      sameMeetingUrl: (left, right) =>
        TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.isSameMeeting(left, right),
      normalizeMeetingUrlForReuse: (url) =>
        TEAMS_MEETINGS_PLATFORM_ADAPTER.urls.normalizeForReuse(url),
      getBrowser: (session) =>
        session.chrome
          ? {
              launched: session.chrome.launched,
              nodeId: session.chrome.nodeId,
              tab: session.chrome.browserTab,
              health: session.chrome.health,
              hasAudioBridge: Boolean(session.chrome.audioBridge),
            }
          : undefined,
      setBrowserTab: (session, tab) => {
        if (session.chrome) {
          session.chrome.browserTab = tab;
        }
      },
      setBrowserHealth: (session, health) => {
        if (session.chrome) {
          session.chrome.health = health;
        }
      },
      joinTransport: async ({ request, session, context }) =>
        await this.#joinTransport(request, session, context),
      releaseBrowserTab: async (session) => await this.#releaseBrowserTab(session),
      refreshBrowserHealth: async (session, options) =>
        await this.#refreshBrowserHealth(session, options),
      refreshStatus: async (session) =>
        await this.#sessions.refreshBrowserHealth(session, { force: true, readOnly: true }),
      refreshReusableSession: async (_session, _request, _resolved) => {},
      ensureRealtimeBridge: async (session) => await this.#ensureRealtimeBridge(session),
      captureTranscript: async (session, options) =>
        await this.#captureTranscript(session, options),
      speakViaTransport: async () => undefined,
    });
  }

  list(): TeamsMeetingsSession[] {
    return this.#sessions.list();
  }

  ownsSession(agentId: string, sessionId: string): boolean {
    return this.list().some((session) => session.id === sessionId && session.agentId === agentId);
  }

  async join(request: TeamsMeetingsJoinRequest): Promise<TeamsMeetingsJoinResult> {
    try {
      return await this.#sessions.join(request);
    } catch (error) {
      const activeIds = new Set(this.list().map((session) => session.id));
      for (const sessionId of this.#requesterSessionKeys.keys()) {
        if (!activeIds.has(sessionId)) {
          this.#requesterSessionKeys.delete(sessionId);
        }
      }
      throw error;
    }
  }

  async leave(sessionId: string) {
    try {
      return await this.#sessions.leave(sessionId);
    } finally {
      this.#requesterSessionKeys.delete(sessionId);
    }
  }

  async status(sessionId?: string) {
    return await this.#sessions.status(sessionId);
  }

  async statusForAgent(agentId: string, sessionId?: string) {
    if (sessionId) {
      return this.ownsSession(agentId, sessionId)
        ? await this.#sessions.status(sessionId)
        : { found: false };
    }
    const sessions = this.list().filter((session) => session.agentId === agentId);
    await Promise.all(sessions.map((session) => this.#sessions.status(session.id)));
    return { found: true, sessions };
  }

  async transcript(sessionId: string, options: { sinceIndex?: number } = {}) {
    return await this.#sessions.transcript(sessionId, options);
  }

  async speak(sessionId: string, instructions?: string) {
    return await this.#sessions.speak(sessionId, instructions);
  }

  async setupStatus(options?: { mode?: TeamsMeetingsMode; transport?: TeamsMeetingsTransport }) {
    return await getTeamsMeetingsSetupStatus({
      config: this.params.config,
      fullConfig: this.params.fullConfig,
      runtime: this.params.runtime,
      options,
    });
  }

  async testSpeech(request: TeamsMeetingsJoinRequest) {
    return await testTeamsMeetingSpeech(this.#probeContext(), request);
  }

  async testListen(request: TeamsMeetingsJoinRequest) {
    return await testTeamsMeetingListening(this.#probeContext(), request);
  }

  #probeContext(): TeamsMeetingsProbeContext {
    return {
      config: this.params.config,
      resolveAgentId: (request) =>
        normalizeAgentId(request.agentId ?? this.params.config.realtime.agentId),
      list: () => this.list(),
      join: async (request) => await this.join(request),
      isReusable: (session, resolved) => this.#sessions.isReusableSession(session, resolved),
      hasHealthHandle: (sessionId) => this.#sessions.hasHealthHandle(sessionId),
      refreshHealth: (sessionId) => this.#sessions.refreshHealth(sessionId),
      refreshCaptionHealth: async (session, timeoutMs) =>
        await this.#refreshBrowserHealth(session, { timeoutMs }),
    };
  }

  async #joinTransport(
    request: TeamsMeetingsJoinRequest,
    session: TeamsMeetingsSession,
    context: JoinContext,
  ): Promise<{ delegatedSpoken?: boolean }> {
    const config = withSessionAgentConfig(this.params.config, session.agentId);
    const result: LaunchResult =
      session.transport === "chrome-node"
        ? await launchTeamsMeetingOnNode({
            runtime: this.params.runtime,
            config,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            requesterSessionKey: request.requesterSessionKey,
            mode: session.mode,
            url: session.url,
            logger: this.params.logger,
          })
        : await launchTeamsMeetingInChrome({
            runtime: this.params.runtime,
            config,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            requesterSessionKey: request.requesterSessionKey,
            mode: session.mode,
            url: session.url,
            logger: this.params.logger,
          });
    const nodeId = "nodeId" in result ? result.nodeId : undefined;
    const tab = context.inheritedBrowserTab({
      session,
      transport: session.transport,
      nodeId,
      meetingUrl: session.url,
      tab: result.tab,
    });
    session.chrome = {
      audioBackend: "blackhole-2ch",
      launched: result.launched,
      nodeId,
      browserProfile: this.params.config.chrome.browserProfile,
      browserTab: tab,
      health: result.browser,
    };
    const handles = this.#attachAudioBridge(session, result.audioBridge);
    if (handles) {
      context.attachRuntimeHandles(session, handles);
    }
    session.notes.push(
      result.audioBridge
        ? session.transport === "chrome-node"
          ? "Teams guest joined in Chrome on the selected node with realtime audio through the node bridge."
          : "Teams guest joined in local Chrome with realtime audio through BlackHole 2ch and SoX."
        : session.mode === "transcribe"
          ? "Teams guest joined observe-only with live-caption transcript capture."
          : "Teams guest join is waiting for the browser to become ready before starting realtime audio.",
    );
    this.#sessions.refreshSpeechReadiness(session);
    return {};
  }

  #attachAudioBridge(
    session: TeamsMeetingsSession,
    audioBridge: AudioBridge | undefined,
  ): MeetingSessionRuntimeHandles<TeamsMeetingsChromeHealth> | undefined {
    if (!session.chrome || !audioBridge) {
      return undefined;
    }
    session.chrome.audioBridge = {
      type: audioBridge.type,
      provider: audioBridge.providerId,
    };
    return {
      stop: audioBridge.stop,
      speak: audioBridge.speak,
      getHealth: audioBridge.getHealth,
    };
  }

  async #ensureRealtimeBridge(
    session: TeamsMeetingsSession,
  ): Promise<MeetingSessionRuntimeHandles<TeamsMeetingsChromeHealth> | undefined> {
    if (
      !isTeamsMeetingsTalkBackMode(session.mode) ||
      session.state !== "active" ||
      !session.chrome ||
      session.chrome.audioBridge ||
      !isTeamsMeetingsRealtimeRouteReady(session.mode, session.chrome.health)
    ) {
      return undefined;
    }
    const config = withSessionAgentConfig(this.params.config, session.agentId);
    const recoveryConfig = {
      ...config,
      chrome: { ...config.chrome, launch: false },
      chromeNode: { node: session.chrome.nodeId ?? config.chromeNode.node },
    };
    const result =
      session.transport === "chrome-node"
        ? await launchTeamsMeetingOnNode({
            runtime: this.params.runtime,
            config: recoveryConfig,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            requesterSessionKey: this.#requesterSessionKeys.get(session.id),
            mode: session.mode,
            trackedTargetId: session.chrome.browserTab?.targetId,
            url: session.url,
            logger: this.params.logger,
          })
        : await launchTeamsMeetingInChrome({
            runtime: this.params.runtime,
            config: recoveryConfig,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            requesterSessionKey: this.#requesterSessionKeys.get(session.id),
            mode: session.mode,
            trackedTargetId: session.chrome.browserTab?.targetId,
            url: session.url,
            logger: this.params.logger,
          });
    if (result.tab) {
      const currentTab = session.chrome.browserTab;
      session.chrome.browserTab = {
        ...result.tab,
        openedByPlugin:
          result.tab.targetId === currentTab?.targetId
            ? currentTab.openedByPlugin
            : result.tab.openedByPlugin,
      };
    }
    if (result.browser) {
      session.chrome.health = { ...session.chrome.health, ...result.browser };
    }
    session.updatedAt = nowIso();
    return this.#attachAudioBridge(session, result.audioBridge);
  }

  async #refreshBrowserHealth(
    session: TeamsMeetingsSession,
    options: { readOnly?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    try {
      const result = await recoverCurrentTeamsMeetingTab({
        runtime: this.params.runtime,
        config: this.params.config,
        meetingSessionId: session.id,
        mode: session.mode,
        nodeId: session.chrome?.nodeId,
        readOnly: options.readOnly,
        trackedMeetingUrl: session.url,
        trackedTargetId: session.chrome?.browserTab?.targetId,
        transport: session.transport,
        timeoutMs: options.timeoutMs,
        url: session.url,
      });
      if (result.found && session.chrome) {
        if (result.tab?.targetId) {
          const currentTab = session.chrome.browserTab;
          session.chrome.browserTab = {
            targetId: result.tab.targetId,
            openedByPlugin:
              result.tab.targetId === currentTab?.targetId ? currentTab.openedByPlugin : false,
          };
        }
        if (result.browser) {
          session.chrome.health = { ...session.chrome.health, ...result.browser };
        }
        session.updatedAt = nowIso();
      }
    } catch (error) {
      this.params.logger.debug?.(
        `${TEAMS_MEETINGS_PLATFORM_ADAPTER.logScope} browser readiness refresh ignored: ${formatErrorMessage(error)}`,
      );
    }
  }

  async #captureTranscript(session: TeamsMeetingsSession, options: { finalize?: boolean } = {}) {
    // Recovery permits caption setup but atomically refuses a different live
    // session owner, so stale sessions read their archived page buffer instead.
    await this.#sessions.refreshCaptionHealth(session);
    const tab = session.chrome?.browserTab;
    if (!tab) {
      return undefined;
    }
    return await readTeamsMeetingTranscript({
      runtime: this.params.runtime,
      config: this.params.config,
      finalize: options.finalize,
      meetingUrl: session.url,
      meetingSessionId: session.id,
      nodeId: session.chrome?.nodeId,
      tab,
    });
  }

  async #releaseBrowserTab(session: TeamsMeetingsSession): Promise<boolean | undefined> {
    const tab = session.chrome?.browserTab;
    if (!tab) {
      noteSession(
        session,
        "No tracked Teams meeting tab; leave the browser meeting manually if it is still active.",
      );
      session.browserLeft = false;
      return false;
    }
    const shared = this.list().some(
      (other) =>
        other.id !== session.id &&
        other.state === "active" &&
        other.chrome?.browserTab?.targetId === tab.targetId &&
        other.chrome?.nodeId === session.chrome?.nodeId,
    );
    if (shared) {
      noteSession(session, "Kept the shared Teams meeting tab open for another active session.");
      return undefined;
    }
    try {
      const result = await leaveTeamsMeetingInBrowser({
        runtime: this.params.runtime,
        config: this.params.config,
        meetingSessionId: session.id,
        meetingUrl: session.url,
        nodeId: session.chrome?.nodeId,
        tab,
      });
      noteSession(session, result.note);
      if (result.left && session.chrome) {
        session.chrome.browserTab = undefined;
        if (session.chrome.health) {
          session.chrome.health = {
            ...session.chrome.health,
            captioning: false,
            audioInputRouted: false,
            audioOutputRouted: false,
            providerConnected: false,
            realtimeReady: false,
            audioInputActive: false,
            audioOutputActive: false,
          };
        }
      }
      session.browserLeft = result.left;
      return result.left;
    } catch (error) {
      noteSession(
        session,
        `Browser control could not leave the Teams meeting tab: ${formatErrorMessage(error)}`,
      );
      session.browserLeft = false;
      return false;
    }
  }
}
