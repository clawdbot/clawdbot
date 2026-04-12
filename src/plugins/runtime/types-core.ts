import type {
  RunEmbeddedAgentFn,
  RunEmbeddedPiAgentFn,
} from "../../agents/pi-embedded-runtime.types.js";
import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { LogLevel } from "../../logging/levels.js";
import type { MediaUnderstandingRuntime } from "../../media-understanding/runtime-types.js";
import type {
  ListSpeechVoices,
  TextToSpeech,
  TextToSpeechTelephony,
} from "../../plugin-sdk/tts-runtime.types.js";
import type { PluginRuntimeTaskFlows, PluginRuntimeTaskRuns } from "./runtime-tasks.types.js";

export type { HeartbeatRunResult };

type RuntimeWriteConfigOptions = {
  envSnapshotForRestore?: Record<string, string | undefined>;
  expectedConfigPath?: string;
  unsetPaths?: string[][];
};

/** Structured logger surface injected into runtime-backed plugin helpers. */
export type RuntimeLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

export type RunHeartbeatOnceOptions = {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
  /** Override heartbeat config (e.g. `{ target: "last" }` to deliver to the last active channel). */
  heartbeat?: { target?: string };
};

/** Core runtime helpers exposed to trusted native plugins. */
export type PluginRuntimeCore = {
  version: string;
  config: {
    loadConfig: () => import("../../config/types.openclaw.js").OpenClawConfig;
    writeConfigFile: (
      cfg: import("../../config/types.openclaw.js").OpenClawConfig,
      options?: RuntimeWriteConfigOptions,
    ) => Promise<void>;
  };
  agent: {
    defaults: {
      model: typeof import("../../agents/defaults.js").DEFAULT_MODEL;
      provider: typeof import("../../agents/defaults.js").DEFAULT_PROVIDER;
    };
    resolveAgentDir: typeof import("../../agents/agent-scope.js").resolveAgentDir;
    resolveAgentWorkspaceDir: typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir;
    resolveAgentIdentity: typeof import("../../agents/identity.js").resolveAgentIdentity;
    resolveThinkingDefault: (params: {
      cfg: import("../../config/types.openclaw.js").OpenClawConfig;
      provider: string;
      model: string;
      catalog?: import("../../agents/model-catalog.types.js").ModelCatalogEntry[];
    }) => import("../../auto-reply/thinking.js").ThinkLevel;
    runEmbeddedAgent: RunEmbeddedAgentFn;
    runEmbeddedPiAgent: RunEmbeddedPiAgentFn;
    resolveAgentTimeoutMs: typeof import("../../agents/timeout.js").resolveAgentTimeoutMs;
    ensureAgentWorkspace: typeof import("../../agents/workspace.js").ensureAgentWorkspace;
    session: {
      resolveStorePath: typeof import("../../config/sessions/paths.js").resolveStorePath;
      loadSessionStore: typeof import("../../config/sessions/store-load.js").loadSessionStore;
      saveSessionStore: import("../../config/sessions/runtime-types.js").SaveSessionStore;
      resolveSessionFilePath: typeof import("../../config/sessions/paths.js").resolveSessionFilePath;
    };
  };
  system: {
    enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
    requestHeartbeatNow: typeof import("../../infra/heartbeat-wake.js").requestHeartbeatNow;
    /**
     * Run a single heartbeat cycle immediately (bypassing the coalesce timer).
     * Accepts an optional `heartbeat` config override so callers can force
     * delivery to the last active channel — the same pattern the cron service
     * uses to avoid the default `target: "none"` suppression.
     */
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => Promise<HeartbeatRunResult>;
    runCommandWithTimeout: typeof import("../../process/exec.js").runCommandWithTimeout;
    formatNativeDependencyHint: typeof import("./native-deps.js").formatNativeDependencyHint;
  };
  media: {
    loadWebMedia: typeof import("../../media/web-media.js").loadWebMedia;
    detectMime: typeof import("../../media/mime.js").detectMime;
    mediaKindFromMime: typeof import("../../media/constants.js").mediaKindFromMime;
    isVoiceCompatibleAudio: typeof import("../../media/audio.js").isVoiceCompatibleAudio;
    getImageMetadata: typeof import("../../media/image-ops.js").getImageMetadata;
    resizeToJpeg: typeof import("../../media/image-ops.js").resizeToJpeg;
  };
  tts: {
    textToSpeech: TextToSpeech;
    textToSpeechTelephony: TextToSpeechTelephony;
    listVoices: ListSpeechVoices;
  };
  mediaUnderstanding: {
    runFile: MediaUnderstandingRuntime["runMediaUnderstandingFile"];
    describeImageFile: MediaUnderstandingRuntime["describeImageFile"];
    describeImageFileWithModel: MediaUnderstandingRuntime["describeImageFileWithModel"];
    describeVideoFile: MediaUnderstandingRuntime["describeVideoFile"];
    transcribeAudioFile: MediaUnderstandingRuntime["transcribeAudioFile"];
  };
  imageGeneration: {
    generate: (
      params: import("../../image-generation/runtime-types.js").GenerateImageParams,
    ) => Promise<import("../../image-generation/runtime-types.js").GenerateImageRuntimeResult>;
    listProviders: (
      params?: import("../../image-generation/runtime-types.js").ListRuntimeImageGenerationProvidersParams,
    ) => import("../../image-generation/runtime-types.js").RuntimeImageGenerationProvider[];
  };
  videoGeneration: {
    generate: (
      params: import("../../video-generation/runtime-types.js").GenerateVideoParams,
    ) => Promise<import("../../video-generation/runtime-types.js").GenerateVideoRuntimeResult>;
    listProviders: (
      params?: import("../../video-generation/runtime-types.js").ListRuntimeVideoGenerationProvidersParams,
    ) => import("../../video-generation/runtime-types.js").RuntimeVideoGenerationProvider[];
  };
  musicGeneration: {
    generate: (
      params: import("../../music-generation/runtime-types.js").GenerateMusicParams,
    ) => Promise<import("../../music-generation/runtime-types.js").GenerateMusicRuntimeResult>;
    listProviders: (
      params?: import("../../music-generation/runtime-types.js").ListRuntimeMusicGenerationProvidersParams,
    ) => import("../../music-generation/runtime-types.js").RuntimeMusicGenerationProvider[];
  };
  webSearch: {
    listProviders: (
      params?: import("../../web-search/runtime-types.js").ListWebSearchProvidersParams,
    ) => import("../../web-search/runtime-types.js").RuntimeWebSearchProviderEntry[];
    search: (
      params: import("../../web-search/runtime-types.js").RunWebSearchParams,
    ) => Promise<import("../../web-search/runtime-types.js").RunWebSearchResult>;
  };
  stt: {
    transcribeAudioFile: MediaUnderstandingRuntime["transcribeAudioFile"];
  };
  events: {
    onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;
    onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;
  };
  logging: {
    shouldLogVerbose: typeof import("../../globals.js").shouldLogVerbose;
    getChildLogger: (
      bindings?: Record<string, unknown>,
      opts?: { level?: LogLevel },
    ) => RuntimeLogger;
  };
  state: {
    resolveStateDir: typeof import("../../config/paths.js").resolveStateDir;
  };
  tasks: {
    runs: PluginRuntimeTaskRuns;
    flows: PluginRuntimeTaskFlows;
    /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
    flow: import("./runtime-taskflow.types.js").PluginRuntimeTaskFlow;
  };
  /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  taskFlow: import("./runtime-taskflow.types.js").PluginRuntimeTaskFlow;
  modelAuth: {
    /** Resolve auth for a model. Only provider/model and optional cfg are used. */
    getApiKeyForModel: (params: {
      model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
    }) => Promise<import("../../agents/model-auth-runtime-shared.js").ResolvedProviderAuth>;
    /** Resolve request-ready auth for a model, including provider runtime exchanges. */
    getRuntimeAuthForModel: (params: {
      model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<import("./model-auth-types.js").ResolvedProviderRuntimeAuth>;
    /** Resolve auth for a provider by name. Only provider and optional cfg are used. */
    resolveApiKeyForProvider: (params: {
      provider: string;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
    }) => Promise<import("../../agents/model-auth-runtime-shared.js").ResolvedProviderAuth>;
  };
};
