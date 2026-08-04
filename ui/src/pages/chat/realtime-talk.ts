// Control UI chat module implements realtime talk behavior.
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import {
  normalizeVoiceTranscriptText,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "../../../../src/talk/voice-transcript.js";
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
import {
  type ClientVoiceSessionOwner,
  type DetachedVoiceSession,
  reserveClientVoiceSessionOwner,
  retireUncommittedRealtimeTalkTransport,
  transcriptPersistenceAbortError,
  waitForTranscriptRetry,
} from "./realtime-talk-transcript-owner.ts";
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
  private pendingTransport: RealtimeTalkTransport | null = null;
  private closed = false;
  private lifecycleGeneration = 0;
  private videoEnabled = false;
  private videoOperation = 0;
  private voiceSessionId: string | undefined;
  private transportGeneration = 0;
  private readonly transcriptSeqByVoiceSessionId = new Map<string, number>();
  private acceptingTranscripts = false;
  private serverOwnedVoiceSession = false;
  private transcriptQueue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
  private clientVoiceSessionOwner: ClientVoiceSessionOwner | undefined;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    private readonly callbacks: RealtimeTalkCallbacks = {},
    private readonly options: RealtimeTalkLaunchOptions = {},
    private readonly localOptions: RealtimeTalkLocalOptions = {},
  ) {}

  async start(): Promise<void> {
    const owner = reserveClientVoiceSessionOwner(this.client, this.sessionKey);
    let ownerTransferred = false;
    try {
      const lifecycleGeneration = ++this.lifecycleGeneration;
      this.stopPendingTransport();
      this.closed = false;
      this.callbacks.onStatus?.("connecting");
      const existingTransport = this.transport;
      const existingVoiceSessionId = this.voiceSessionId;
      const existingOwner = this.clientVoiceSessionOwner;
      const existingAcceptingTranscripts = this.acceptingTranscripts;
      const existingServerOwnedVoiceSession = this.serverOwnedVoiceSession;
      const existingTransportGeneration = this.transportGeneration;
      const providerVideoCapable = await this.resolveVideoCapability();
      if (this.closed || lifecycleGeneration !== this.lifecycleGeneration) {
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
      if (this.closed || lifecycleGeneration !== this.lifecycleGeneration) {
        this.closeUnadoptedVoiceSession(voiceSessionId, transport, owner);
        ownerTransferred = true;
        return;
      }
      if (
        existingOwner &&
        (transport === "gateway-relay" || voiceSessionId !== existingVoiceSessionId)
      ) {
        this.closeUnadoptedVoiceSession(voiceSessionId, transport, owner);
        ownerTransferred = true;
        throw new Error("Realtime Talk replacement changed the active voice session");
      }
      const adoptedOwner =
        existingOwner && voiceSessionId === existingVoiceSessionId ? existingOwner : owner;
      if (adoptedOwner !== owner) {
        owner.release();
      }
      // Candidate generations must be unique without retiring the committed transport.
      // Overlapping starts can then fence every superseded candidate independently.
      const nextTransportGeneration = lifecycleGeneration;
      const callbacks =
        transport === "gateway-relay"
          ? this.callbacks
          : this.clientOwnedTranscriptCallbacks(
              voiceSessionId,
              nextTransportGeneration,
              adoptedOwner.signal,
            );
      const transcriptQueue = this.transcriptQueue;
      let nextTransport: RealtimeTalkTransport | null = null;
      let startResult: Awaited<ReturnType<RealtimeTalkTransport["start"]>>;
      try {
        nextTransport = createTransport(session, {
          client: this.client,
          sessionKey: this.sessionKey,
          voiceSessionId,
          flushTranscriptWrites: async () => await transcriptQueue.flush(),
          callbacks,
          inputDeviceId: this.localOptions.inputDeviceId,
          videoDeviceId: this.localOptions.videoDeviceId,
          consultThinkingLevel: session.consultThinkingLevel,
          consultFastMode: session.consultFastMode,
        });
        this.pendingTransport = nextTransport;
        this.callbacks.onVideoCapability?.(
          providerVideoCapable && typeof nextTransport.setVideoEnabled === "function",
        );
        startResult = await nextTransport.start();
      } catch (error) {
        if (this.pendingTransport === nextTransport) {
          this.pendingTransport = null;
        }
        retireUncommittedRealtimeTalkTransport({
          nextTransport,
          transport,
          owner: adoptedOwner,
          reusesExistingOwner: Boolean(existingOwner && adoptedOwner === existingOwner),
          closeVoiceSession: () =>
            this.closeUnadoptedVoiceSession(voiceSessionId, transport, adoptedOwner),
        });
        ownerTransferred = true;
        throw error;
      }
      if (this.pendingTransport === nextTransport) {
        this.pendingTransport = null;
      }
      if (
        startResult === "cancelled" ||
        this.closed ||
        lifecycleGeneration !== this.lifecycleGeneration
      ) {
        retireUncommittedRealtimeTalkTransport({
          nextTransport,
          transport,
          owner: adoptedOwner,
          reusesExistingOwner: Boolean(existingOwner && adoptedOwner === existingOwner),
          closeVoiceSession: () =>
            this.closeUnadoptedVoiceSession(voiceSessionId, transport, adoptedOwner),
        });
        ownerTransferred = true;
        return;
      }
      this.voiceSessionId = voiceSessionId;
      this.acceptingTranscripts = true;
      this.serverOwnedVoiceSession = transport === "gateway-relay";
      this.transportGeneration = nextTransportGeneration;
      this.transport = nextTransport;
      if (this.serverOwnedVoiceSession) {
        owner.release();
        this.clientVoiceSessionOwner = undefined;
      } else {
        this.clientVoiceSessionOwner = adoptedOwner;
      }
      try {
        // Publish the candidate before releasing bounded events buffered during permission.
        nextTransport.activate?.();
      } catch (error) {
        const canRestoreExistingTransport =
          !this.closed &&
          lifecycleGeneration === this.lifecycleGeneration &&
          this.transport === nextTransport;
        if (canRestoreExistingTransport) {
          this.voiceSessionId = existingVoiceSessionId;
          this.acceptingTranscripts = existingAcceptingTranscripts;
          this.serverOwnedVoiceSession = existingServerOwnedVoiceSession;
          this.transportGeneration = existingTransportGeneration;
          this.transport = existingTransport;
          this.clientVoiceSessionOwner = existingOwner;
          retireUncommittedRealtimeTalkTransport({
            nextTransport,
            transport,
            owner: adoptedOwner,
            reusesExistingOwner: Boolean(existingOwner && adoptedOwner === existingOwner),
            closeVoiceSession: () =>
              this.closeUnadoptedVoiceSession(voiceSessionId, transport, adoptedOwner),
          });
        } else {
          // Stop or supersession wins activation and owns allocation cleanup.
          if (this.transport === nextTransport) {
            nextTransport.stop({ emitClosed: false });
          }
          existingTransport?.stop({ emitClosed: false });
        }
        ownerTransferred = true;
        throw error;
      }
      ownerTransferred = true;
      existingTransport?.stop({ emitClosed: false });
    } finally {
      if (!ownerTransferred) {
        owner.release();
      }
    }
  }

  private async resolveVideoCapability(): Promise<boolean> {
    if (!this.callbacks.onVideoCapability) {
      return false;
    }
    try {
      const catalog = await this.client.request<TalkCatalogResult>(
        "talk.catalog",
        {},
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
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
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      let transport = launchOptions.transport;
      if (!transport) {
        let result: RealtimeTalkConfigResult;
        try {
          result = await this.client.request<RealtimeTalkConfigResult>(
            "talk.config",
            {},
            { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
          );
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
          { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
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
    this.lifecycleGeneration += 1;
    this.closed = true;
    this.videoOperation += 1;
    this.videoEnabled = false;
    activeRealtimeTalkSessions.delete(this);
    this.callbacks.onStatus?.("idle");
    this.stopPendingTransport();
    const detached = this.detachVoiceSession();
    this.transport?.stop();
    this.transport = null;
    if (detached) {
      this.closeLogicalVoiceSession(detached);
    }
  }

  private stopPendingTransport(): void {
    const pendingTransport = this.pendingTransport;
    this.pendingTransport = null;
    pendingTransport?.stop({ emitClosed: false });
  }

  private closeUnadoptedVoiceSession(
    voiceSessionId: string,
    transport: string,
    owner: ClientVoiceSessionOwner,
  ): void {
    // A stopped or superseded create still owns the allocation returned to it.
    // Close at the provider boundary without installing a stale transport.
    if (transport === "gateway-relay") {
      void this.client
        .request(
          "talk.session.close",
          { sessionId: voiceSessionId },
          { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
        )
        .catch(() => undefined)
        .finally(owner.release);
      return;
    }
    const transcriptQueue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
    transcriptQueue.seal();
    this.closeLogicalVoiceSession({
      voiceSessionId,
      serverOwned: false,
      transcriptQueue,
      owner,
    });
  }

  private clientOwnedTranscriptCallbacks(
    owningVoiceSessionId: string,
    owningGeneration: number,
    transcriptSignal: AbortSignal,
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
          const entryId = String(transcriptSeq);
          const role = entry.role;
          const text = normalizeVoiceTranscriptText(entry.text);
          if (text) {
            const admission = this.transcriptQueue.enqueue(
              async () =>
                await this.writeTranscriptWithRetry({
                  voiceSessionId: owningVoiceSessionId,
                  entryId,
                  role,
                  text,
                  signal: transcriptSignal,
                }),
              { weight: text.length },
            );
            if (!admission.accepted) {
              if (admission.reason === "overflow") {
                this.failTranscriptPersistence(owningGeneration);
              }
              return;
            }
            this.transcriptSeqByVoiceSessionId.set(owningVoiceSessionId, transcriptSeq);
            void admission.completion.catch((error: unknown) => {
              if (transcriptSignal.aborted) {
                return;
              }
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
        }
        this.callbacks.onTranscript?.(entry);
      },
    };
  }

  private failTranscriptPersistence(owningGeneration: number): void {
    if (
      this.transportGeneration !== owningGeneration ||
      !this.acceptingTranscripts ||
      !this.voiceSessionId
    ) {
      return;
    }
    this.lifecycleGeneration += 1;
    this.closed = true;
    this.videoOperation += 1;
    this.videoEnabled = false;
    activeRealtimeTalkSessions.delete(this);
    this.stopPendingTransport();
    const detached = this.detachVoiceSession();
    // Retire the overflowing transport before accepted-write and close failures
    // settle so the first terminal persistence error keeps precedence.
    this.transportGeneration += 1;
    this.transport?.stop();
    this.transport = null;
    console.warn(VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    this.callbacks.onStatus?.("error", VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage);
    if (detached) {
      this.closeLogicalVoiceSession(detached);
    }
  }

  private async writeTranscriptWithRetry(params: {
    voiceSessionId: string;
    entryId: string;
    role: "user" | "assistant";
    text: string;
    signal: AbortSignal;
  }): Promise<void> {
    const retryDelaysMs = [0, 500, 2_000];
    let lastError: unknown;
    for (const delayMs of retryDelaysMs) {
      if (delayMs > 0) {
        await waitForTranscriptRetry(delayMs, params.signal);
      } else if (params.signal.aborted) {
        throw transcriptPersistenceAbortError();
      }
      try {
        await this.client.request(
          "talk.client.transcript",
          {
            sessionKey: this.sessionKey,
            voiceSessionId: params.voiceSessionId,
            entryId: params.entryId,
            role: params.role,
            text: params.text,
            timestamp: Date.now(),
          },
          {
            signal: params.signal,
            timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
          },
        );
        return;
      } catch (error) {
        if (params.signal.aborted) {
          throw transcriptPersistenceAbortError();
        }
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
      transcriptQueue: this.transcriptQueue,
      owner: this.clientVoiceSessionOwner,
    } satisfies DetachedVoiceSession;
    detached.transcriptQueue.seal();
    this.transcriptSeqByVoiceSessionId.delete(voiceSessionId);
    this.voiceSessionId = undefined;
    this.acceptingTranscripts = false;
    this.serverOwnedVoiceSession = false;
    this.transcriptQueue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
    this.clientVoiceSessionOwner = undefined;
    return detached;
  }

  private closeLogicalVoiceSession(detached: DetachedVoiceSession): void {
    if (detached.serverOwned) {
      detached.owner?.release();
      return;
    }
    const owner = detached.owner!;
    owner.beginDrain();
    void detached.transcriptQueue
      .flush()
      .then(async () => {
        let lastError: unknown;
        for (const delayMs of [0, 500, 2_000]) {
          if (delayMs > 0) {
            await waitForTranscriptRetry(delayMs, owner.closeSignal);
          } else if (owner.closeSignal.aborted) {
            throw transcriptPersistenceAbortError();
          }
          try {
            await this.client.request(
              "talk.client.close",
              {
                sessionKey: this.sessionKey,
                voiceSessionId: detached.voiceSessionId,
              },
              {
                signal: owner.closeSignal,
                timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
              },
            );
            return;
          } catch (error) {
            if (owner.closeSignal.aborted) {
              throw transcriptPersistenceAbortError();
            }
            lastError = error;
          }
        }
        throw transcriptWriteError(lastError, "Realtime Talk voice session close failed");
      })
      .catch((error: unknown) => {
        if (owner.closeSignal.aborted) {
          return;
        }
        console.warn("Realtime Talk voice session close failed", error);
        // Suppress if a newer transport has started: closing the old call is its own
        // teardown and must not push the active replacement call into an error state.
        if (this.transportGeneration === detached.generation) {
          this.callbacks.onStatus?.("error", "Realtime Talk voice session close failed");
        }
      })
      .finally(owner.release);
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
