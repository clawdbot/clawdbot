// Google Meet composes platform strategies with the shared meeting session runtime.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createMeetingSession,
  MeetingSessionRuntime,
  type MeetingSessionLeaveResult,
  type MeetingSessionRuntimeHandles,
  type MeetingSessionRuntimeJoinContext,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetModeInput,
  GoogleMeetTransport,
} from "./config.js";
import {
  testGoogleMeetListening,
  testGoogleMeetSpeech,
  type GoogleMeetRuntimeProbeContext,
} from "./runtime-probes.js";
import {
  isBrowserTransport,
  noteSession,
  resolveMode,
  resolveTransport,
  withSessionAgentConfig,
} from "./runtime-session.js";
import { getGoogleMeetRuntimeSetupStatus } from "./runtime-setup.js";
import {
  launchChromeMeet,
  launchChromeMeetOnNode,
  leaveChromeMeet,
  leaveChromeMeetOnNode,
  readChromeMeetTranscript,
  readChromeMeetTranscriptOnNode,
  recoverCurrentMeetTab,
  recoverCurrentMeetTabOnNode,
} from "./transports/chrome.js";
import {
  GOOGLE_MEET_PLATFORM_ADAPTER,
  isGoogleMeetTalkBackMode,
} from "./transports/google-meet-platform-adapter.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetJoinRequest,
  GoogleMeetJoinResult,
  GoogleMeetSession,
} from "./transports/types.js";
import {
  createVoiceCallGateway,
  endMeetVoiceCallGatewayCall,
  getMeetVoiceCallGatewayCall,
  isVoiceCallMissingError,
  joinMeetViaVoiceCallGateway,
  speakMeetViaVoiceCallGateway,
  type VoiceCallGateway,
} from "./voice-call-gateway.js";

type ChromeAudioBridgeResult = NonNullable<
  | Awaited<ReturnType<typeof launchChromeMeet>>["audioBridge"]
  | Awaited<ReturnType<typeof launchChromeMeetOnNode>>["audioBridge"]
>;
type ChromeLaunchResult =
  | Awaited<ReturnType<typeof launchChromeMeet>>
  | Awaited<ReturnType<typeof launchChromeMeetOnNode>>;
type GoogleMeetManualActionReason = NonNullable<GoogleMeetChromeHealth["manualActionReason"]>;
type GoogleMeetSpeechBlockedReason = NonNullable<GoogleMeetChromeHealth["speechBlockedReason"]>;
type GoogleMeetSessionRuntime = MeetingSessionRuntime<
  GoogleMeetSession,
  GoogleMeetJoinRequest,
  GoogleMeetTransport,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetBrowserTab,
  GoogleMeetManualActionReason,
  GoogleMeetSpeechBlockedReason
>;
type GoogleMeetJoinContext = MeetingSessionRuntimeJoinContext<
  GoogleMeetSession,
  GoogleMeetTransport,
  GoogleMeetMode,
  GoogleMeetChromeHealth,
  GoogleMeetBrowserTab
>;

const nowIso = () => new Date().toISOString();

export class GoogleMeetRuntime {
  readonly #createdBrowserTabs = new Map<string, string>();
  readonly #agentId: string;
  readonly #voiceCallGateway: VoiceCallGateway;
  readonly #sessions: GoogleMeetSessionRuntime;

