import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
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

function collectChromeAudioCommands(config: GoogleMeetConfig): string[] {
  const commands = config.chrome.audioBridgeCommand
    ? [config.chrome.audioBridgeCommand[0]]
    : [config.chrome.audioInputCommand?.[0], config.chrome.audioOutputCommand?.[0]];
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

  status(sessionId?: string): {
    found: boolean;
    session?: GoogleMeetSession;
    sessions?: GoogleMeetSession[];
  } {
    this.#refreshHealth(sessionId);
    if (!sessionId) {
      return { found: true, sessions: this.list() };
    }
    const session = this.#sessions.get(sessionId);
    return session ? { found: true, session } : { found: false };
  }

  async setupStatus(options: { transport?: GoogleMeetTransport } = {}) {
    const transport = resolveTransport(options.transport, this.params.config);
    const shouldCheckChromeNode =
      transport === "chrome-node" ||
      (!options.transport && Boolean(this.params.config.chromeNode.node));
    let status = getGoogleMeetSetupStatus(this.params.config, {
      fullConfig: this.params.fullConfig,
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
    if (transport === "chrome") {
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
    if (reusable) {
      reusable.notes = [
        ...reusable.notes.filter((note) => note !== "Reused existing active Meet session."),
        "Reused existing active Meet session.",
      ];
      reusable.updatedAt = nowIso();
      if (request.message || this.params.config.realtime.introMessage) {
        this.speak(reusable.id, request.message);
      }
      return { session: reusable };
    }
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
    if (mode === "realtime" && this.params.config.realtime.introMessage) {
      this.speak(session.id, request.message);
    }
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
      this.#sessionHealth.delete(sessionId);
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
    session: GoogleMeetSession;
  }> {
    const before = new Set(this.list().map((session) => session.id));
    const result = await this.join(request);
    const spoken = this.speak(
      result.session.id,
      request.message ?? "Say exactly: Google Meet speech test complete.",
    ).spoken;
    const health = result.session.chrome?.health;
    return {
      createdSession: !before.has(result.session.id),
      inCall: health?.inCall,
      manualActionRequired: health?.manualActionRequired,
      manualActionReason: health?.manualActionReason,
      manualActionMessage: health?.manualActionMessage,
      spoken,
      session: result.session,
    };
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
    }
  }
}
