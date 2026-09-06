// Control UI chat module implements realtime talk behavior.
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../../src/talk/voice-transcript.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { RealtimeTalkInputController } from "./realtime-talk-input.ts";
import type {
  RealtimeTalkCallbacks,
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkSessionResult,
  RealtimeTalkStatus,
  RealtimeTalkTransport,
} from "./realtime-talk-shared.ts";
import {
  type ClientVoiceSessionOwner,
  ClientVoiceTranscriptQueue,
  type DetachedVoiceSession,
  reserveClientVoiceSessionOwner,
  retireUncommittedRealtimeTalkTransport,
  retryVoiceTranscriptPersistence,
} from "./realtime-talk-transcript-owner.ts";
import {
  createRealtimeTalkTransport,
  resolveRealtimeTalkTransport,
} from "./realtime-talk-transport.ts";

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
type RealtimeTalkCatalog = TalkCatalogResult["realtime"];

type RealtimeTalkConfigResult = {
  config?: {
    talk?: {
      realtime?: {
        provider?: string;
        transport?: unknown;
        providers?: Record<string, { authMethod?: unknown }>;
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

function compactLaunchParams(
  params: RealtimeTalkLaunchOptions & {
    sessionKey: string;
    mode?: string;
    brain?: string;
  },
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

export class RealtimeTalkSession {
  private transport: RealtimeTalkTransport | null = null;
  private pendingStartup: Pick<RealtimeTalkTransport, "stop"> | null = null;
  private closed = false;
  private lifecycleGeneration = 0;
  private videoEnabled = false;
  private videoOperation = 0;
  private voiceSessionId: string | undefined;
  private transportGeneration = 0;
  private transcriptItems: ClientVoiceTranscriptQueue | undefined;
  private acceptingTranscripts = false;
  private serverOwnedVoiceSession = false;
  private activeIdentityValue: string | null = null;

  get activeIdentity(): string | null {
    return this.activeIdentityValue;
  }
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
    let input: RealtimeTalkInputController | undefined;
    try {
      // Each start owns a new call. Provider allocation can retire an earlier
      // transport, so a failed start cannot restore that transport locally.
      this.retireTransport();
      const lifecycleGeneration = this.lifecycleGeneration;
      this.closed = false;
      const isCurrent = () => !this.closed && lifecycleGeneration === this.lifecycleGeneration;
      this.callbacks.onStatus?.("connecting", t("chat.voice.preparing"));
      if (!isCurrent()) {
        return;
      }
      input = new RealtimeTalkInputController(
        () => undefined,
        (detail) => this.callbacks.onStatus?.("connecting", detail),
      );
      this.pendingStartup = input;
      try {
        // Browser permission can wait indefinitely; do not spend a provider's
        // short activation window until the candidate owns its microphone.
        await input.open(this.localOptions.inputDeviceId);
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        throw error;
      }
      if (!isCurrent()) {
        return;
      }
      const catalog = await this.loadRealtimeCatalog();
      const providerVideoCapable =
        Boolean(this.callbacks.onVideoCapability) &&
        this.resolveProvider(catalog, this.options.provider)?.supportsVideoFrames === true;
      if (!isCurrent()) {
        return;
      }
      input.requireStream();
      // Declaring voice-transcript arms the server-side spoken-confirmation gate;
      // this client reports every finalized utterance, so the gate is completable.
      const capabilities: Array<"camera-frame" | "voice-transcript"> = ["voice-transcript"];
      if (providerVideoCapable) {
        capabilities.push("camera-frame");
      }
      const session = await this.createSession(
        { ...this.options, capabilities },
        catalog,
        () => isCurrent() && Boolean(input?.stream),
      );
      const transport = resolveRealtimeTalkTransport(session);
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
      if (!isCurrent()) {
        this.closeUnadoptedVoiceSession(voiceSessionId, transport, owner);
        ownerTransferred = true;
        return;
      }
      const nextTransportGeneration = lifecycleGeneration;
      if (transport !== "gateway-relay") {
        // SDP setup can already deliver provider items. The logical allocation
        // owns their queue before its still-provisional transport becomes ready.
        this.voiceSessionId = voiceSessionId;
        this.transportGeneration = nextTransportGeneration;
        this.acceptingTranscripts = true;
        this.clientVoiceSessionOwner = owner;
        ownerTransferred = true;
      }
      const closeCandidate = () => {
        if (transport === "gateway-relay") {
          this.closeUnadoptedVoiceSession(voiceSessionId, transport, owner);
        } else if (this.clientVoiceSessionOwner === owner) {
          const detached = this.detachVoiceSession();
          if (detached) {
            this.closeLogicalVoiceSession(detached);
          }
        }
      };
      const callbacks =
        transport === "gateway-relay"
          ? this.callbacks
          : this.clientOwnedTranscriptCallbacks(
              voiceSessionId,
              nextTransportGeneration,
              owner.signal,
            );
      const transcriptQueue = this.transcriptQueue;
      let nextTransport: RealtimeTalkTransport | null = null;
      let startResult: Awaited<ReturnType<RealtimeTalkTransport["start"]>>;
      try {
        input.requireStream();
        nextTransport = createRealtimeTalkTransport(session, {
          client: this.client,
          sessionKey: this.sessionKey,
          voiceSessionId,
          flushTranscriptWrites: async () => await transcriptQueue.flush(),
          callbacks,
          input,
          videoDeviceId: this.localOptions.videoDeviceId,
          consultThinkingLevel: session.consultThinkingLevel,
          consultFastMode: session.consultFastMode,
        });
        this.pendingStartup = nextTransport;
        this.callbacks.onVideoCapability?.(
          providerVideoCapable && typeof nextTransport.setVideoEnabled === "function",
        );
        startResult =
          this.pendingStartup === nextTransport ? await nextTransport.start() : "cancelled";
      } catch (error) {
        if (this.pendingStartup === nextTransport) {
          this.pendingStartup = null;
        }
        retireUncommittedRealtimeTalkTransport({
          nextTransport,
          transport,
          owner,
          closeVoiceSession: closeCandidate,
        });
        ownerTransferred = true;
        throw error;
      }
      if (this.pendingStartup === nextTransport) {
        this.pendingStartup = null;
      }
      if (startResult === "cancelled" || !isCurrent()) {
        retireUncommittedRealtimeTalkTransport({
          nextTransport,
          transport,
          owner,
          closeVoiceSession: closeCandidate,
        });
        ownerTransferred = true;
        return;
      }
      this.transport = nextTransport;
      const unknown = t("common.unknown");
      this.activeIdentityValue = t("talkPage.activeIdentity", {
        provider: session.provider,
        model: session.model ?? unknown,
        auth: session.transport === "webrtc" ? (session.authMethod ?? unknown) : unknown,
        voice: session.voice ?? unknown,
        transport,
      });
      if (transport === "gateway-relay") {
        this.voiceSessionId = voiceSessionId;
        this.transportGeneration = nextTransportGeneration;
        this.acceptingTranscripts = true;
        this.serverOwnedVoiceSession = true;
        owner.release();
      }
      ownerTransferred = true;
      try {
        // Publish before releasing bounded events buffered during startup.
        nextTransport.activate?.();
      } catch (error) {
        if (this.transport === nextTransport) {
          this.retireTransport();
        }
        throw error;
      }
    } finally {
      if (input && this.pendingStartup === input) {
        this.pendingStartup = null;
        input.stop();
      }
      if (!ownerTransferred) {
        owner.release();
      }
    }
  }

  private async loadRealtimeCatalog(): Promise<RealtimeTalkCatalog | undefined> {
    try {
      const catalog = await this.client.request<TalkCatalogResult>(
        "talk.catalog",
        {},
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
      return catalog.realtime;
    } catch {
      return undefined;
    }
  }

  private resolveProvider(catalog: RealtimeTalkCatalog | undefined, providerId?: string) {
    const selected = (providerId?.trim() || catalog?.activeProvider)?.toLowerCase();
    return selected
      ? (catalog?.providers.find((provider) => provider.id === selected) ??
          catalog?.providers.find((provider) => provider.aliases?.includes(selected)))
      : undefined;
  }

  private async createSession(
    launchOptions: RealtimeTalkLaunchOptions & {
      capabilities?: Array<"camera-frame" | "voice-transcript">;
    },
    catalog: RealtimeTalkCatalog | undefined,
    canRecover: () => boolean,
  ): Promise<RealtimeTalkSessionResult> {
    try {
      return await this.client.request<RealtimeTalkSessionResult>(
        "talk.client.create",
        compactLaunchParams({
          sessionKey: this.sessionKey,
          ...launchOptions,
        }),
        { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      let transport = launchOptions.transport;
      if (!transport && canRecover()) {
        let result: RealtimeTalkConfigResult;
        const realtimeProvider = launchOptions.provider?.trim();
        try {
          result = await this.client.request<RealtimeTalkConfigResult>(
            "talk.config",
            realtimeProvider ? { realtimeProvider } : {},
            { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
          );
        } catch {
          throw error;
        }
        if (!result.config || typeof result.config !== "object") {
          throw error;
        }
        const configuredRealtime = result.config?.talk?.realtime;
        const configuredTransport = configuredRealtime?.transport;
        // Scope strict auth to this call's canonical provider, not inactive legacy
        // rows. Unknown selection stays fail-closed; resolved Auto can recover.
        const provider = this.resolveProvider(
          catalog,
          launchOptions.provider?.trim() || configuredRealtime?.provider,
        );
        const providers = configuredRealtime?.providers ?? {};
        const strictAuthSelected = provider
          ? providers[provider.id]?.authMethod !== undefined
          : Object.values(providers).some((entry) => entry.authMethod !== undefined);
        transport =
          configuredTransport === undefined && !strictAuthSelected
            ? "gateway-relay"
            : normalizeLaunchTransport(configuredTransport);
      }
      // Recovery starts a new allocation: stopped/replaced calls or lost input cannot admit it.
      if (transport !== "gateway-relay" || !canRecover()) {
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
            transport,
            brain: "agent-consult",
          }),
          { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
        );
        return resolveRealtimeTalkTransport(relaySession) === "gateway-relay"
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
    try {
      this.retireTransport();
    } finally {
      this.callbacks.onStatus?.("idle");
    }
  }

  private retireTransport(): void {
    this.lifecycleGeneration += 1;
    this.closed = true;
    this.activeIdentityValue = null;
    this.videoOperation += 1;
    this.videoEnabled = false;
    activeRealtimeTalkSessions.delete(this);
    const detached = this.detachVoiceSession();
    const transport = this.transport;
    this.transport = null;
    try {
      this.stopPendingStartup();
    } finally {
      try {
        transport?.stop();
      } finally {
        if (detached) {
          this.closeLogicalVoiceSession(detached);
        }
      }
    }
  }

  private stopPendingStartup(): void {
    const pending = this.pendingStartup;
    this.pendingStartup = null;
    pending?.stop({ emitClosed: false });
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
    const transcripts = new ClientVoiceTranscriptQueue(
      this.transcriptQueue,
      (entryId, role, text) =>
        this.writeTranscriptWithRetry({
          voiceSessionId: owningVoiceSessionId,
          entryId,
          role,
          text,
          signal: transcriptSignal,
        }),
      (error) => {
        if (transcriptSignal.aborted) {
          return;
        }
        const detail = `Voice transcript could not be saved: ${formatUiError(error)}`;
        console.warn(detail, error);
        if (this.transportGeneration === owningGeneration) {
          this.callbacks.onStatus?.("error", detail);
        }
      },
    );
    this.transcriptItems = transcripts;
    const isCurrent = () =>
      this.transportGeneration === owningGeneration &&
      this.voiceSessionId === owningVoiceSessionId &&
      this.acceptingTranscripts;
    return {
      ...this.callbacks,
      onTalkEvent: (event) => {
        try {
          // A transport's terminal event owns cleanup, even while its error stays
          // visible. Retired transports cannot close a newer call.
          if (
            event.type === "session.closed" &&
            this.transportGeneration === owningGeneration &&
            this.voiceSessionId === owningVoiceSessionId &&
            this.acceptingTranscripts
          ) {
            this.retireTransport();
          }
        } finally {
          this.callbacks.onTalkEvent?.(event);
        }
      },
      onTranscriptItem: (item) => {
        if (!isCurrent()) {
          return;
        }
        let orders;
        try {
          orders = transcripts.observe(item);
        } catch (error) {
          this.failTranscriptPersistence(owningGeneration, formatUiError(error));
          return;
        }
        if (orders.length > 0) {
          this.callbacks.onTranscriptOrder?.(orders);
        }
      },
      onTranscript: (entry) => {
        // Retired transports cannot append into a restarted call's write queue.
        if (!isCurrent()) {
          return;
        }
        // Persist before notifying: a consumer callback that stops or throws must
        // not be able to drop an already-finalized utterance from the write tail.
        let published;
        try {
          published = transcripts.publish(entry);
        } catch (error) {
          this.failTranscriptPersistence(owningGeneration, formatUiError(error));
          return;
        }
        if (published) {
          this.callbacks.onTranscript?.(published);
        }
      },
    };
  }

  private failTranscriptPersistence(
    owningGeneration: number,
    detail: string = VOICE_TRANSCRIPT_QUEUE_POLICY.overflowMessage,
  ): void {
    if (
      this.transportGeneration !== owningGeneration ||
      !this.acceptingTranscripts ||
      !this.voiceSessionId
    ) {
      return;
    }
    this.retireTransport();
    // Retire the overflowing transport before accepted-write and close failures
    // settle so the first terminal persistence error keeps precedence.
    this.transportGeneration += 1;
    console.warn(detail);
    this.callbacks.onStatus?.("error", detail);
  }

  private async writeTranscriptWithRetry(params: {
    voiceSessionId: string;
    entryId: string;
    role: "user" | "assistant";
    text: string;
    signal: AbortSignal;
  }): Promise<void> {
    await retryVoiceTranscriptPersistence(
      params.signal,
      () =>
        this.client.request(
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
        ),
      "voice transcript save failed",
    );
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
    const missingItems = this.transcriptItems?.close() ?? [];
    this.transcriptItems = undefined;
    detached.transcriptQueue.seal();
    this.voiceSessionId = undefined;
    this.acceptingTranscripts = false;
    this.serverOwnedVoiceSession = false;
    this.transcriptQueue = VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue();
    this.clientVoiceSessionOwner = undefined;
    if (missingItems.length > 0) {
      const message = `Voice call closed with ${missingItems.length} unfinished transcript item(s); finalized speech was preserved.`;
      console.warn(message);
    }
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
      .then(() =>
        retryVoiceTranscriptPersistence(
          owner.closeSignal,
          () =>
            this.client.request(
              "talk.client.close",
              {
                sessionKey: this.sessionKey,
                voiceSessionId: detached.voiceSessionId,
              },
              {
                signal: owner.closeSignal,
                timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
              },
            ),
          "Realtime Talk voice session close failed",
        ),
      )
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