  constructor(
    private readonly params: {
      config: GoogleMeetConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {
    const adapter = GOOGLE_MEET_PLATFORM_ADAPTER;
    this.#agentId = resolveDefaultAgentId(params.fullConfig);
    this.#voiceCallGateway = createVoiceCallGateway(params);
    this.#sessions = new MeetingSessionRuntime({
      logger: params.logger,
      logScope: "[google-meet]",
      formatError: formatErrorMessage,
      reuseExistingBrowserTab: params.config.chrome.reuseExistingTab,
      waitForInCallMs: params.config.chrome.waitForInCallMs,
      joinTimeoutMs: params.config.chrome.joinTimeoutMs,
      defaultSpeechInstructions: params.config.realtime.introMessage,
      transientSpeechBlockedReasons: new Set<GoogleMeetSpeechBlockedReason>([
        "not-in-call",
        "browser-unverified",
        "meet-microphone-muted",
      ]),
      messages: {
        previousBrowserLeaveFailed:
          "Could not leave the previous Meet browser tab before reassignment.",
        reassignedSessionNote: "Ended before the same Meet tab was reassigned to another agent.",
        reusedSessionNote: "Reused existing active Meet session.",
        replacementBrowserLeaveFailed:
          "Could not leave the previous Meet browser tab before reassignment.",
        speechBlockedFallback: "Realtime speech blocked until Google Meet is ready.",
        speech: {
          audioBridgeUnavailable: "Realtime speech requires an active Chrome audio bridge.",
          browserUnverified: "Google Meet browser state has not been verified yet.",
          manualActionFallback:
            "Resolve the Google Meet browser prompt before asking OpenClaw to speak.",
          microphoneMuted:
            "Turn on the OpenClaw Google Meet microphone before asking OpenClaw to speak.",
          microphoneMutedReason: "meet-microphone-muted",
          notInCall: "Google Meet has not reported that the browser participant is in the call.",
          notInCallReason: "not-in-call",
          browserUnverifiedReason: "browser-unverified",
          audioBridgeUnavailableReason: "audio-bridge-unavailable",
        },
      },
      resolveJoin: (request) => ({
        url: adapter.urls.validateAndNormalize(request.url),
        transport: resolveTransport(request.transport, params.config),
        mode: resolveMode(request.mode, params.config),
        agentId: normalizeAgentId(
          request.agentId ?? params.config.realtime.agentId ?? this.#agentId,
        ),
      }),
      createSession: ({ resolved, createdAt }): GoogleMeetSession =>
        createMeetingSession({ platform: adapter, config: params.config, resolved, createdAt }),
      resolveSpeechInstructions: (request) =>
        request.message ?? params.config.realtime.introMessage,
      isBrowserTransport,
      isTalkBackMode: isGoogleMeetTalkBackMode,
      isTranscribeMode: (mode) => mode === "transcribe",
      sameMeetingUrl: (left, right) => adapter.urls.isSameMeeting(left, right),
      normalizeMeetingUrlForReuse: (url) => adapter.urls.normalizeForReuse(url),
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
      refreshStatus: async (session) => await this.#refreshStatus(session),
      refreshReusableSession: async (session, _request, _resolved) => {
        if (session.transport === "twilio") {
          await this.#refreshTwilioVoiceCallStatus(session);
        }
      },
      ensureRealtimeBridge: async (session) => await this.#ensureChromeRealtimeBridge(session),
      captureTranscript: async (session, options) =>
        await this.#captureTranscript(session, options),
      speakViaTransport: async (session, instructions) =>
        await this.#speakViaTransport(session, instructions),
      durableTranscripts: {
        config: params.fullConfig.transcripts,
        providerId: "google-meet",
        providerName: "Google Meet",
      },
    });
  }

  list(): GoogleMeetSession[] {
    return this.#sessions.list();
  }

  async status(sessionId?: string) {
    return await this.#sessions.status(sessionId);
  }

  async transcript(sessionId: string, options: { sinceIndex?: number } = {}) {
    return await this.#sessions.transcript(sessionId, options);
  }

  transcriptSourceRuntime = () => this.#sessions;

  async setupStatus(
    options: {
      transport?: GoogleMeetTransport;
      mode?: GoogleMeetModeInput;
      dialInNumber?: string;
    } = {},
  ) {
    return await getGoogleMeetRuntimeSetupStatus({
      config: this.params.config,
      fullConfig: this.params.fullConfig,
      runtime: this.params.runtime,
      options,
    });
  }

  async createViaBrowser() {
    const result = await GOOGLE_MEET_PLATFORM_ADAPTER.create!.browser({
      runtime: this.params.runtime,
      config: this.params.config,
    });
    if (result.openedByPlugin && result.targetId) {
      this.#createdBrowserTabs.set(`${result.nodeId}:${result.targetId}`, result.meetingUri);
    }
    return result;
  }

