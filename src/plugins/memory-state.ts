/** Registry state for plugin memory runtimes, prompt supplements, and flush planning. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { MemorySearchManager } from "../memory-host-sdk/host/types.js";
import { requireActivePluginRegistry, resolveDirectPluginRegistrationOwner } from "./runtime.js";

const log = createSubsystemLogger("plugins/memory-state");

export type MemoryPromptSectionParams = {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

export type MemoryPromptSectionBuilder = (params: MemoryPromptSectionParams) => string[];

/**
 * Loads and renders prompt state before synchronous prompt assembly.
 * Implementations may perform async state reads here, but must validate their
 * owner instance before returning lines for the current run.
 */
type MemoryPromptSectionPreparer = (
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
  recordWriteProvenance?: (params: {
    workspaceDir: string;
    relativePath: string;
    contentBefore: string;
    contentAfter: string;
    originClass: "agent" | "untrusted";
    observedAt: number;
  }) => Promise<(() => Promise<void>) | void>;
  clearWriteProvenance?: (params: { workspaceDir: string; relativePath: string }) => Promise<void>;
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

export type MemoryPluginCapabilityRegistration = {
  pluginId: string;
  capability: MemoryPluginCapability;
};

export type MemoryPluginState = {
  capability?: MemoryPluginCapabilityRegistration;
  corpusSupplements: MemoryCorpusSupplementRegistration[];
  promptPreparations: MemoryPromptPreparationRegistration[];
  promptSupplements: MemoryPromptSupplementRegistration[];
};

export function resolveMemoryCapabilityRegistration(
  registrations: readonly MemoryPluginCapabilityRegistration[],
): MemoryPluginCapabilityRegistration | undefined {
  let effective: MemoryPluginCapabilityRegistration | undefined;
  for (const registration of registrations) {
    const existing = effective?.capability;
    // An artifact bridge layers onto the selected memory runtime without taking ownership of it.
    const preserveExisting =
      existing &&
      Boolean(registration.capability.publicArtifacts) &&
      !registration.capability.promptBuilder &&
      !registration.capability.flushPlanResolver &&
      !registration.capability.runtime;
    effective = {
      pluginId: registration.pluginId,
      capability: {
        ...(preserveExisting ? existing : {}),
        ...registration.capability,
      },
    };
  }
  return effective;
}

const getMemoryCapability = () =>
  resolveMemoryCapabilityRegistration(requireActivePluginRegistry().memoryCapabilities);

const preparedMemoryPromptSections = new WeakSet<PreparedMemoryPromptSection>();
const activePreparedMemoryPromptSection = new AsyncLocalStorage<PreparedMemoryPromptSection>();

export function registerMemoryCorpusSupplement(
  pluginId: string,
  supplement: MemoryCorpusSupplement,
): void {
  pluginId = resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryCorpusSupplements = registry.memoryCorpusSupplements
    .filter((registration) => registration.pluginId !== pluginId)
    .concat({ pluginId, supplement });
}

export function registerMemoryCapability(
  pluginId: string,
  capability: MemoryPluginCapability,
): void {
  pluginId = resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryCapabilities.push({ pluginId, capability });
}

export function getMemoryCapabilityRegistration(): MemoryPluginCapabilityRegistration | undefined {
  const capability = getMemoryCapability();
  return capability
    ? {
        pluginId: capability.pluginId,
        capability: { ...capability.capability },
      }
    : undefined;
}

export function listMemoryCorpusSupplements(): MemoryCorpusSupplementRegistration[] {
  return [...requireActivePluginRegistry().memoryCorpusSupplements];
}
export function registerMemoryPromptSupplement(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
): void {
  pluginId = resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryPromptSupplements = registry.memoryPromptSupplements
    .filter((registration) => registration.pluginId !== pluginId)
    .concat({ pluginId, builder });
}

export function registerMemoryPromptPreparation(
  pluginId: string,
  prepare: MemoryPromptSectionPreparer,
): void {
  pluginId = resolveDirectPluginRegistrationOwner(pluginId) ?? pluginId;
  const registry = requireActivePluginRegistry();
  registry.memoryPromptPreparations = registry.memoryPromptPreparations
    .filter((registration) => registration.pluginId !== pluginId)
    .concat({ pluginId, prepare });
}

function buildSynchronousMemoryPromptSection(params: MemoryPromptSectionParams): {
  primary: string[];
  supplements: Array<{ pluginId: string; lines: string[] }>;
} {
  const registry = requireActivePluginRegistry();
  const primary = normalizeMemoryPromptLines(
    resolveMemoryCapabilityRegistration(registry.memoryCapabilities)?.capability.promptBuilder?.(
      params,
    ) ?? [],
  );
  const supplements = registry.memoryPromptSupplements
    // Keep supplement order stable even if plugin registration order changes.
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
    .map((registration) => ({
      pluginId: registration.pluginId,
      lines: normalizeMemoryPromptLines(registration.builder(params)),
    }));
  return { primary, supplements };
}

function cloneMemoryPromptSectionParams(
  params: MemoryPromptSectionParams,
): MemoryPromptSectionParams {
  return {
    availableTools: new Set(params.availableTools),
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
  };
}

function snapshotMemoryPromptContext(
  params: MemoryPromptSectionParams,
): PreparedMemoryPromptSection["context"] {
  return Object.freeze({
    availableTools: Object.freeze([...params.availableTools].toSorted()),
    citationsMode: params.citationsMode,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed === true,
  });
}

function preparedMemoryPromptContextMatches(
  prepared: PreparedMemoryPromptSection,
  params: MemoryPromptSectionParams,
): boolean {
  const current = snapshotMemoryPromptContext(params);
  return (
    prepared.context.citationsMode === current.citationsMode &&
    prepared.context.agentId === current.agentId &&
    prepared.context.agentSessionKey === current.agentSessionKey &&
    prepared.context.sandboxed === current.sandboxed &&
    prepared.context.availableTools.length === current.availableTools.length &&
    prepared.context.availableTools.every((tool, index) => tool === current.availableTools[index])
  );
}

/** Prepare one immutable memory prompt snapshot for a run. */
export async function prepareMemoryPromptSection(
  params: MemoryPromptSectionParams,
): Promise<PreparedMemoryPromptSection> {
  const runParams = cloneMemoryPromptSectionParams(params);
  const context = snapshotMemoryPromptContext(runParams);
  const synchronous = buildSynchronousMemoryPromptSection(
    cloneMemoryPromptSectionParams(runParams),
  );
  const preparationRegistrations = [...requireActivePluginRegistry().memoryPromptPreparations];
  const preparedSupplements = await Promise.all(
    preparationRegistrations.map(async (registration) => ({
      pluginId: registration.pluginId,
      lines: normalizeMemoryPromptLines(
        await registration.prepare(cloneMemoryPromptSectionParams(runParams)),
      ),
    })),
  );
  const lines = Object.freeze([
    ...synchronous.primary,
    ...[...synchronous.supplements, ...preparedSupplements]
      .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId))
      .flatMap((registration) => registration.lines),
  ]);
  const prepared = Object.freeze({
    context,
    lines,
  });
  preparedMemoryPromptSections.add(prepared);
  return prepared;
}

