import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { LogLevel } from "../../logging/levels.js";
import type { MediaUnderstandingRuntime } from "../../media-understanding/runtime-types.js";
import type {
  ListSpeechVoices,
  TextToSpeech,
  TextToSpeechStream,
  TextToSpeechTelephony,
} from "../../plugin-sdk/tts-runtime.types.js";
import type { PluginRuntimeTaskFlows, PluginRuntimeTaskRuns } from "./runtime-tasks.types.js";

export type { HeartbeatRunResult };

export type RuntimeRequestHeartbeatOptions = Parameters<
  typeof import("../../infra/heartbeat-wake.js").requestHeartbeat
>[0];

export type RuntimeRequestHeartbeatNowOptions = Omit<
  RuntimeRequestHeartbeatOptions,
  "source" | "intent"
> &
  Partial<Pick<RuntimeRequestHeartbeatOptions, "source" | "intent">>;

type RuntimeWriteConfigOptions = {
  envSnapshotForRestore?: Record<string, string | undefined>;
  expectedConfigPath?: string;
  unsetPaths?: string[][];
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

type RuntimeConfigAfterWrite = import("../../config/config.js").ConfigWriteAfterWrite;
type RuntimeConfigReplaceResult = import("../../config/mutate.js").ConfigReplaceResult;
type RuntimeConfigMutationBase = import("../../config/mutate.js").ConfigMutationBase;
type RuntimeConfigMutationContext = {
  snapshot: import("../../config/types.openclaw.js").ConfigFileSnapshot;
  previousHash: string | null;
};
type RuntimeMutateConfigFileParams<T = void> = {
  base?: RuntimeConfigMutationBase;
  baseHash?: string;
  afterWrite: RuntimeConfigAfterWrite;
  writeOptions?: RuntimeWriteConfigOptions;
  mutate: (
    draft: import("../../config/types.openclaw.js").OpenClawConfig,
    context: RuntimeConfigMutationContext,
  ) => Promise<T | void> | T | void;
};
type RuntimeReplaceConfigFileParams = {
  nextConfig: import("../../config/types.openclaw.js").OpenClawConfig;
  baseHash?: string;
  afterWrite: RuntimeConfigAfterWrite;
  writeOptions?: RuntimeWriteConfigOptions;
};
export type PluginRuntimeThinkingPolicyRequest = {
  provider?: string | null;
  model?: string | null;
  catalog?: import("../../auto-reply/thinking.js").ThinkingCatalogEntry[];
};
export type PluginRuntimeThinkingPolicyLevel = {
  id: import("../../auto-reply/thinking.js").ThinkLevel;
  label: string;
};
export type PluginRuntimeThinkingPolicy = {
  levels: PluginRuntimeThinkingPolicyLevel[];
  defaultLevel?: import("../../auto-reply/thinking.js").ThinkLevel | null;
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

export type LlmCompleteMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmCompleteCaller = {
  kind: "plugin" | "context-engine" | "host" | "unknown";
  id?: string;
  name?: string;
};

export type LlmCompleteUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type LlmCompleteParams = {
  messages: LlmCompleteMessage[];
  /** Model ref (e.g. "anthropic/claude-sonnet-4-6"); defaults to the target agent's configured model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  /** Human-readable reason for audit/debug output. */
  purpose?: string;
  /** Agent whose model/credentials to use. Session-bound capabilities may disallow overrides. */
  agentId?: string;
};

export type LlmCompleteResult = {
  text: string;
  provider: string;
  model: string;
  agentId: string;
  usage: LlmCompleteUsage;
  audit: {
    caller: LlmCompleteCaller;
    purpose?: string;
    sessionKey?: string;
  };
};

type RuntimeRunEmbeddedPiAgent = (
  params: import("../../agents/pi-embedded-runner/run/params.js").RunEmbeddedPiAgentParams,
) => Promise<import("../../agents/pi-embedded-runner/types.js").EmbeddedPiRunResult>;

/** Core runtime helpers exposed to trusted native plugins. */
export type PluginRuntimeCore = {
  version: string;
  config: {
    /** Current process runtime config snapshot. Prefer config passed into the active call path. */
    current: () => DeepReadonly<import("../../config/types.openclaw.js").OpenClawConfig>;
    /**
     * Persist a focused config mutation. Callers must choose the post-write
     * behavior explicitly so the gateway can hot-reload, restart, or defer.
     */
    mutateConfigFile: <T = void>(
      params: RuntimeMutateConfigFileParams<T>,
    ) => Promise<RuntimeConfigReplaceResult & { result: T | undefined }>;
    /**
     * Persist a full config replacement. Callers must choose the post-write
     * behavior explicitly so the gateway can hot-reload, restart, or defer.
     */
    replaceConfigFile: (
      params: RuntimeReplaceConfigFileParams,
    ) => Promise<RuntimeConfigReplaceResult>;
    /**
     * @deprecated Use current(), or pass the already loaded config through the
     * call path. Runtime code must not reload config on demand. Bundled
     * plugins and repo code are blocked from using this by the
     * deprecated-internal-config-api architecture guard.
     */
    loadConfig: () => import("../../config/types.openclaw.js").OpenClawConfig;
    /**
     * @deprecated Use mutateConfigFile() or replaceConfigFile() with an
     * explicit afterWrite intent so restart behavior stays under host control.
     * Bundled plugins and repo code are blocked from using this by the
     * deprecated-internal-config-api architecture guard.
     */
    writeConfigFile: (
      cfg: import("../../config/types.openclaw.js").OpenClawConfig,
      options?: RuntimeWriteConfigOptions & { afterWrite?: RuntimeConfigAfterWrite },
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
    normalizeThinkingLevel: (
      raw?: string | null,
    ) => import("../../auto-reply/thinking.js").ThinkLevel | undefined;
    resolveThinkingPolicy: (
      params: PluginRuntimeThinkingPolicyRequest,
    ) => PluginRuntimeThinkingPolicy;
    runEmbeddedAgent: RuntimeRunEmbeddedPiAgent;
    runEmbeddedPiAgent: RuntimeRunEmbeddedPiAgent;
    resolveAgentTimeoutMs: typeof import("../../agents/timeout.js").resolveAgentTimeoutMs;
    ensureAgentWorkspace: typeof import("../../agents/workspace.js").ensureAgentWorkspace;
    session: {
      resolveStorePath: typeof import("../../config/sessions/paths.js").resolveStorePath;
      loadSessionStore: typeof import("../../config/sessions/store-load.js").loadSessionStore;
      saveSessionStore: import("../../config/sessions/runtime-types.js").SaveSessionStore;
      updateSessionStore: typeof import("../../config/sessions/store.js").updateSessionStore;
      updateSessionStoreEntry: typeof import("../../config/sessions/store.js").updateSessionStoreEntry;
      resolveSessionFilePath: typeof import("../../config/sessions/paths.js").resolveSessionFilePath;
    };
  };
  system: {
    enqueueSystemEvent: typeof import("../../infra/system-events.js").enqueueSystemEvent;
    requestHeartbeat: typeof import("../../infra/heartbeat-wake.js").requestHeartbeat;
    /**
     * @deprecated Use `requestHeartbeat({ source, intent, reason })` so wake producers declare
     * scheduler intent explicitly.
     */
    requestHeartbeatNow: (opts?: RuntimeRequestHeartbeatNowOptions) => void;
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
    textToSpeechStream: TextToSpeechStream;
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
    openKeyedStore: <T>(
      options: import("../../plugin-state/plugin-state-store.types.js").OpenKeyedStoreOptions,
    ) => import("../../plugin-state/plugin-state-store.types.js").PluginStateKeyedStore<T>;
  };
  tasks: {
    runs: PluginRuntimeTaskRuns;
    flows: PluginRuntimeTaskFlows;
    managedFlows: import("./runtime-taskflow.types.js").PluginRuntimeTaskFlow;
    /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
    flow: import("./runtime-taskflow.types.js").PluginRuntimeTaskFlow;
  };
  /** @deprecated Use runtime.tasks.flows for DTO-based TaskFlow access. */
  taskFlow: import("./runtime-taskflow.types.js").PluginRuntimeTaskFlow;
  llm: {
    complete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  };
  modelAuth: {
    /** Resolve auth for a model. Only provider/model, optional cfg, and workspaceDir are used. */
    getApiKeyForModel: (params: {
      model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<import("../../agents/model-auth-runtime-shared.js").ResolvedProviderAuth>;
    /** Resolve request-ready auth for a model, including provider runtime exchanges. */
    getRuntimeAuthForModel: (params: {
      model: import("@mariozechner/pi-ai").Model<import("@mariozechner/pi-ai").Api>;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<import("./model-auth-types.js").ResolvedProviderRuntimeAuth>;
    /** Resolve auth for a provider by name. Only provider, optional cfg, and workspaceDir are used. */
    resolveApiKeyForProvider: (params: {
      provider: string;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<import("../../agents/model-auth-runtime-shared.js").ResolvedProviderAuth>;
  };
};