  async recoverCurrentTab(request: { url?: string; transport?: GoogleMeetTransport } = {}) {
    const transport = resolveTransport(request.transport, this.params.config);
    if (transport === "twilio") {
      throw new Error("recover_current_tab only supports chrome or chrome-node transports");
    }
    const url = request.url
      ? GOOGLE_MEET_PLATFORM_ADAPTER.urls.validateAndNormalize(request.url)
      : undefined;
    return transport === "chrome-node"
      ? await recoverCurrentMeetTabOnNode({
          runtime: this.params.runtime,
          config: this.params.config,
          fullConfig: this.params.fullConfig,
          url,
        })
      : await recoverCurrentMeetTab({
          runtime: this.params.runtime,
          config: this.params.config,
          fullConfig: this.params.fullConfig,
          url,
        });
  }

  async join(request: GoogleMeetJoinRequest): Promise<GoogleMeetJoinResult> {
    return await this.#sessions.join(request);
  }

  async leave(
    sessionId: string,
    options?: { keepBrowserTab?: boolean },
  ): Promise<MeetingSessionLeaveResult<GoogleMeetSession>> {
    return await this.#sessions.leave(sessionId, options);
  }

  async speak(sessionId: string, instructions?: string) {
    return await this.#sessions.speak(sessionId, instructions);
  }

