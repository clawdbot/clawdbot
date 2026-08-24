import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  getPreparedRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshotRevision,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  type GetPublishedPreparedModelCatalogOwnerParams,
} from "../../agents/prepared-model-catalog.js";
import { getPreparedModelRuntimeAuthMaterializations } from "../../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.js";
import { resolveSwarmConfig } from "../../agents/subagents/swarm/swarm-config.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { getSkillsSnapshotVersion } from "../../skills/runtime/refresh-state.js";
import { listAgentsForGateway } from "../session-utils.js";
import type {
  ChatMetadataReadParams,
  ChatMetadataResult,
  ChatMetadataSessionEntry,
} from "./chat-metadata-contract.js";
import type {
  ChatStartupProjectionReadParams,
  ChatStartupProjectionResult,
} from "./chat-startup-projection-contract.js";
import type { GatewayRequestContext } from "./types.js";

export type { ChatMetadataResult } from "./chat-metadata-contract.js";

type PreparedAgentFacts = {
  agentId: string;
  owner: PreparedModelRuntimeSnapshot;
  authStore: AuthProfileStore;
  authStoreRevision: string;
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

type PreparedAgentProjection = {
  metadata: ChatMetadataResult;
  modelCatalog: ModelCatalogEntry[];
};

type PreparedMetadataGeneration = {
  epoch: number;
  facts: PreparedGenerationFacts;
  agentsById: Map<string, PreparedAgentMetadata>;
  neutralProjectionByAgentId: Map<string, Promise<PreparedAgentProjection>>;
  sessionProjectionByKey: Map<string, Promise<PreparedAgentProjection>>;
  agentsListByKey: Map<string, ChatStartupProjectionResult["agentsList"]>;
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
    params: GetPublishedPreparedModelCatalogOwnerParams,
  ) => PreparedModelRuntimeSnapshot | undefined;
  getPreparedAuthStore: (
    agentDir?: string,
    inheritedAuthDir?: string,
  ) => AuthProfileStore | undefined;
  getAuthStoreRevision: (agentDir?: string) => number;
  getSkillsVersion: (workspaceDir?: string) => number;
  getPluginRegistryVersion: () => number;
  buildCommands: (params: {
    cfg: OpenClawConfig;
    agentId: string;
  }) => Promise<{ commands?: unknown[] }>;
  buildProjection: (params: {
    context: GatewayRequestContext;
    facts: PreparedAgentFacts;
    preferredProfileId?: string;
    lockedProfileId?: string;
  }) => Promise<{ modelCatalog: ModelCatalogEntry[]; models?: unknown[] }>;
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
    // Metadata follows the published lifecycle owner while its replacement gate owns turnover;
    // display-only config publications must not make that still-current owner disappear.
    const owner = deps.getPreparedOwner({ agentId, config });
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
      authStoreRevision: `${deps.getAuthStoreRevision(owner.agentDir)}:${deps.getAuthStoreRevision(owner.inheritedAuthDir)}`,
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
      candidate.authStoreRevision === agent.authStoreRevision &&
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
  const profileSource = resolveSessionAuthProfileOverrideSource(sessionEntry);
  return {
    preferredProfileId: profileId,
    ...(profileSource === "user" ? { lockedProfileId: profileId } : {}),
  };
}

