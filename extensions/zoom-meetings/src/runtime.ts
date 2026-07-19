import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  MeetingSessionRuntime,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { ZoomMeetingsConfig, ZoomMeetingsMode, ZoomMeetingsTransport } from "./config.js";
import {
  testZoomMeetingListening,
  testZoomMeetingSpeech,
  type ZoomMeetingsProbeContext,
} from "./runtime-probes.js";
import { createZoomMeetingsSession } from "./runtime-session.js";
import { getZoomMeetingsSetupStatus } from "./runtime-setup.js";
import {
  launchZoomMeetingInChrome,
  launchZoomMeetingOnNode,
  leaveZoomMeetingInBrowser,
  readZoomMeetingTranscript,
  recoverCurrentZoomMeetingTab,
} from "./transports/chrome.js";
import type {
  ZoomMeetingsBrowserTab,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsJoinRequest,
  ZoomMeetingsJoinResult,
  ZoomMeetingsSession,
} from "./transports/types.js";
import {
  ZOOM_MEETINGS_PLATFORM_ADAPTER,
  isZoomMeetingsRealtimeRouteReady,
  isZoomMeetingsTalkBackMode,
} from "./transports/zoom-meetings-platform-adapter.js";
import { hasSameZoomMeetingJoinCredential } from "./transports/zoom-meetings-urls.js";

type ManualActionReason = NonNullable<ZoomMeetingsChromeHealth["manualActionReason"]>;
type SpeechBlockedReason = NonNullable<ZoomMeetingsChromeHealth["speechBlockedReason"]>;
type SessionRuntime = MeetingSessionRuntime<
  ZoomMeetingsSession,
  ZoomMeetingsJoinRequest,
  ZoomMeetingsTransport,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsBrowserTab,
  ManualActionReason,
  SpeechBlockedReason
>;
type JoinContext = MeetingSessionRuntimeJoinContext<
  ZoomMeetingsSession,
  ZoomMeetingsTransport,
  ZoomMeetingsMode,
  ZoomMeetingsChromeHealth,
  ZoomMeetingsBrowserTab
>;
type LaunchResult =
  | Awaited<ReturnType<typeof launchZoomMeetingInChrome>>
  | Awaited<ReturnType<typeof launchZoomMeetingOnNode>>;
type AudioBridge = NonNullable<LaunchResult["audioBridge"]>;

function nowIso(): string {
  return new Date().toISOString();
}

function resolveTransport(
  request: ZoomMeetingsJoinRequest,
  config: ZoomMeetingsConfig,
): ZoomMeetingsTransport {
  return request.transport ?? (config.chromeNode.node ? "chrome-node" : "chrome");
}

function withSessionAgentConfig(config: ZoomMeetingsConfig, agentId: string): ZoomMeetingsConfig {
  const consultAgentId = config.realtime.agentId ?? agentId;
  return config.realtime.agentId === consultAgentId
    ? config
    : { ...config, realtime: { ...config.realtime, agentId: consultAgentId } };
}

function noteSession(session: ZoomMeetingsSession, note: string): void {
  session.notes = [...session.notes.filter((item) => item !== note), note];
}

function isAwaitingAdmission(session: ZoomMeetingsSession): boolean {
  return (
    session.chrome?.health?.lobbyWaiting === true ||
    session.chrome?.health?.manualActionReason === "zoom-admission-required"
  );
}

export class ZoomMeetingsRuntime {
  readonly #sessions: SessionRuntime;
  readonly #requesterSessionKeys = new Map<string, string>();

