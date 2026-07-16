// Core runtime types define system, config, and task helper contracts for plugins.
import type { CreateChannelIngressQueueOptions } from "../../channels/message/ingress-queue.js";
import type { ConfigMutationBase } from "../../config/mutation-types.js";
import type { SessionPluginJsonValue } from "../../config/sessions/types.js";
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

type RuntimeRequestHeartbeatOptions = Parameters<
  typeof import("../../infra/heartbeat-wake.js").requestHeartbeat
>[0];

type RuntimeRequestHeartbeatNowOptions = Omit<RuntimeRequestHeartbeatOptions, "source" | "intent"> &
  Partial<Pick<RuntimeRequestHeartbeatOptions, "source" | "intent">>;

type RuntimeWriteConfigOptions = {
  envSnapshotForRestore?: Record<string, string | undefined>;
  expectedConfigPath?: string;
  unsetPaths?: string[][];
};

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

type RuntimeConfigAfterWrite = import("../../config/config.js").ConfigWriteAfterWrite;
type RuntimeConfigReplaceResult = import("../../config/mutate.js").ConfigReplaceResult;
type RuntimeProviderListParams = {
  config?: import("../../config/types.openclaw.js").OpenClawConfig;
};
type RuntimeConfigMutationContext = {
  snapshot: import("../../config/types.openclaw.js").ConfigFileSnapshot;
  previousHash: string | null;
};
type RuntimeMutateConfigFileParams<T = void> = {
  base?: ConfigMutationBase;
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
type RuntimeSessionEntry = import("../../config/sessions/types.js").SessionEntry;
type RuntimeSessionPluginExtensions =
  | Record<string, Record<string, SessionPluginJsonValue>>
  | undefined;
type RuntimeSessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  sessionKey: string;
  readConsistency?: "latest";
  storePath?: string;
};
type RuntimeSessionStoreListParams = Partial<Omit<RuntimeSessionStoreReadParams, "sessionKey">>;
type RuntimeSessionStoreEntrySummary = {
  sessionKey: string;
  entry: RuntimeSessionEntry;
};
type RuntimeCreateSessionEntryResult = {
  key: string;
  agentId: string;
  sessionId: string;
  entry: RuntimeSessionEntry;
};
type RuntimeCreateSessionEntryFinalPatch = {
  pluginExtensions: RuntimeSessionPluginExtensions;
};
type RuntimeCreateSessionEntryBaseParams = {
  cfg: import("../../config/types.openclaw.js").OpenClawConfig;
  key: string;
  agentId?: string;
  label?: string;
  spawnedCwd?: string;
  /** Bind the created session's CLI execution to this paired node. */
  execNode?: string;
  /** Working directory interpreted only by execNode. */
  execCwd?: string;
  initialEntry:
    | {
        agentHarnessId: string;
        modelSelectionLocked?: true;
        pluginExtensions?: RuntimeSessionPluginExtensions;
      }
    | {
        cliBackendId: string;
        model: string;
        cliSessionBinding: import("../../config/sessions/types.js").CliSessionBinding;
        modelSelectionLocked: true;
        pluginExtensions?: RuntimeSessionPluginExtensions;
        /** Registry-injected owner; plugin callers cannot select another owner. */
        pluginOwnerId?: string;
      };
};
type RuntimeCreateSessionEntryParams = RuntimeCreateSessionEntryBaseParams &
  (
    | {
        /** Retry an interrupted initializer only when persisted trusted state matches exactly. */
        recoverMatchingInitialEntry: true;
        afterCreate: (
          created: RuntimeCreateSessionEntryResult,
        ) => Promise<RuntimeCreateSessionEntryFinalPatch>;
      }
    | {
        recoverMatchingInitialEntry?: never;
        afterCreate?: (
          created: RuntimeCreateSessionEntryResult,
        ) => Promise<RuntimeCreateSessionEntryFinalPatch | void>;
      }
  );
type RuntimeSessionStoreEntryPatchParams = RuntimeSessionStoreReadParams & {
  fallbackEntry?: RuntimeSessionEntry;
  maintenanceConfig?: import("../../config/sessions/store.js").ResolvedSessionMaintenanceConfigInput;
  preserveActivity?: boolean;
  replaceEntry?: boolean;
  update: (
    entry: RuntimeSessionEntry,
    context: { existingEntry?: RuntimeSessionEntry },
  ) => Promise<Partial<RuntimeSessionEntry> | null> | Partial<RuntimeSessionEntry> | null;
};
type RuntimeUpsertSessionEntryParams = RuntimeSessionStoreReadParams & {
  entry: RuntimeSessionEntry;
};
type RuntimeSessionWorkAdmissionParams = {
  storePath: string;
  sessionKey: string;
  signal?: AbortSignal;
};
type RuntimeSessionStoreEntryUpdateParams = {
  storePath: string;
  sessionKey: string;
  update: (
    entry: RuntimeSessionEntry,
  ) => Promise<Partial<RuntimeSessionEntry> | null> | Partial<RuntimeSessionEntry> | null;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  requireWriteSuccess?: boolean;
};
/** @public Part of the PluginRuntime declaration contract. */
export type PluginRuntimeThinkingPolicyRequest = {
  provider?: string | null;
  model?: string | null;
  catalog?: import("../../auto-reply/thinking.js").ThinkingCatalogEntry[];
  agentRuntime?: string | null;
};
/** @public Part of the PluginRuntime declaration contract. */
export type PluginRuntimeThinkingPolicyLevel = {
  id: import("../../auto-reply/thinking.js").ThinkLevel;
  label: string;
};
/** @public Part of the PluginRuntime declaration contract. */
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

