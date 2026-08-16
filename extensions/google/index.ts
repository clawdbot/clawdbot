// Google plugin entrypoint registers its OpenClaw integration.
import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { adaptMemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { MusicGenerationProvider } from "openclaw/plugin-sdk/music-generation";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import {
  createGoogleMusicGenerationProviderMetadata,
  createGoogleVideoGenerationProviderMetadata,
} from "./generation-provider-metadata.js";
import { geminiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { registerGoogleProvider } from "./provider-registration.js";
import { buildGoogleSpeechProvider } from "./speech-provider.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

let googleImageGenerationProviderPromise: Promise<ImageGenerationProvider> | null = null;
let googleMediaUnderstandingProviderPromise: Promise<MediaUnderstandingProvider> | null = null;
let googleMusicGenerationProviderPromise: Promise<MusicGenerationProvider> | null = null;
let googleRealtimeVoiceProviderPromise: Promise<RealtimeVoiceProviderPlugin> | null = null;
let googleVideoGenerationProviderPromise: Promise<VideoGenerationProvider> | null = null;

type GoogleMediaUnderstandingProvider = Required<
  Pick<
    MediaUnderstandingProvider,
    "describeImage" | "describeImages" | "transcribeAudio" | "describeVideo"
  >
>;

async function loadGoogleImageGenerationProvider(): Promise<ImageGenerationProvider> {
  if (!googleImageGenerationProviderPromise) {
    googleImageGenerationProviderPromise = import("./image-generation-provider.js").then((mod) =>
      mod.buildGoogleImageGenerationProvider(),
    );
  }
  return await googleImageGenerationProviderPromise;
}

async function loadGoogleMediaUnderstandingProvider(): Promise<MediaUnderstandingProvider> {
  if (!googleMediaUnderstandingProviderPromise) {
    googleMediaUnderstandingProviderPromise = import("./media-understanding-provider.js").then(
      (mod) => mod.googleMediaUnderstandingProvider,
    );
  }
  return await googleMediaUnderstandingProviderPromise;
}

async function loadGoogleMusicGenerationProvider(): Promise<MusicGenerationProvider> {
  if (!googleMusicGenerationProviderPromise) {
    googleMusicGenerationProviderPromise = import("./music-generation-provider.js").then((mod) =>
      mod.buildGoogleMusicGenerationProvider(),
    );
  }
  return await googleMusicGenerationProviderPromise;
}

async function loadGoogleRealtimeVoiceProvider(): Promise<RealtimeVoiceProviderPlugin> {
  if (!googleRealtimeVoiceProviderPromise) {
    googleRealtimeVoiceProviderPromise = import("./realtime-voice-provider.js").then((mod) =>
      mod.buildGoogleRealtimeVoiceProvider(),
    );
  }
  return await googleRealtimeVoiceProviderPromise;
}

async function loadGoogleVideoGenerationProvider(): Promise<VideoGenerationProvider> {
  if (!googleVideoGenerationProviderPromise) {
    googleVideoGenerationProviderPromise = import("./video-generation-provider.js").then((mod) =>
      mod.buildGoogleVideoGenerationProvider(),
    );
  }
  return await googleVideoGenerationProviderPromise;
}

async function loadGoogleRequiredMediaUnderstandingProvider(): Promise<GoogleMediaUnderstandingProvider> {
  const provider = await loadGoogleMediaUnderstandingProvider();
  if (
    !provider.describeImage ||
    !provider.describeImages ||
    !provider.transcribeAudio ||
    !provider.describeVideo
  ) {
    throw new Error("google media understanding provider missing required handlers");
  }
  return provider as GoogleMediaUnderstandingProvider;
}

function createLazyGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: "gemini-3.1-flash-image",
    models: ["gemini-3.1-flash-image", "gemini-3-pro-image"],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: ["1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"],
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    generateImage: async (req) => (await loadGoogleImageGenerationProvider()).generateImage(req),
  };
}

function createLazyGoogleMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "google",
    capabilities: ["image", "audio", "video"],
    defaultModels: {
      image: "gemini-3-flash-preview",
      audio: "gemini-3-flash-preview",
      video: "gemini-3-flash-preview",
    },
    autoPriority: { image: 30, audio: 40, video: 10 },
    nativeDocumentInputs: ["pdf"],
    describeImage: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImage(...args),
    describeImages: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeImages(...args),
    transcribeAudio: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).transcribeAudio(...args),
    describeVideo: async (...args) =>
      await (await loadGoogleRequiredMediaUnderstandingProvider()).describeVideo(...args),
  };
}

function createLazyGoogleMusicGenerationProvider(): MusicGenerationProvider {
  return {
    ...createGoogleMusicGenerationProviderMetadata(),
    generateMusic: async (...args) =>
      await (await loadGoogleMusicGenerationProvider()).generateMusic(...args),
  };
}

function resolveGoogleRealtimeProviderConfig(
  rawConfig: RealtimeVoiceProviderConfig,
  cfg?: { models?: { providers?: { google?: { apiKey?: unknown } } } },
): RealtimeVoiceProviderConfig {
  const providers =
    typeof rawConfig.providers === "object" &&
    rawConfig.providers !== null &&
    !Array.isArray(rawConfig.providers)
      ? (rawConfig.providers as Record<string, unknown>)
      : undefined;
  const nested = providers?.google;
  const raw =
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : typeof rawConfig.google === "object" &&
          rawConfig.google !== null &&
          !Array.isArray(rawConfig.google)
        ? (rawConfig.google as Record<string, unknown>)
        : rawConfig;
  return {
    ...raw,
    ...(raw.apiKey === undefined
      ? cfg?.models?.providers?.google?.apiKey === undefined
        ? {}
        : {
            apiKey: normalizeResolvedSecretInputString({
              value: cfg.models.providers.google.apiKey,
              path: "models.providers.google.apiKey",
            }),
          }
      : {
          apiKey: normalizeResolvedSecretInputString({
            value: raw.apiKey,
            path: "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
          }),
        }),
  };
}

function resolveGoogleRealtimeEnvApiKey(): string | undefined {
  return (
    normalizeOptionalString(process.env.GEMINI_API_KEY) ??
    normalizeOptionalString(process.env.GOOGLE_API_KEY)
  );
}

const GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGES = 128;
const GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGE_BYTES = 256 * 1024;

