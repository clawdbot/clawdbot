import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) => string[];

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

export type MemoryCorpusGetResult = {
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
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
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
}) => MemoryFlushPlan | null;

export type RegisteredMemorySearchManager = MemorySearchManager;

export type MemoryRuntimeQmdConfig = {
  command?: string;
};

export type MemoryRuntimeBackendConfig =
  | {
      backend: "builtin";
    }
  | {
      backend: "qmd";
      qmd?: MemoryRuntimeQmdConfig;
    };

export type MemoryPluginRuntime = {
  getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status" | "cli";
  }): Promise<{
    manager: RegisteredMemorySearchManager | null;
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
  closeAllMemorySearchManagers?(): Promise<void>;
};

export type MemoryPluginPublicArtifactContentType = "markdown" | "json" | "text";

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
};

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

type MemoryPluginState = {
  capability?: MemoryPluginCapabilityRegistration;
  corpusSupplements: MemoryCorpusSupplementRegistration[];
  promptSupplements: MemoryPromptSupplementRegistration[];
  // LEGACY(memory-v1): kept for external plugins still registering the older
  // split memory surfaces. Prefer `registerMemoryCapability(...)`.
  promptBuilder?: MemoryPromptSectionBuilder;
  // LEGACY(memory-v1): remove after external memory plugins migrate to the
  // unified capability registration path.
  flushPlanResolver?: MemoryFlushPlanResolver;
  // LEGACY(memory-v1): remove after external memory plugins migrate to the
  // unified capability registration path.
  runtime?: MemoryPluginRuntime;
};

const memoryPluginState: MemoryPluginState = {
  corpusSupplements: [],
  promptSupplements: [],
};

export function registerMemoryCorpusSupplement(
  pluginId: string,
  supplement: MemoryCorpusSupplement,
): void {
  const next = memoryPluginState.corpusSupplements.filter(
    (registration) => registration.pluginId !== pluginId,
  );
  next.push({ pluginId, supplement });
  memoryPluginState.corpusSupplements = next;
}

export function registerMemoryCapability(
  pluginId: string,
  capability: MemoryPluginCapability,
): void {
  memoryPluginState.capability = { pluginId, capability: { ...capability } };
}

export function getMemoryCapabilityRegistration(): MemoryPluginCapabilityRegistration | undefined {
  return memoryPluginState.capability
    ? {
        pluginId: memoryPluginState.capability.pluginId,
        capability: { ...memoryPluginState.capability.capability },
      }
    : undefined;
}

export function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[] {
  return [...memoryPluginState.corpusSupplements];
}

/** @deprecated Use registerMemoryCapability(pluginId, { promptBuilder }) instead. */
export function registerMemoryPromptSection(builder: MemoryPromptSectionBuilder): void {
  memoryPluginState.promptBuilder = builder;
}

export function registerMemoryPromptSupplement(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  const next = memoryPluginState.promptSupplements.filter(
    (registration) => registration.pluginId !== pluginId,
  );
  next.push({ pluginId, builder });
  memoryPluginState.promptSupplements = next;
}

export function buildMemoryPromptSection(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[] {
  const primary = normalizeMemoryPromptLines(
    memoryPluginState.capability?.capability.promptBuilder?.(params) ??
      memoryPluginState.promptBuilder?.(params) ??
      [],
  );
  const supplements = memoryPluginState.promptSupplements
    // Keep supplement order stable even if plugin registration order changes.
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
    .flatMap((registration) => normalizeMemoryPromptLines(registration.builder(params)));
  return [...primary, ...supplements];
}

function normalizeMemoryPromptLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((line): line is string => typeof line === "string");
}

export function getMemoryPromptSectionBuilder(): MemoryPromptSectionBuilder | undefined {
  return memoryPluginState.capability?.capability.promptBuilder ?? memoryPluginState.promptBuilder;
}

export function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[] {
  return [...memoryPluginState.promptSupplements];
}

/** @deprecated Use registerMemoryCapability(pluginId, { flushPlanResolver }) instead. */
export function registerMemoryFlushPlanResolver(resolver: MemoryFlushPlanResolver): void {
  memoryPluginState.flushPlanResolver = resolver;
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return (
    memoryPluginState.capability?.capability.flushPlanResolver?.(params) ??
    memoryPluginState.flushPlanResolver?.(params) ??
    null
  );
}

export function getMemoryFlushPlanResolver(): MemoryFlushPlanResolver | undefined {
  return (
    memoryPluginState.capability?.capability.flushPlanResolver ??
    memoryPluginState.flushPlanResolver
  );
}

/** @deprecated Use registerMemoryCapability(pluginId, { runtime }) instead. */
export function registerMemoryRuntime(runtime: MemoryPluginRuntime): void {
  memoryPluginState.runtime = runtime;
}

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.capability?.capability.runtime ?? memoryPluginState.runtime;
}

export function hasMemoryRuntime(): boolean {
  return getMemoryRuntime() !== undefined;
}

function cloneMemoryPublicArtifact(
  artifact: MemoryPluginPublicArtifact,
): MemoryPluginPublicArtifact {
  return {
    ...artifact,
    agentIds: [...artifact.agentIds],
  };
}

export async function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const artifacts =
    (await memoryPluginState.capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
  return artifacts.map(cloneMemoryPublicArtifact).toSorted((left, right) => {
    const workspaceOrder = left.workspaceDir.localeCompare(right.workspaceDir);
    if (workspaceOrder !== 0) {
      return workspaceOrder;
    }
    const relativePathOrder = left.relativePath.localeCompare(right.relativePath);
    if (relativePathOrder !== 0) {
      return relativePathOrder;
    }
    const kindOrder = left.kind.localeCompare(right.kind);
    if (kindOrder !== 0) {
      return kindOrder;
    }
    const contentTypeOrder = left.contentType.localeCompare(right.contentType);
    if (contentTypeOrder !== 0) {
      return contentTypeOrder;
    }
    const agentOrder = left.agentIds.join("\0").localeCompare(right.agentIds.join("\0"));
    if (agentOrder !== 0) {
      return agentOrder;
    }
    return left.absolutePath.localeCompare(right.absolutePath);
  });
}

export function restoreMemoryPluginState(state: MemoryPluginState): void {
  memoryPluginState.capability = state.capability
    ? {
        pluginId: state.capability.pluginId,
        capability: { ...state.capability.capability },
      }
    : undefined;
  memoryPluginState.corpusSupplements = [...state.corpusSupplements];
  memoryPluginState.promptBuilder = state.promptBuilder;
  memoryPluginState.promptSupplements = [...state.promptSupplements];
  memoryPluginState.flushPlanResolver = state.flushPlanResolver;
  memoryPluginState.runtime = state.runtime;
}

export function clearMemoryPluginState(): void {
  memoryPluginState.capability = undefined;
  memoryPluginState.corpusSupplements = [];
  memoryPluginState.promptBuilder = undefined;
  memoryPluginState.promptSupplements = [];
  memoryPluginState.flushPlanResolver = undefined;
  memoryPluginState.runtime = undefined;
}

export const _resetMemoryPluginState = clearMemoryPluginState;