/** Keep async preparation run-scoped while a context engine assembles synchronously. */
export async function runWithPreparedMemoryPromptSection<T>(
  params: MemoryPromptSectionParams,
  run: () => Promise<T>,
): Promise<T> {
  const prepared = await prepareMemoryPromptSection(params);
  return activePreparedMemoryPromptSection.run(prepared, run);
}

export function getActivePreparedMemoryPromptSection(): PreparedMemoryPromptSection | undefined {
  return activePreparedMemoryPromptSection.getStore();
}

export function buildMemoryPromptSection(
  params: MemoryPromptSectionParams,
  prepared?: PreparedMemoryPromptSection,
): string[] {
  if (prepared) {
    // Run-scoped prompt state must never cross agent/session/tool boundaries.
    if (
      !preparedMemoryPromptSections.has(prepared) ||
      !preparedMemoryPromptContextMatches(prepared, params)
    ) {
      throw new Error("prepared memory prompt section does not match the current run");
    }
    return [...prepared.lines];
  }
  const synchronous = buildSynchronousMemoryPromptSection(params);
  return [...synchronous.primary, ...synchronous.supplements.flatMap((entry) => entry.lines)];
}

function normalizeMemoryPromptLines(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((line): line is string => typeof line === "string");
}

export function listMemoryPromptSupplements(): MemoryPromptSupplementRegistration[] {
  return [...requireActivePluginRegistry().memoryPromptSupplements];
}
export function listMemoryPromptPreparations(): MemoryPromptPreparationRegistration[] {
  return [...requireActivePluginRegistry().memoryPromptPreparations];
}
export function resolveMemoryFlushPlan(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): MemoryFlushPlan | null {
  return getMemoryCapability()?.capability.flushPlanResolver?.(params) ?? null;
}
export function getMemoryRuntime(): MemoryPluginRuntime | undefined {
  return getMemoryCapability()?.capability.runtime;
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
  const capability = getMemoryCapability();
  const pluginId = capability?.pluginId;
  const listed = (await capability?.capability.publicArtifacts?.listArtifacts(params)) ?? [];
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
  const registry = requireActivePluginRegistry();
  registry.memoryCapabilities = state.capability
    ? [{ pluginId: state.capability.pluginId, capability: { ...state.capability.capability } }]
    : [];
  registry.memoryCorpusSupplements = [...state.corpusSupplements];
  registry.memoryPromptPreparations = [...state.promptPreparations];
  registry.memoryPromptSupplements = [...state.promptSupplements];
}

export function clearMemoryPluginState(): void {
  const registry = requireActivePluginRegistry();
  registry.memoryCapabilities = [];
  registry.memoryCorpusSupplements = [];
  registry.memoryPromptPreparations = [];
  registry.memoryPromptSupplements = [];
}
