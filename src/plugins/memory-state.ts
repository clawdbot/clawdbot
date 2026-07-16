/** Registry state for plugin memory runtimes, prompt supplements, and flush planning. */
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";

const log = createSubsystemLogger("plugins/memory-state");

export type MemoryPromptSectionBuilder = (params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
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

type MemoryCorpusSupplementRegistration = {
  pluginId: string;
  supplement: MemoryCorpusSupplement;
};

type MemoryPromptSupplementRegistration = {
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

type MemoryRuntimeQmdConfig = {
  command?: string;
};

type MemoryRuntimeBackendConfig =
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
    debug?: {
      backend?: "builtin" | "qmd";
      purpose?: "default" | "status" | "cli";
      managerMs?: number;
      managerCacheState?:
        | "cached-full-hit"
        | "cached-full-miss"
        | "transient-cli"
        | "transient-status"
        | "pending-create-wait"
        | "fallback-builtin"
        | "recent-failure-cooldown";
      qmdIdentityHash?: string;
      failureCode?: "qmd-unavailable";
    };
    error?: string;
  }>;
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig;
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
};

type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

type MemoryPluginState = {
  capability?: MemoryPluginCapabilityRegistration;
  corpusSupplements: MemoryCorpusSupplementRegistration[];
  promptSupplements: MemoryPromptSupplementRegistration[];
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
  const existingCapability = memoryPluginState.capability?.capability;
  // A selected memory plugin can add bridge artifacts while memory-core owns sidecar runtime hooks.
  const shouldPreserveExisting =
    existingCapability &&
    Boolean(capability.publicArtifacts) &&
    !capability.promptBuilder &&
    !capability.flushPlanResolver &&
    !capability.runtime;
  memoryPluginState.capability = {
    pluginId,
    capability: {
      ...(shouldPreserveExisting ? existingCapability : {}),
      ...capability,
    },
  };
}

function patchMemoryCapability(pluginId: string, patch: MemoryPluginCapability): void {
  const current =
    memoryPluginState.capability?.pluginId === pluginId
      ? memoryPluginState.capability.capability
      : {};
  registerMemoryCapability(pluginId, { ...current, ...patch });
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
export function registerMemoryPromptSectionForPlugin(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  patchMemoryCapability(pluginId, { promptBuilder: builder });
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
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): string[] {
  const primary = normalizeMemoryPromptLines(
    memoryPluginState.capability?.capability.promptBuilder?.(params) ?? [],
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

export function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[] {
  return [...memoryPluginState.promptSupplements];
}
export function registerMemoryFlushPlanResolverForPlugin(
  pluginId: string,
  resolver: MemoryFlushPlanResolver,
): void {
  patchMemoryCapability(pluginId, { flushPlanResolver: resolver });
}

export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return memoryPluginState.capability?.capability.flushPlanResolver?.(params) ?? null;
}
export function registerMemoryRuntimeForPlugin(
  pluginId: string,
  runtime: MemoryPluginRuntime,
): void {
  patchMemoryCapability(pluginId, { runtime });
}

export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return memoryPluginState.capability?.capability.runtime;
}

export function hasMemoryRuntime(): boolean {
  return getMemoryRuntime() !== undefined;
}

function cloneMemoryPublicArtifact(
  artifact: MemoryPluginPublicArtifact,
): MemoryPluginPublicArtifact {
  const agentIds = Array.isArray(artifact.agentIds) ? artifact.agentIds : [];
  return {
    ...artifact,
    agentIds: [...agentIds],
  };
}

// The sort below dereferences these fields, so a plugin-supplied artifact
// missing any of them would crash every status/bridge consumer.
function isValidMemoryPublicArtifact(
  artifact: MemoryPluginPublicArtifact | null | undefined,
): artifact is MemoryPluginPublicArtifact {
  return (
    typeof artifact?.kind === "string" &&
    typeof artifact.workspaceDir === "string" &&
    typeof artifact.relativePath === "string" &&
    typeof artifact.absolutePath === "string" &&
    typeof artifact.contentType === "string"
  );
}

export async function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const pluginId = memoryPluginState.capability?.pluginId;
  const listed =
    (await memoryPluginState.capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
  if (!Array.isArray(listed)) {
    log.warn(`ignoring public memory artifacts from plugin "${pluginId}": not an array`);
    return [];
  }
  const artifacts = listed.filter(isValidMemoryPublicArtifact);
  if (artifacts.length < listed.length) {
    log.warn(
      `ignoring ${listed.length - artifacts.length} malformed public memory artifact(s) from plugin "${pluginId}": artifacts must include string kind, workspaceDir, relativePath, absolutePath, and contentType`,
    );
  }
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
  memoryPluginState.promptSupplements = [...state.promptSupplements];
}

export function clearMemoryPluginState(): void {
  memoryPluginState.capability = undefined;
  memoryPluginState.corpusSupplements = [];
  memoryPluginState.promptSupplements = [];
}
