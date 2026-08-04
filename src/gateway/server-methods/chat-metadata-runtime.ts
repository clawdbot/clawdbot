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
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import type { GatewayRequestContext } from "./types.js";

export type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
  swarmEnabled: boolean;
};

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
  facts: PreparedGenerationFacts;
  agentsById: Map<string, PreparedAgentMetadata>;
  metadataByKey: Map<string, Promise<ChatMetadataResult>>;
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

export class ChatMetadataSnapshotUnavailableError extends Error {
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

function resolveSessionProfiles(sessionEntry: SessionEntry | undefined): {
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

function metadataKey(agentId: string, sessionEntry: SessionEntry | undefined): string {
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
  refresh: () => Promise<void>;
  read: (params: { agentId: string; sessionEntry?: SessionEntry }) => Promise<ChatMetadataResult>;
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
    sessionEntry?: SessionEntry,
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
    if (params.beforeRefresh) {
      if (pending) {
        return pending.promise;
      }
      const promise = refreshTail.catch(() => {}).then(runRefresh);
      refreshTail = promise;
      pending = { promise };
      const clearPending = () => {
        if (pending?.promise === promise) {
          pending = undefined;
        }
      };
      void promise.then(clearPending, clearPending);
      return promise;
    }
    let facts: PreparedGenerationFacts;
    try {
      facts = captureGenerationFacts(deps);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(formatErrorMessage(error)));
    }
    if (current && generationFactsMatch(current.facts, facts)) {
      return Promise.resolve();
    }
    if (pending?.facts && generationFactsMatch(pending.facts, facts)) {
      return pending.promise;
    }
    const promise = refreshTail.catch(() => {}).then(runRefresh);
    refreshTail = promise;
    pending = { facts, promise };
    const clearPending = () => {
      if (pending?.promise === promise) {
        pending = undefined;
      }
    };
    void promise.then(clearPending, clearPending);
    return promise;
  };

  const read = async (readParams: {
    agentId: string;
    sessionEntry?: SessionEntry;
  }): Promise<ChatMetadataResult> => {
    if (pending) {
      await pending.promise;
    }
    let generation = current;
    if (!generation && params.refreshOnRead) {
      await refresh();
      generation = current;
    }
    if (!generation) {
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
    return await projectMetadata(generation, agent, readParams.sessionEntry);
  };

  const invalidate = () => {
    invalidationEpoch += 1;
    current = undefined;
  };

  return { invalidate, read, refresh };
}