  constructor(
    private readonly params: {
      config: ZoomMeetingsConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {
    this.#sessions = new MeetingSessionRuntime({
      logger: params.logger,
      logScope: ZOOM_MEETINGS_PLATFORM_ADAPTER.logScope,
      formatError: formatErrorMessage,
      reuseExistingBrowserTab: params.config.chrome.reuseExistingTab,
      waitForInCallMs: params.config.chrome.waitForInCallMs,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      defaultSpeechInstructions: params.config.realtime.introMessage,
      transientSpeechBlockedReasons: new Set<SpeechBlockedReason>([
        "not-in-call",
        "browser-unverified",
        "zoom-microphone-muted",
      ]),
      messages: {
        previousBrowserLeaveFailed:
          "Could not leave the previous Zoom meeting tab before reassignment.",
        reassignedSessionNote:
          "Ended before the same Zoom meeting tab was reassigned to another agent.",
        reusedSessionNote: "Reused existing active Zoom meeting session.",
        replacementBrowserLeaveFailed:
          "Could not leave the previous Zoom meeting tab before reassignment.",
        speechBlockedFallback: "Realtime speech blocked until Zoom is ready.",
        speech: {
          audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
          browserUnverified: "Zoom browser state has not been verified yet.",
          manualActionFallback: "Resolve the Zoom browser prompt before asking OpenClaw to speak.",
          microphoneMuted: "Turn on the OpenClaw Zoom microphone before asking OpenClaw to speak.",
          microphoneMutedReason: "zoom-microphone-muted",
          notInCall: "Zoom has not reported that the browser guest is in the call.",
          notInCallReason: "not-in-call",
          browserUnverifiedReason: "browser-unverified",
          audioBridgeUnavailableReason: "audio-bridge-unavailable",
        },
      },
      resolveJoin: (request) => ({
        url: ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(request.url),
        transport: resolveTransport(request, params.config),
        mode: request.mode ?? params.config.defaultMode,
        agentId: normalizeAgentId(request.agentId),
      }),
      createSession: ({ request, resolved, createdAt }) => {
        const session = createZoomMeetingsSession({ config: params.config, resolved, createdAt });
        if (request.requesterSessionKey) {
          this.#requesterSessionKeys.set(session.id, request.requesterSessionKey);
        }
        return session;
      },
      resolveSpeechInstructions: (request) =>
        request.message ?? params.config.realtime.introMessage,
      isBrowserTransport: () => true,
      isTalkBackMode: isZoomMeetingsTalkBackMode,
      isTranscribeMode: (mode) => mode === "transcribe",
      sameMeetingUrl: (left, right) =>
        ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.isSameMeeting(left, right),
      normalizeMeetingUrlForReuse: (url) =>
        ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.normalizeForReuse(url),
      getBrowser: (session) =>
        session.chrome
          ? {
              launched: session.chrome.launched,
              nodeId: session.chrome.nodeId,
              tab: session.chrome.browserTab,
              health: session.chrome.health,
              hasAudioBridge: Boolean(
                session.chrome.audioBridge && session.chrome.health?.bridgeClosed !== true,
              ),
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
      refreshStatus: async (session) => {
        await this.#sessions.refreshBrowserHealth(session, {
          force: true,
          readOnly: !isAwaitingAdmission(session),
        });
        const confirmedTabMissing = session.chrome?.health?.status === "browser-tab-missing";
        if (session.state === "active" && confirmedTabMissing) {
          session.browserLeft = true;
          await this.#sessions.leave(session.id, { keepBrowserTab: true });
          this.#requesterSessionKeys.delete(session.id);
        } else if (session.state === "active" && session.chrome?.health?.meetingEnded === true) {
          await this.leave(session.id);
        }
      },
      refreshReusableSession: async (session, request) => {
        await this.#sessions.refreshBrowserHealth(session, {
          force: true,
          readOnly: false,
        });
        const browser = session.chrome;
        const health = browser?.health;
        const staleSession =
          !browser?.browserTab ||
          health?.meetingEnded === true ||
          health?.manualActionReason === "zoom-session-conflict" ||
          health?.manualActionReason === "browser-control-unavailable" ||
          health?.bridgeClosed === true;
        const replacePendingJoin =
          health?.inCall !== true &&
          health?.manualActionReason === "zoom-passcode-required" &&
          !hasSameZoomMeetingJoinCredential(session.url, request.url);
        if (staleSession || replacePendingJoin) {
          session.state = "ended";
          session.updatedAt = nowIso();
          noteSession(
            session,
            replacePendingJoin
              ? "Ended pending Zoom session after receiving a corrected meeting credential."
              : "Ended stale Zoom session before opening a replacement.",
          );
          this.#requesterSessionKeys.delete(session.id);
          return {
            keepBrowserTab:
              !replacePendingJoin && health?.meetingEnded !== true && health?.bridgeClosed !== true,
          };
        }
        return undefined;
      },
      ensureRealtimeBridge: async (session) => await this.#ensureRealtimeBridge(session),
      captureTranscript: async (session, options) =>
        await this.#captureTranscript(session, options),
      speakViaTransport: async () => undefined,
    });
  }

  list(): ZoomMeetingsSession[] {
    return this.#sessions.list();
  }

  ownsSession(agentId: string, sessionId: string): boolean {
    return this.list().some((session) => session.id === sessionId && session.agentId === agentId);
  }

  async join(request: ZoomMeetingsJoinRequest): Promise<ZoomMeetingsJoinResult> {
    try {
      const url = ZOOM_MEETINGS_PLATFORM_ADAPTER.urls.validateAndNormalize(request.url);
      const agentId = normalizeAgentId(request.agentId);
      return await this.#sessions.join({ ...request, agentId, url });
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

  async setupStatus(options?: { mode?: ZoomMeetingsMode; transport?: ZoomMeetingsTransport }) {
    return await getZoomMeetingsSetupStatus({
      config: this.params.config,
      fullConfig: this.params.fullConfig,
      runtime: this.params.runtime,
      options,
    });
  }

  async testSpeech(request: ZoomMeetingsJoinRequest) {
    return await testZoomMeetingSpeech(this.#probeContext(), request);
  }

  async testListen(request: ZoomMeetingsJoinRequest) {
    return await testZoomMeetingListening(this.#probeContext(), request);
  }

  #probeContext(): ZoomMeetingsProbeContext {
    return {
      config: this.params.config,
      resolveAgentId: (request) => normalizeAgentId(request.agentId),
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
    request: ZoomMeetingsJoinRequest,
    session: ZoomMeetingsSession,
    context: JoinContext,
  ): Promise<{ delegatedSpoken?: boolean }> {
    const config = withSessionAgentConfig(this.params.config, session.agentId);
    const result: LaunchResult =
      session.transport === "chrome-node"
        ? await launchZoomMeetingOnNode({
            runtime: this.params.runtime,
            config,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            requesterSessionKey: request.requesterSessionKey,
            mode: session.mode,
            url: session.url,
            logger: this.params.logger,
          })
        : await launchZoomMeetingInChrome({
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
    if (result.browser?.meetingEnded === true) {
      throw new Error("The Zoom meeting has already ended.");
    }
    const handles = this.#attachAudioBridge(session, result.audioBridge);
    if (handles) {
      context.attachRuntimeHandles(session, handles);
    }
    session.notes.push(
      result.audioBridge
        ? session.transport === "chrome-node"
          ? "Zoom guest joined in Chrome on the selected node with realtime audio through the node bridge."
          : "Zoom guest joined in local Chrome with realtime audio through BlackHole 2ch and SoX."
        : session.mode === "transcribe"
          ? "Zoom guest joined observe-only with live-caption transcript capture."
          : "Zoom guest join is waiting for the browser to become ready before starting realtime audio.",
    );
    this.#sessions.refreshSpeechReadiness(session);
    return {};
  }

  #attachAudioBridge(
    session: ZoomMeetingsSession,
    audioBridge: AudioBridge | undefined,
  ): MeetingSessionRuntimeHandles<ZoomMeetingsChromeHealth> | undefined {
    if (!session.chrome || !audioBridge) {
      return undefined;
    }
    session.chrome.audioBridge = {
      type: audioBridge.type,
      provider: audioBridge.providerId,
    };
    session.chrome.health = { ...session.chrome.health, bridgeClosed: false };
    return {
      stop: audioBridge.stop,
      speak: audioBridge.speak,
      getHealth: audioBridge.getHealth,
    };
  }

  async #ensureRealtimeBridge(
    session: ZoomMeetingsSession,
  ): Promise<MeetingSessionRuntimeHandles<ZoomMeetingsChromeHealth> | undefined> {
    const bridgeClosed = session.chrome?.health?.bridgeClosed === true;
    if (
      !isZoomMeetingsTalkBackMode(session.mode) ||
      session.state !== "active" ||
      !session.chrome ||
      (session.chrome.audioBridge && !bridgeClosed) ||
      !isZoomMeetingsRealtimeRouteReady(session.mode, session.chrome.health)
    ) {
      return undefined;
    }
    if (bridgeClosed) {
      session.chrome.audioBridge = undefined;
    }
    const config = withSessionAgentConfig(this.params.config, session.agentId);
    const recoveryConfig = {
      ...config,
      chrome: { ...config.chrome, launch: false },
      chromeNode: { node: session.chrome.nodeId ?? config.chromeNode.node },
    };
    const result =
      session.transport === "chrome-node"
        ? await launchZoomMeetingOnNode({
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
        : await launchZoomMeetingInChrome({
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
    session: ZoomMeetingsSession,
    options: { readOnly?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    try {
      const result = await recoverCurrentZoomMeetingTab({
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
      } else if (session.chrome) {
        session.chrome.browserTab = undefined;
        session.browserLeft = true;
        session.chrome.health = {
          ...session.chrome.health,
          inCall: false,
          micMuted: undefined,
          captioning: false,
          audioInputRouted: false,
          audioOutputRouted: false,
          manualActionRequired: true,
          manualActionReason: "browser-control-unavailable",
          manualActionMessage: result.message,
          status: "browser-tab-missing",
          notes: [
            ...(session.chrome.health?.notes ?? []).filter((note) => note !== result.message),
            result.message,
          ],
        };
        session.updatedAt = nowIso();
      }
    } catch (error) {
      const message = `Zoom browser readiness refresh failed: ${formatErrorMessage(error)}`;
      this.params.logger.debug?.(`${ZOOM_MEETINGS_PLATFORM_ADAPTER.logScope} ${message}`);
      if (session.chrome) {
        session.chrome.health = {
          ...session.chrome.health,
          inCall: false,
          micMuted: undefined,
          captioning: false,
          audioInputRouted: false,
          audioOutputRouted: false,
          manualActionRequired: true,
          manualActionReason: "browser-control-unavailable",
          manualActionMessage: message,
          status: "browser-control",
          notes: [
            ...(session.chrome.health?.notes ?? []).filter((note) => note !== message),
            message,
          ],
        };
        session.updatedAt = nowIso();
      }
    }
  }

  async #captureTranscript(session: ZoomMeetingsSession, options: { finalize?: boolean } = {}) {
    // Recovery permits caption setup but atomically refuses a different live
    // session owner, so stale sessions read their archived page buffer instead.
    await this.#sessions.refreshCaptionHealth(session);
    const tab = session.chrome?.browserTab;
    if (!tab) {
      return undefined;
    }
    return await readZoomMeetingTranscript({
      runtime: this.params.runtime,
      config: this.params.config,
      finalize: options.finalize,
      meetingUrl: session.url,
      meetingSessionId: session.id,
      nodeId: session.chrome?.nodeId,
      tab,
    });
  }

  async #releaseBrowserTab(session: ZoomMeetingsSession): Promise<boolean | undefined> {
    const tab = session.chrome?.browserTab;
    if (!tab) {
      noteSession(
        session,
        "No tracked Zoom meeting tab; leave the browser meeting manually if it is still active.",
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
      noteSession(session, "Kept the shared Zoom meeting tab open for another active session.");
      return undefined;
    }
    try {
      const result = await leaveZoomMeetingInBrowser({
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
          // MeetingSessionRuntime owns the canonical in-call/manual reset after this
          // release reports success; this plugin clears only Zoom-specific health.
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
        `Browser control could not leave the Zoom meeting tab: ${formatErrorMessage(error)}`,
      );
      session.browserLeft = false;
      return false;
    }
  }
}
