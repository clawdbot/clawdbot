import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import { getGoogleMeetSetupStatus } from "./setup.js";
import { launchChromeMeet, launchChromeMeetOnNode } from "./transports/chrome.js";
import { buildMeetDtmfSequence, normalizeDialInNumber } from "./transports/twilio.js";
import type {
  GoogleMeetJoinRequest,
  GoogleMeetJoinResult,
  GoogleMeetSession,
} from "./transports/types.js";
import { endMeetVoiceCallGatewayCall, joinMeetViaVoiceCallGateway } from "./voice-call-gateway.js";

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

export class GoogleMeetRuntime {
  readonly #sessions = new Map<string, GoogleMeetSession>();
  readonly #sessionStops = new Map<string, () => Promise<void>>();
  readonly #sessionSpeakers = new Map<string, (instructions?: string) => void>();

  constructor(
    private readonly params: {
      config: GoogleMeetConfig;
      fullConfig: OpenClawConfig;
      runtime: PluginRuntime;
      logger: RuntimeLogger;
    },
  ) {}

  list(): GoogleMeetSession[] {
    return [...this.#sessions.values()].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  status(sessionId?: string): {
    found: boolean;
    session?: GoogleMeetSession;
    sessions?: GoogleMeetSession[];
  } {
    if (!sessionId) {
      return { found: true, sessions: this.list() };
    }
    const session = this.#sessions.get(sessionId);
    return session ? { found: true, session } : { found: false };
  }

  setupStatus() {
    return getGoogleMeetSetupStatus(this.params.config);
  }

  async join(request: GoogleMeetJoinRequest): Promise<GoogleMeetJoinResult> {
    const url = normalizeMeetUrl(request.url);
    const transport = resolveTransport(request.transport, this.params.config);
    const mode = resolveMode(request.mode, this.params.config);
    const createdAt = nowIso();

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
        };
        if (
          result.audioBridge?.type === "command-pair" ||
          result.audioBridge?.type === "node-command-pair"
        ) {
          this.#sessionStops.set(session.id, result.audioBridge.stop);
          this.#sessionSpeakers.set(session.id, result.audioBridge.speak);
        }
        session.notes.push(
          result.audioBridge
            ? transport === "chrome-node"
              ? "Chrome node transport joins as the signed-in Google profile on the selected node and routes realtime audio through the node bridge."
              : "Chrome transport joins as the signed-in Google profile and routes realtime audio through the configured bridge."
            : "Chrome transport joins as the signed-in Google profile and expects BlackHole 2ch audio routing.",
        );
      } else {
        const dialInNumber = normalizeDialInNumber(
          request.dialInNumber ?? this.params.config.twilio.defaultDialInNumber,
        );
        if (!dialInNumber) {
          throw new Error("dialInNumber required for twilio transport");
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
            })
          : undefined;
        session.twilio = {
          dialInNumber,
          pinProvided: Boolean(request.pin ?? this.params.config.twilio.defaultPin),
          dtmfSequence,
          voiceCallId: voiceCallResult?.callId,
          dtmfSent: voiceCallResult?.dtmfSent,
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
            ? "Twilio transport delegated the call to the voice-call plugin and sent configured DTMF."
            : "Twilio transport is an explicit dial plan; voice-call delegation is disabled.",
        );
      }
    } catch (err) {
      this.params.logger.warn(`[google-meet] join failed: ${formatErrorMessage(err)}`);
      throw err;
    }

    this.#sessions.set(session.id, session);
    return { session };
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
      await stop();
    }
    session.state = "ended";
    session.updatedAt = nowIso();
    return { found: true, session };
  }

  speak(
    sessionId: string,
    instructions?: string,
  ): { found: boolean; spoken: boolean; session?: GoogleMeetSession } {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return { found: false, spoken: false };
    }
    const speak = this.#sessionSpeakers.get(sessionId);
    if (!speak || session.state !== "active") {
      return { found: true, spoken: false, session };
    }
    speak(instructions || this.params.config.realtime.introMessage);
    session.updatedAt = nowIso();
    return { found: true, spoken: true, session };
  }
}
