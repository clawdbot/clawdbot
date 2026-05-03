import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { addGoogleMeetSetupCheck, getGoogleMeetSetupStatus } from "./setup.js";
import { isSameMeetUrlForReuse, resolveChromeNodeInfo } from "./transports/chrome-browser-proxy.js";
import { createMeetWithBrowserProxyOnNode } from "./transports/chrome-create.js";
import {
  assertBlackHole2chAvailable,
  launchChromeMeet,
  launchChromeMeetOnNode,
  recoverCurrentMeetTab,
  recoverCurrentMeetTabOnNode,
} from "./transports/chrome.js";
import { buildMeetDtmfSequence, normalizeDialInNumber } from "./transports/twilio.js";
import type {
  GoogleMeetChromeHealth,
  GoogleMeetJoinRequest,
  GoogleMeetJoinResult,
  GoogleMeetSession,
} from "./transports/types.js";
import {
  endMeetVoiceCallGatewayCall,
  joinMeetViaVoiceCallGateway,
  speakMeetViaVoiceCallGateway,
} from "./voice-call-gateway.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeMeetUrl(input: unknown): string {
  const raw = normalizeOptionalString(input);
  if (!raw) {
    throw new Error("url required");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("url must be a valid Google Meet URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "meet.google.com") {
    throw new Error("url must be an explicit https://meet.google.com/... URL");
  }
  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:$|[/?#])/i.test(url.pathname)) {
    throw new Error("url must include a Google Meet meeting code");
  }
  return url.toString();
}

function resolveTransport(input: GoogleMeetTransport | undefined, config: GoogleMeetConfig) {
  return input ?? config.defaultTransport;
}