function createLazyGoogleRealtimeVoiceBridge(
  req: RealtimeVoiceBridgeCreateRequest,
): RealtimeVoiceBridge {
  let bridge: RealtimeVoiceBridge | undefined;
  let bridgePromise: Promise<RealtimeVoiceBridge> | undefined;
  let bridgeReady = false;
  let closed = false;
  // Provider close is terminal for input admission. Only an explicit connect()
  // call may reopen it; late callbacks and microphone frames stay ignored.
  let providerTerminated = false;
  let generation = 0;
  let latestMediaTimestamp: number | undefined;
  let pendingGreeting: string | undefined;
  // Lazy startup keeps the newest microphone tail when loading stalls.
  const pendingAudio = createRealtimeVoiceAudioQueue("drop-oldest");
  const pendingUserMessages: string[] = [];
  let pendingUserMessageBytes = 0;
  const closedBridges = new WeakSet<RealtimeVoiceBridge>();
  const clearPendingInput = () => {
    pendingAudio.clear();
    pendingUserMessages.length = 0;
    pendingUserMessageBytes = 0;
    pendingGreeting = undefined;
    latestMediaTimestamp = undefined;
  };
  const isCurrentNonterminalGeneration = (candidate: number) =>
    candidate === generation && !providerTerminated;
  // Loading and connecting finish on separate async boundaries. Keep close ownership
  // here so either late completion closes the provider bridge exactly once.
  const closeBridge = (loadedBridge = bridge) => {
    if (!loadedBridge || closedBridges.has(loadedBridge)) {
      return;
    }
    closedBridges.add(loadedBridge);
    loadedBridge.close();
  };
  const emitTerminal = (terminalGeneration: number, reason: "completed" | "error") => {
    if (!isCurrentNonterminalGeneration(terminalGeneration)) {
      return;
    }
    bridgeReady = false;
    providerTerminated = true;
    clearPendingInput();
    req.onClose?.(reason);
  };
  const throwTerminalBridgeError = (
    terminalGeneration: number,
    loadedBridge: RealtimeVoiceBridge,
    primaryError: unknown,
  ): never => {
    if (isCurrentNonterminalGeneration(terminalGeneration)) {
      try {
        req.onError?.(
          primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
        );
      } catch {
        // Consumer callback failures cannot prevent terminal cleanup or replace the provider failure.
      }
      try {
        emitTerminal(terminalGeneration, "error");
      } catch {
        // Consumer callback failures cannot prevent cleanup or replace the provider failure.
      }
    }
    try {
      closeBridge(loadedBridge);
    } catch {
      // Cleanup failures cannot replace the provider failure.
    }
    throw primaryError;
  };
  const loadBridge = async () => {
    if (!bridgePromise) {
      const loadGeneration = generation;
      bridgePromise = loadGoogleRealtimeVoiceProvider().then((provider) =>
        provider.createBridge({
          ...req,
          onReady: () => {
            if (loadGeneration !== generation || closed || providerTerminated) {
              return;
            }
            req.onReady?.();
            if (loadGeneration !== generation || closed || providerTerminated || !bridge) {
              return;
            }
            bridgeReady = true;
            // `connect()` and provider readiness are separate lifecycle facts.
            // Release prompts only after the provider can accept user content.
            flushPending(bridge);
          },
          onClose: (reason) => {
            emitTerminal(loadGeneration, reason);
          },
        }),
      );
    }
    bridge = await bridgePromise;
    if (closed) {
      closeBridge(bridge);
    }
    return bridge;
  };
  const requireBridge = () => {
    if (!bridge) {
      throw new Error("Google realtime voice bridge is not connected");
    }
    return bridge;
  };
  const flushPending = (loadedBridge: RealtimeVoiceBridge) => {
    if (closed || providerTerminated) {
      return;
    }
    if (typeof latestMediaTimestamp === "number") {
      loadedBridge.setMediaTimestamp(latestMediaTimestamp);
    }
    for (const audio of pendingAudio.drain()) {
      loadedBridge.sendAudio(audio);
    }
    const userMessages = pendingUserMessages.splice(0);
    pendingUserMessageBytes = 0;
    for (const text of userMessages) {
      loadedBridge.sendUserMessage?.(text);
    }
    if (pendingGreeting !== undefined) {
      const greeting = pendingGreeting;
      pendingGreeting = undefined;
      loadedBridge.triggerGreeting?.(greeting);
    }
  };
  return {
    get supportsToolResultContinuation() {
      return bridge?.supportsToolResultContinuation ?? false;
    },
    supportsToolResultSuppression: false,
    connect: async () => {
      if (providerTerminated) {
        generation += 1;
        bridge = undefined;
        bridgePromise = undefined;
        bridgeReady = false;
        providerTerminated = false;
      }
      const connectGeneration = generation;
      const loadedBridge = await loadBridge();
      if (connectGeneration !== generation || closed) {
        closeBridge(loadedBridge);
        return;
      }
      try {
        await loadedBridge.connect();
      } catch (error) {
        throwTerminalBridgeError(connectGeneration, loadedBridge, error);
      }
      if (connectGeneration !== generation || closed) {
        closeBridge(loadedBridge);
      }
    },
    sendAudio: (audio) => {
      if (closed || providerTerminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      pendingAudio.enqueue(audio);
    },
    setMediaTimestamp: (ts) => {
      if (closed || providerTerminated) {
        return;
      }
      latestMediaTimestamp = ts;
      bridge?.setMediaTimestamp(ts);
    },
    sendUserMessage: (text) => {
      if (closed || providerTerminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.sendUserMessage?.(text);
        return;
      }
      const messageBytes = Buffer.byteLength(text, "utf8");
      if (
        pendingUserMessages.length >= GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGES ||
        pendingUserMessageBytes + messageBytes > GOOGLE_REALTIME_LAZY_MAX_PENDING_USER_MESSAGE_BYTES
      ) {
        req.onError?.(
          new Error("Google realtime voice pending user message queue overflow during startup"),
        );
        return;
      }
      pendingUserMessages.push(text);
      pendingUserMessageBytes += messageBytes;
    },
    triggerGreeting: (instructions) => {
      if (closed || providerTerminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.triggerGreeting?.(instructions);
        return;
      }
      pendingGreeting = instructions;
    },
    handleBargeIn: (options) => requireBridge().handleBargeIn?.(options),
    submitToolResult: (callId, result, options) =>
      requireBridge().submitToolResult(callId, result, options),
    acknowledgeMark: () => requireBridge().acknowledgeMark(),
    close: () => {
      if (closed) {
        return;
      }
      const closeGeneration = generation;
      closed = true;
      bridgeReady = false;
      clearPendingInput();
      closeBridge();
      // A bridge closed before its first connect has no provider-owned
      // connection to report the terminal outcome.
      emitTerminal(closeGeneration, "completed");
    },
    isConnected: () => bridge?.isConnected() ?? false,
  };
}

function createLazyGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "google",
    label: "Google Live Voice",
    autoSelectOrder: 20,
    resolveConfig: ({ cfg, rawConfig }) => resolveGoogleRealtimeProviderConfig(rawConfig, cfg),
    isConfigured: ({ cfg, providerConfig }) =>
      Boolean(
        normalizeOptionalString(providerConfig.apiKey) ??
        normalizeOptionalString(cfg?.models?.providers?.google?.apiKey) ??
        resolveGoogleRealtimeEnvApiKey(),
      ),
    createBridge: createLazyGoogleRealtimeVoiceBridge,
    createBrowserSession: async (req) => {
      const provider = await loadGoogleRealtimeVoiceProvider();
      if (!provider.createBrowserSession) {
        throw new Error("Google realtime voice browser sessions are unavailable");
      }
      return await provider.createBrowserSession(req);
    },
  };
}

