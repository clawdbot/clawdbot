// Google Meet plugin module implements runtime behavior.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GoogleMeetConfig,
  GoogleMeetMode,
  GoogleMeetModeInput,
  GoogleMeetTransport,
} from "./config.js";
import { normalizeMeetUrl } from "./meet-url.js";
import { addGoogleMeetSetupCheck, getGoogleMeetSetupStatus } from "./setup.js";
import {
  isSameMeetUrlForReuse,
  normalizeMeetUrlForReuse,
  resolveChromeNodeInfo,
} from "./transports/chrome-browser-proxy.js";
import { createMeetWithBrowserProxyOnNode } from "./transports/chrome-create.js";
import {
  assertBlackHole2chAvailable,
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
  buildMeetDtmfSequence,
  normalizeDialInNumber,
  prefixDtmfWait,
} from "./transports/twilio.js";
import { GOOGLE_MEET_TRANSCRIPT_MAX_LINES } from "./transports/types.js";
import type {
  GoogleMeetBrowserTab,
  GoogleMeetChromeHealth,
  GoogleMeetJoinRequest,
  GoogleMeetJoinResult,
  GoogleMeetSession,
  GoogleMeetTranscriptLine,
  GoogleMeetTranscriptSnapshot,
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

type GoogleMeetLeaveResult = {
  found: boolean;
  session?: GoogleMeetSession;
  browserLeft?: boolean;
};

type RetainedBrowserTab = {
  session: GoogleMeetSession;
  tab: GoogleMeetBrowserTab;
};

type RetainedTranscriptSnapshot = GoogleMeetTranscriptSnapshot & {
  pageEpoch?: string;
  pageNextIndex: number;
};

const GOOGLE_MEET_ENDED_TRANSCRIPTS_MAX = 4;

function nowIso(): string {
  return new Date().toISOString();
}

function buildTwilioVoiceCallSessionKey(meetingSessionId: string): string {
  return `voice:google-meet:${meetingSessionId}`;
}

function resolveTransport(input: GoogleMeetTransport | undefined, config: GoogleMeetConfig) {
  return input ?? config.defaultTransport;
}

function resolveMode(input: GoogleMeetModeInput | undefined, config: GoogleMeetConfig) {
  return input === "realtime" ? "agent" : (input ?? config.defaultMode);
}

function resolveSessionAgentId(request: GoogleMeetJoinRequest, config: GoogleMeetConfig): string {
  return normalizeAgentId(request.agentId ?? config.realtime.agentId);
}

function withSessionAgentConfig(config: GoogleMeetConfig, agentId: string): GoogleMeetConfig {
  return config.realtime.agentId === agentId
    ? config
    : {
        ...config,
        realtime: { ...config.realtime, agentId },
      };
}

function isGoogleMeetTalkBackMode(mode: GoogleMeetMode): boolean {
  return mode === "agent" || mode === "bidi";
}

function isBrowserTransport(transport: GoogleMeetTransport): boolean {
  return transport === "chrome" || transport === "chrome-node";
}

function isReusableMeetSession(
  session: GoogleMeetSession,
  params: {
    url: string;
    transport: GoogleMeetTransport;
    mode: GoogleMeetMode;
    agentId: string;
  },
): boolean {
  return (
    session.state === "active" &&
    isSameMeetUrlForReuse(session.url, params.url) &&
    session.transport === params.transport &&
    session.mode === params.mode &&
    session.agentId === params.agentId
  );
}

function hasRealtimeAudioOutputAdvanced(
  health: GoogleMeetChromeHealth | undefined,
  startOutputBytes: number,
): boolean {
  return (health?.lastOutputBytes ?? 0) > startOutputBytes;
}

type TranscriptCheckpoint = {
  lines: number;
  lastCaptionAt?: string;
  lastCaptionText?: string;
};

function transcriptCheckpoint(health: GoogleMeetChromeHealth | undefined): TranscriptCheckpoint {
  return {
    lines: health?.transcriptLines ?? 0,
    lastCaptionAt: health?.lastCaptionAt,
    lastCaptionText: health?.lastCaptionText,
  };
}

function hasTranscriptAdvanced(
  health: GoogleMeetChromeHealth | undefined,
  start: TranscriptCheckpoint,
): boolean {
  if ((health?.transcriptLines ?? 0) > start.lines) {
    return true;
  }
  if (health?.lastCaptionAt && health.lastCaptionAt !== start.lastCaptionAt) {
    return true;
  }
  return Boolean(health?.lastCaptionText && health.lastCaptionText !== start.lastCaptionText);
}

function resolveProbeTimeoutMs(input: number | undefined, fallback: number): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), 120_000);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), 120_000);
}

function isManagedChromeBrowserSession(session: GoogleMeetSession): boolean {
  return Boolean(
    (session.transport === "chrome" || session.transport === "chrome-node") &&
    session.chrome &&
    session.chrome.launched,
  );
}

function noteSession(session: GoogleMeetSession, note: string): void {
  session.notes = [...session.notes.filter((item) => item !== note), note];
}

function evaluateSpeechReadiness(session: GoogleMeetSession): {
  ready: boolean;
  reason?: NonNullable<GoogleMeetChromeHealth["speechBlockedReason"]>;
  message?: string;
} {
  if (!isGoogleMeetTalkBackMode(session.mode) || !session.chrome) {
    return { ready: true };
  }
  if (!isManagedChromeBrowserSession(session)) {
    if (session.chrome.audioBridge) {
      return { ready: true };
    }
    return {
      ready: false,
      reason: "audio-bridge-unavailable",
      message: "Realtime speech requires an active Chrome audio bridge.",
    };
  }
  const health = session.chrome.health;
  if (health?.manualActionRequired) {
    return {
      ready: false,
      reason: health.manualActionReason ?? "browser-unverified",
      message:
        health.manualActionMessage ??
        "Resolve the Google Meet browser prompt before asking OpenClaw to speak.",
    };
  }
  if (health?.inCall === true) {
    if (health.micMuted === true) {
      return {
        ready: false,
        reason: "meet-microphone-muted",
        message: "Turn on the OpenClaw Google Meet microphone before asking OpenClaw to speak.",
      };
    }
    if (session.chrome.audioBridge) {
      return { ready: true };
    }
    return {
      ready: false,
      reason: "audio-bridge-unavailable",
      message: "Realtime speech requires an active Chrome audio bridge.",
    };
  }
  if (health?.inCall === false) {
    return {
      ready: false,
      reason: "not-in-call",
      message: "Google Meet has not reported that the browser participant is in the call.",
    };
  }
  return {
    ready: false,
    reason: "browser-unverified",
    message: "Google Meet browser state has not been verified yet.",
  };
}

