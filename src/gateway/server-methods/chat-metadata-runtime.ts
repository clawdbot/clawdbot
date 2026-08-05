import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  getPreparedRuntimeAuthProfileStoreSnapshot,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import {
  getPreparedModelCatalogOwnerSnapshot,
  type LoadPreparedModelCatalogParams,
} from "../../agents/prepared-model-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { resolveSwarmConfig } from "../../agents/swarm-config.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import type {
  ChatMetadataReadParams,
  ChatMetadataResult,
  ChatMetadataSessionEntry,
} from "./chat-metadata-contract.js";
import type { GatewayRequestContext } from "./types.js";

export type { ChatMetadataResult } from "./chat-metadata-contract.js";

type PreparedAgentFacts = {
  agentId: string;
  owner: PreparedModelRuntimeSnapshot;
  authStore: AuthProfileStore;
  skillsVersion: number;
};

type PreparedGenerationFacts = {
  config: OpenClawConfig;
  configKey: string;
  pluginRegistryVersion: number;
  agents: PreparedAgentFacts[];
};

type PreparedAgentMetadata = PreparedAgentFacts & {
  commands?: unknown[];
  swarmEnabled: boolean;
};

type PreparedMetadataGeneration = {
  epoch: number;
  facts: PreparedGenerationFacts;
  agentsById: Map<string, PreparedAgentMetadata>;
  metadataByKey: Map<string, Promise<ChatMetadataResult>>;
};

type MetadataReplacement = {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
};

type ChatMetadataRuntimeDeps = {
  getConfig: () => OpenClawConfig;
  getContext: () => GatewayRequestContext;
  getPreparedOwner: (
    params: LoadPreparedModelCatalogParams,
  ) => PreparedModelRuntimeSnapshot | undefined;
  getPreparedAuthStore: (
    agentDir?: string,
    inheritedAuthDir?: string,
  ) => AuthProfileStore | undefined;
  getSkillsVersion: (workspaceDir?: string) => number;
  getPluginRegistryVersion: () => number;
  buildCommands: (params: {
    cfg: OpenClawConfig;
    agentId: string;
  }) => Promise<{ commands?: unknown[] }>;
  buildModels: (params: {
    context: GatewayRequestContext;
    facts: PreparedAgentFacts;
    preferredProfileId?: string;
    lockedProfileId?: string;
  }) => Promise<{ models?: unknown[] }>;
};

const CHAT_METADATA_CACHE_MAX_ENTRIES = 64;

function createMetadataReplacement(): MetadataReplacement {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Reads and lifecycle refreshes observe the original promise. This handler only prevents an
  // unobserved rejection when shutdown or reload failure occurs without a concurrent reader.
  void promise.catch(() => {});
  return { promise, reject, resolve };
}

class ChatMetadataSnapshotUnavailableError extends Error {
  constructor(message = "prepared chat metadata snapshot is unavailable") {
    super(message);
    this.name = "ChatMetadataSnapshotUnavailableError";
  }
}

function captureGenerationFacts(deps: ChatMetadataRuntimeDeps): PreparedGenerationFacts {
  const config = deps.getConfig();
  const agents = listAgentIds(config).map((rawAgentId): PreparedAgentFacts => {
    const agentId = normalizeAgentId(rawAgentId);
    const owner =
      deps.getPreparedOwner({
        agentId,
        config,
        readOnly: true,
        allowGatewaySubagentBinding: true,
      }) ??
      deps.getPreparedOwner({
        agentId,
        config,
        readOnly: true,
      });
    if (!owner) {
      throw new ChatMetadataSnapshotUnavailableError(
        `prepared chat metadata owner is unavailable for agent "${agentId}"`,
      );
    }
    const workspaceDir = owner.workspaceDir ?? resolveAgentWorkspaceDir(config, agentId);
    return {
      agentId,
      owner,
      authStore: deps.getPreparedAuthStore(owner.agentDir, owner.inheritedAuthDir) ?? {
        version: 1,
        profiles: {},
      },
      skillsVersion: deps.getSkillsVersion(workspaceDir),
    };
  });
  return {
    config,
    configKey: resolveRuntimeConfigCacheKey(config),
    pluginRegistryVersion: deps.getPluginRegistryVersion(),
    agents,
  };
}

function generationFactsMatch(
  left: PreparedGenerationFacts,
  right: PreparedGenerationFacts,
): boolean {
  if (
    left.configKey !== right.configKey ||
    left.pluginRegistryVersion !== right.pluginRegistryVersion ||
    left.agents.length !== right.agents.length
  ) {
    return false;
  }
  return left.agents.every((agent, index) => {
    const candidate = right.agents[index];
    return (
      candidate?.agentId === agent.agentId &&
      candidate.owner === agent.owner &&
      candidate.skillsVersion === agent.skillsVersion
    );
  });
}

