import type { PreparedAgentCredentialModes } from "../../agents/agent-auth-credential-modes.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import {
  getPreparedRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshotRevision,
  type AuthProfileStore,
} from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import {
  getPublishedPreparedModelCatalogOwnerSnapshot,
  type GetPublishedPreparedModelCatalogOwnerParams,
} from "../../agents/prepared-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthMaterializations,
} from "../../agents/prepared-model-runtime-auth.js";
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

type PreparedAgentFacts = {
  agentId: string;
  owner: PreparedModelRuntimeSnapshot;
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
  authStoreRevision: string;
  modelCatalog: ModelCatalogSnapshot;
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

type PreparedAgentProjection<T = ChatMetadataResult> = PreparedProjection<T> & {
  modelCatalog: ModelCatalogEntry[];
};
type PreparedProjection<T> = { read: () => T; isCurrent: () => boolean };

type AgentProjectionEntry =
  | { state: "pending"; promise: Promise<PreparedAgentProjection> }
  | { state: "ready"; projection: PreparedAgentProjection };

type PreparedMetadataGeneration = {
  epoch: number;
  facts: PreparedGenerationFacts;
  agentsById: Map<string, PreparedAgentMetadata>;
  neutralProjectionByAgentId: Map<string, AgentProjectionEntry>;
  sessionProjectionByKey: Map<string, AgentProjectionEntry>;
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
  }) => Promise<PreparedAgentProjection<{ models?: unknown[] }>>;
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
    const fullModelCatalog = owner.readFullModelCatalog?.();
    const fullCatalogAuth = fullModelCatalog
      ? getPreparedModelFullCatalogAuth(fullModelCatalog)
      : undefined;
    if (fullModelCatalog && !fullCatalogAuth) {
      throw new Error("prepared full model catalog omitted its auth generation");
    }
    return {
      agentId,
      owner,
      authStore: fullCatalogAuth?.authStore ??
        deps.getPreparedAuthStore(owner.agentDir, owner.inheritedAuthDir) ?? {
          version: 1,
          profiles: {},
        },
      authModes: fullCatalogAuth?.authModes ?? owner.authModes,
      authStoreRevision: `${deps.getAuthStoreRevision(owner.agentDir)}:${deps.getAuthStoreRevision(owner.inheritedAuthDir)}`,
      modelCatalog: fullModelCatalog ?? owner.modelCatalog,
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
      candidate.modelCatalog === agent.modelCatalog &&
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
}): Promise<PreparedAgentProjection<{ models?: unknown[] }>> {
  const { prepareModelsListResult, createGatewayAgentModelCatalogProjector } =
    await import("./models-list-result.js");
  // Chat metadata must stay on process-published facts. Live discovery belongs to explicit
  // models.list control-plane reads so a slow provider cannot delay chat startup.
  const snapshot = params.facts.modelCatalog;
  const projector = createGatewayAgentModelCatalogProjector({
    cfg: params.facts.owner.config,
    agentId: params.facts.agentId,
    snapshot,
    metadataSnapshot: params.facts.owner.metadataSnapshot,
    preparedAuthStore: params.facts.authStore,
    // The owner records usable auth at discovery; metadata must share that exact generation fact.
    preparedRuntimeAuthModes: params.facts.authModes,
    preparedRuntimeAuthMaterializations: getPreparedModelRuntimeAuthMaterializations(
      params.facts.owner,
    ),
    ...(params.preferredProfileId ? { preferredProfileId: params.preferredProfileId } : {}),
    ...(params.lockedProfileId ? { lockedProfileId: params.lockedProfileId } : {}),
  });
  const [modelCatalog, readModels] = await Promise.all([
    projector.projectCatalog(),
    prepareModelsListResult({
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
  return {
    modelCatalog,
    read: () => ({ models: readModels.read().models }),
    isCurrent: readModels.isCurrent,
  };
}

export function createGatewayChatMetadataRuntime(params: {
  getConfig: () => OpenClawConfig;
  getContext: () => GatewayRequestContext;
  beforeRefresh?: () => Promise<void>;
  onChanged?: () => void;
  refreshOnRead?: boolean;
  log: {
    warn: (message: string) => void;
  };
  deps?: Partial<ChatMetadataRuntimeDeps>;
}): {
  invalidate: () => void;
  fail: (error: unknown) => void;
  refresh: () => Promise<void>;
  stop: () => Promise<void>;
  read: (params: ChatMetadataReadParams) => Promise<ChatMetadataResult>;
  readStartup: (
    params: ChatStartupProjectionReadParams,
  ) => Promise<ChatStartupProjectionResult | undefined>;
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
  let refreshVersion = 0;
  let lastSettlement: PreparedMetadataGeneration | number | undefined;
  let refreshTail: Promise<void> = Promise.resolve();
  let stoppedError: ChatMetadataSnapshotUnavailableError | undefined;
  const activeWork = new Set<Promise<unknown>>();
  const trackWork = <T>(work: Promise<T>): Promise<T> => {
    activeWork.add(work);
    const settled = () => activeWork.delete(work);
    void work.then(settled, settled);
    return work;
  };
  const assertOpen = () => {
    if (stoppedError) {
      throw stoppedError;
    }
  };
  let pending:
    | {
        facts?: PreparedGenerationFacts;
        promise: Promise<void>;
      }
    | undefined;

  const projectAgent = async (
    generation: PreparedMetadataGeneration,
    agent: PreparedAgentMetadata,
    sessionEntry?: ChatMetadataSessionEntry,
  ): Promise<PreparedAgentProjection> => {
    assertOpen();
    const profiles = resolveSessionProfiles(sessionEntry);
    const neutral =
      profiles.preferredProfileId === undefined && profiles.lockedProfileId === undefined;
    const projections = neutral
      ? generation.neutralProjectionByAgentId
      : generation.sessionProjectionByKey;
    const key = neutral ? agent.agentId : sessionProjectionKey(agent.agentId, profiles);
    const existing = projections.get(key);
    if (existing) {
      const prepared = existing.state === "ready" ? existing.projection : await existing.promise;
      if (prepared.isCurrent()) {
        return prepared;
      }
      if (projections.get(key) === existing) {
        projections.delete(key);
      }
      return projectAgent(generation, agent, sessionEntry);
    }
    const projection = deps
      .buildProjection({
        context: deps.getContext(),
        facts: agent,
        ...profiles,
      })
      .then((prepared) => {
        const preparedProjection: PreparedAgentProjection = {
          ...prepared,
          read: () => ({
            ...prepared.read(),
            ...(agent.commands !== undefined ? { commands: agent.commands } : {}),
            swarmEnabled: agent.swarmEnabled,
          }),
        };
        // Only this pending entry may publish its settlement; eviction or invalidation
        // must not let an obsolete completion replace a newer profile projection.
        if (generation.epoch === invalidationEpoch && projections.get(key) === entry) {
          projections.set(key, { state: "ready", projection: preparedProjection });
        }
        return preparedProjection;
      })
      .catch((error: unknown) => {
        if (projections.get(key) === entry) {
          projections.delete(key);
        }
        throw error;
      });
    void trackWork(projection);
    const entry: AgentProjectionEntry = { state: "pending", promise: projection };
    projections.set(key, entry);
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
  ): Promise<PreparedMetadataGeneration | undefined> => {
    const agents = await Promise.all(
      facts.agents.map(async (agent): Promise<PreparedAgentMetadata> => {
        let commands: unknown[] | undefined;
        try {
          commands = (
            await trackWork(deps.buildCommands({ cfg: facts.config, agentId: agent.agentId }))
          ).commands;
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
    };
    if (epoch !== invalidationEpoch) {
      return undefined;
    }
    await Promise.all(agents.map((agent) => projectAgent(generation, agent)));
    return generation;
  };

  const runRefresh = async (version: number) => {
    assertOpen();
    await params.beforeRefresh?.();
    // Ownership can change during preparation; build completion checks it again after suspension.
    if (version !== refreshVersion) {
      return;
    }
    for (;;) {
      const epoch = invalidationEpoch;
      try {
        const facts = captureGenerationFacts(deps);
        if (current && generationFactsMatch(current.facts, facts)) {
          return;
        }
        const generation = await buildGeneration(facts, epoch);
        if (version !== refreshVersion) {
          return;
        }
        if (
          generation &&
          epoch === invalidationEpoch &&
          generationFactsMatch(facts, captureGenerationFacts(deps))
        ) {
          current = generation;
          return;
        }
      } catch (error) {
        // A superseded build may fail after replacement starts; only its current epoch may fail readers.
        if (version !== refreshVersion) {
          return;
        }
        if (epoch === invalidationEpoch) {
          throw error;
        }
      }
    }
  };

  const refresh = (): Promise<void> => {
    if (stoppedError) {
      return Promise.reject(stoppedError);
    }
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
          if (lastSettlement !== current) {
            lastSettlement = current;
            params.onChanged?.();
          }
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
      const version = ++refreshVersion;
      const promise = refreshTail.catch(() => {}).then(() => runRefresh(version));
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
    const version = ++refreshVersion;
    const promise = refreshTail.catch(() => {}).then(() => runRefresh(version));
    return trackRefresh(promise, facts);
  };

  const readCurrent = async <Result>(
    project: (generation: PreparedMetadataGeneration) => Promise<PreparedProjection<Result>>,
  ): Promise<Result> => {
    for (;;) {
      assertOpen();
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
        const readProjection = await project(generation);
        // Lazy projections may outlive their generation. Never return an obsolete success after
        // invalidation; retry through the replacement gate so the caller sees one coherent epoch.
        if (
          current === generation &&
          generation.epoch === invalidationEpoch &&
          readProjection.isCurrent()
        ) {
          return readProjection.read();
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
      return projectAgent(generation, agent, readParams.sessionEntry);
    });

  const readStartup = async (
    readParams: ChatStartupProjectionReadParams,
  ): Promise<ChatStartupProjectionResult | undefined> => {
    const assemble = (
      neutral: PreparedAgentProjection,
      session: PreparedAgentProjection,
    ): ChatStartupProjectionResult => ({
      // History consumes stable catalogs only; live readiness stays inside the current-read fence.
      ...(readParams.readPolicy === "ready" ? {} : { metadata: session.read() }),
      sessionModelCatalog: session.modelCatalog,
      defaultModelCatalog: neutral.modelCatalog,
    });
    const projectStartup = async (
      generation: PreparedMetadataGeneration,
    ): Promise<PreparedProjection<ChatStartupProjectionResult>> => {
      const agentId = normalizeAgentId(readParams.agentId);
      const agent = generation.agentsById.get(agentId);
      if (!agent) {
        throw new ChatMetadataSnapshotUnavailableError(
          `prepared chat startup projection is unavailable for agent "${agentId}"`,
        );
      }
      const readNeutral = await projectAgent(generation, agent);
      const readSession = await projectAgent(generation, agent, readParams.sessionEntry);
      return {
        isCurrent: () => readNeutral.isCurrent() && readSession.isCurrent(),
        read: () => assemble(readNeutral, readSession),
      };
    };
    const profiles = resolveSessionProfiles(readParams.sessionEntry);
    if (readParams.readPolicy !== "ready" && profiles.preferredProfileId) {
      return readCurrent(projectStartup);
    }
    const generation = current;
    // Optional reads consume only settled exact-profile facts. Never start preparation
    // or wait for a lifecycle replacement just to decorate an available transcript.
    if (!generation || replacement || pending || generation.epoch !== invalidationEpoch) {
      return undefined;
    }
    if (params.refreshOnRead) {
      try {
        if (!generationFactsMatch(generation.facts, captureGenerationFacts(deps))) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    }
    const agentId = normalizeAgentId(readParams.agentId);
    const neutral = generation.neutralProjectionByAgentId.get(agentId);
    const session = profiles.preferredProfileId
      ? generation.sessionProjectionByKey.get(sessionProjectionKey(agentId, profiles))
      : neutral;
    if (
      neutral?.state !== "ready" ||
      session?.state !== "ready" ||
      !neutral.projection.isCurrent() ||
      !session.projection.isCurrent()
    ) {
      return undefined;
    }
    return assemble(neutral.projection, session.projection);
  };

  const invalidate = () => {
    if (stoppedError) {
      return;
    }
    invalidationEpoch += 1;
    current = undefined;
    lastError = undefined;
    replacement ??= createMetadataReplacement();
  };

  const fail = (error: unknown) => {
    const replacementError = error instanceof Error ? error : new Error(formatErrorMessage(error));
    refreshVersion += 1;
    pending = undefined;
    current = undefined;
    lastError = replacementError;
    const failedReplacement = replacement;
    replacement = undefined;
    failedReplacement?.reject(replacementError);
    // Unavailable reads may retry capture. Notify once for the failed epoch, not once per reader.
    // A later ready generation is a different settlement even without another invalidation.
    if (!stoppedError && lastSettlement !== invalidationEpoch) {
      lastSettlement = invalidationEpoch;
      params.onChanged?.();
    }
  };

  const stop = async () => {
    if (!stoppedError) {
      stoppedError = new ChatMetadataSnapshotUnavailableError(
        "gateway chat metadata runtime is stopped",
      );
      invalidationEpoch += 1;
      fail(stoppedError);
    }
    // Retain preparation and readers through shutdown, including evicted projections
    // and superseded refreshes no longer reachable from the current generation.
    while (activeWork.size > 0) {
      await Promise.allSettled(activeWork);
    }
  };

  return {
    fail,
    invalidate,
    read: (readParams) => trackWork(read(readParams)),
    readStartup: (startupParams) => trackWork(readStartup(startupParams)),
    refresh: () => trackWork(refresh()),
    stop,
  };
}
