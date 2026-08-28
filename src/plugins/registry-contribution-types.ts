/** Acyclic contracts for capabilities stored in the installed plugin registry. */
import type { EmbeddingInput } from "../../packages/memory-host-sdk/src/engine-embeddings.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine } from "../context-engine/types.js";
import type {
  LegacyMemoryReadResult,
  MemoryOriginClass,
  MemoryReadResult,
  MemorySearchManager,
  MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import type {
  EmbeddingProvider,
  EmbeddingProviderAdapter,
  EmbeddingProviderCallOptions,
  EmbeddingProviderCreateOptions,
  EmbeddingProviderCreateResult,
  EmbeddingProviderIndexIdentity,
  EmbeddingProviderRuntime,
} from "./embedding-provider-types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRecord } from "./plugin-record.types.js";

/** A narrow, in-process Browser-owned request surface for approved plugin consumers. */
export type BrowserNodeDelegationRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
  nodeId: string;
};

/** Browser registers this capability; the registry exposes it only to named consumers. */
export type BrowserNodeDelegation = {
  consumerPluginIds: readonly string[];
  request: (
    params: BrowserNodeDelegationRequest & { consumerPluginId: string },
  ) => Promise<unknown>;
};

export type PluginBrowserNodeDelegationRegistration = {
  pluginId: string;
  providerRecord: PluginRecord;
  provider: {
    origin: PluginOrigin;
    source: string;
    rootDir?: string;
    trustedOfficialInstall?: boolean;
  };
  delegation: BrowserNodeDelegation;
};

export type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};
export type ContextEngineFactory = (
  ctx: ContextEngineFactoryContext,
) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationLifecycle = "runtime" | "readOnlyDiscovery";
export type ContextEngineRegistration = {
  factory: ContextEngineFactory;
  owner: string;
  lifecycle: ContextEngineRegistrationLifecycle;
};

type CompactionProviderSummarizationInstructions = {
  identifierPolicy?: "strict" | "off" | "custom";
  identifierInstructions?: string;
};

export interface CompactionProvider {
  id: string;
  label: string;
  summarize(params: {
    messages: unknown[];
    signal?: AbortSignal;
    compressionRatio?: number;
    customInstructions?: string;
    summarizationInstructions?: CompactionProviderSummarizationInstructions;
    previousSummary?: string;
  }): Promise<string>;
}

export type RegisteredCompactionProvider = {
  provider: CompactionProvider;
  ownerPluginId?: string;
};

export type MemoryEmbeddingBatchChunk = {
  text: string;
  embeddingInput?: EmbeddingInput;
};

export type MemoryEmbeddingBatchOptions = {
  agentId: string;
  chunks: MemoryEmbeddingBatchChunk[];
  wait: boolean;
  concurrency: number;
  pollIntervalMs: number;
  timeoutMs: number;
  debug: (message: string, data?: Record<string, unknown>) => void;
};

export type MemoryEmbeddingProviderCallOptions = Pick<EmbeddingProviderCallOptions, "signal">;

export type MemoryEmbeddingProviderRuntime = EmbeddingProviderRuntime & {
  sourceWideBatchEmbed?: boolean;
  batchEmbed?: (options: MemoryEmbeddingBatchOptions) => Promise<number[][] | null>;
};

export type MemoryEmbeddingProviderIndexIdentity = EmbeddingProviderIndexIdentity;

export type MemoryEmbeddingProvider = EmbeddingProvider;

export type MemoryEmbeddingProviderCreateOptions = Omit<EmbeddingProviderCreateOptions, "local"> & {
  fallback?: string;
  local?: NonNullable<EmbeddingProviderCreateOptions["local"]> & {
    contextSize?: number | "auto";
  };
};

export type MemoryEmbeddingProviderCreateResult = Omit<EmbeddingProviderCreateResult, "runtime"> & {
  runtime?: MemoryEmbeddingProviderRuntime;
};

export type MemoryEmbeddingProviderAdapter = Omit<EmbeddingProviderAdapter, "create"> & {
  autoSelectPriority?: number;
  allowExplicitWhenConfiguredAuto?: boolean;
  supportsMultimodalEmbeddings?: (params: { model: string }) => boolean;
  create: (
    options: MemoryEmbeddingProviderCreateOptions,
  ) => Promise<MemoryEmbeddingProviderCreateResult>;
  shouldContinueAutoSelection?: (err: unknown) => boolean;
};