function resolveSessionProfiles(sessionEntry: ChatMetadataSessionEntry | undefined): {
  preferredProfileId?: string;
  lockedProfileId?: string;
} {
  const profileId = sessionEntry?.authProfileOverride?.trim();
  if (!profileId) {
    return {};
  }
  const profileSource = sessionEntry?.authProfileOverrideSource;
  const legacyUserProfile =
    profileSource === undefined && sessionEntry?.authProfileOverrideCompactionCount === undefined;
  return {
    preferredProfileId: profileId,
    ...(profileSource === "user" || legacyUserProfile ? { lockedProfileId: profileId } : {}),
  };
}

function metadataKey(agentId: string, sessionEntry: ChatMetadataSessionEntry | undefined): string {
  const profiles = resolveSessionProfiles(sessionEntry);
  return [
    normalizeAgentId(agentId),
    profiles.preferredProfileId ?? "",
    profiles.lockedProfileId ?? "",
  ].join("\0");
}

async function defaultBuildCommands(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<{ commands?: unknown[] }> {
  const { buildCommandsListResult } = await import("./commands-list-result.js");
  return buildCommandsListResult({
    cfg: params.cfg,
    agentId: params.agentId,
    includeArgs: true,
    scope: "text",
  });
}

async function defaultBuildModels(params: {
  context: GatewayRequestContext;
  facts: PreparedAgentFacts;
  preferredProfileId?: string;
  lockedProfileId?: string;
}): Promise<{ models?: unknown[] }> {
  const { buildModelsListResult, createGatewayAgentModelCatalogProjector } =
    await import("./models-list-result.js");
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: params.facts.owner.config,
    agentId: params.facts.agentId,
    snapshot: params.facts.owner.modelCatalog,
    metadataSnapshot: params.facts.owner.metadataSnapshot,
    preparedAuthStore: params.facts.authStore,
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
  });
  return await buildModelsListResult({
    context: params.context,
    agentId: params.facts.agentId,
    params: { view: "configured" },
    preloadedCatalog: {
      agentId: params.facts.agentId,
      config: params.facts.owner.config,
      snapshot: params.facts.owner.modelCatalog,
    },
    preloadedOnly: true,
    catalogProjector: projector,
  });
}

