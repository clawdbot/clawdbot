import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  TranscriptStartRequest,
  TranscriptStopRequest,
} from "../transcripts/provider-types.js";
import { isMeetingRealtimeRouteReady } from "./meeting-modes.js";
import type { MeetingPluginConfig } from "./plugin-config.js";
import type {
  MeetingRuntimeAudioBridge,
  MeetingRuntimeFacadeConstructor,
  MeetingRuntimeFacadeOptions,
  MeetingRuntimeHookContext,
  MeetingRuntimeOwner,
  MeetingRuntimeParams,
  MeetingRuntimeProbeResults,
  MeetingRuntimeRequest,
  MeetingRuntimeSession,
  MeetingRuntimeSpeechBlockedReason,
} from "./runtime-facade-types.js";
import type { MeetingProbeContext } from "./runtime-probes.js";
import { createMeetingSession } from "./session-factory.js";
import {
  MeetingSessionRuntime,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
} from "./session-runtime.js";
import type { MeetingBrowserTab, MeetingPluginChromeHealth } from "./session-types.js";

const nowIso = () => new Date().toISOString();

export function createMeetingRuntimeFacade<
  Config extends MeetingPluginConfig & { defaultMode: Mode },
  Transport extends "chrome" | "chrome-node",
  Mode extends string,
  Health extends MeetingPluginChromeHealth<string, string>,
  Results extends MeetingRuntimeProbeResults,