type RuntimeRunEmbeddedAgent = (
  params: import("../../agents/embedded-agent-runner/run/params.js").RunEmbeddedAgentParams,
) => Promise<import("../../agents/embedded-agent-runner/types.js").EmbeddedAgentRunResult>;

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
    runEmbeddedAgent: RuntimeRunEmbeddedAgent;
    /** @deprecated Use runEmbeddedAgent. */
    runEmbeddedPiAgent: RuntimeRunEmbeddedAgent;
    resolveAgentTimeoutMs: typeof import("../../agents/timeout.js").resolveAgentTimeoutMs;
    ensureAgentWorkspace: typeof import("../../agents/workspace.js").ensureAgentWorkspace;
    session: {
      resolveStorePath: typeof import("../../config/sessions/paths.js").resolveStorePath;
      createSessionEntry: (
        params: RuntimeCreateSessionEntryParams,
      ) => Promise<RuntimeCreateSessionEntryResult>;
      getSessionEntry: (params: RuntimeSessionStoreReadParams) => RuntimeSessionEntry | undefined;
      listSessionEntries: (
        params?: RuntimeSessionStoreListParams,
      ) => RuntimeSessionStoreEntrySummary[];
      patchSessionEntry: (
        params: RuntimeSessionStoreEntryPatchParams,
      ) => Promise<RuntimeSessionEntry | null>;
      upsertSessionEntry: (params: RuntimeUpsertSessionEntryParams) => Promise<void>;
      runWithWorkAdmission: <T>(
        params: RuntimeSessionWorkAdmissionParams,
        run: (signal: AbortSignal) => Promise<T>,
      ) => Promise<T>;
      updateSessionStoreEntry: (
        params: RuntimeSessionStoreEntryUpdateParams,
      ) => Promise<RuntimeSessionEntry | null>;
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
    detectMime: typeof import("@openclaw/media-core/mime").detectMime;
    mediaKindFromMime: typeof import("@openclaw/media-core/constants").mediaKindFromMime;
    isVoiceCompatibleAudio: typeof import("../../media/audio.js").isVoiceCompatibleAudio;
    getImageMetadata: typeof import("../../media/media-services.js").getImageMetadata;
    resizeToJpeg: typeof import("../../media/media-services.js").resizeToJpeg;
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
    extractStructuredWithModel: MediaUnderstandingRuntime["extractStructuredWithModel"];
    describeVideoFile: MediaUnderstandingRuntime["describeVideoFile"];
    transcribeAudioFile: MediaUnderstandingRuntime["transcribeAudioFile"];
  };
  imageGeneration: {
    generate: (
      params: import("../../image-generation/runtime-types.js").GenerateImageParams,
    ) => Promise<import("../../image-generation/runtime-types.js").GenerateImageRuntimeResult>;
    listProviders: (
      params?: RuntimeProviderListParams,
    ) => import("../../image-generation/types.js").ImageGenerationProvider[];
  };
  videoGeneration: {
    generate: (
      params: import("../../video-generation/runtime-types.js").GenerateVideoParams,
    ) => Promise<import("../../video-generation/runtime-types.js").GenerateVideoRuntimeResult>;
    listProviders: (
      params?: RuntimeProviderListParams,
    ) => import("../../video-generation/types.js").VideoGenerationProvider[];
  };
  musicGeneration: {
    generate: (
      params: import("../../music-generation/runtime-types.js").GenerateMusicParams,
    ) => Promise<import("../../music-generation/runtime-types.js").GenerateMusicRuntimeResult>;
    listProviders: (
      params?: RuntimeProviderListParams,
    ) => import("../../music-generation/types.js").MusicGenerationProvider[];
  };
  webSearch: {
    listProviders: (
      params?: RuntimeProviderListParams,
    ) => import("../web-provider-types.js").PluginWebSearchProviderEntry[];
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
    openSyncKeyedStore: <T>(
      options: import("../../plugin-state/plugin-state-store.types.js").OpenKeyedStoreOptions,
    ) => import("../../plugin-state/plugin-state-store.types.js").PluginStateSyncKeyedStore<T>;
    openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
      options?: Omit<CreateChannelIngressQueueOptions, "channelId">,
    ) => import("../../channels/message/ingress-queue.js").ChannelIngressQueue<
      TPayload,
      TMetadata,
      TCompletedMetadata
    >;
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
    acquireLocalService: (
      target: {
        providerId: string;
        baseUrl: string;
        headers?: HeadersInit;
      },
      signal?: AbortSignal | null,
    ) => Promise<{ release: () => void } | undefined>;
  };
  modelAuth: {
    /** Resolve auth for a model. Only provider/model, optional cfg, and workspaceDir are used. */
    getApiKeyForModel: (params: {
      model: import("openclaw/plugin-sdk/llm").Model<import("openclaw/plugin-sdk/llm").Api>;
      cfg?: import("../../config/types.openclaw.js").OpenClawConfig;
      workspaceDir?: string;
    }) => Promise<import("../../agents/model-auth-runtime-shared.js").ResolvedProviderAuth>;
    /** Resolve request-ready auth for a model, including provider runtime exchanges. */
    getRuntimeAuthForModel: (params: {
      model: import("openclaw/plugin-sdk/llm").Model<import("openclaw/plugin-sdk/llm").Api>;
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