  async testSpeech(request: GoogleMeetJoinRequest) {
    return await testGoogleMeetSpeech(this.#probeContext(), request);
  }

  async testListen(request: GoogleMeetJoinRequest) {
    return await testGoogleMeetListening(this.#probeContext(), request);
  }

  #probeContext(): GoogleMeetRuntimeProbeContext {
    return {
      config: this.params.config,
      resolveAgentId: (request) =>
        normalizeAgentId(request.agentId ?? this.params.config.realtime.agentId ?? this.#agentId),
      list: () => this.list(),
      join: async (request) => await this.join(request),
      isReusable: (session, resolved) => this.#sessions.isReusableSession(session, resolved),
      hasHealthHandle: (sessionId) => this.#sessions.hasHealthHandle(sessionId),
      refreshHealth: (sessionId) => this.#sessions.refreshHealth(sessionId),
      refreshCaptionHealth: async (session) => await this.#sessions.refreshCaptionHealth(session),
    };
  }

  async #joinTransport(
    request: GoogleMeetJoinRequest,
    session: GoogleMeetSession,
    context: GoogleMeetJoinContext,
  ): Promise<{ delegatedSpoken?: boolean }> {
    if (isBrowserTransport(session.transport)) {
      const chromeConfig = withSessionAgentConfig(this.params.config, session.agentId);
      const result: ChromeLaunchResult =
        session.transport === "chrome-node"
          ? await launchChromeMeetOnNode({
              runtime: this.params.runtime,
              config: chromeConfig,
              fullConfig: this.params.fullConfig,
              meetingSessionId: session.id,
              requesterSessionKey: request.requesterSessionKey,
              mode: session.mode,
              url: session.url,
              logger: this.params.logger,
            })
          : await launchChromeMeet({
              runtime: this.params.runtime,
              config: chromeConfig,
              fullConfig: this.params.fullConfig,
              meetingSessionId: session.id,
              requesterSessionKey: request.requesterSessionKey,
              mode: session.mode,
              url: session.url,
              logger: this.params.logger,
            });
      const nodeId = "nodeId" in result ? result.nodeId : undefined;
      let tab = result.tab;
      const createdKey =
        session.transport === "chrome-node" && nodeId && tab
          ? `${nodeId}:${tab.targetId}`
          : undefined;
      const createdUrl = createdKey ? this.#createdBrowserTabs.get(createdKey) : undefined;
      if (createdKey) {
        this.#createdBrowserTabs.delete(createdKey);
      }
      if (tab && GOOGLE_MEET_PLATFORM_ADAPTER.urls.isSameMeeting(createdUrl, session.url)) {
        tab = { ...tab, openedByPlugin: true };
      }
      tab = context.inheritedBrowserTab({
        session,
        transport: session.transport,
        nodeId,
        meetingUrl: session.url,
        tab,
      });
      session.chrome = {
        audioBackend: this.params.config.chrome.audioBackend,
        launched: result.launched,
        nodeId,
        browserProfile: this.params.config.chrome.browserProfile,
        browserTab: tab,
        health: result.browser,
      };
      const handles = this.#attachChromeAudioBridge(session, result.audioBridge);
      if (handles) {
        context.attachRuntimeHandles(session, handles);
      }
      session.notes.push(
        result.audioBridge
          ? session.transport === "chrome-node"
            ? "Chrome node transport joins as the signed-in Google profile on the selected node and routes realtime audio through the node bridge."
            : "Chrome transport joins as the signed-in Google profile and routes realtime audio through the configured bridge."
          : isGoogleMeetTalkBackMode(session.mode)
            ? "Chrome transport joins as the signed-in Google profile and expects BlackHole 2ch audio routing."
            : "Chrome transport joins as the signed-in Google profile without starting the realtime audio bridge.",
      );
      this.#sessions.refreshSpeechReadiness(session);
      return {};
    }

    const dialPlan = GOOGLE_MEET_PLATFORM_ADAPTER.dialIn!.buildPlan({
      dialInNumber: request.dialInNumber,
      defaultDialInNumber: this.params.config.twilio.defaultDialInNumber,
      pin: request.pin,
      defaultPin: this.params.config.twilio.defaultPin,
      dtmfSequence: request.dtmfSequence,
      defaultDtmfSequence: this.params.config.twilio.defaultDtmfSequence,
      dtmfDelayMs: this.params.config.voiceCall.dtmfDelayMs,
    });
    const dialInNumber = dialPlan.number;
    if (!dialInNumber) {
      throw new Error(
        "Twilio transport requires a Meet dial-in phone number. Google Meet URLs do not include dial-in details; pass dialInNumber with optional pin/dtmfSequence, configure twilio.defaultDialInNumber, or use chrome/chrome-node transport.",
      );
    }
    const dtmfSequence = dialPlan.dtmfSequence;
    const hasExplicitAgent = Boolean(
      normalizeOptionalString(request.agentId) ||
      normalizeOptionalString(this.params.config.realtime.agentId),
    );
    const delegatedAgentId = hasExplicitAgent ? session.agentId : undefined;
    const voiceCallResult = this.params.config.voiceCall.enabled
      ? await joinMeetViaVoiceCallGateway({
          config: this.params.config,
          gateway: this.#voiceCallGateway,
          dialInNumber,
          dtmfSequence,
          logger: this.params.logger,
          ...(request.requesterSessionKey
            ? { requesterSessionKey: request.requesterSessionKey }
            : {}),
          agentId: delegatedAgentId,
          sessionKey: delegatedAgentId
            ? `agent:${delegatedAgentId}:google-meet:${session.id}`
            : `voice:google-meet:${session.id}`,
          message: isGoogleMeetTalkBackMode(session.mode)
            ? (request.message ??
              this.params.config.voiceCall.introMessage ??
              this.params.config.realtime.introMessage)
            : undefined,
        })
      : undefined;
    session.twilio = {
      dialInNumber,
      pinProvided: Boolean(dialPlan.pin),
      dtmfSequence,
      voiceCallId: voiceCallResult?.callId,
      dtmfSent: voiceCallResult?.dtmfSent,
      introSent: voiceCallResult?.introSent,
    };
    if (voiceCallResult?.callId) {
      context.attachRuntimeHandles(session, {
        stop: async () => {
          await endMeetVoiceCallGatewayCall({
            gateway: this.#voiceCallGateway,
            callId: voiceCallResult.callId,
          });
        },
      });
    }
    session.notes.push(
      this.params.config.voiceCall.enabled
        ? dtmfSequence
          ? "Twilio transport delegated the phone leg to the voice-call plugin, then queued configured DTMF before realtime connect."
          : "Twilio transport delegated the call to the voice-call plugin without configured DTMF."
        : "Twilio transport is an explicit dial plan; voice-call delegation is disabled.",
    );
    return { delegatedSpoken: Boolean(voiceCallResult?.introSent) };
  }

  #attachChromeAudioBridge(
    session: GoogleMeetSession,
    audioBridge: ChromeAudioBridgeResult | undefined,
  ): MeetingSessionRuntimeHandles<GoogleMeetChromeHealth> | undefined {
    if (!session.chrome || !audioBridge) {
      return undefined;
    }
    session.chrome.audioBridge = {
      type: audioBridge.type,
      provider:
        audioBridge.type === "command-pair" || audioBridge.type === "node-command-pair"
          ? audioBridge.providerId
          : undefined,
    };
    return audioBridge.type === "command-pair" || audioBridge.type === "node-command-pair"
      ? { stop: audioBridge.stop, speak: audioBridge.speak, getHealth: audioBridge.getHealth }
      : undefined;
  }

