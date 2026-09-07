import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { createRealtimeVoiceAudioQueue } from "openclaw/plugin-sdk/realtime-voice-audio-queue";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
let googleRealtimeVoiceProviderPromise: Promise<RealtimeVoiceProviderPlugin> | null = null;

async function loadGoogleRealtimeVoiceProvider(): Promise<RealtimeVoiceProviderPlugin> {
  if (!googleRealtimeVoiceProviderPromise) {
    googleRealtimeVoiceProviderPromise = import("./realtime-voice-provider.js").then((mod) =>
      mod.buildGoogleRealtimeVoiceProvider(),
    );
  }
  return await googleRealtimeVoiceProviderPromise;
}

function resolveGoogleRealtimeProviderConfig(
  rawConfig: RealtimeVoiceProviderConfig,
  cfg?: { models?: { providers?: { google?: { apiKey?: unknown } } } },
): RealtimeVoiceProviderConfig {
  const providers = asOptionalRecord(rawConfig.providers);
  const raw =
    asOptionalRecord(providers?.google) ?? asOptionalRecord(rawConfig.google) ?? rawConfig;
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
  let bridgePromiseGeneration = 0;
  let bridgeReady = false;
  // Provider close is terminal for input admission. Only an explicit connect()
  // call may reopen it; late callbacks and microphone frames stay ignored.
  let terminated = false;
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
    candidate === generation && !terminated;
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
    terminated = true;
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
      bridgePromiseGeneration = loadGeneration;
      bridgePromise = loadGoogleRealtimeVoiceProvider().then((provider) =>
        provider.createBridge({
          ...req,
          onReady: () => {
            if (loadGeneration !== generation || terminated) {
              return;
            }
            req.onReady?.();
            if (loadGeneration !== generation || terminated || !bridge) {
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
    const loading = bridgePromise;
    const loadGeneration = bridgePromiseGeneration;
    const loadedBridge = await loading;
    // Explicit reconnect can replace the lazy load before it settles. Only the
    // matching generation may publish a bridge; stale instances must close.
    if (loading !== bridgePromise || loadGeneration !== generation || terminated) {
      closeBridge(loadedBridge);
      return loadedBridge;
    }
    bridge = loadedBridge;
    return loadedBridge;
  };
  const requireBridge = () => {
    if (!bridge) {
      throw new Error("Google realtime voice bridge is not connected");
    }
    return bridge;
  };
  const flushPending = (loadedBridge: RealtimeVoiceBridge) => {
    if (terminated) {
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
      if (terminated) {
        generation += 1;
        bridge = undefined;
        bridgePromise = undefined;
        bridgeReady = false;
        terminated = false;
      }
      const connectGeneration = generation;
      const loadedBridge = await loadBridge();
      if (connectGeneration !== generation || terminated) {
        closeBridge(loadedBridge);
        return;
      }
      try {
        await loadedBridge.connect();
      } catch (error) {
        throwTerminalBridgeError(connectGeneration, loadedBridge, error);
      }
      if (connectGeneration !== generation || terminated) {
        closeBridge(loadedBridge);
      }
    },
    sendAudio: (audio) => {
      if (terminated) {
        return;
      }
      if (bridgeReady && bridge) {
        bridge.sendAudio(audio);
        return;
      }
      pendingAudio.enqueue(audio);
    },
    setMediaTimestamp: (ts) => {
      if (terminated) {
        return;
      }
      latestMediaTimestamp = ts;
      bridge?.setMediaTimestamp(ts);
    },
    sendUserMessage: (text) => {
      if (terminated) {
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
      if (terminated) {
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
      if (terminated) {
        return;
      }
      terminated = true;
      bridgeReady = false;
      clearPendingInput();
      closeBridge();
      // A bridge closed before its first connect has no provider-owned
      // connection to report the terminal outcome.
      req.onClose?.("completed");
    },
    isConnected: () => !terminated && (bridge?.isConnected() ?? false),
  };
}

export function createLazyGoogleRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
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
