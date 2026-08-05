import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import type {
  SpeechProviderPlugin,
  SpeechSynthesisStreamRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import {
  assertXaiRealtimeVoiceRequestSupported,
  createXaiImageGenerationProviderMetadata,
  createXaiMediaUnderstandingProviderMetadata,
  createXaiRealtimeTranscriptionProviderMetadata,
  createXaiRealtimeVoiceProviderMetadata,
  createXaiVideoGenerationProviderMetadata,
  normalizeXaiRealtimeTranscriptionProviderConfig,
} from "./capability-provider-metadata.js";
import { createXaiSpeechProviderMetadata } from "./speech-provider-metadata.js";

const MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_LAZY_REALTIME_VOICE_USER_MESSAGES = 128;
const MAX_LAZY_REALTIME_VOICE_USER_MESSAGE_BYTES = 256 * 1024;
const MAX_LAZY_REALTIME_VOICE_TOOL_RESULTS = 128;
const MAX_LAZY_REALTIME_VOICE_TOOL_RESULT_BYTES = 256 * 1024;

function serializedJsonBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

const loadXaiImageGenerationProvider = createLazyRuntimeModule(async () =>
  (await import("./image-generation-provider.js")).buildXaiImageGenerationProvider(),
);
const loadXaiMediaUnderstandingProvider = createLazyRuntimeModule(async () =>
  (await import("./stt.js")).buildXaiMediaUnderstandingProvider(),
);
const loadXaiRealtimeTranscriptionProvider = createLazyRuntimeModule(async () =>
  (await import("./realtime-transcription-provider.js")).buildXaiRealtimeTranscriptionProvider(),
);
const loadXaiRealtimeVoiceProvider = createLazyRuntimeModule(async () =>
  (await import("./realtime-voice-provider.js")).buildXaiRealtimeVoiceProvider(),
);
const loadXaiSpeechProvider = createLazyRuntimeModule(async () =>
  (await import("./speech-provider.js")).buildXaiSpeechProvider(),
);
const loadXaiVideoGenerationProvider = createLazyRuntimeModule(async () =>
  (await import("./video-generation-provider.js")).buildXaiVideoGenerationProvider(),
);

function createPendingTranscriptionAudioQueue(): {
  clear: () => void;
  drain: () => Buffer[];
  enqueue: (audio: Buffer) => void;
} {
  let chunks: Array<Buffer | undefined> = [];
  let head = 0;
  let bytes = 0;
  const clear = () => {
    chunks = [];
    head = 0;
    bytes = 0;
  };
  return {
    clear,
    drain: () => {
      const pending = chunks.slice(head).filter((chunk): chunk is Buffer => chunk !== undefined);
      clear();
      return pending;
    },
    enqueue: (audio) => {
      if (audio.byteLength > MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES) {
        return;
      }
      const chunk = Buffer.from(audio);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      while (bytes > MAX_LAZY_REALTIME_TRANSCRIPTION_AUDIO_BYTES && head < chunks.length) {
        const dropped = chunks[head];
        chunks[head] = undefined;
        head += 1;
        bytes -= dropped?.byteLength ?? 0;
      }
      if (head > 256 && head * 2 >= chunks.length) {
        chunks = chunks.slice(head);
        head = 0;
      }
    },
  };
}

function createLazyXaiRealtimeTranscriptionSession(
  req: RealtimeTranscriptionSessionCreateRequest,
): RealtimeTranscriptionSession {
  let session: RealtimeTranscriptionSession | undefined;
  let sessionPromise: Promise<RealtimeTranscriptionSession> | undefined;
  let activeConnect:
    | {
        generation: number;
        promise: Promise<void>;
      }
    | undefined;
  let generation = 0;
  let closedSessionGeneration: number | undefined;
  let closed = false;
  let acceptsInput = false;
  const pendingAudio = createPendingTranscriptionAudioQueue();

  const closeSession = (
    closeGeneration: number,
    loadedSession: RealtimeTranscriptionSession | undefined = session,
  ) => {
    if (!loadedSession || closedSessionGeneration === closeGeneration) {
      return;
    }
    closedSessionGeneration = closeGeneration;
    loadedSession.close();
  };
  const loadSession = async () => {
    if (!sessionPromise) {
      sessionPromise = loadXaiRealtimeTranscriptionProvider().then((provider) =>
        provider.createSession(req),
      );
    }
    session = await sessionPromise;
    return session;
  };
  const beginConnectGeneration = () => {
    if (closed) {
      generation += 1;
      closed = false;
    }
    return generation;
  };

  return {
    connect: async () => {
      const connectGeneration = beginConnectGeneration();
      if (activeConnect?.generation === connectGeneration) {
        await activeConnect.promise;
        return;
      }
      const promise = (async () => {
        const loadedSession = await loadSession();
        if (connectGeneration !== generation || closed) {
          if (connectGeneration === generation && closed) {
            closeSession(connectGeneration, loadedSession);
          }
          return;
        }
        for (const audio of pendingAudio.drain()) {
          loadedSession.sendAudio(audio);
        }
        acceptsInput = true;
        await loadedSession.connect();
        if (connectGeneration === generation && closed) {
          closeSession(connectGeneration, loadedSession);
        }
      })();
      const connectTask = { generation: connectGeneration, promise };
      activeConnect = connectTask;
      try {
        await promise;
      } finally {
        if (activeConnect === connectTask) {
          activeConnect = undefined;
        }
      }
    },
    sendAudio: (audio) => {
      if (closed) {
        return;
      }
      if (acceptsInput && session) {
        session.sendAudio(audio);
        return;
      }
      pendingAudio.enqueue(audio);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      acceptsInput = false;
      pendingAudio.clear();
      closeSession(generation);
    },
    isConnected: () => !closed && (session?.isConnected() ?? false),
  };
}

function createLazyXaiRealtimeVoiceBridge(
  req: RealtimeVoiceBridgeCreateRequest,
): RealtimeVoiceBridge {
  assertXaiRealtimeVoiceRequestSupported(req);
  type PendingVoiceOperation =
    | { type: "audio" }
    | { timestamp: number; type: "media-timestamp" }
    | { bytes: number; text: string; type: "user-message" }
    | { instructions?: string; type: "greeting" }
    | {
        bytes: number;
        callId: string;
        options?: RealtimeVoiceToolResultOptions;
        result: unknown;
        type: "tool-result";
      };
  type PendingMediaTimestamp = Extract<PendingVoiceOperation, { type: "media-timestamp" }>;
  type PendingVoiceGreeting = Extract<PendingVoiceOperation, { type: "greeting" }>;

  let bridge: RealtimeVoiceBridge | undefined;
  let bridgeState:
    | {
        generation: number;
        promise: Promise<RealtimeVoiceBridge>;
      }
    | undefined;
  let activeConnect:
    | {
        generation: number;
        promise: Promise<void>;
      }
    | undefined;
  let generation = 0;
  let terminalGeneration: number | undefined;
  let closed = false;
  let acceptsInput = false;
  let pendingMediaTimestamp: PendingMediaTimestamp | undefined;
  let pendingGreeting: PendingVoiceGreeting | undefined;
  let pendingUserMessageCount = 0;
  let pendingUserMessageBytes = 0;
  let pendingToolResultCount = 0;
  let pendingToolResultBytes = 0;
  const closedBridges = new WeakSet<RealtimeVoiceBridge>();
  const pendingAudio = createRealtimeVoiceAudioQueue("reject-newest");
  const pendingOperations: PendingVoiceOperation[] = [];

  const clearPendingInput = () => {
    pendingAudio.clear();
    pendingOperations.length = 0;
    pendingMediaTimestamp = undefined;
    pendingGreeting = undefined;
    pendingUserMessageCount = 0;
    pendingUserMessageBytes = 0;
    pendingToolResultCount = 0;
    pendingToolResultBytes = 0;
  };
  const emitTerminal = (
    terminalForGeneration: number,
    outcome: Parameters<NonNullable<RealtimeVoiceBridgeCreateRequest["onClose"]>>[0],
  ) => {
    if (terminalForGeneration !== generation || terminalGeneration === terminalForGeneration) {
      return;
    }
    terminalGeneration = terminalForGeneration;
    acceptsInput = false;
    clearPendingInput();
    req.onClose?.(outcome);
  };
  const closeBridge = (loadedBridge: RealtimeVoiceBridge | undefined = bridge) => {
    if (!loadedBridge || closedBridges.has(loadedBridge)) {
      return;
    }
    closedBridges.add(loadedBridge);
    loadedBridge.close();
  };
  const acceptsProviderCallback = (callbackGeneration: number) =>
    callbackGeneration === generation && !closed && terminalGeneration !== callbackGeneration;
  const guardProviderCallback = <TArgs extends unknown[]>(
    callbackGeneration: number,
    callback: (...args: TArgs) => void,
  ) => {
    return (...args: TArgs) => {
      if (acceptsProviderCallback(callbackGeneration)) {
        callback(...args);
      }
    };
  };
  const loadBridge = async (loadGeneration: number) => {
    const existingState = bridgeState;
    const state =
      existingState?.generation === loadGeneration
        ? existingState
        : {
            generation: loadGeneration,
            promise: loadXaiRealtimeVoiceProvider().then((provider) =>
              provider.createBridge({
                ...req,
                // An explicit wrapper reconnect owns a new provider bridge. Guard every
                // nonterminal callback so late events cannot reach its replacement.
                onAudio: guardProviderCallback(loadGeneration, req.onAudio),
                onClearAudio: guardProviderCallback(loadGeneration, req.onClearAudio),
                ...(req.onMark
                  ? { onMark: guardProviderCallback(loadGeneration, req.onMark) }
                  : {}),
                ...(req.onTranscript
                  ? { onTranscript: guardProviderCallback(loadGeneration, req.onTranscript) }
                  : {}),
                ...(req.onEvent
                  ? { onEvent: guardProviderCallback(loadGeneration, req.onEvent) }
                  : {}),
                ...(req.onToolCall
                  ? { onToolCall: guardProviderCallback(loadGeneration, req.onToolCall) }
                  : {}),
                ...(req.onReady
                  ? { onReady: guardProviderCallback(loadGeneration, req.onReady) }
                  : {}),
                ...(req.onError
                  ? { onError: guardProviderCallback(loadGeneration, req.onError) }
                  : {}),
                onClose: (outcome) => emitTerminal(loadGeneration, outcome),
              }),
            ),
          };
    if (state !== existingState) {
      bridgeState = state;
    }
    const loadedBridge = await state.promise;
    if (bridgeState === state && loadGeneration === generation) {
      bridge = loadedBridge;
    }
    return loadedBridge;
  };
  const replacePendingOperation = <T extends PendingVoiceOperation>(
    previous: T | undefined,
    next: T,
  ): T => {
    if (previous) {
      const previousIndex = pendingOperations.indexOf(previous);
      if (previousIndex >= 0) {
        pendingOperations.splice(previousIndex, 1);
      }
    }
    pendingOperations.push(next);
    return next;
  };
  const beginConnectGeneration = () => {
    if (closed || terminalGeneration === generation) {
      generation += 1;
      closed = false;
      acceptsInput = false;
      bridge = undefined;
    }
    return generation;
  };
  const acceptsCurrentInput = () => !closed && terminalGeneration !== generation;
  const flushPendingInput = async (
    loadedBridge: RealtimeVoiceBridge,
    connectGeneration: number,
  ) => {
    if (connectGeneration !== generation || !acceptsCurrentInput()) {
      return;
    }
    while (true) {
      if (connectGeneration !== generation || !acceptsCurrentInput()) {
        return;
      }
      const operation = pendingOperations.shift();
      if (!operation) {
        // Queue exhaustion and direct admission must change in the same turn.
        // An await between them can strand input admitted by the next microtask.
        acceptsInput = true;
        return;
      }
      switch (operation.type) {
        case "audio": {
          const chunk = pendingAudio.dequeue();
          if (!chunk) {
            throw new Error("xAI realtime voice pending audio queue invariant violated");
          }
          loadedBridge.sendAudio(chunk);
          break;
        }
        case "media-timestamp":
          if (pendingMediaTimestamp === operation) {
            pendingMediaTimestamp = undefined;
          }
          loadedBridge.setMediaTimestamp(operation.timestamp);
          break;
        case "user-message":
          loadedBridge.sendUserMessage?.(operation.text);
          break;
        case "tool-result":
          await loadedBridge.submitToolResult(
            operation.callId,
            operation.result,
            operation.options,
          );
          break;
        case "greeting":
          if (pendingGreeting === operation) {
            pendingGreeting = undefined;
          }
          loadedBridge.triggerGreeting?.(operation.instructions);
          break;
      }
      if (connectGeneration !== generation || !acceptsCurrentInput()) {
        return;
      }
      if (operation.type === "user-message") {
        pendingUserMessageCount -= 1;
        pendingUserMessageBytes -= operation.bytes;
      } else if (operation.type === "tool-result") {
        pendingToolResultCount -= 1;
        pendingToolResultBytes -= operation.bytes;
      }
    }
  };

  return {
    get supportsToolResultContinuation() {
      return bridge?.supportsToolResultContinuation ?? false;
    },
    connect: async () => {
      const connectGeneration = beginConnectGeneration();
      if (activeConnect?.generation === connectGeneration) {
        await activeConnect.promise;
        return;
      }
      const promise = (async () => {
        const loadedBridge = await loadBridge(connectGeneration);
        if (connectGeneration !== generation || !acceptsCurrentInput()) {
          closeBridge(loadedBridge);
          return;
        }
        try {
          await loadedBridge.connect();
        } catch (error) {
          if (connectGeneration === generation) {
            acceptsInput = false;
            terminalGeneration = connectGeneration;
            clearPendingInput();
          }
          throw error;
        }
        if (connectGeneration !== generation || !acceptsCurrentInput()) {
          closeBridge(loadedBridge);
          return;
        }
        try {
          await flushPendingInput(loadedBridge, connectGeneration);
        } catch (error) {
          emitTerminal(connectGeneration, "error");
          closeBridge(loadedBridge);
          throw error;
        }
        if (connectGeneration !== generation || !acceptsCurrentInput()) {
          closeBridge(loadedBridge);
        }
      })();
      const connectTask = { generation: connectGeneration, promise };
      activeConnect = connectTask;
      try {
        await promise;
      } finally {
        if (activeConnect === connectTask) {
          activeConnect = undefined;
        }
      }
    },
    sendAudio: (audio) => {
      if (!acceptsCurrentInput()) {
        return;
      }
      if (acceptsInput && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      if (pendingAudio.enqueue(audio)) {
        pendingOperations.push({ type: "audio" });
      }
    },
    setMediaTimestamp: (timestamp) => {
      if (!acceptsCurrentInput()) {
        return;
      }
      if (acceptsInput && bridge) {
        bridge.setMediaTimestamp(timestamp);
        return;
      }
      pendingMediaTimestamp = replacePendingOperation(pendingMediaTimestamp, {
        timestamp,
        type: "media-timestamp",
      });
    },
    sendUserMessage: (text) => {
      if (!acceptsCurrentInput()) {
        return;
      }
      if (acceptsInput && bridge) {
        bridge.sendUserMessage?.(text);
        return;
      }
      const messageBytes = Buffer.byteLength(text, "utf8");
      if (
        pendingUserMessageCount >= MAX_LAZY_REALTIME_VOICE_USER_MESSAGES ||
        pendingUserMessageBytes + messageBytes > MAX_LAZY_REALTIME_VOICE_USER_MESSAGE_BYTES
      ) {
        req.onError?.(
          new Error("xAI realtime voice pending user message overflow during lazy startup"),
        );
        return;
      }
      pendingOperations.push({
        bytes: messageBytes,
        text,
        type: "user-message",
      });
      pendingUserMessageCount += 1;
      pendingUserMessageBytes += messageBytes;
    },
    triggerGreeting: (instructions) => {
      if (!acceptsCurrentInput()) {
        return;
      }
      if (acceptsInput && bridge) {
        bridge.triggerGreeting?.(instructions);
        return;
      }
      pendingGreeting = replacePendingOperation(pendingGreeting, {
        instructions,
        type: "greeting",
      });
    },
    handleBargeIn: (options) => {
      if (acceptsCurrentInput()) {
        bridge?.handleBargeIn?.(options);
      }
    },
    submitToolResult: (callId, result, options) => {
      if (!acceptsCurrentInput()) {
        return;
      }
      if (acceptsInput && bridge) {
        return bridge.submitToolResult(callId, result, options);
      }
      const pending = { callId, result, ...(options ? { options } : {}) };
      const resultBytes = serializedJsonBytes(pending);
      if (
        resultBytes === undefined ||
        pendingToolResultCount >= MAX_LAZY_REALTIME_VOICE_TOOL_RESULTS ||
        pendingToolResultBytes + resultBytes > MAX_LAZY_REALTIME_VOICE_TOOL_RESULT_BYTES
      ) {
        req.onError?.(
          new Error("xAI realtime voice pending tool result overflow during lazy startup"),
        );
        return;
      }
      pendingOperations.push({
        ...pending,
        bytes: resultBytes,
        type: "tool-result",
      });
      pendingToolResultCount += 1;
      pendingToolResultBytes += resultBytes;
    },
    acknowledgeMark: (markName) => {
      if (acceptsCurrentInput()) {
        bridge?.acknowledgeMark(markName);
      }
    },
    close: () => {
      if (closed) {
        return;
      }
      const closeGeneration = generation;
      closed = true;
      acceptsInput = false;
      clearPendingInput();
      closeBridge();
      // A bridge closed before its first connect has no provider-owned
      // connection to report the terminal outcome.
      emitTerminal(closeGeneration, "completed");
    },
    isConnected: () => acceptsCurrentInput() && (bridge?.isConnected() ?? false),
  };
}

export function createLazyXaiImageGenerationProvider(): ImageGenerationProvider {
  return {
    ...createXaiImageGenerationProviderMetadata(),
    generateImage: async (req) => (await loadXaiImageGenerationProvider()).generateImage(req),
  };
}

export function createLazyXaiMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    ...createXaiMediaUnderstandingProviderMetadata(),
    transcribeAudio: async (req) => {
      const provider = await loadXaiMediaUnderstandingProvider();
      if (!provider.transcribeAudio) {
        throw new Error("xAI media understanding provider missing transcribeAudio");
      }
      return await provider.transcribeAudio(req);
    },
  };
}