function collectChromeAudioCommands(config: GoogleMeetConfig): string[] {
  const commands = config.chrome.audioBridgeCommand
    ? [config.chrome.audioBridgeCommand[0]]
    : [
        config.chrome.audioInputCommand?.[0],
        config.chrome.audioOutputCommand?.[0],
        config.chrome.bargeInInputCommand?.[0],
      ];
  return uniqueStrings(commands.filter((value): value is string => Boolean(value?.trim())));
}

async function commandExists(runtime: PluginRuntime, command: string): Promise<boolean> {
  const result = await runtime.system.runCommandWithTimeout(
    ["/bin/sh", "-lc", 'command -v "$1" >/dev/null 2>&1', "sh", command],
    { timeoutMs: 5_000 },
  );
  return result.code === 0;
}

export class GoogleMeetRuntime {
  readonly #sessions = new Map<string, GoogleMeetSession>();
  readonly #sessionLeaves = new Map<string, Promise<GoogleMeetLeaveResult>>();
  readonly #browserMeetingLocks = new Map<string, Promise<void>>();
  readonly #createdBrowserTabs = new Map<string, string>();
  readonly #sessionStops = new Map<string, () => Promise<void>>();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();
  readonly #sessionHealth = new Map<string, () => GoogleMeetChromeHealth>();
  readonly #transcripts = new Map<string, RetainedTranscriptSnapshot>();
  readonly #transcriptCaptures = new Map<string, Promise<void>>();
  readonly #transcriptFinalizing = new Set<string>();
  readonly #retiredTranscripts = new Set<string>();
  readonly #voiceCallGateway: VoiceCallGateway;