>(
  options: MeetingRuntimeFacadeOptions<Config, Transport, Mode, Health, Results>,
): MeetingRuntimeFacadeConstructor<Config, Transport, Mode, Health, Results> {
  type Session = MeetingRuntimeSession<Transport, Mode, Health>;
  type Request = MeetingRuntimeRequest<Transport, Mode>;
  type SessionRuntime = MeetingRuntimeOwner<Transport, Mode, Health>;
  type JoinContext = MeetingSessionRuntimeJoinContext<
    Session,
    Transport,
    Mode,
    Health,
    MeetingBrowserTab
  >;

  return class MeetingRuntimeFacade {
    readonly #defaultAgentId: string;
    readonly #sessions: SessionRuntime;
    readonly #requesterSessionKeys = new Map<string, string>();

    constructor(private readonly params: MeetingRuntimeParams<Config>) {
      this.#defaultAgentId = normalizeAgentId(
        params.config.realtime.agentId ?? resolveDefaultAgentId(params.fullConfig),
      );
      this.#sessions = new MeetingSessionRuntime({
        logger: params.logger,
        logScope: options.platform.logScope,
        formatError: formatErrorMessage,
        reuseExistingBrowserTab: params.config.chrome.reuseExistingTab,
        waitForInCallMs: params.config.chrome.waitForInCallMs,
        joinTimeoutMs: params.config.chrome.joinTimeoutMs,
        defaultSpeechInstructions: params.config.realtime.introMessage,
        transientSpeechBlockedReasons: new Set<MeetingRuntimeSpeechBlockedReason<Health>>([
          "not-in-call",
          "browser-unverified",
          options.messages.sessionRuntime.speech.microphoneMutedReason,
        ] as MeetingRuntimeSpeechBlockedReason<Health>[]),
        messages: options.messages.sessionRuntime,
        resolveJoin: (request) => this.#resolveJoin(request),
        createSession: ({ request, resolved, createdAt }) => {
          const session = createMeetingSession({
            platform: options.platform,
            config: params.config,
            resolved,
            createdAt,
          }) as Session;
          if (request.requesterSessionKey) {
            this.#requesterSessionKeys.set(session.id, request.requesterSessionKey);
          }
          return session;
        },
        resolveSpeechInstructions: (request) =>
          request.message ?? params.config.realtime.introMessage,
        isBrowserTransport: () => true,
        isTalkBackMode: (mode) => mode === "agent" || mode === "bidi",
        isTranscribeMode: (mode) => mode === "transcribe",
        sameMeetingUrl: (left, right) => options.platform.urls.isSameMeeting(left, right),
        normalizeMeetingUrlForReuse: (url) => options.platform.urls.normalizeForReuse(url),
        getBrowser: (session) =>
          session.chrome
            ? {
                launched: session.chrome.launched,
                nodeId: session.chrome.nodeId,
                tab: session.chrome.browserTab,
                health: session.chrome.health,
                hasAudioBridge:
                  options.hooks?.isAudioBridgeActive?.(session) ??
                  Boolean(session.chrome.audioBridge),
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
        refreshBrowserHealth: async (session, refreshOptions) =>
          await this.#refreshBrowserHealth(session, refreshOptions),
        refreshStatus: async (session) => await this.#refreshStatus(session),
        refreshReusableSession: async (session, request) =>
          await options.hooks?.refreshReusableSession?.(session, request, this.#hookContext()),
        ensureRealtimeBridge: async (session) => await this.#ensureRealtimeBridge(session),
        captureTranscript: async (session, captureOptions) =>
          await this.#captureTranscript(session, captureOptions),
        speakViaTransport: async () => undefined,
        durableTranscripts: {
          config: params.fullConfig.transcripts,
          ...options.messages.durableTranscripts,
        },
      });
    }

    list(): Session[] {
      return this.#sessions.list();
    }

    async startTranscriptSource(request: TranscriptStartRequest) {
      return await this.#sessions.startTranscriptSource(request);
    }

    async stopTranscriptSource(request: TranscriptStopRequest) {
      return await this.#sessions.stopTranscriptSource(request);
    }

    ownsSession(agentId: string, sessionId: string): boolean {
      return this.list().some((session) => session.id === sessionId && session.agentId === agentId);
    }

    async join(request: Request) {
      try {
        return await this.#sessions.join(
          options.hooks?.normalizeJoinRequest?.(request, this.#hookContext()) ?? request,
        );
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

    async transcript(sessionId: string, transcriptOptions: { sinceIndex?: number } = {}) {
      return await this.#sessions.transcript(sessionId, transcriptOptions);
    }

    async speak(sessionId: string, instructions?: string) {
      return await this.#sessions.speak(sessionId, instructions);
    }

    async setupStatus(setupOptions?: { mode?: Mode; transport?: Transport }) {
      return await options.probes.setupStatus({ ...this.params, options: setupOptions });
    }

    async testSpeech(request: Request) {
      return await options.probes.testSpeech(this.#probeContext(), request);
    }

    async testListen(request: Request) {
      return await options.probes.testListening(this.#probeContext(), request);
    }

    #resolveJoin(request: Request) {
      return {
        url: options.platform.urls.validateAndNormalize(request.url),
        transport:
          request.transport ??
          ((this.params.config.chromeNode.node ? "chrome-node" : "chrome") as Transport),
        mode: request.mode ?? (this.params.config.defaultMode as Mode),
        agentId: normalizeAgentId(request.agentId ?? this.#defaultAgentId),
      };
    }

    #hookContext(): MeetingRuntimeHookContext<Session, Request, Transport, Mode, Health> {
      return {
        deleteRequesterSessionKey: (sessionId) => this.#requesterSessionKeys.delete(sessionId),
        endSession: async (sessionId, leaveOptions) => {
          await this.#sessions.leave(sessionId, leaveOptions);
          this.#requesterSessionKeys.delete(sessionId);
        },
        noteSession: (session, note) => this.#noteSession(session, note),
        refreshBrowserHealth: async (session, refreshOptions) =>
          await this.#sessions.refreshBrowserHealth(session, refreshOptions),
        resolvedJoin: (request) => this.#resolveJoin(request),
      };
    }

    #probeContext(): MeetingProbeContext<Config, Mode, Transport, Health, Session, Request> {
      return {
        config: this.params.config,
        resolveAgentId: (request) => normalizeAgentId(request.agentId ?? this.#defaultAgentId),
        list: () => this.list(),
        join: async (request) => await this.join(request),
        isReusable: (session, resolved) => this.#sessions.isReusableSession(session, resolved),
        hasHealthHandle: (sessionId) => this.#sessions.hasHealthHandle(sessionId),
        refreshHealth: (sessionId) => this.#sessions.refreshHealth(sessionId),
        refreshCaptionHealth: async (session, timeoutMs) =>
          await this.#refreshBrowserHealth(session, { timeoutMs }),
      };
    }

    async #joinTransport(request: Request, session: Session, context: JoinContext) {
      const config = this.#withSessionAgentConfig(session.agentId);
      const launchParams = {
        runtime: this.params.runtime,
        config,
        fullConfig: this.params.fullConfig,
        meetingSessionId: session.id,
        requesterSessionKey: request.requesterSessionKey,
        mode: session.mode,
        url: session.url,
        logger: this.params.logger,
      };
      const result =
        session.transport === "chrome-node"
          ? await options.transport.launchOnNode(launchParams)
          : await options.transport.launchInChrome(launchParams);
      const nodeId = result.nodeId;
      const tab = context.inheritedBrowserTab({
        session,
        transport: session.transport,
        nodeId,
        meetingUrl: session.url,
        tab: result.tab,
      });
      session.chrome = {
        audioBackend: result.audioBackend,
        launched: result.launched,
        nodeId,
        browserProfile: this.params.config.chrome.browserProfile,
        browserTab: tab,
        health: result.browser,
      };
      options.hooks?.validateLaunchResult?.(result);
      const handles = this.#attachAudioBridge(session, result.audioBridge);
      if (handles) {
        context.attachRuntimeHandles(session, handles);
      }
      session.notes.push(
        result.audioBridge
          ? session.transport === "chrome-node"
            ? options.messages.joined.node
            : options.messages.joined.local
          : session.mode === "transcribe"
            ? options.messages.joined.transcribe
            : options.messages.joined.waiting,
      );
      this.#sessions.refreshSpeechReadiness(session);
      return {};
    }

    #attachAudioBridge(
      session: Session,
      audioBridge: MeetingRuntimeAudioBridge<Health> | undefined,
    ): MeetingSessionRuntimeHandles<Health> | undefined {
      if (!session.chrome || !audioBridge) {
        return undefined;
      }
      session.chrome.audioBridge = {
        type: audioBridge.type,
        provider: audioBridge.providerId,
      };
      options.hooks?.afterAudioBridgeAttached?.(session);
      return {
        stop: audioBridge.stop,
        speak: audioBridge.speak,
        getHealth: audioBridge.getHealth,
      };
    }

    async #ensureRealtimeBridge(
      session: Session,
    ): Promise<MeetingSessionRuntimeHandles<Health> | undefined> {
      const audioBridgeActive =
        options.hooks?.isAudioBridgeActive?.(session) ?? Boolean(session.chrome?.audioBridge);
      if (
        (session.mode !== "agent" && session.mode !== "bidi") ||
        session.state !== "active" ||
        !session.chrome ||
        audioBridgeActive ||
        !isMeetingRealtimeRouteReady(session.mode, session.chrome.health)
      ) {
        return undefined;
      }
      if (session.chrome.audioBridge) {
        session.chrome.audioBridge = undefined;
      }
      const config = this.#withSessionAgentConfig(session.agentId);
      const recoveryConfig = {
        ...config,
        chrome: { ...config.chrome, launch: false },
        chromeNode: { node: session.chrome.nodeId ?? config.chromeNode.node },
      };
      const launchParams = {
        runtime: this.params.runtime,
        config: recoveryConfig,
        fullConfig: this.params.fullConfig,
        meetingSessionId: session.id,
        requesterSessionKey: this.#requesterSessionKeys.get(session.id),
        mode: session.mode,
        trackedTargetId: session.chrome.browserTab?.targetId,
        url: session.url,
        logger: this.params.logger,
      };
      const result =
        session.transport === "chrome-node"
          ? await options.transport.launchOnNode(launchParams)
          : await options.transport.launchInChrome(launchParams);
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

    async #refreshStatus(session: Session): Promise<void> {
      await this.#sessions.refreshBrowserHealth(session, {
        force: true,
        readOnly: !(options.hooks?.isAwaitingAdmission?.(session) ?? false),
      });
      await options.hooks?.afterStatusRefresh?.(session, this.#hookContext());
    }

    async #refreshBrowserHealth(
      session: Session,
      refreshOptions: { readOnly?: boolean; timeoutMs?: number } = {},
    ): Promise<void> {
      try {
        const result = await options.transport.recoverCurrentTab({
          runtime: this.params.runtime,
          config: this.params.config,
          fullConfig: this.params.fullConfig,
          meetingSessionId: session.id,
          mode: session.mode,
          nodeId: session.chrome?.nodeId,
          readOnly: refreshOptions.readOnly,
          trackedMeetingUrl: session.url,
          trackedTargetId: session.chrome?.browserTab?.targetId,
          transport: session.transport,
          timeoutMs: refreshOptions.timeoutMs,
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
          options.hooks?.recordBrowserRecoveryFailure?.(session, {
            kind: "missing",
            message: result.message,
          });
        }
      } catch (error) {
        const formattedError = formatErrorMessage(error);
        const message = options.messages.browserReadinessFailed?.(formattedError) ?? formattedError;
        if (options.hooks?.recordBrowserRecoveryFailure) {
          this.params.logger.debug?.(`${options.platform.logScope} ${message}`);
          options.hooks.recordBrowserRecoveryFailure(session, { kind: "error", message });
        } else {
          this.params.logger.debug?.(
            `${options.platform.logScope} browser readiness refresh ignored: ${formatErrorMessage(error)}`,
          );
        }
      }
    }

    async #captureTranscript(session: Session, captureOptions: { finalize?: boolean } = {}) {
      // Recovery permits caption setup but atomically refuses a different live
      // session owner, so stale sessions read their archived page buffer instead.
      await this.#sessions.refreshCaptionHealth(session);
      const tab = session.chrome?.browserTab;
      if (!tab) {
        return undefined;
      }
      return await options.transport.readTranscript({
        runtime: this.params.runtime,
        config: this.params.config,
        finalize: captureOptions.finalize,
        meetingUrl: session.url,
        meetingSessionId: session.id,
        nodeId: session.chrome?.nodeId,
        tab,
      });
    }

    async #releaseBrowserTab(session: Session): Promise<boolean | undefined> {
      const tab = session.chrome?.browserTab;
      if (!tab) {
        this.#noteSession(session, options.messages.noTrackedTab);
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
        this.#noteSession(session, options.messages.sharedTab);
        return undefined;
      }
      try {
        const result = await options.transport.leaveInBrowser({
          runtime: this.params.runtime,
          config: this.params.config,
          meetingSessionId: session.id,
          meetingUrl: session.url,
          nodeId: session.chrome?.nodeId,
          tab,
        });
        this.#noteSession(session, result.note);
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
        this.#noteSession(session, options.messages.leaveFailed(formatErrorMessage(error)));
        session.browserLeft = false;
        return false;
      }
    }

    #withSessionAgentConfig(agentId: string): Config {
      return this.params.config.realtime.agentId === agentId
        ? this.params.config
        : {
            ...this.params.config,
            realtime: { ...this.params.config.realtime, agentId },
          };
    }

    #noteSession(session: Session, note: string): void {
      session.notes = [...session.notes.filter((item) => item !== note), note];
    }
  };
}
