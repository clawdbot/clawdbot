// Control UI chat module implements realtime talk behavior.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkSessionResult,
  RealtimeTalkStatus,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
  RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export type { RealtimeTalkStatus };

type RealtimeTalkLaunchOptions = {
  provider?: string;
  model?: string;
  voice?: string;
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room";
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};

type RealtimeTalkLocalOptions = {
  inputDeviceId?: string;
  videoDeviceId?: string;
};

const activeRealtimeTalkSessions = new Set<RealtimeTalkSession>();

export async function switchActiveRealtimeTalkCameras(
  videoDeviceId: string | undefined,
): Promise<void> {
  let failed = false;
  let firstError: unknown;
  await Promise.all(
    [...activeRealtimeTalkSessions].map(async (session) => {
      try {
        await session.switchCameraIfEnabled(videoDeviceId);
      } catch (error) {
        failed = true;
        firstError ??= error;
      }
    }),
  );
  if (failed) {
    throw firstError;
  }
}

type RealtimeTalkLaunchTransport = NonNullable<RealtimeTalkLaunchOptions["transport"]>;

type DetachedVoiceSession = {
  voiceSessionId: string;
  serverOwned: boolean;
  generation: number;
  transcriptWrites: Promise<void>;
};

type RealtimeTalkConfigResult = {
  config?: {
    talk?: {
      realtime?: {
        transport?: unknown;
      };
    };
  };
};

function normalizeLaunchTransport(value: unknown): RealtimeTalkLaunchTransport | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const transport = normalizeTalkTransport(value);
  if (
    transport === "webrtc" ||
    transport === "provider-websocket" ||
    transport === "gateway-relay" ||
    transport === "managed-room"
  ) {
    return transport;
  }
  return undefined;
}

function createTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveTransport(session);
  if (transport === "webrtc") {
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  const unknownTransport = (session as { transport?: string }).transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}

function resolveTransport(session: RealtimeTalkSessionResult): string {
  return normalizeTalkTransport((session as { transport?: string }).transport) ?? "webrtc";
}

function transcriptWriteError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback, { cause: error });
}

