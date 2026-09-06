import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveRealtimeBootstrapContextInstructions } from "openclaw/plugin-sdk/realtime-bootstrap-context";
import {
  createRealtimeVoiceBridgeSession,
  createTalkSessionController,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  recordRealtimeVoiceTranscript,
  recordTalkObservabilityEvent,
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceResponseOutcome,
  type RealtimeVoiceTranscriptEntry,
  type TalkEvent,
  type TalkEventInput,
} from "openclaw/plugin-sdk/realtime-voice";
import { startFaceTimeAudioPump } from "./audio-pump.js";
import type { FaceTimeConfig } from "./config.js";
import { createFaceTimeConsultController } from "./talk-consult-controller.js";
import {
  agentIdFromSessionKey,
  assertAuthenticatedSenderConsultSupport,
  buildRealtimeInstructions,
  FACETIME_END_CALL_TOOL,
  INPUT_AUDIO_STATUS_INTERVAL_MS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_ENTRY_CHARS,
  REALTIME_READY_TIMEOUT_MS,
  resolveFaceTimeRealtimeProvider,
} from "./talk-driver-config.js";

export type FaceTimeTalkDriver = {
  readonly callUUID: string;
  readonly recentTalkEvents: readonly TalkEvent[];
  readyForAudio(): Promise<void>;
  processOutputSuppressed(): boolean;
  realtimeActive(): boolean;
  activate(): void;
  suspendMedia(reason?: string): Promise<void>;
  failClosed(reason?: string): Promise<void>;
  close(reason?: string): Promise<void>;
};