export function createLazyXaiVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createXaiVideoGenerationProviderMetadata(),
    generateVideo: async (req) => (await loadXaiVideoGenerationProvider()).generateVideo(req),
  };
}

export function createLazyXaiSpeechProvider(): SpeechProviderPlugin {
  return {
    ...createXaiSpeechProviderMetadata(),
    listVoices: async (req) => {
      const provider = await loadXaiSpeechProvider();
      if (!provider.listVoices) {
        throw new Error("xAI speech provider missing listVoices");
      }
      return await provider.listVoices(req);
    },
    synthesize: async (req) => await (await loadXaiSpeechProvider()).synthesize(req),
    streamSynthesize: async (req: SpeechSynthesisStreamRequest) => {
      const provider = await loadXaiSpeechProvider();
      if (!provider.streamSynthesize) {
        throw new Error("xAI speech provider missing streamSynthesize");
      }
      return await provider.streamSynthesize(req);
    },
    synthesizeTelephony: async (req: SpeechTelephonySynthesisRequest) => {
      const provider = await loadXaiSpeechProvider();
      if (!provider.synthesizeTelephony) {
        throw new Error("xAI speech provider missing synthesizeTelephony");
      }
      return await provider.synthesizeTelephony(req);
    },
  };
}

export function createLazyXaiRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    ...createXaiRealtimeTranscriptionProviderMetadata(),
    createSession: (req) => {
      // Preserve synchronous config validation even though transport code loads on connect().
      normalizeXaiRealtimeTranscriptionProviderConfig(req.providerConfig);
      return createLazyXaiRealtimeTranscriptionSession(req);
    },
  };
}

export function createLazyXaiRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    ...createXaiRealtimeVoiceProviderMetadata(),
    createBridge: createLazyXaiRealtimeVoiceBridge,
  };
}