  constructor(
    private readonly params: {
      config: GoogleMeetConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {
    this.#voiceCallGateway = createVoiceCallGateway(params);
  }

  list(): GoogleMeetSession[] {
    this.#refreshHealth();
    return [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async status(sessionId?: string): Promise<{
    found: boolean;
    session?: GoogleMeetSession;
    sessions?: GoogleMeetSession[];
  }> {
    this.#refreshHealth(sessionId);
    if (!sessionId) {
      const sessions = [...this.#sessions.values()].toSorted((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      await Promise.all(sessions.map((session) => this.#refreshStatusHealthForSession(session)));
      return { found: true, sessions };
    }
    const session = this.#sessions.get(sessionId);
    if (session) {
      await this.#refreshStatusHealthForSession(session);
    }
    return session ? { found: true, session } : { found: false };
  }

  async transcript(
    sessionId: string,
    options: { sinceIndex?: number } = {},
  ): Promise<{
    found: boolean;
    sessionId?: string;
    startIndex?: number;
    nextIndex?: number;
    droppedLines?: number;
    evicted?: boolean;
    lines?: GoogleMeetTranscriptLine[];
  }> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    if (session.mode !== "transcribe") {
      throw new Error("transcript is only available for transcribe-mode sessions");
    }
    const sinceIndex = options.sinceIndex ?? 0;
    if (!Number.isSafeInteger(sinceIndex) || sinceIndex < 0) {
      throw new Error("sinceIndex must be a non-negative safe integer");
    }
    if (session.state === "active" && !this.#transcriptFinalizing.has(session.id)) {
      await this.#captureTranscriptSnapshot(session);
    }
    const snapshot = this.#transcripts.get(sessionId) ?? { droppedLines: 0, lines: [] };
    const startIndex = Math.max(sinceIndex, snapshot.droppedLines);
    return {
      found: true,
      sessionId,
      startIndex,
      nextIndex: snapshot.droppedLines + snapshot.lines.length,
      droppedLines: snapshot.droppedLines,
      ...(session.transcriptEvicted ? { evicted: true } : {}),
      lines: snapshot.lines.slice(startIndex - snapshot.droppedLines),
    };
  }

  async setupStatus(
    options: {
      transport?: GoogleMeetTransport;
      mode?: GoogleMeetModeInput;
      dialInNumber?: string;
    } = {},
  ) {
    const transport = resolveTransport(options.transport, this.params.config);
    const mode = resolveMode(options.mode, this.params.config);
    const twilioDialInNumber =
      transport === "twilio" ? normalizeDialInNumber(options.dialInNumber) : undefined;
    const shouldCheckChromeNode =
      transport === "chrome-node" ||
      (!options.transport && Boolean(this.params.config.chromeNode.node));
    let status = getGoogleMeetSetupStatus(this.params.config, {
      fullConfig: this.params.fullConfig,
      mode,
      transport,
      twilioDialInNumber,
    });
    if (shouldCheckChromeNode) {
      try {
        const node = await resolveChromeNodeInfo({
          runtime: this.params.runtime,
          requestedNode: this.params.config.chromeNode.node,
        });
        const label = node.displayName ?? node.remoteIp ?? node.nodeId ?? "connected node";
        status = addGoogleMeetSetupCheck(status, {
          id: "chrome-node-connected",
          ok: true,
          message: `Connected Google Meet node ready: ${label}`,
        });
      } catch (error) {
        status = addGoogleMeetSetupCheck(status, {
          id: "chrome-node-connected",
          ok: false,
          message: formatErrorMessage(error),
        });
      }
    }
    if (transport === "chrome" && isGoogleMeetTalkBackMode(mode)) {
      try {
        await assertBlackHole2chAvailable({
          runtime: this.params.runtime,
          timeoutMs: Math.min(this.params.config.chrome.joinTimeoutMs, 10_000),
        });
        status = addGoogleMeetSetupCheck(status, {
          id: "chrome-local-audio-device",
          ok: true,
          message: "BlackHole 2ch audio device found",
        });
      } catch (error) {
        status = addGoogleMeetSetupCheck(status, {
          id: "chrome-local-audio-device",
          ok: false,
          message: formatErrorMessage(error),
        });
      }

      const commands = collectChromeAudioCommands(this.params.config);
      const missingCommands: string[] = [];
      for (const command of commands) {
        try {
          if (!(await commandExists(this.params.runtime, command))) {
            missingCommands.push(command);
          }
        } catch {
          missingCommands.push(command);
        }
      }
      status = addGoogleMeetSetupCheck(status, {
        id: "chrome-local-audio-commands",
        ok: commands.length > 0 && missingCommands.length === 0,
        message:
          commands.length === 0
            ? "Chrome talk-back audio commands are not configured"
            : missingCommands.length === 0
              ? `Chrome audio command${commands.length === 1 ? "" : "s"} available: ${commands.join(", ")}`
              : `Chrome audio command${missingCommands.length === 1 ? "" : "s"} missing: ${missingCommands.join(", ")}`,
      });
    }
    return status;
  }

  async createViaBrowser() {
    const result = await createMeetWithBrowserProxyOnNode({
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
    const url = request.url ? normalizeMeetUrl(request.url) : undefined;
    if (transport === "chrome-node") {
      return recoverCurrentMeetTabOnNode({
        runtime: this.params.runtime,
        config: this.params.config,
        url,
      });
    }
    return recoverCurrentMeetTab({
      runtime: this.params.runtime,
      config: this.params.config,
      url,
    });
  }

  async join(request: GoogleMeetJoinRequest): Promise<GoogleMeetJoinResult> {
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    const mode = resolveMode(request.mode, this.params.config);
    const agentId = resolveSessionAgentId(request, this.params.config);
    if (!isBrowserTransport(transport)) {
      return await this.#joinUnlocked(request, { url, transport, mode, agentId });
    }
    return await this.#withBrowserMeetingLock(
      transport,
      url,
      async () => await this.#joinUnlocked(request, { url, transport, mode, agentId }),
    );
  }

  async #joinUnlocked(
    request: GoogleMeetJoinRequest,
    resolved: {
      url: string;
      transport: GoogleMeetTransport;
      mode: GoogleMeetMode;
      agentId: string;
    },
  ): Promise<GoogleMeetJoinResult> {
    const { url, transport, mode, agentId } = resolved;
    const activeSessions = this.list().filter(
      (session) =>
        session.state === "active" &&
        isSameMeetUrlForReuse(session.url, url) &&
        session.transport === transport,
    );
    const retainedBrowserTabs: RetainedBrowserTab[] = [];
    if (isBrowserTransport(transport) && isGoogleMeetTalkBackMode(mode)) {
      for (const session of activeSessions) {
        if (
          !isGoogleMeetTalkBackMode(session.mode) ||
          isReusableMeetSession(session, { url, transport, mode, agentId })
        ) {
          continue;
        }
        // A reused browser tab can only host one live talk-back bridge safely.
        // End the previous owner before the tab is reused for another agent.
        // Keep the tab: the new session takes it over without re-admission.
        const tab = this.params.config.chrome.reuseExistingTab
          ? session.chrome?.browserTab
          : undefined;
        const keepBrowserParticipant = Boolean(tab) || session.chrome?.launched === false;
        if (tab) {
          retainedBrowserTabs.push({ session, tab });
        }
        try {
          const left = await this.#leaveUnlocked(
            session.id,
            keepBrowserParticipant ? { keepBrowserTab: true } : undefined,
          );
          if (left.browserLeft === false) {
            throw new Error("Could not leave the previous Meet browser tab before reassignment.");
          }
        } catch (error) {
          await this.#settleRetainedBrowserTabs(retainedBrowserTabs);
          throw error;
        }
        noteSession(session, "Ended before the same Meet tab was reassigned to another agent.");
      }
    }
    let reusable = activeSessions.find((session) =>
      isReusableMeetSession(session, { url, transport, mode, agentId }),
    );
    if (reusable?.transport === "twilio") {
      await this.#refreshTwilioVoiceCallStatus(reusable);
      if (reusable.state !== "active") {
        reusable = undefined;
      }
    }
    const speechInstructions = request.message ?? this.params.config.realtime.introMessage;
    if (reusable) {
      await this.#refreshBrowserHealthForChromeSession(reusable);
      noteSession(reusable, "Reused existing active Meet session.");
      reusable.updatedAt = nowIso();
      const spoken =
        isGoogleMeetTalkBackMode(mode) && speechInstructions
          ? await this.#speakWhenReady(reusable, speechInstructions)
          : false;
      return { session: reusable, spoken };
    }
    const createdAt = nowIso();
    let delegatedTwilioSpoken = false;

    const session: GoogleMeetSession = {
      id: `meet_${randomUUID()}`,
      url,
      transport,
      mode,
      agentId,
      state: "active",
      createdAt,
      updatedAt: createdAt,
      participantIdentity:
        transport === "twilio"
          ? "Twilio phone participant"
          : transport === "chrome-node"
            ? "signed-in Google Chrome profile on a paired node"
            : "signed-in Google Chrome profile",
      realtime: {
        enabled: isGoogleMeetTalkBackMode(mode),
        strategy: mode === "bidi" ? "bidi" : "agent",
        provider:
          mode === "bidi"
            ? (this.params.config.realtime.voiceProvider ?? this.params.config.realtime.provider)
            : undefined,
        model: mode === "bidi" ? this.params.config.realtime.model : undefined,
        transcriptionProvider:
          mode === "agent"
            ? (this.params.config.realtime.transcriptionProvider ??
              this.params.config.realtime.provider)
            : undefined,
        toolPolicy: this.params.config.realtime.toolPolicy,
      },
      notes: [],
    };

    try {
      if (transport === "chrome" || transport === "chrome-node") {
        // Session ownership must outlive the original request so later bridge
        // startup and reuse stay on the same workspace and tool policy.
        const chromeConfig = withSessionAgentConfig(this.params.config, agentId);
        let result: ChromeLaunchResult;
        try {
          result =
            transport === "chrome-node"
              ? await launchChromeMeetOnNode({
                  runtime: this.params.runtime,
                  config: chromeConfig,
                  fullConfig: this.params.fullConfig,
                  meetingSessionId: session.id,
                  requesterSessionKey: request.requesterSessionKey,
                  mode,
                  url,
                  logger: this.params.logger,
                })
              : await launchChromeMeet({
                  runtime: this.params.runtime,
                  config: chromeConfig,
                  fullConfig: this.params.fullConfig,
                  meetingSessionId: session.id,
                  requesterSessionKey: request.requesterSessionKey,
                  mode,
                  url,
                  logger: this.params.logger,
                });
        } catch (error) {
          await this.#settleRetainedBrowserTabs(retainedBrowserTabs);
          throw error;
        }
        const resultNodeId = "nodeId" in result ? result.nodeId : undefined;
        const browserTab = this.#inheritBrowserTabOwnership({
          transport,
          nodeId: resultNodeId,
          meetingUrl: url,
          tab: result.tab,
        });
        session.chrome = {
          audioBackend: this.params.config.chrome.audioBackend,
          launched: result.launched,
          nodeId: resultNodeId,
          browserProfile: this.params.config.chrome.browserProfile,
          browserTab,
          health: "browser" in result ? result.browser : undefined,
        };
        this.#attachChromeAudioBridge(session, result.audioBridge);
        const retainedTabsSettled = await this.#settleRetainedBrowserTabs(
          retainedBrowserTabs,
          browserTab ? { transport, nodeId: resultNodeId, tab: browserTab } : undefined,
        );
        if (!retainedTabsSettled) {
          try {
            await this.#leaveSession(session);
          } catch (error) {
            this.params.logger.warn(
              `[google-meet] replacement cleanup failed: ${formatErrorMessage(error)}`,
            );
          }
          throw new Error("Could not leave the previous Meet browser tab before reassignment.");
        }
        session.notes.push(
          result.audioBridge
            ? transport === "chrome-node"
              ? "Chrome node transport joins as the signed-in Google profile on the selected node and routes realtime audio through the node bridge."
              : "Chrome transport joins as the signed-in Google profile and routes realtime audio through the configured bridge."
            : isGoogleMeetTalkBackMode(mode)
              ? "Chrome transport joins as the signed-in Google profile and expects BlackHole 2ch audio routing."
              : "Chrome transport joins as the signed-in Google profile without starting the realtime audio bridge.",
        );
        this.#refreshSpeechReadiness(session);
      } else {
        const dialInNumber = normalizeDialInNumber(
          request.dialInNumber ?? this.params.config.twilio.defaultDialInNumber,
        );
        if (!dialInNumber) {
          throw new Error(
            "Twilio transport requires a Meet dial-in phone number. Google Meet URLs do not include dial-in details; pass dialInNumber with optional pin/dtmfSequence, configure twilio.defaultDialInNumber, or use chrome/chrome-node transport.",
          );
        }
        const rawDtmfSequence = buildMeetDtmfSequence({
          pin: request.pin ?? this.params.config.twilio.defaultPin,
          dtmfSequence: request.dtmfSequence ?? this.params.config.twilio.defaultDtmfSequence,
        });
        const dtmfSequence =
          request.dtmfSequence || this.params.config.twilio.defaultDtmfSequence
            ? rawDtmfSequence
            : prefixDtmfWait(rawDtmfSequence, this.params.config.voiceCall.dtmfDelayMs);
        const hasExplicitDelegatedAgent = Boolean(
          normalizeOptionalString(request.agentId) ||
          normalizeOptionalString(this.params.config.realtime.agentId),
        );
        const delegatedAgentId = hasExplicitDelegatedAgent ? agentId : undefined;
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
                : buildTwilioVoiceCallSessionKey(session.id),
              message: isGoogleMeetTalkBackMode(mode)
                ? (request.message ??
                  this.params.config.voiceCall.introMessage ??
                  this.params.config.realtime.introMessage)
                : undefined,
            })
          : undefined;
        delegatedTwilioSpoken = Boolean(voiceCallResult?.introSent);
        session.twilio = {
          dialInNumber,
          pinProvided: Boolean(request.pin ?? this.params.config.twilio.defaultPin),
          dtmfSequence,
          voiceCallId: voiceCallResult?.callId,
          dtmfSent: voiceCallResult?.dtmfSent,
          introSent: voiceCallResult?.introSent,
        };
        if (voiceCallResult?.callId) {
          this.#sessionStops.set(session.id, async () => {
            await endMeetVoiceCallGatewayCall({
              gateway: this.#voiceCallGateway,
              callId: voiceCallResult.callId,
            });
          });
        }
        session.notes.push(
          this.params.config.voiceCall.enabled
            ? dtmfSequence
              ? "Twilio transport delegated the phone leg to the voice-call plugin, then queued configured DTMF before realtime connect."
              : "Twilio transport delegated the call to the voice-call plugin without configured DTMF."
            : "Twilio transport is an explicit dial plan; voice-call delegation is disabled.",
        );
      }
    } catch (err) {
      this.params.logger.warn(`[google-meet] join failed: ${formatErrorMessage(err)}`);
      throw err;
    }

    this.#sessions.set(session.id, session);
    const spoken =
      transport === "twilio"
        ? delegatedTwilioSpoken
        : isGoogleMeetTalkBackMode(mode) && speechInstructions
          ? await this.#speakWhenReady(session, speechInstructions)
          : false;
    return { session, spoken };
  }

  async leave(
    sessionId: string,
    opts?: { keepBrowserTab?: boolean },
  ): Promise<GoogleMeetLeaveResult> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    if (!isBrowserTransport(session.transport)) {
      return await this.#leaveUnlocked(sessionId, opts);
    }
    return await this.#withBrowserMeetingLock(
      session.transport,
      session.url,
      async () => await this.#leaveUnlocked(sessionId, opts),
    );
  }

  async #leaveUnlocked(
    sessionId: string,
    opts?: { keepBrowserTab?: boolean },
  ): Promise<GoogleMeetLeaveResult> {
    const inFlight = this.#sessionLeaves.get(sessionId);
    if (inFlight) {
      return await inFlight;
    }
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    // Mark terminal before awaiting teardown so retries and concurrent callers
    // cannot act on the same browser tab twice.
    if (session.state === "ended") {
      return {
        found: true,
        session,
        ...(session.browserLeft === undefined ? {} : { browserLeft: session.browserLeft }),
      };
    }
    const leave = this.#leaveSession(session, opts);
    this.#sessionLeaves.set(sessionId, leave);
    try {
      return await leave;
    } finally {
      if (this.#sessionLeaves.get(sessionId) === leave) {
        this.#sessionLeaves.delete(sessionId);
      }
    }
  }

  async #withBrowserMeetingLock<T>(
    transport: GoogleMeetTransport,
    url: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Logical sessions may share one physical tab. Serialize adoption and
    // departure for the canonical meeting so neither can invalidate the other.
    const meeting = normalizeMeetUrlForReuse(url) ?? url;
    const key = `${transport}:${meeting}`;
    const previous = this.#browserMeetingLocks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#browserMeetingLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#browserMeetingLocks.get(key) === tail) {
        this.#browserMeetingLocks.delete(key);
      }
    }
  }

  async #leaveSession(
    session: GoogleMeetSession,
    opts?: { keepBrowserTab?: boolean },
  ): Promise<GoogleMeetLeaveResult> {
    // #leaveUnlocked publishes this promise in #sessionLeaves before another
    // event can re-enter, so the final snapshot remains inside one teardown.
    if (session.mode === "transcribe") {
      this.#transcriptFinalizing.add(session.id);
      await this.#captureTranscriptSnapshot(session, { finalize: true }).catch((error: unknown) => {
        this.params.logger.debug?.(
          `[google-meet] final transcript snapshot ignored: ${formatErrorMessage(error)}`,
        );
      });
    }
    session.state = "ended";
    session.updatedAt = nowIso();
    const stop = this.#sessionStops.get(session.id);
    this.#sessionStops.delete(session.id);
    this.#sessionSpeakers.delete(session.id);
    this.#sessionHealth.delete(session.id);
    let browserLeft: boolean | undefined;
    try {
      await stop?.();
    } finally {
      try {
        // A bridge teardown failure must not leave the browser participant behind.
        if (!opts?.keepBrowserTab) {
          browserLeft = await this.#releaseBrowserTab(session);
        }
      } finally {
        this.#retireTranscript(session.id);
        this.#transcriptFinalizing.delete(session.id);
      }
    }
    return { found: true, session, ...(browserLeft === undefined ? {} : { browserLeft }) };
  }

  async #captureTranscriptSnapshot(
    session: GoogleMeetSession,
    options: { finalize?: boolean } = {},
  ): Promise<void> {
    // Preserve browser-read order so an older response cannot regress the cursor
    // or overwrite the final snapshot queued by leave.
    const previous = this.#transcriptCaptures.get(session.id) ?? Promise.resolve();
    const capture = previous
      .catch(() => {})
      .then(async () => {
        if (!isBrowserTransport(session.transport) || session.mode !== "transcribe") {
          return;
        }
        const tab = session.chrome?.browserTab;
        if (!tab) {
          return;
        }
        const snapshot =
          session.transport === "chrome-node"
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
        this.#mergeTranscriptSnapshot(session.id, snapshot);
      });
    this.#transcriptCaptures.set(session.id, capture);
    try {
      await capture;
    } finally {
      if (this.#transcriptCaptures.get(session.id) === capture) {
        this.#transcriptCaptures.delete(session.id);
      }
    }
  }

  #mergeTranscriptSnapshot(sessionId: string, snapshot: GoogleMeetTranscriptSnapshot): void {
    const pageNextIndex = snapshot.droppedLines + snapshot.lines.length;
    const retained = this.#transcripts.get(sessionId);
    if (!retained) {
      this.#transcripts.set(sessionId, {
        droppedLines: snapshot.droppedLines,
        lines: snapshot.lines,
        pageEpoch: snapshot.epoch,
        pageNextIndex,
      });
      return;
    }

    // A page reload starts a new epoch, but the runtime cursor stays absolute
    // so already delivered captions remain addressable.
    if (retained.pageEpoch !== snapshot.epoch) {
      retained.droppedLines += snapshot.droppedLines;
      retained.lines.push(...snapshot.lines);
      retained.pageEpoch = snapshot.epoch;
      retained.pageNextIndex = pageNextIndex;
    } else if (pageNextIndex > retained.pageNextIndex) {
      const appendFrom = Math.max(retained.pageNextIndex, snapshot.droppedLines);
      retained.droppedLines += Math.max(0, snapshot.droppedLines - retained.pageNextIndex);
      retained.lines.push(...snapshot.lines.slice(appendFrom - snapshot.droppedLines));
      retained.pageNextIndex = pageNextIndex;
    }

    const excess = retained.lines.length - GOOGLE_MEET_TRANSCRIPT_MAX_LINES;
    if (excess > 0) {
      retained.lines.splice(0, excess);
      retained.droppedLines += excess;
    }
  }

  #retireTranscript(sessionId: string): void {
    const snapshot = this.#transcripts.get(sessionId);
    if (snapshot) {
      this.#transcripts.delete(sessionId);
      this.#transcripts.set(sessionId, snapshot);
      this.#retiredTranscripts.delete(sessionId);
      this.#retiredTranscripts.add(sessionId);
    }
    const retainedIds = [...this.#retiredTranscripts]
      .filter((id) => this.#transcripts.has(id))
      .toSorted((a, b) =>
        (this.#sessions.get(a)?.updatedAt ?? "").localeCompare(
          this.#sessions.get(b)?.updatedAt ?? "",
        ),
      );
    for (const id of retainedIds.slice(0, -GOOGLE_MEET_ENDED_TRANSCRIPTS_MAX)) {
      this.#transcripts.delete(id);
      this.#retiredTranscripts.delete(id);
      const session = this.#sessions.get(id);
      if (session) {
        session.transcriptEvicted = true;
      }
    }
  }

  #inheritBrowserTabOwnership(params: {
    transport: GoogleMeetTransport;
    nodeId?: string;
    meetingUrl: string;
    tab?: GoogleMeetBrowserTab;
  }): GoogleMeetBrowserTab | undefined {
    if (!params.tab) {
      return undefined;
    }
    const tab = params.tab;
    const createdTabKey =
      params.transport === "chrome-node" && params.nodeId
        ? `${params.nodeId}:${tab.targetId}`
        : undefined;
    const createdMeetingUrl = createdTabKey
      ? this.#createdBrowserTabs.get(createdTabKey)
      : undefined;
    const inheritedFromCreate = isSameMeetUrlForReuse(createdMeetingUrl, params.meetingUrl);
    if (createdMeetingUrl && createdTabKey) {
      this.#createdBrowserTabs.delete(createdTabKey);
    }
    const inheritedFromSession = [...this.#sessions.values()].some((session) => {
      const trackedTab = session.chrome?.browserTab;
      if (!trackedTab) {
        return false;
      }
      return (
        session.transport === params.transport &&
        isSameMeetUrlForReuse(session.url, params.meetingUrl) &&
        session.chrome?.nodeId === params.nodeId &&
        trackedTab.targetId === tab.targetId &&
        trackedTab.openedByPlugin
      );
    });
    return inheritedFromCreate || inheritedFromSession ? { ...tab, openedByPlugin: true } : tab;
  }

  async #settleRetainedBrowserTabs(
    retained: RetainedBrowserTab[],
    adopted?: {
      transport: GoogleMeetTransport;
      nodeId?: string;
      tab: GoogleMeetBrowserTab;
    },
  ): Promise<boolean> {
    let settled = true;
    for (const { session, tab } of retained.splice(0)) {
      const adoptedThisTab =
        adopted?.transport === session.transport &&
        adopted.nodeId === session.chrome?.nodeId &&
        adopted.tab.targetId === tab.targetId;
      if (adoptedThisTab) {
        if (session.chrome) {
          session.chrome.browserTab = undefined;
        }
        continue;
      }
      if ((await this.#releaseBrowserTab(session)) === false) {
        settled = false;
      }
    }
    return settled;
  }

  async #releaseBrowserTab(session: GoogleMeetSession): Promise<boolean | undefined> {
    let browserLeft: boolean | undefined;
    try {
      browserLeft = await this.#leaveBrowserMeetTab(session);
    } catch (error) {
      noteSession(
        session,
        `Browser control could not leave the Meet tab: ${formatErrorMessage(error)}`,
      );
      browserLeft = false;
    }
    session.browserLeft = browserLeft;
    if (session.chrome && browserLeft !== false) {
      // Ownership has either been consumed, transferred to an active session,
      // or released to the user. Never let a stale session act on it again.
      session.chrome.browserTab = undefined;
    }
    return browserLeft;
  }

  // Chrome transports have no stop hook that touches the meeting itself, so
  // without this the browser participant stays in the call after `leave`
  // reports success (#103386). Twilio ends the real call via its stop hook.
  // Acts only on the exact tab identity persisted at join; URL rediscovery
  // could hit a different tab in another browser context.
  // Returns undefined when no browser departure applies (non-browser transport,
  // tab intentionally kept for another session), else whether the participant
  // actually left. Callers must not report plain success on false.
  async #leaveBrowserMeetTab(session: GoogleMeetSession): Promise<boolean | undefined> {
    if (!isBrowserTransport(session.transport)) {
      return undefined;
    }
    const tab = session.chrome?.browserTab;
    if (!tab) {
      noteSession(
        session,
        "No tracked Meet browser tab for this session; close the Meet tab manually if it is still in the call.",
      );
      return false;
    }
    // Same URL is not the same tab: only sessions on the same target in the
    // same browser context (local vs a specific node) truly share it.
    const sharedWithActiveSession = this.list().some(
      (other) =>
        other.id !== session.id &&
        other.state === "active" &&
        isBrowserTransport(other.transport) &&
        other.chrome?.browserTab?.targetId === tab.targetId &&
        other.chrome?.nodeId === session.chrome?.nodeId,
    );
    if (sharedWithActiveSession) {
      noteSession(session, "Kept the shared Meet tab open because another active session uses it.");
      return undefined;
    }
    const result =
      session.transport === "chrome-node"
        ? await leaveChromeMeetOnNode({
            runtime: this.params.runtime,
            nodeId: session.chrome?.nodeId,
            config: this.params.config,
            meetingUrl: session.url,
            tab,
          })
        : await leaveChromeMeet({
            runtime: this.params.runtime,
            config: this.params.config,
            meetingUrl: session.url,
            tab,
          });
    noteSession(session, result.note);
    return result.left;
  }

  async speak(
    sessionId: string,
    instructions?: string,
  ): Promise<{ found: boolean; spoken: boolean; session?: GoogleMeetSession }> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false, spoken: false };
    }
    if (session.transport === "twilio" && session.twilio?.voiceCallId) {
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
      } catch (err) {
        if (!isVoiceCallMissingError(err)) {
          throw err;
        }
        this.#markTwilioSessionEnded(session, "Voice Call is no longer active.");
        return { found: true, spoken: false, session };
      }
      session.twilio.introSent = true;
      session.updatedAt = nowIso();
      return { found: true, spoken: true, session };
    }
    await this.#refreshBrowserHealthForChromeSession(session);
    await this.#ensureChromeRealtimeBridge(session);
    const speak = this.#sessionSpeakers.get(sessionId);
    if (!speak || session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    const readiness = this.#refreshSpeechReadiness(session);
    if (!readiness.ready) {
      const note = readiness.message
        ? `Realtime speech blocked: ${readiness.message}`
        : "Realtime speech blocked until Google Meet is ready.";
      session.notes = [...session.notes.filter((item) => item !== note), note];
      session.updatedAt = nowIso();
      return { found: true, spoken: false, session };
    }
    speak(instructions || this.params.config.realtime.introMessage);
    session.updatedAt = nowIso();
    this.#refreshHealth(sessionId);
    return { found: true, spoken: true, session };
  }

  async #speakWhenReady(session: GoogleMeetSession, instructions: string): Promise<boolean> {
    let result = await this.speak(session.id, instructions);
    if (result.spoken || session.transport === "twilio") {
      return result.spoken;
    }
    const waitMs = Math.min(
      Math.max(0, this.params.config.chrome.waitForInCallMs),
      Math.max(0, this.params.config.chrome.joinTimeoutMs),
    );
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      result = await this.speak(session.id, instructions);
      if (result.spoken) {
        return true;
      }
      const health = result.session?.chrome?.health;
      if (health?.manualActionRequired || result.session?.state !== "active") {
        return false;
      }
      const blocked = health?.speechBlockedReason;
      if (
        blocked &&
        blocked !== "not-in-call" &&
        blocked !== "browser-unverified" &&
        blocked !== "meet-microphone-muted"
      ) {
        return false;
      }
    }
    return false;
  }

  async testSpeech(request: GoogleMeetJoinRequest): Promise<{
    createdSession: boolean;
    inCall?: boolean;
    manualActionRequired?: boolean;
    manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    spoken: boolean;
    speechOutputVerified: boolean;
    speechOutputTimedOut: boolean;
    speechReady?: boolean;
    speechBlockedReason?: GoogleMeetChromeHealth["speechBlockedReason"];
    speechBlockedMessage?: string;
    audioOutputActive?: boolean;
    lastOutputBytes?: number;
    session: GoogleMeetSession;
  }> {
    if (request.mode === "transcribe") {
      throw new Error(
        "test_speech requires mode: agent or bidi; use join mode: transcribe for observe-only sessions.",
      );
    }
    const requestedMode = request.mode ? resolveMode(request.mode, this.params.config) : undefined;
    const mode =
      requestedMode && isGoogleMeetTalkBackMode(requestedMode)
        ? requestedMode
        : isGoogleMeetTalkBackMode(this.params.config.defaultMode)
          ? this.params.config.defaultMode
          : "agent";
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    const agentId = resolveSessionAgentId(request, this.params.config);
    const beforeSessions = this.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existingSession = beforeSessions.find((session) =>
      isReusableMeetSession(session, { url, transport, mode, agentId }),
    );
    const existingOutputBytes = existingSession?.chrome?.health?.lastOutputBytes ?? 0;
    const result = await this.join({
      ...request,
      transport,
      url,
      mode,
      message: request.message ?? "Say exactly: Google Meet speech test complete.",
    });
    const startOutputBytes = existingSession?.id === result.session.id ? existingOutputBytes : 0;
    let health = result.session.chrome?.health;
    const shouldWaitForOutput =
      result.spoken === true &&
      health?.manualActionRequired !== true &&
      this.#sessionHealth.has(result.session.id);
    if (shouldWaitForOutput && !hasRealtimeAudioOutputAdvanced(health, startOutputBytes)) {
      const deadline = Date.now() + Math.min(this.params.config.chrome.joinTimeoutMs, 5_000);
      while (Date.now() < deadline) {
        await sleep(100);
        this.#refreshHealth(result.session.id);
        health = result.session.chrome?.health;
        if (hasRealtimeAudioOutputAdvanced(health, startOutputBytes)) {
          break;
        }
      }
    }
    const speechOutputVerified = hasRealtimeAudioOutputAdvanced(health, startOutputBytes);
    return {
      createdSession: !before.has(result.session.id),
      inCall: health?.inCall,
      manualActionRequired: health?.manualActionRequired,
      manualActionReason: health?.manualActionReason,
      manualActionMessage: health?.manualActionMessage,
      spoken: result.spoken ?? false,
      speechOutputVerified,
      speechOutputTimedOut: shouldWaitForOutput && !speechOutputVerified,
      speechReady: health?.speechReady,
      speechBlockedReason: health?.speechBlockedReason,
      speechBlockedMessage: health?.speechBlockedMessage,
      audioOutputActive: health?.audioOutputActive,
      lastOutputBytes: health?.lastOutputBytes,
      session: result.session,
    };
  }

  async testListen(request: GoogleMeetJoinRequest): Promise<{
    createdSession: boolean;
    inCall?: boolean;
    manualActionRequired?: boolean;
    manualActionReason?: GoogleMeetChromeHealth["manualActionReason"];
    manualActionMessage?: string;
    listenVerified: boolean;
    listenTimedOut: boolean;
    captioning?: boolean;
    captionsEnabledAttempted?: boolean;
    transcriptLines?: number;
    lastCaptionAt?: string;
    lastCaptionSpeaker?: string;
    lastCaptionText?: string;
    recentTranscript?: GoogleMeetChromeHealth["recentTranscript"];
    session: GoogleMeetSession;
  }> {
    const requestedMode = request.mode ? resolveMode(request.mode, this.params.config) : undefined;
    if (requestedMode && isGoogleMeetTalkBackMode(requestedMode)) {
      throw new Error(
        "test_listen requires mode: transcribe; use test_speech for talk-back sessions.",
      );
    }
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    if (transport === "twilio") {
      throw new Error("test_listen supports chrome or chrome-node transports");
    }
    const agentId = resolveSessionAgentId(request, this.params.config);
    const beforeSessions = this.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existingSession = beforeSessions.find((session) =>
      isReusableMeetSession(session, {
        url,
        transport,
        mode: "transcribe",
        agentId,
      }),
    );
    const existingStart = transcriptCheckpoint(existingSession?.chrome?.health);
    const result = await this.join({
      ...request,
      transport,
      url,
      mode: "transcribe",
      message: undefined,
    });
    const start =
      existingSession?.id === result.session.id ? existingStart : transcriptCheckpoint(undefined);
    let health = result.session.chrome?.health;
    const timeoutMs = resolveProbeTimeoutMs(
      request.timeoutMs,
      this.params.config.chrome.joinTimeoutMs,
    );
    const shouldWait =
      health?.manualActionRequired !== true && isManagedChromeBrowserSession(result.session);
    if (shouldWait && !hasTranscriptAdvanced(health, start)) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(250);
        await this.#refreshCaptionHealthForSession(result.session);
        health = result.session.chrome?.health;
        if (health?.manualActionRequired || hasTranscriptAdvanced(health, start)) {
          break;
        }
      }
    }
    const listenVerified = hasTranscriptAdvanced(health, start);
    return {
      createdSession: !before.has(result.session.id),
      inCall: health?.inCall,
      manualActionRequired: health?.manualActionRequired,
      manualActionReason: health?.manualActionReason,
      manualActionMessage: health?.manualActionMessage,
      listenVerified,
      listenTimedOut: shouldWait && !listenVerified && health?.manualActionRequired !== true,
      captioning: health?.captioning,
      captionsEnabledAttempted: health?.captionsEnabledAttempted,
      transcriptLines: health?.transcriptLines,
      lastCaptionAt: health?.lastCaptionAt,
      lastCaptionSpeaker: health?.lastCaptionSpeaker,
      lastCaptionText: health?.lastCaptionText,
      recentTranscript: health?.recentTranscript,
      session: result.session,
    };
  }

  async #refreshCaptionHealthForSession(session: GoogleMeetSession) {
    if (session.mode !== "transcribe") {
      this.#refreshSpeechReadiness(session);
      return;
    }
    await this.#refreshBrowserHealthForChromeSession(session);
  }

  async #refreshStatusHealthForSession(session: GoogleMeetSession) {
    if (session.transport === "chrome" || session.transport === "chrome-node") {
      await this.#refreshBrowserHealthForChromeSession(session, { force: true, readOnly: true });
      return;
    }
    if (session.transport === "twilio") {
      await this.#refreshTwilioVoiceCallStatus(session);
      return;
    }
    this.#refreshSpeechReadiness(session);
  }

  #markTwilioSessionEnded(session: GoogleMeetSession, reason: string) {
    session.state = "ended";
    session.updatedAt = nowIso();
    this.#sessionStops.delete(session.id);
    this.#sessionSpeakers.delete(session.id);
    this.#sessionHealth.delete(session.id);
    noteSession(session, reason);
  }

  async #refreshTwilioVoiceCallStatus(session: GoogleMeetSession) {
    const callId = session.twilio?.voiceCallId;
    if (!callId || session.state !== "active") {
      this.#refreshSpeechReadiness(session);
      return;
    }
    try {
      const status = await getMeetVoiceCallGatewayCall({
        gateway: this.#voiceCallGateway,
        callId,
      });
      if (status.found === false) {
        this.#markTwilioSessionEnded(session, "Voice Call is no longer active.");
      }
    } catch (error) {
      this.params.logger.debug?.(
        `[google-meet] voice-call status refresh ignored: ${formatErrorMessage(error)}`,
      );
    }
    this.#refreshSpeechReadiness(session);
  }

  async #refreshBrowserHealthForChromeSession(
    session: GoogleMeetSession,
    options: { force?: boolean; readOnly?: boolean } = {},
  ) {
    if (!isManagedChromeBrowserSession(session)) {
      this.#refreshSpeechReadiness(session);
      return;
    }
    if (
      !options.force &&
      isGoogleMeetTalkBackMode(session.mode) &&
      evaluateSpeechReadiness(session).ready
    ) {
      this.#refreshSpeechReadiness(session);
      return;
    }
    try {
      const result =
        session.transport === "chrome-node"
          ? await recoverCurrentMeetTabOnNode({
              runtime: this.params.runtime,
              config: this.params.config,
              mode: session.mode,
              readOnly: options.readOnly,
              url: session.url,
            })
          : await recoverCurrentMeetTab({
              runtime: this.params.runtime,
              config: this.params.config,
              mode: session.mode,
              readOnly: options.readOnly,
              url: session.url,
            });
      if (result.found && result.browser && session.chrome) {
        session.chrome.health = {
          ...session.chrome.health,
          ...result.browser,
        };
        session.updatedAt = nowIso();
      }
    } catch (error) {
      this.params.logger.debug?.(
        `[google-meet] browser readiness refresh ignored: ${formatErrorMessage(error)}`,
      );
    }
    this.#refreshSpeechReadiness(session);
  }

  #attachChromeAudioBridge(
    session: GoogleMeetSession,
    audioBridge: ChromeAudioBridgeResult | undefined,
  ) {
    if (!session.chrome || !audioBridge) {
      return;
    }
    session.chrome.audioBridge = {
      type: audioBridge.type,
      provider:
        audioBridge.type === "command-pair" || audioBridge.type === "node-command-pair"
          ? audioBridge.providerId
          : undefined,
    };
    if (audioBridge.type === "command-pair" || audioBridge.type === "node-command-pair") {
      this.#sessionStops.set(session.id, audioBridge.stop);
      this.#sessionSpeakers.set(session.id, audioBridge.speak);
      this.#sessionHealth.set(session.id, audioBridge.getHealth);
    }
  }

  async #ensureChromeRealtimeBridge(session: GoogleMeetSession) {
    if (
      !isGoogleMeetTalkBackMode(session.mode) ||
      session.transport !== "chrome" ||
      session.state !== "active" ||
      !session.chrome ||
      session.chrome.audioBridge
    ) {
      return;
    }
    const health = session.chrome.health;
    if (
      health?.inCall !== true ||
      health.micMuted === true ||
      health.manualActionRequired === true
    ) {
      return;
    }
    const sessionConfig = withSessionAgentConfig(this.params.config, session.agentId);
    const result = await launchChromeMeet({
      runtime: this.params.runtime,
      config: {
        ...sessionConfig,
        chrome: {
          ...sessionConfig.chrome,
          launch: false,
        },
      },
      fullConfig: this.params.fullConfig,
      meetingSessionId: session.id,
      mode: session.mode,
      url: session.url,
      logger: this.params.logger,
    });
    this.#attachChromeAudioBridge(session, result.audioBridge);
    session.updatedAt = nowIso();
  }

  #refreshSpeechReadiness(session: GoogleMeetSession) {
    const readiness = evaluateSpeechReadiness(session);
    if (readiness.ready) {
      session.notes = session.notes.filter((note) => !note.startsWith("Realtime speech blocked:"));
    }
    if (session.chrome) {
      session.chrome.health = {
        ...session.chrome.health,
        speechReady: readiness.ready,
        speechBlockedReason: readiness.reason,
        speechBlockedMessage: readiness.message,
      };
    }
    return readiness;
  }

  #refreshHealth(sessionId?: string) {
    const ids = sessionId ? [sessionId] : [...this.#sessionHealth.keys()];
    for (const id of ids) {
      const session = this.#sessions.get(id);
      const getHealth = this.#sessionHealth.get(id);
      if (!session?.chrome || !getHealth) {
        continue;
      }
      session.chrome.health = {
        ...session.chrome.health,
        ...getHealth(),
      };
      this.#refreshSpeechReadiness(session);
    }
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