export async function startFaceTimeTalkDriver(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  callUUID: string;
  senderId: string;
  senderIsOwner: true;
  captureBinary: string;
  signal?: AbortSignal;
  onHangupRequested: () => Promise<void>;
  onFailure?: (error: Error) => boolean | Promise<boolean>;
}): Promise<FaceTimeTalkDriver> {
  if (params.signal?.aborted) {
    throw new Error("FaceTime talk startup aborted");
  }
  // Fail closed before the call is answered; older hosts silently ignore the
  // owner fields and would otherwise create a privilege-downgrade footgun.
  assertAuthenticatedSenderConsultSupport();
  const consultAgentId = agentIdFromSessionKey(
    params.config.realtime.sessionKey,
    params.fullConfig,
  );
  const normalizedCallUUID = params.callUUID.trim().toLowerCase();
  const consultSessionKey = `agent:${consultAgentId}:facetime:${normalizedCallUUID}`;
  const requesterSessionKey = params.config.realtime.sessionKey.startsWith("agent:")
    ? params.config.realtime.sessionKey
    : `agent:${consultAgentId}:${params.config.realtime.sessionKey}`;
  const talk = createTalkSessionController(
    {
      sessionId: `facetime:${params.callUUID}`,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.config.realtime.provider,
      maxRecentEvents: 40,
      turnIdPrefix: `facetime:${params.callUUID}:turn`,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const transcript: RealtimeVoiceTranscriptEntry[] = [];
  const appendTranscript = (entry: Pick<RealtimeVoiceTranscriptEntry, "role" | "text">) => {
    recordRealtimeVoiceTranscript(
      transcript,
      entry.role,
      entry.text.slice(0, MAX_TRANSCRIPT_ENTRY_CHARS),
      40,
    );
    while (
      transcript.reduce((total, current) => total + current.text.length, 0) > MAX_TRANSCRIPT_CHARS
    ) {
      transcript.shift();
    }
  };
  let stopped = false;
  let mediaSuspended = false;
  let bridge: RealtimeVoiceBridgeSession | undefined;
  let lastInputAudioStatusAt = 0;
  let callMediaTimestampMs = 0;
  let modelMediaGeneration = 1;
  let responseGeneration = 0;
  let response:
    | {
        id?: string;
        generation: number;
        startTimestampMs: number;
        playbackStartFrame: number;
        outcome?: RealtimeVoiceResponseOutcome;
      }
    | undefined;
  const settledResponseIds = new Set<string>();
  let suppressNextUnkeyedLegacyTerminal = false;
  const consultRef: { current?: ReturnType<typeof createFaceTimeConsultController> } = {};
  let failurePromise: Promise<boolean> | undefined;
  let activated = false;
  let providerReady = false;
  const providerReadyDeferred = createDeferred<void>();
  let providerConnectPromise: Promise<void> | undefined;
  let audioReadyPromise: Promise<void> | undefined;
  let interruptProviderConnect: (() => void) | undefined;
  let mediaSuspensionError: Error | undefined;
  const mediaSuspendedDeferred = createDeferred<never>();
  const mediaSuspendedPromise = mediaSuspendedDeferred.promise;
  void mediaSuspendedPromise.catch(() => {});
  let suspendMediaPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let startupSettled = false;
  let startupFailure: Error | undefined;
  const startupFailureDeferred = createDeferred<never>();
  const startupFailurePromise = startupFailureDeferred.promise;
  // A provider or audio callback can fail while connect() is still pending.
  // Keep that failure observable until startup either rejects or returns a live driver.
  void startupFailurePromise.catch(() => {});

  const signalStartupFailure = (error: Error) => {
    if (startupSettled || startupFailure) {
      return;
    }
    startupFailure = error;
    startupFailureDeferred.reject(error);
  };

  const reportFailure = (error: Error): Promise<boolean> => {
    if (failurePromise) {
      return failurePromise;
    }
    failurePromise = Promise.resolve(params.onFailure?.(error)).then((safeToClose) => {
      return safeToClose !== false;
    });
    return failurePromise;
  };

  const suspendMedia = async (reason = "suspended") => {
    if (suspendMediaPromise) {
      return await suspendMediaPromise;
    }
    // Set the terminal media state before touching the provider. Its close
    // callback must not report a second failure or restart any media path.
    mediaSuspended = true;
    activated = false;
    providerReady = false;
    mediaSuspensionError ??= new Error(`FaceTime model media suspended: ${reason}`);
    mediaSuspendedDeferred.reject(mediaSuspensionError);
    interruptProviderConnect?.();
    consultRef.current?.abortForClose();
    suspendMediaPromise = (async () => {
      try {
        bridge?.close();
      } catch (error) {
        params.logger.debug?.(
          `[facetime] realtime bridge close ignored: ${formatErrorMessage(error)}`,
        );
      }
      try {
        await pump?.suspendMedia();
      } catch (error) {
        // The logical media gates above are already terminal. Native cleanup
        // failure must not prevent carrier safety reporting or final teardown.
        params.logger.warn?.(
          `[facetime] native media suspension failed: ${formatErrorMessage(error)}`,
        );
      }
      resetResponsePlayback();
      finishOutputAudio(reason);
    })();
    return await suspendMediaPromise;
  };

  const close = async (reason = "closed") => {
    if (closePromise) {
      return await closePromise;
    }
    closePromise = (async () => {
      const mediaStop = suspendMedia(reason);
      stopped = true;
      try {
        await mediaStop;
      } finally {
        try {
          await pump?.stop();
        } finally {
          remember({ type: "session.closed", payload: { reason }, final: true });
        }
      }
    })();
    return await closePromise;
  };

  const remember = (input: TalkEventInput) => talk.emit(input);
  const ensureTurn = () => {
    const turn = talk.ensureTurn({ payload: { callUUID: params.callUUID } });
    return turn.turnId;
  };
  const finishOutputAudio = (reason: string) => {
    talk.finishOutputAudio({ payload: { reason } });
  };
  const endTurn = (reason: string) => {
    const ended = talk.endTurn({ payload: { reason } });
    return ended.ok;
  };
  const playedCurrentResponseMs = () =>
    response === undefined
      ? 0
      : Math.max(0, ((pump?.playedAudioFrames() ?? 0) - response.playbackStartFrame) / 24);
  const resetResponsePlayback = () => {
    response = undefined;
  };
  const finishDrainedResponse = () => {
    const current = response;
    if (!current || current.outcome?.status !== "completed") {
      return;
    }
    callMediaTimestampMs = Math.max(
      callMediaTimestampMs,
      current.startTimestampMs + playedCurrentResponseMs(),
    );
    bridge?.setMediaTimestamp(Math.floor(callMediaTimestampMs));
    rememberSettledResponse(current.id);
    resetResponsePlayback();
    finishOutputAudio("playback-drained");
    endTurn("completed");
  };
  const rememberSettledResponse = (responseId: string | undefined) => {
    if (!responseId) {
      return;
    }
    settledResponseIds.add(responseId);
    if (settledResponseIds.size > 64) {
      const oldest = settledResponseIds.values().next().value;
      if (oldest) {
        settledResponseIds.delete(oldest);
      }
    }
  };
  const startResponse = (responseId?: string) => {
    if (response && responseId && response.id === responseId) {
      return;
    }
    if (response && responseId && !response.id) {
      response.id = responseId;
      return;
    }
    if (response) {
      pump?.clearOutputAudio();
      finishOutputAudio("response-superseded");
      endTurn("response-superseded");
    }
    response = {
      id: responseId,
      generation: ++responseGeneration,
      startTimestampMs: callMediaTimestampMs,
      playbackStartFrame: pump?.playedAudioFrames() ?? 0,
    };
    bridge?.setMediaTimestamp(Math.floor(callMediaTimestampMs));
  };
  const finishResponseOutcome = (outcome: RealtimeVoiceResponseOutcome, typed: boolean) => {
    if (outcome.responseId && settledResponseIds.has(outcome.responseId)) {
      return;
    }
    if (outcome.responseId && response?.id && outcome.responseId !== response.id) {
      return;
    }
    if (!response) {
      startResponse(outcome.responseId);
    }
    if (!response) {
      return;
    }
    response.outcome = outcome;
    if (!outcome.responseId && typed) {
      suppressNextUnkeyedLegacyTerminal = true;
    }
    if (outcome.status === "completed") {
      if ((pump?.queuedAudioFrames() ?? 0) > 0) {
        pump?.finishOutputAudio();
      } else {
        finishDrainedResponse();
      }
      return;
    }
    pump?.clearOutputAudio();
    if (outcome.status === "failed" || outcome.status === "incomplete") {
      remember({ type: "session.error", payload: outcome, final: true });
    }
    rememberSettledResponse(outcome.responseId);
    finishOutputAudio(outcome.status);
    endTurn(outcome.status);
    resetResponsePlayback();
  };
  const resetProviderContinuity = () => {
    modelMediaGeneration += 1;
    consultRef.current?.abortForClose();
    pump?.clearOutputAudio();
    resetResponsePlayback();
    finishOutputAudio("continuity-reset");
    endTurn("continuity-reset");
  };
  const consultController = createFaceTimeConsultController({
    config: params.config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    consultAgentId,
    consultSessionKey,
    requesterSessionKey,
    normalizedCallUUID,
    senderId: params.senderId,
    senderIsOwner: params.senderIsOwner,
    transcript,
    getBridge: () => bridge,
    getGeneration: () => modelMediaGeneration,
    isUnavailable: () => stopped || mediaSuspended,
    ensureTurn,
    remember,
    suspendMedia,
    reportFailure,
    close,
    onHangupRequested: params.onHangupRequested,
  });
  consultRef.current = consultController;

  remember({ type: "session.started", payload: { callUUID: params.callUUID } });
  const pump = startFaceTimeAudioPump({
    captureBinary: params.captureBinary,
    logger: params.logger,
    onInputAudio(audio) {
      if (stopped || mediaSuspended || !activated) {
        return;
      }
      callMediaTimestampMs += audio.byteLength / 2 / 24;
      if (!talk.outputAudioActive) {
        bridge?.setMediaTimestamp(Math.floor(callMediaTimestampMs));
      }
      const now = Date.now();
      if (now - lastInputAudioStatusAt >= INPUT_AUDIO_STATUS_INTERVAL_MS) {
        lastInputAudioStatusAt = now;
        remember({
          type: "input.audio.delta",
          turnId: ensureTurn(),
          payload: { byteLength: audio.byteLength },
        });
      }
      bridge?.sendAudio(audio);
    },
    onSuppressionLost(error) {
      void reportFailure(error);
    },
    async onError(error) {
      signalStartupFailure(error);
      remember({
        type: "session.error",
        payload: { message: formatErrorMessage(error) },
        final: true,
      });
      await suspendMedia("audio-error");
      const safeToClose = await reportFailure(error);
      if (safeToClose) {
        await close("audio-error");
      }
      return safeToClose;
    },
    onPlaybackDrained() {
      finishDrainedResponse();
    },
  });
  try {
    await Promise.race([pump.suppressionReady(), startupFailurePromise]);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    await suspendMedia("capture-start-failed");
    const safeToClose = startupFailure === normalized ? await reportFailure(normalized) : true;
    if (safeToClose) {
      await close("capture-start-failed");
    }
    throw error;
  }
  const connectProvider = async () => {
    if (providerConnectPromise) {
      return await providerConnectPromise;
    }
    providerConnectPromise = (async () => {
      let removeAbortListener: (() => void) | undefined;
      let readinessTimer: NodeJS.Timeout | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        const interrupt = () => reject(new Error("FaceTime talk startup aborted"));
        interruptProviderConnect = interrupt;
        params.signal?.addEventListener("abort", interrupt, { once: true });
        removeAbortListener = () => params.signal?.removeEventListener("abort", interrupt);
        if (params.signal?.aborted || stopped || mediaSuspended) {
          interrupt();
        }
      });
      const readinessTimedOut = new Promise<never>((_resolve, reject) => {
        readinessTimer = setTimeout(() => {
          reject(new Error("Realtime provider was not ready within 15 seconds"));
        }, REALTIME_READY_TIMEOUT_MS);
        readinessTimer.unref?.();
      });
      const prepareAndConnect = async () => {
        const providerResolution = resolveFaceTimeRealtimeProvider({
          config: params.config,
          fullConfig: params.fullConfig,
          agentId: consultAgentId,
        });
        const bootstrapContextResolution = resolveRealtimeBootstrapContextInstructions({
          config: params.fullConfig,
          agentId: consultAgentId,
          sessionKey: requesterSessionKey,
          warn: (message) =>
            params.logger.warn?.(`[facetime] realtime bootstrap context: ${message}`),
        }).catch((error: unknown) => {
          params.logger.warn?.(
            `[facetime] realtime bootstrap context unavailable: ${formatErrorMessage(error)}`,
          );
          return undefined;
        });
        const [resolved, bootstrapContext] = await Promise.all([
          providerResolution,
          bootstrapContextResolution,
        ]);
        if (params.signal?.aborted || stopped || mediaSuspended) {
          throw new Error("FaceTime talk startup aborted");
        }
        bridge = createRealtimeVoiceBridgeSession({
          provider: resolved.provider,
          providerConfig: resolved.providerConfig,
          audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
          // Configured voice/personality instructions remain customizable, but the
          // authoritative-agent boundary must not disappear when they are replaced.
          instructions: buildRealtimeInstructions({
            instructions: params.config.realtime.instructions,
            bootstrapContext,
            toolPolicy: params.config.realtime.toolPolicy,
          }),
          autoRespondToAudio: true,
          triggerGreetingOnReady: false,
          initialGreetingInstructions: "Greet the caller briefly and say you are listening.",
          markStrategy: "ack-immediately",
          tools: resolveRealtimeVoiceAgentConsultTools(params.config.realtime.toolPolicy, [
            FACETIME_END_CALL_TOOL,
          ]),
          audioSink: {
            isOpen: () => !stopped && !mediaSuspended,
            sendAudio(audio) {
              if (stopped || mediaSuspended) {
                return;
              }
              const turnId = ensureTurn();
              if (!response) {
                startResponse();
              }
              talk.startOutputAudio({ turnId, payload: { callUUID: params.callUUID } });
              remember({
                type: "output.audio.delta",
                turnId,
                payload: { byteLength: audio.byteLength },
              });
              pump?.writeOutputAudio(audio);
            },
            clearAudio() {
              if (stopped || mediaSuspended) {
                return;
              }
              pump?.clearOutputAudio();
              resetResponsePlayback();
              finishOutputAudio("clear");
            },
          },
          onTranscript(role, text, final) {
            if (stopped || mediaSuspended) {
              return;
            }
            const turnId = ensureTurn();
            remember({
              type:
                role === "assistant"
                  ? final
                    ? "output.text.done"
                    : "output.text.delta"
                  : final
                    ? "transcript.done"
                    : "transcript.delta",
              turnId,
              payload: role === "assistant" ? { text } : { role, text },
              final,
            });
            if (role === "user" && final) {
              remember({
                type: "input.audio.committed",
                turnId,
                payload: { callUUID: params.callUUID },
                final: true,
              });
            }
            if (final) {
              appendTranscript({ role, text });
            }
          },
          onEvent(event) {
            if (stopped || mediaSuspended) {
              return;
            }
            if (!(event.direction === "client" && event.type === "input_audio_buffer.append")) {
              remember({
                type: "health.changed",
                payload: {
                  name: `${event.direction}:${event.type}`,
                  message: event.detail,
                },
              });
            }
            if (event.type === "input_audio_buffer.speech_started") {
              // A caller follow-up supersedes any consult started for the previous
              // utterance. Close its provider tool call immediately so a slow agent
              // cannot block the new turn, then ignore its eventual settlement.
              consultController.cancelPending();
              const playbackActive = response !== undefined && (pump?.queuedAudioFrames() ?? 0) > 0;
              if (response) {
                bridge?.setMediaTimestamp(
                  Math.floor(response.startTimestampMs + playedCurrentResponseMs()),
                );
              }
              bridge?.handleBargeIn({ audioPlaybackActive: playbackActive });
              if (playbackActive || talk.outputAudioActive) {
                pump?.clearOutputAudio();
                finishOutputAudio("barge-in");
              }
              resetResponsePlayback();
            } else if (event.type === "response.created") {
              startResponse(event.responseId);
            } else if (event.type === "session.continuity.reset") {
              resetProviderContinuity();
            } else if (event.type === "response.done") {
              if (!event.responseId && suppressNextUnkeyedLegacyTerminal) {
                suppressNextUnkeyedLegacyTerminal = false;
              } else {
                finishResponseOutcome(
                  {
                    status: "completed",
                    ...(event.responseId ? { responseId: event.responseId } : {}),
                  },
                  false,
                );
              }
            } else if (event.type === "error") {
              remember({
                type: "session.error",
                payload: { message: event.detail ?? "Realtime provider error" },
                final: true,
              });
            }
          },
          onResponseDone(outcome) {
            finishResponseOutcome(outcome, true);
          },
          onToolCall: consultController.handleToolCall,
          onReady() {
            if (!stopped && !mediaSuspended) {
              remember({ type: "session.ready", payload: { callUUID: params.callUUID } });
              providerReadyDeferred.resolve();
            }
          },
          onError(error) {
            if (stopped || mediaSuspended) {
              return;
            }
            remember({
              type: "session.error",
              payload: { message: formatErrorMessage(error) },
              final: true,
            });
            params.logger.warn(`[facetime] realtime bridge failed: ${formatErrorMessage(error)}`);
            if (!providerReady && !startupSettled) {
              signalStartupFailure(error);
            }
          },
          onClose(reason) {
            if (stopped || mediaSuspended) {
              return;
            }
            finishOutputAudio(reason);
            remember({ type: "session.closed", payload: { reason }, final: true });
            const error = new Error(`Realtime bridge closed unexpectedly: ${reason}`);
            signalStartupFailure(error);
            void (async () => {
              await suspendMedia("provider-closed");
              const safeToClose = await reportFailure(error);
              if (safeToClose) {
                await close("provider-closed");
              }
            })();
          },
        });
        await bridge.connect();
      };
      try {
        // Provider connect() may return before the server's setup-complete
        // event. onReady is the contract that the session can accept audio.
        await Promise.race([
          Promise.all([prepareAndConnect(), providerReadyDeferred.promise]),
          startupFailurePromise,
          interrupted,
          readinessTimedOut,
        ]);
        if (startupFailure) {
          throw startupFailure;
        }
        if (params.signal?.aborted || stopped || mediaSuspended) {
          throw new Error("FaceTime talk startup aborted");
        }
        startupSettled = true;
        providerReady = true;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        await suspendMedia(
          params.signal?.aborted || stopped ? "startup-aborted" : "connect-failed",
        );
        const safeToClose =
          params.signal?.aborted || stopped ? true : await reportFailure(normalized);
        if (safeToClose) {
          await close(params.signal?.aborted || stopped ? "startup-aborted" : "connect-failed");
        }
        throw normalized;
      } finally {
        if (readinessTimer) {
          clearTimeout(readinessTimer);
        }
        interruptProviderConnect = undefined;
        removeAbortListener?.();
      }
    })();
    return await providerConnectPromise;
  };
  return {
    callUUID: params.callUUID,
    get recentTalkEvents() {
      return talk.recentEvents;
    },
    async readyForAudio() {
      audioReadyPromise ??= connectProvider().then(async () => {
        await Promise.race([pump?.routeReady(), mediaSuspendedPromise]);
        // A route-ready callback can race with safety suspension. Never let an
        // already-waiting runtime resume carrier transmission afterward.
        if (mediaSuspended || stopped) {
          throw mediaSuspensionError ?? new Error("FaceTime model media is unavailable");
        }
      });
      await audioReadyPromise;
    },
    processOutputSuppressed() {
      return pump?.processOutputSuppressed() ?? false;
    },
    realtimeActive() {
      return providerReady && !mediaSuspended && !stopped;
    },
    activate() {
      if (stopped || mediaSuspended || !providerReady || activated) {
        return;
      }
      activated = true;
      bridge?.triggerGreeting("Greet the caller briefly and say you are listening.");
    },
    suspendMedia,
    async failClosed(reason = "fail-closed") {
      mediaSuspended = true;
      stopped = true;
      activated = false;
      providerReady = false;
      consultController.abortForClose();
      bridge?.close();
      await pump?.failClosed();
      remember({ type: "session.closed", payload: { reason }, final: true });
    },
    close,
  };
}