function sessionProjectionKey(
  agentId: string,
  profiles: ReturnType<typeof resolveSessionProfiles>,
): string {
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

async function defaultBuildProjection(params: {
  context: GatewayRequestContext;
  facts: PreparedAgentFacts;
  preferredProfileId?: string;
  lockedProfileId?: string;
}): Promise<{ modelCatalog: ModelCatalogEntry[]; models?: unknown[] }> {
  const { buildModelsListResult, createGatewayAgentModelCatalogProjector } =
    await import("./models-list-result.js");
  // Chat metadata must stay on process-published facts. Live discovery belongs to explicit
  // models.list control-plane reads so a slow provider cannot delay chat startup.
  const snapshot = params.facts.owner.modelCatalog;
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: params.facts.owner.config,
    agentId: params.facts.agentId,
    snapshot,
    metadataSnapshot: params.facts.owner.metadataSnapshot,
    preparedAuthStore: params.facts.authStore,
    // The owner records usable auth at discovery; metadata must share that exact generation fact.
    preparedRuntimeAuthModes: params.facts.owner.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(
      params.facts.owner,
    ),
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
  });
  const [modelCatalog, metadata] = await Promise.all([
    projector.projectCatalog(),
    buildModelsListResult({
      context: params.context,
      agentId: params.facts.agentId,
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: params.facts.agentId,
        config: params.facts.owner.config,
        snapshot,
      },
      preloadedOnly: true,
      catalogProjector: projector,
    }),
  ]);
  return { modelCatalog, models: metadata.models };
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
  readStartup: (params: ChatStartupProjectionReadParams) => Promise<ChatStartupProjectionResult>;
} {
  const deps: ChatMetadataRuntimeDeps = {
    getConfig: params.getConfig,
    getContext: params.getContext,
    getPreparedOwner: getPublishedPreparedModelCatalogOwnerSnapshot,
    getPreparedAuthStore: getPreparedRuntimeAuthProfileStoreSnapshot,
    getAuthStoreRevision: getRuntimeAuthProfileStoreSnapshotRevision,
    getSkillsVersion: getSkillsSnapshotVersion,
    getPluginRegistryVersion: getActivePluginRegistryVersion,
    buildCommands: defaultBuildCommands,
    buildProjection: defaultBuildProjection,
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

  const projectAgent = (
    generation: PreparedMetadataGeneration,
    agent: PreparedAgentMetadata,
    sessionEntry?: ChatMetadataSessionEntry,
  ): Promise<PreparedAgentProjection> => {
    const profiles = resolveSessionProfiles(sessionEntry);
    const neutral =
      profiles.preferredProfileId === undefined && profiles.lockedProfileId === undefined;
    const projections = neutral
      ? generation.neutralProjectionByAgentId
      : generation.sessionProjectionByKey;
    const key = neutral ? agent.agentId : sessionProjectionKey(agent.agentId, profiles);
    const existing = projections.get(key);
    if (existing) {
      return existing;
    }
    const projection = deps
      .buildProjection({
        context: deps.getContext(),
        facts: agent,
        ...profiles,
      })
      .then(({ modelCatalog, ...models }) => ({
        modelCatalog,
        metadata: {
          ...models,
          ...(agent.commands !== undefined ? { commands: agent.commands } : {}),
          swarmEnabled: agent.swarmEnabled,
        },
      }))
      .catch((error: unknown) => {
        projections.delete(key);
        throw error;
      });
    projections.set(key, projection);
    if (!neutral) {
      // Neutral projections belong to the published generation. Only request-derived profile
      // variants are bounded; evicting neutral entries puts catalog work back on startup reads.
      pruneMapToMaxSize(projections, CHAT_METADATA_CACHE_MAX_ENTRIES);
    }
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
      neutralProjectionByAgentId: new Map(),
      sessionProjectionByKey: new Map(),
      agentsListByKey: new Map(),
    };
    if (epoch !== invalidationEpoch) {
      return false;
    }
    await Promise.all(agents.map((agent) => projectAgent(generation, agent)));
    if (epoch !== invalidationEpoch) {
      return false;
    }
    current = generation;
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

  const readCurrent = async <Result>(
    project: (generation: PreparedMetadataGeneration) => Promise<Result>,
  ): Promise<Result> => {
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
      // Unavailable means the prepared owner was missing, not that publication failed.
      // Retry capture so a later published owner is not hidden behind lastError.
      const retryUnavailableOwner = lastError instanceof ChatMetadataSnapshotUnavailableError;
      if (!generation && (params.refreshOnRead || retryUnavailableOwner)) {
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
      try {
        const result = await project(generation);
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

  const read = async (readParams: ChatMetadataReadParams): Promise<ChatMetadataResult> =>
    await readCurrent(async (generation) => {
      const agentId = normalizeAgentId(readParams.agentId);
      const agent = generation.agentsById.get(agentId);
      if (!agent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat metadata is unavailable for agent "${agentId}"`,
        );
      }
      return (await projectAgent(generation, agent, readParams.sessionEntry)).metadata;
    });

  const readStartup = async (
    readParams: ChatStartupProjectionReadParams,
  ): Promise<ChatStartupProjectionResult> =>
    await readCurrent(async (generation) => {
      const sessionAgentId = normalizeAgentId(readParams.agentId);
      const sessionAgent = generation.agentsById.get(sessionAgentId);
      if (!sessionAgent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat startup projection is unavailable for agent "${sessionAgentId}"`,
        );
      }
      const defaultAgentId = sessionAgentId;
      const profileNeutralProjections = await Promise.all(
        [...generation.agentsById.values()].map(
          async (agent) => [agent.agentId, await projectAgent(generation, agent)] as const,
        ),
      );
      const projectionByAgentId = new Map(profileNeutralProjections);
      const sessionProjection = await projectAgent(
        generation,
        sessionAgent,
        readParams.sessionEntry,
      );
      const defaultProjection = projectionByAgentId.get(defaultAgentId);
      if (!defaultProjection) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat startup projection is unavailable for default agent "${defaultAgentId}"`,
        );
      }
      const agentsListKey = readParams.includeSystem ? "include-system" : "agents-only";
      let agentsList = generation.agentsListByKey.get(agentsListKey);
      if (!agentsList) {
        const modelCatalogByAgentId = new Map(
          profileNeutralProjections.map(([agentId, projection]) => [
            agentId,
            projection.modelCatalog,
          ]),
        );
        // Disk-only legacy roster rows remain visible, but inherit the default prepared catalog.
        // Only configured agents own auth/plugin projections in the lifecycle generation.
        agentsList = listAgentsForGateway(generation.facts.config, defaultProjection.modelCatalog, {
          modelCatalogByAgentId,
          includeSystem: readParams.includeSystem,
        });
        generation.agentsListByKey.set(agentsListKey, agentsList);
      }
      return {
        metadata: sessionProjection.metadata,
        sessionModelCatalog: sessionProjection.modelCatalog,
        defaultModelCatalog: defaultProjection.modelCatalog,
        agentsList,
      };
    });

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

  return { fail, invalidate, read, readStartup, refresh };
}