export type MemoryPromptSectionParams = {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

export type MemoryPromptSectionBuilder = (params: MemoryPromptSectionParams) => string[];

export type MemoryPromptSectionPreparer = (
  params: MemoryPromptSectionParams,
) => Promise<readonly string[]>;

export type PreparedMemoryPromptSection = Readonly<{
  context: Readonly<{
    availableTools: readonly string[];
    citationsMode?: MemoryCitationsMode;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed: boolean;
  }>;
  lines: readonly string[];
}>;

export type MemoryCorpusSearchResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  source?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

type MemoryCorpusGetResult = {
  corpus: string;
  path: string;
  title?: string;
  kind?: string;
  content: string;
  fromLine: number;
  lineCount: number;
  id?: string;
  provenanceLabel?: string;
  sourceType?: string;
  sourcePath?: string;
  updatedAt?: string;
};

export type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }): Promise<MemoryCorpusGetResult | null>;
};

export type MemoryCorpusSupplementRegistration = {
  pluginId: string;
  supplement: MemoryCorpusSupplement;
};

export type MemoryPromptSupplementRegistration = {
  pluginId: string;
  builder: MemoryPromptSectionBuilder;
};

export type MemoryPromptPreparationRegistration = {
  pluginId: string;
  prepare: MemoryPromptSectionPreparer;
};

export type MemoryFlushPlan = {
  softThresholdTokens: number;
  forceFlushTranscriptBytes: number;
  reserveTokensFloor: number;
  model?: string;
  prompt: string;
  systemPrompt: string;
  relativePath: string;
};

export type MemoryFlushPlanResolver = (params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
  contextWindowTokens?: number;
}) => MemoryFlushPlan | null;

export type RegisteredMemorySearchManager = Omit<MemorySearchManager, "readFile"> & {
  readFile(
    params: Parameters<MemorySearchManager["readFile"]>[0],
  ): Promise<LegacyMemoryReadResult | MemoryReadResult>;
};

type MemoryRuntimeBackendConfig = { backend: "builtin" };

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
    /** Request a read-only source freshness scan; runtimes may ignore unsupported diagnostics. */
    inspectSources?: boolean;
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    debug?: {
      backend?: "builtin";
      purpose?: "default" | "status" | "cli";
      managerMs?: number;
    };
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  /** Authorize raw hits before caller-visible use; absent runtimes must not expose session hits. */
  authorizeSearchHits?(params: {
    cfg: OpenClawConfig;
    agentId: string;
    requesterSessionKey: string | undefined;
    sandboxed: boolean;
    hits: MemorySearchResult[];
  }): Promise<MemorySearchResult[]>;
  classifyWorkspaceMemoryPaths?(params: {
    cfg: OpenClawConfig;
    agentId: string;
    workspaceDir: string;
    relativePaths: string[];
  }): Promise<Array<{ relativePath: string; originClass: MemoryOriginClass }>>;
  closeMemorySearchManager?(params: { cfg: OpenClawConfig; agentId: string }): Promise<void>;
  closeAllMemorySearchManagers?(): Promise<void>;
};

type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

export type MemoryPluginPublicArtifact = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: MemoryPluginPublicArtifactContentType;
};

export type MemoryPluginPublicArtifactsProvider = {
  listArtifacts(params: { cfg: OpenClawConfig }): Promise<MemoryPluginPublicArtifact[]>;
};

export type MemoryPluginCapability = {
  promptBuilder?: MemoryPromptSectionBuilder;
  flushPlanResolver?: MemoryFlushPlanResolver;
  runtime?: MemoryPluginRuntime;
  publicArtifacts?: MemoryPluginPublicArtifactsProvider;
  /** Local deterministic recall tool required by provider-owned direct lookup. */
  deterministicRecallToolName?: string;
  /** Whether recall may read protected same-agent private session transcripts. */
  supportsPrivateTranscriptRecall?: boolean;
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

export type SessionDiscussionState = "none" | "available" | "open";
export type SessionDiscussionInfo = {
  state: SessionDiscussionState;
  embedUrl?: string;
  openUrl?: string;
};

export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string; agentId: string }): Promise<SessionDiscussionInfo>;
};

export type ResolvedPluginRuntimeArtifact = { source: string; rootDir: string };