export function createGatewayChatMetadataRuntime(params: {
  getConfig: () => OpenClawConfig;
  getContext: () => GatewayRequestContext;
  beforeRefresh?: () => Promise<void>;
  refreshOnRead?: boolean;
  log: {
    warn: (message: string) => void;
  };
  deps?: Partial<ChatMetadataRuntimeDeps>;
}): {
  invalidate: () => void;
  fail: (error: unknown) => void;
  refresh: () => Promise<void>;
  read: (params: ChatMetadataReadParams) => Promise<ChatMetadataResult>;
} {
  const deps: ChatMetadataRuntimeDeps = {
    getConfig: params.getConfig,
    getContext: params.getContext,
    getPreparedOwner: getPreparedModelCatalogOwnerSnapshot,
    getPreparedAuthStore: getPreparedRuntimeAuthProfileStoreSnapshot,
    getSkillsVersion: getSkillsSnapshotVersion,
    getPluginRegistryVersion: getActivePluginRegistryVersion,
    buildCommands: defaultBuildCommands,
    buildModels: defaultBuildModels,
    ...params.deps,
  };
  let current: PreparedMetadataGeneration | undefined;
  let lastError: Error | undefined;
  let replacement: MetadataReplacement | undefined;
  let invalidationEpoch = 0;
  let refreshTail: Promise<void> = Promise.resolve();
  let pending:
    | {
        facts?: PreparedGenerationFacts;
        promise: Promise<void>;
      }
    | undefined;

  const projectMetadata = (
    generation: PreparedMetadataGeneration,
    agent: PreparedAgentMetadata,
    sessionEntry?: ChatMetadataSessionEntry,
  ): Promise<ChatMetadataResult> => {
    const key = metadataKey(agent.agentId, sessionEntry);
    const existing = generation.metadataByKey.get(key);
    if (existing) {
      return existing;
    }
    const profiles = resolveSessionProfiles(sessionEntry);
    const projection = deps
      .buildModels({
        context: deps.getContext(),
        facts: agent,
        ...profiles,
      })
      .then((models) => ({
        ...models,
        ...(agent.commands !== undefined ? { commands: agent.commands } : {}),
        swarmEnabled: agent.swarmEnabled,
      }))
      .catch((error: unknown) => {
        generation.metadataByKey.delete(key);
        throw error;
      });
    generation.metadataByKey.set(key, projection);
    pruneMapToMaxSize(generation.metadataByKey, CHAT_METADATA_CACHE_MAX_ENTRIES);
    return projection;
  };

  const buildGeneration = async (
    facts: PreparedGenerationFacts,
    epoch: number,
  ): Promise<boolean> => {
    const agents = await Promise.all(
      facts.agents.map(async (agent): Promise<PreparedAgentMetadata> => {
        let commands: unknown[] | undefined;
        try {
          commands = (await deps.buildCommands({ cfg: facts.config, agentId: agent.agentId }))
            .commands;
        } catch (error) {
          params.log.warn(
            `chat metadata continuing without text commands for ${agent.agentId}: ${formatErrorMessage(error)}`,
          );
        }
        return {
          ...agent,
          ...(commands !== undefined ? { commands } : {}),
          swarmEnabled: resolveSwarmConfig(facts.config, agent.agentId).enabled,
        };
      }),
    );
    const generation: PreparedMetadataGeneration = {
      epoch,
      facts,
      agentsById: new Map(agents.map((agent) => [agent.agentId, agent])),
      metadataByKey: new Map(),
    };
    if (epoch !== invalidationEpoch) {
      return false;
    }
    current = generation;
    await Promise.allSettled(agents.map((agent) => projectMetadata(generation, agent)));
    return epoch === invalidationEpoch;
  };

  const runRefresh = async () => {
    await params.beforeRefresh?.();
    for (;;) {
      const facts = captureGenerationFacts(deps);
      if (current && generationFactsMatch(current.facts, facts)) {
        return;
      }
      const epoch = invalidationEpoch;
      if (!(await buildGeneration(facts, epoch))) {
        continue;
      }
      const latest = captureGenerationFacts(deps);
      if (epoch === invalidationEpoch && generationFactsMatch(facts, latest)) {
        return;
      }
    }
  };

  const refresh = (): Promise<void> => {
    const trackRefresh = (
      promise: Promise<void>,
      facts?: PreparedGenerationFacts,
    ): Promise<void> => {
      refreshTail = promise;
      pending = { ...(facts ? { facts } : {}), promise };
      void promise.then(
        () => {
          if (pending?.promise !== promise) {
            return;
          }
          pending = undefined;
          // One worker can absorb later invalidations and publish their generation. Settle the
          // replacement owned by what it actually committed, not by the epoch that scheduled it.
          if (current?.epoch !== invalidationEpoch) {
            return;
          }
          lastError = undefined;
          const committedReplacement = replacement;
          replacement = undefined;
          committedReplacement?.resolve();
        },
        (error: unknown) => {
          if (pending?.promise !== promise) {
            return;
          }
          pending = undefined;
          fail(error);
        },
      );
      return promise;
    };
    if (params.beforeRefresh) {
      if (pending) {
        return pending.promise;
      }
      const promise = refreshTail.catch(() => {}).then(runRefresh);
      return trackRefresh(promise);
    }
    let facts: PreparedGenerationFacts;
    try {
      facts = captureGenerationFacts(deps);
    } catch (error) {
      const refreshError = error instanceof Error ? error : new Error(formatErrorMessage(error));
      fail(refreshError);
      return Promise.reject(refreshError);
    }
    if (current && generationFactsMatch(current.facts, facts)) {
      return Promise.resolve();
    }
    if (pending?.facts && generationFactsMatch(pending.facts, facts)) {
      return pending.promise;
    }
    const promise = refreshTail.catch(() => {}).then(runRefresh);
    return trackRefresh(promise, facts);
  };

  const read = async (readParams: ChatMetadataReadParams): Promise<ChatMetadataResult> => {
    for (;;) {
      const replacementPromise = replacement?.promise;
      if (replacementPromise) {
        await replacementPromise;
        continue;
      }
      const refreshPromise = pending?.promise;
      if (refreshPromise) {
        await refreshPromise;
        continue;
      }
      let generation = current;
      if (!generation && params.refreshOnRead) {
        await refresh();
        generation = current;
      }
      if (!generation) {
        if (lastError) {
          throw lastError;
        }
        throw new ChatMetadataSnapshotUnavailableError();
      }
      if (params.refreshOnRead) {
        let latest: PreparedGenerationFacts | undefined;
        try {
          latest = captureGenerationFacts(deps);
        } catch {
          await refresh();
          generation = current;
        }
        if (latest && generation && !generationFactsMatch(generation.facts, latest)) {
          await refresh();
          generation = current;
        }
      }
      if (!generation) {
        throw new ChatMetadataSnapshotUnavailableError();
      }
      if (params.refreshOnRead) {
        const latest = captureGenerationFacts(deps);
        if (!generationFactsMatch(generation.facts, latest)) {
          throw new ChatMetadataSnapshotUnavailableError(
            "prepared chat metadata snapshot is stale while its replacement is publishing",
          );
        }
      }
      const agentId = normalizeAgentId(readParams.agentId);
      const agent = generation.agentsById.get(agentId);
      if (!agent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat metadata is unavailable for agent "${agentId}"`,
        );
      }
      try {
        const result = await projectMetadata(generation, agent, readParams.sessionEntry);
        // Lazy projections may outlive their generation. Never return an obsolete success after
        // invalidation; retry through the replacement gate so the caller sees one coherent epoch.
        if (current === generation && generation.epoch === invalidationEpoch) {
          return result;
        }
      } catch (error) {
        if (current === generation && generation.epoch === invalidationEpoch) {
          throw error;
        }
      }
    }
  };

  const invalidate = () => {
    invalidationEpoch += 1;
    current = undefined;
    lastError = undefined;
    replacement ??= createMetadataReplacement();
  };

  const fail = (error: unknown) => {
    const replacementError = error instanceof Error ? error : new Error(formatErrorMessage(error));
    current = undefined;
    lastError = replacementError;
    const failedReplacement = replacement;
    replacement = undefined;
    failedReplacement?.reject(replacementError);
  };

  return { fail, invalidate, read, refresh };
}