function compactLaunchParams(
  params: RealtimeTalkLaunchOptions & {
    sessionKey: string;
    voiceSessionId?: string;
    mode?: string;
    brain?: string;
  },
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

export class RealtimeTalkSession {
  private transport: RealtimeTalkTransport | null = null;
  private closed = false;
  private videoEnabled = false;
  private videoOperation = 0;
  private voiceSessionId: string | undefined;
  private transportGeneration = 0;
  private readonly transcriptSeqByVoiceSessionId = new Map<string, number>();
  private acceptingTranscripts = false;
  private serverOwnedVoiceSession = false;
  private transcriptWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
    private readonly options: RealtimeTalkLaunchOptions = {},
    private readonly localOptions: RealtimeTalkLocalOptions = {},
  ) {}

  async start(): Promise<void> {
    this.closed = false;
    this.callbacks.onStatus?.("connecting");
    const providerVideoCapable = await this.resolveVideoCapability();
    if (this.closed) {
      return;
    }
    // Declaring voice-transcript arms the server-side spoken-confirmation gate;
    // this client reports every finalized utterance, so the gate is completable.
    const capabilities: Array<"camera-frame" | "voice-transcript"> = ["voice-transcript"];
    if (providerVideoCapable) {
      capabilities.push("camera-frame");
    }
    const session = await this.createSession({ ...this.options, capabilities });
    const transport = resolveTransport(session);
    // Managed-room stays unsupported here and carries no voice bookkeeping;
    // reject it before the voice-session requirement produces a misleading error.
    if (transport === "managed-room") {
      throw new Error("Managed-room realtime Talk sessions are not available in this UI yet");
    }
    const voiceSessionId =
      session.voiceSessionId ??
      (transport === "gateway-relay"
        ? (session as RealtimeTalkGatewayRelaySessionResult).relaySessionId
        : undefined);
    if (!voiceSessionId) {
      throw new Error("Realtime Talk session did not return a voice session id");
    }
    this.voiceSessionId = voiceSessionId;
    this.acceptingTranscripts = true;
    this.serverOwnedVoiceSession = transport === "gateway-relay";
    if (this.closed) {
      const detached = this.detachVoiceSession();
      if (detached) {
        this.closeLogicalVoiceSession(detached);
      }
      return;
    }
    this.transportGeneration += 1;
    const callbacks =
      transport === "gateway-relay"
        ? this.callbacks
        : this.clientOwnedTranscriptCallbacks(voiceSessionId, this.transportGeneration);
    this.transport = createTransport(session, {
      client: this.client,
      sessionKey: this.sessionKey,
      voiceSessionId,
      flushTranscriptWrites: async () => await this.transcriptWrites,
      callbacks,
      inputDeviceId: this.localOptions.inputDeviceId,
      videoDeviceId: this.localOptions.videoDeviceId,
      consultThinkingLevel: session.consultThinkingLevel,
      consultFastMode: session.consultFastMode,
    });
    this.callbacks.onVideoCapability?.(
      providerVideoCapable && typeof this.transport.setVideoEnabled === "function",
    );
    await this.transport.start();
  }

  private async resolveVideoCapability(): Promise<boolean> {
    if (!this.callbacks.onVideoCapability) {
      return false;
    }
    try {
      const catalog = await this.client.request<TalkCatalogResult>("talk.catalog", {});
      const selectedProvider = this.options.provider ?? catalog.realtime.activeProvider;
      if (!selectedProvider) {
        return false;
      }
      return (
        catalog.realtime.providers.find(
          (provider) =>
            provider.id === selectedProvider || provider.aliases?.includes(selectedProvider),
        )?.supportsVideoFrames === true
      );
    } catch {
      return false;
    }
  }

  private async createSession(
    options: RealtimeTalkLaunchOptions & {
      capabilities?: Array<"camera-frame" | "voice-transcript">;
    },
  ): Promise<RealtimeTalkSessionResult> {
    const launchOptions = { ...options };
    try {
      return await this.client.request<RealtimeTalkSessionResult>(
        "talk.client.create",
        compactLaunchParams({
          sessionKey: this.sessionKey,
          voiceSessionId: this.voiceSessionId,
          ...launchOptions,
        }),
      );
    } catch (error) {
      let transport = launchOptions.transport;
      if (!transport) {
        let result: RealtimeTalkConfigResult;
        try {
          result = await this.client.request<RealtimeTalkConfigResult>("talk.config", {});
        } catch {
          throw error;
        }
        if (!result.config || typeof result.config !== "object") {
          throw error;
        }
        const configuredTransport = result.config?.talk?.realtime?.transport;
        if (configuredTransport !== undefined) {
          transport = normalizeLaunchTransport(configuredTransport);
          if (!transport) {
            throw error;
          }
        }
      }
      if (transport && transport !== "gateway-relay") {
        throw error;
      }
      const gatewayOptions = { ...launchOptions };
      delete gatewayOptions.capabilities;
      try {
        const relaySession = await this.client.request<RealtimeTalkSessionResult>(
          "talk.session.create",
          compactLaunchParams({
            sessionKey: this.sessionKey,
            ...gatewayOptions,
            mode: "realtime",
            transport: transport ?? "gateway-relay",
            brain: "agent-consult",
          }),
        );
        return resolveTransport(relaySession) === "gateway-relay"
          ? {
              ...relaySession,
              voiceSessionId: (relaySession as RealtimeTalkGatewayRelaySessionResult)
                .relaySessionId,
            }
          : relaySession;
      } catch {
        throw error;
      }
    }
  }

  stop(): void {
    this.closed = true;
    this.videoOperation += 1;
    this.videoEnabled = false;
    activeRealtimeTalkSessions.delete(this);
    this.callbacks.onStatus?.("idle");
    const detached = this.detachVoiceSession();
    this.transport?.stop();
    this.transport = null;
    if (detached) {
      this.closeLogicalVoiceSession(detached);
    }
  }

  private clientOwnedTranscriptCallbacks(
    owningVoiceSessionId: string,
    owningGeneration: number,
  ): RealtimeTalkCallbacks {
    return {
      ...this.callbacks,
      onTranscript: (entry) => {
        // Transport replacement can reuse the voice session id, so a retired
        // transport's late finals are fenced by generation, not id alone.
        if (
          this.transportGeneration !== owningGeneration ||
          this.voiceSessionId !== owningVoiceSessionId ||
          !this.acceptingTranscripts
        ) {
          return;
        }
        // Persist before notifying: a consumer callback that stops or throws must
        // not be able to drop an already-finalized utterance from the write tail.
        if (entry.final) {
          const transcriptSeq =
            (this.transcriptSeqByVoiceSessionId.get(owningVoiceSessionId) ?? 0) + 1;
          this.transcriptSeqByVoiceSessionId.set(owningVoiceSessionId, transcriptSeq);
          const entryId = String(transcriptSeq);
          // One promise tail preserves transcript order and makes consult flushes
          // observe the same dedupe sequence used by close.
          const write = this.transcriptWrites.then(async () => {
            await this.writeTranscriptWithRetry({
              voiceSessionId: owningVoiceSessionId,
              entryId,
              role: entry.role,
              text: entry.text,
            });
          });
          this.transcriptWrites = write.catch((error: unknown) => {
            // The utterance exists only in client memory; after retries and surfacing the error,
            // keeping the record open cannot recover it, while server entryId dedupe preserves order.
            // Deferring close would only shift the identical loss to the 6h stale sweep.
            const detail = `Voice transcript could not be saved: ${error instanceof Error ? error.message : String(error)}`;
            console.warn(detail, error);
            // Only surface to the user if this transport is still the active one; a
            // retired call's late failure must not error a healthy replacement call.
            if (this.transportGeneration === owningGeneration) {
              this.callbacks.onStatus?.("error", detail);
            }
          });
        }
        this.callbacks.onTranscript?.(entry);
      },
    };
  }

  private async writeTranscriptWithRetry(params: {
    voiceSessionId: string;
    entryId: string;
    role: "user" | "assistant";
    text: string;
  }): Promise<void> {
    const retryDelaysMs = [0, 500, 2_000];
    let lastError: unknown;
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await this.client.request("talk.client.transcript", {
          sessionKey: this.sessionKey,
          voiceSessionId: params.voiceSessionId,
          entryId: params.entryId,
          role: params.role,
          text: params.text,
          timestamp: Date.now(),
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw transcriptWriteError(lastError, "voice transcript save failed");
  }

  private detachVoiceSession(): DetachedVoiceSession | undefined {
    const voiceSessionId = this.voiceSessionId;
    if (!voiceSessionId) {
      return undefined;
    }
    const detached = {
      voiceSessionId,
      serverOwned: this.serverOwnedVoiceSession,
      generation: this.transportGeneration,
      transcriptWrites: this.transcriptWrites,
    } satisfies DetachedVoiceSession;
    this.voiceSessionId = undefined;
    this.acceptingTranscripts = false;
    this.serverOwnedVoiceSession = false;
    this.transcriptWrites = Promise.resolve();
    return detached;
  }

  private closeLogicalVoiceSession(detached: DetachedVoiceSession): void {
    if (detached.serverOwned) {
      return;
    }
    void detached.transcriptWrites
      .then(async () => {
        let lastError: unknown;
        for (const delayMs of [0, 500, 2_000]) {
          if (delayMs > 0) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, delayMs);
            });
          }
          try {
            await this.client.request("talk.client.close", {
              sessionKey: this.sessionKey,
              voiceSessionId: detached.voiceSessionId,
            });
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw transcriptWriteError(lastError, "Realtime Talk voice session close failed");
      })
      .catch((error: unknown) => {
        console.warn("Realtime Talk voice session close failed", error);
        // Suppress if a newer transport has started: closing the old call is its own
        // teardown and must not push the active replacement call into an error state.
        if (this.transportGeneration === detached.generation) {
          this.callbacks.onStatus?.("error", "Realtime Talk voice session close failed");
        }
      });
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    const transport = this.transport;
    if (this.closed || !transport?.setVideoEnabled) {
      throw new Error("Camera is unavailable for this realtime session");
    }
    const operation = ++this.videoOperation;
    const previousEnabled = this.videoEnabled;
    this.videoEnabled = enabled;
    if (enabled) {
      activeRealtimeTalkSessions.add(this);
    } else {
      activeRealtimeTalkSessions.delete(this);
    }
    try {
      await transport.setVideoEnabled(enabled);
    } catch (error) {
      if (operation === this.videoOperation && !this.closed && this.transport === transport) {
        this.videoEnabled = previousEnabled;
        if (previousEnabled) {
          activeRealtimeTalkSessions.add(this);
        } else {
          activeRealtimeTalkSessions.delete(this);
        }
      }
      throw error;
    }
    if (operation === this.videoOperation && (this.closed || this.transport !== transport)) {
      this.videoEnabled = false;
      activeRealtimeTalkSessions.delete(this);
    }
  }

  async switchCamera(videoDeviceId: string | undefined): Promise<void> {
    const normalizedDeviceId = videoDeviceId?.trim() || undefined;
    this.localOptions.videoDeviceId = normalizedDeviceId;
    if (this.closed || !this.transport?.switchCamera) {
      throw new Error("Camera switching is unavailable for this realtime session");
    }
    await this.transport.switchCamera(normalizedDeviceId);
  }

  async switchCameraIfEnabled(videoDeviceId: string | undefined): Promise<void> {
    if (!this.videoEnabled) {
      return;
    }
    try {
      await this.switchCamera(videoDeviceId);
    } catch (error) {
      this.callbacks.onVideoError?.(error);
      throw error;
    }
  }
}