  async #ensureChromeRealtimeBridge(
    session: GoogleMeetSession,
  ): Promise<MeetingSessionRuntimeHandles<GoogleMeetChromeHealth> | undefined> {
    if (
      !isGoogleMeetTalkBackMode(session.mode) ||
      !isBrowserTransport(session.transport) ||
      session.state !== "active" ||
      !session.chrome ||
      session.chrome.audioBridge ||
      session.chrome.health?.inCall !== true ||
      session.chrome.health.micMuted !== false ||
      session.chrome.health.manualActionRequired === true
    ) {
      return undefined;
    }
    const config = withSessionAgentConfig(this.params.config, session.agentId);
    // This session already owns its browser tab. Bridge recovery must not
    // launch or navigate another tab, even when tab reuse is disabled.
    const recoveryConfig = {
      ...config,
      chrome: { ...config.chrome, launch: false },
      ...(session.chrome.nodeId
        ? { chromeNode: { ...config.chromeNode, node: session.chrome.nodeId } }
        : {}),
    };
    const result: ChromeLaunchResult =
      session.transport === "chrome-node"
        ? await launchChromeMeetOnNode({
            runtime: this.params.runtime,
            config: recoveryConfig,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            mode: session.mode,
            url: session.url,
            logger: this.params.logger,
          })
        : await launchChromeMeet({
            runtime: this.params.runtime,
            config: recoveryConfig,
            fullConfig: this.params.fullConfig,
            meetingSessionId: session.id,
            mode: session.mode,
            url: session.url,
            logger: this.params.logger,
          });
    session.updatedAt = nowIso();
    return this.#attachChromeAudioBridge(session, result.audioBridge);
  }

  async #refreshBrowserHealth(
    session: GoogleMeetSession,
    options: { force?: boolean; readOnly?: boolean } = {},
  ): Promise<void> {
    try {
      const result =
        session.transport === "chrome-node"
          ? await recoverCurrentMeetTabOnNode({
              runtime: this.params.runtime,
              config: this.params.config,
              fullConfig: this.params.fullConfig,
              mode: session.mode,
              readOnly: options.readOnly,
              trackedMeetingUrl: session.url,
              trackedTargetId: session.chrome?.browserTab?.targetId,
              url: session.url,
            })
          : await recoverCurrentMeetTab({
              runtime: this.params.runtime,
              config: this.params.config,
              fullConfig: this.params.fullConfig,
              mode: session.mode,
              readOnly: options.readOnly,
              trackedMeetingUrl: session.url,
              trackedTargetId: session.chrome?.browserTab?.targetId,
              url: session.url,
            });
      if (result.found && session.chrome) {
        if (result.targetId) {
          const currentTab = session.chrome.browserTab;
          session.chrome.browserTab = {
            targetId: result.targetId,
            openedByPlugin:
              result.targetId === currentTab?.targetId ? currentTab.openedByPlugin : false,
          };
        }
        if (result.browser) {
          session.chrome.health = { ...session.chrome.health, ...result.browser };
        }
        session.updatedAt = nowIso();
      }
    } catch (error) {
      this.params.logger.debug?.(
        `[google-meet] browser readiness refresh ignored: ${formatErrorMessage(error)}`,
      );
    }
  }

  async #refreshStatus(session: GoogleMeetSession): Promise<void> {
    if (isBrowserTransport(session.transport)) {
      await this.#sessions.refreshBrowserHealth(session, { force: true, readOnly: true });
    } else if (session.transport === "twilio") {
      await this.#refreshTwilioVoiceCallStatus(session);
    } else {
      this.#sessions.refreshSpeechReadiness(session);
    }
  }

  async #refreshTwilioVoiceCallStatus(session: GoogleMeetSession): Promise<void> {
    const callId = session.twilio?.voiceCallId;
    if (!callId || session.state !== "active") {
      this.#sessions.refreshSpeechReadiness(session);
      return;
    }
    try {
      const status = await getMeetVoiceCallGatewayCall({
        gateway: this.#voiceCallGateway,
        callId,
      });
      if (status.found === false) {
        this.#sessions.markSessionEnded(session, "Voice Call is no longer active.");
      }
    } catch (error) {
      this.params.logger.debug?.(
        `[google-meet] voice-call status refresh ignored: ${formatErrorMessage(error)}`,
      );
    }
    this.#sessions.refreshSpeechReadiness(session);
  }

  async #speakViaTransport(
    session: GoogleMeetSession,
    instructions?: string,
  ): Promise<{ handled: boolean; spoken: boolean } | undefined> {
    if (session.transport !== "twilio" || !session.twilio?.voiceCallId) {
      return undefined;
    }
    try {
      await speakMeetViaVoiceCallGateway({
        gateway: this.#voiceCallGateway,
        callId: session.twilio.voiceCallId,
        message:
          instructions ||
          this.params.config.voiceCall.introMessage ||
          this.params.config.realtime.introMessage ||
          "",
      });
    } catch (error) {
      if (!isVoiceCallMissingError(error)) {
        throw error;
      }
      this.#sessions.markSessionEnded(session, "Voice Call is no longer active.");
      return { handled: true, spoken: false };
    }
    session.twilio.introSent = true;
    session.updatedAt = nowIso();
    return { handled: true, spoken: true };
  }

  async #captureTranscript(session: GoogleMeetSession, options: { finalize?: boolean } = {}) {
    const tab = session.chrome?.browserTab;
    if (!tab) {
      return undefined;
    }
    return session.transport === "chrome-node"
      ? await readChromeMeetTranscriptOnNode({
          runtime: this.params.runtime,
          nodeId: session.chrome?.nodeId,
          config: this.params.config,
          ...(options.finalize === undefined ? {} : { finalize: options.finalize }),
          meetingUrl: session.url,
          meetingSessionId: session.id,
          tab,
        })
      : await readChromeMeetTranscript({
          runtime: this.params.runtime,
          config: this.params.config,
          ...(options.finalize === undefined ? {} : { finalize: options.finalize }),
          meetingUrl: session.url,
          meetingSessionId: session.id,
          tab,
        });
  }

  async #releaseBrowserTab(session: GoogleMeetSession): Promise<boolean | undefined> {
    if (!isBrowserTransport(session.transport)) {
      return undefined;
    }
    const tab = session.chrome?.browserTab;
    if (!tab) {
      noteSession(
        session,
        "No tracked Meet browser tab for this session; close the Meet tab manually if it is still in the call.",
      );
      session.browserLeft = false;
      return false;
    }
    const shared = this.list().some(
      (other) =>
        other.id !== session.id &&
        other.state === "active" &&
        isBrowserTransport(other.transport) &&
        other.chrome?.browserTab?.targetId === tab.targetId &&
        other.chrome?.nodeId === session.chrome?.nodeId,
    );
    if (shared) {
      noteSession(session, "Kept the shared Meet tab open because another active session uses it.");
      session.browserLeft = undefined;
      return undefined;
    }
    let left: boolean;
    try {
      const result =
        session.transport === "chrome-node"
          ? await leaveChromeMeetOnNode({
              runtime: this.params.runtime,
              nodeId: session.chrome?.nodeId,
              config: this.params.config,
              meetingSessionId: session.id,
              meetingUrl: session.url,
              tab,
            })
          : await leaveChromeMeet({
              runtime: this.params.runtime,
              config: this.params.config,
              meetingSessionId: session.id,
              meetingUrl: session.url,
              tab,
            });
      noteSession(session, result.note);
      left = result.left;
    } catch (error) {
      noteSession(
        session,
        `Browser control could not leave the Meet tab: ${formatErrorMessage(error)}`,
      );
      left = false;
    }
    if (session.chrome && left) {
      session.chrome.browserTab = undefined;
      if (session.chrome.health) {
        session.chrome.health = {
          ...session.chrome.health,
          captioning: false,
          audioOutputRouted: false,
          providerConnected: false,
          realtimeReady: false,
          audioInputActive: false,
          audioOutputActive: false,
        };
      }
    }
    session.browserLeft = left;
    return left;
  }
}