function resolveMode(input: GoogleMeetMode | undefined, config: GoogleMeetConfig) {
  return input ?? config.defaultMode;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isManagedChromeBrowserSession(session: GoogleMeetSession): boolean {
  return Boolean(
    (session.transport === "chrome" || session.transport === "chrome-node") &&
    session.chrome &&
    session.chrome.launched,
  );
}

function evaluateSpeechReadiness(session: GoogleMeetSession): {
  ready: boolean;
  reason?: NonNullable<GoogleMeetChromeHealth["speechBlockedReason"]>;
  message?: string;
} {
  if (session.mode !== "realtime" || !session.chrome) {
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
  return [...new Set(commands.filter((value): value is string => Boolean(value?.trim())))];
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
  readonly #sessionStops = new Map<string, () => Promise<void>>();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();
  readonly #sessionHealth = new Map<string, () => GoogleMeetChromeHealth>();

  constructor(
    private readonly params: {
      config: GoogleMeetConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {}

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
      await Promise.all(sessions.map((session) => this.#refreshCaptionHealthForSession(session)));
      return { found: true, sessions };
    }
    const session = this.#sessions.get(sessionId);
    if (session) {
      await this.#refreshCaptionHealthForSession(session);
    }
    return session ? { found: true, session } : { found: false };
  }

  async setupStatus(
    options: {
      transport?: GoogleMeetTransport;
      mode?: GoogleMeetMode;
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
    if (transport === "chrome" && mode === "realtime") {
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
            ? "Chrome realtime audio commands are not configured"
            : missingCommands.length === 0
              ? `Chrome audio command${commands.length === 1 ? "" : "s"} available: ${commands.join(", ")}`
              : `Chrome audio command${missingCommands.length === 1 ? "" : "s"} missing: ${missingCommands.join(", ")}`,
      });
    }
    return status;
  }

  async createViaBrowser() {
    return createMeetWithBrowserProxyOnNode({
      runtime: this.params.runtime,
      config: this.params.config,
    });
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
      config: this.params.config,
      url,
    });
  }

  async join(request: GoogleMeetJoinRequest): Promise<GoogleMeetJoinResult> {
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    const mode = resolveMode(request.mode, this.params.config);
    const reusable = this.list().find(
      (session) =>
        session.state === "active" &&
        isSameMeetUrlForReuse(session.url, url) &&
        session.transport === transport &&
        session.mode === mode,
    );
    const speechInstructions = request.message ?? this.params.config.realtime.introMessage;
    if (reusable) {
      await this.#refreshBrowserHealthForChromeSession(reusable);
      reusable.notes = [
        ...reusable.notes.filter((note) => note !== "Reused existing active Meet session."),
        "Reused existing active Meet session.",
      ];
      reusable.updatedAt = nowIso();
      const spoken =
        mode === "realtime" && speechInstructions
          ? (await this.speak(reusable.id, speechInstructions)).spoken
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
        enabled: mode === "realtime",
        provider: this.params.config.realtime.provider,
        model: this.params.config.realtime.model,
        toolPolicy: this.params.config.realtime.toolPolicy,
      },
      notes: [],
    };

    try {
      if (transport === "chrome" || transport === "chrome-node") {
        const result =
          transport === "chrome-node"
            ? await launchChromeMeetOnNode({
                runtime: this.params.runtime,
                config: this.params.config,
                fullConfig: this.params.fullConfig,
                meetingSessionId: session.id,
                mode,
                url,
                logger: this.params.logger,
              })
            : await launchChromeMeet({
                runtime: this.params.runtime,
                config: this.params.config,
                fullConfig: this.params.fullConfig,
                meetingSessionId: session.id,
                mode,
                url,
                logger: this.params.logger,
              });
        session.chrome = {
          audioBackend: this.params.config.chrome.audioBackend,
          launched: result.launched,
          nodeId: "nodeId" in result ? result.nodeId : undefined,
          browserProfile: this.params.config.chrome.browserProfile,
          audioBridge: result.audioBridge
            ? {
                type: result.audioBridge.type,
                provider:
                  result.audioBridge.type === "command-pair" ||
                  result.audioBridge.type === "node-command-pair"
                    ? result.audioBridge.providerId
                    : undefined,
              }
            : undefined,
          health: "browser" in result ? result.browser : undefined,
        };
        if (
          result.audioBridge?.type === "command-pair" ||
          result.audioBridge?.type === "node-command-pair"
        ) {
          this.#sessionStops.set(session.id, result.audioBridge.stop);
          this.#sessionSpeakers.set(session.id, result.audioBridge.speak);
          this.#sessionHealth.set(session.id, result.audioBridge.getHealth);
        }
        session.notes.push(
          result.audioBridge
            ? transport === "chrome-node"
              ? "Chrome node transport joins as the signed-in Google profile on the selected node and routes realtime audio through the node bridge."
              : "Chrome transport joins as the signed-in Google profile and routes realtime audio through the configured bridge."
            : mode === "realtime"
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
        const dtmfSequence = buildMeetDtmfSequence({
          pin: request.pin ?? this.params.config.twilio.defaultPin,
          dtmfSequence: request.dtmfSequence ?? this.params.config.twilio.defaultDtmfSequence,
        });
        const voiceCallResult = this.params.config.voiceCall.enabled
          ? await joinMeetViaVoiceCallGateway({
              config: this.params.config,
              dialInNumber,
              dtmfSequence,
              logger: this.params.logger,
              message:
                mode === "realtime"
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
              config: this.params.config,
              callId: voiceCallResult.callId,
            });
          });
        }
        session.notes.push(
          this.params.config.voiceCall.enabled
            ? dtmfSequence
              ? "Twilio transport delegated the phone leg to the voice-call plugin, then sent configured DTMF after connect before speaking."
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
        : mode === "realtime" && speechInstructions
          ? (await this.speak(session.id, speechInstructions)).spoken
          : false;
    return { session, spoken };
  }

  async leave(sessionId: string): Promise<{ found: boolean; session?: GoogleMeetSession }> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false };
    }
    const stop = this.#sessionStops.get(sessionId);
    if (stop) {
      this.#sessionStops.delete(sessionId);
      this.#sessionSpeakers.delete(sessionId);
      this.#sessionHealth.delete(sessionId);
      await stop();
    }
    session.state = "ended";
    session.updatedAt = nowIso();
    return { found: true, session };
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
      await speakMeetViaVoiceCallGateway({
        config: this.params.config,
        callId: session.twilio.voiceCallId,
        message:
          instructions ||
          this.params.config.voiceCall.introMessage ||
          this.params.config.realtime.introMessage ||
          "",
      });
      session.twilio.introSent = true;
      session.updatedAt = nowIso();
      return { found: true, spoken: true, session };
    }
    await this.#refreshBrowserHealthForChromeSession(session);
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
        "test_speech requires mode: realtime; use join mode: transcribe for observe-only sessions.",
      );
    }
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    const beforeSessions = this.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existingSession = beforeSessions.find(
      (session) =>
        session.state === "active" &&
        isSameMeetUrlForReuse(session.url, url) &&
        session.transport === transport &&
        session.mode === "realtime",
    );
    const startOutputBytes = existingSession?.chrome?.health?.lastOutputBytes ?? 0;
    const result = await this.join({
      ...request,
      transport,
      url,
      mode: "realtime",
      message: request.message ?? "Say exactly: Google Meet speech test complete.",
    });
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
    if (request.mode === "realtime") {
      throw new Error(
        "test_listen requires mode: transcribe; use test_speech for realtime talk-back.",
      );
    }
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    if (transport === "twilio") {
      throw new Error("test_listen supports chrome or chrome-node transports");
    }
    const beforeSessions = this.list();
    const before = new Set(beforeSessions.map((session) => session.id));
    const existingSession = beforeSessions.find(
      (session) =>
        session.state === "active" &&
        isSameMeetUrlForReuse(session.url, url) &&
        session.transport === transport &&
        session.mode === "transcribe",
    );
    const start = transcriptCheckpoint(existingSession?.chrome?.health);
    const result = await this.join({
      ...request,
      transport,
      url,
      mode: "transcribe",
      message: undefined,
    });
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

  async #refreshBrowserHealthForChromeSession(session: GoogleMeetSession) {
    if (!isManagedChromeBrowserSession(session)) {
      this.#refreshSpeechReadiness(session);
      return;
    }
    if (session.mode === "realtime" && evaluateSpeechReadiness(session).ready) {
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
              url: session.url,
            })
          : await recoverCurrentMeetTab({
              config: this.params.config,
              mode: session.mode,
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

  #refreshSpeechReadiness(session: GoogleMeetSession) {
    const readiness = evaluateSpeechReadiness(session);
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