function createLazyGoogleVideoGenerationProvider(): VideoGenerationProvider {
  return {
    ...createGoogleVideoGenerationProviderMetadata(),
    generateVideo: async (...args) =>
      await (await loadGoogleVideoGenerationProvider()).generateVideo(...args),
  };
}

export default definePluginEntry({
  id: "google",
  name: "Google Plugin",
  description: "Bundled Google plugin",
  register(api) {
    api.registerCliBackend(buildGoogleGeminiCliBackend());
    registerGoogleGeminiCliProvider(api);
    registerGoogleProvider(api);
    api.registerEmbeddingProvider(
      adaptMemoryEmbeddingProviderAdapter(geminiMemoryEmbeddingProviderAdapter),
    );
    api.registerImageGenerationProvider(createLazyGoogleImageGenerationProvider());
    api.registerMediaUnderstandingProvider(createLazyGoogleMediaUnderstandingProvider());
    api.registerMusicGenerationProvider(createLazyGoogleMusicGenerationProvider());
    api.registerRealtimeVoiceProvider(createLazyGoogleRealtimeVoiceProvider());
    api.registerSpeechProvider(buildGoogleSpeechProvider());
    api.registerVideoGenerationProvider(createLazyGoogleVideoGenerationProvider());
    api.registerWebSearchProvider(createGeminiWebSearchProvider());
  },
});
