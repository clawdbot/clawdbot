import { isDeepStrictEqual } from "node:util";
import { listAgentEntries, tryResolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { pinSurvivorWorkspaceForRosterCollapse } from "./agent-workspace-roster-transition.js";
import { getConfigValueAtPath, setConfigValueAtPath } from "./config-paths.js";
import { prepareAuthInheritanceOwnerForWrite } from "./io.auth-inheritance-owner.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";
import { prepareSessionStoreOwnershipForWrite } from "./io.session-store-owner.js";
import type {
  ConfigWriteOptions,
  ReadConfigFileSnapshotWithPluginMetadataResult,
} from "./io.types.js";
import { migratePersistedImplicitMainRoster } from "./legacy.roster.js";
import type { OpenClawConfig } from "./types.js";
import { materializeLegacyAgentOwnershipForActiveChannelsResult } from "./validation.js";

// Validation and commits share ownership preparation. Cron migration, runtime refresh,
// and persistence remain in the committing writer.
export function prepareConfigWriteTopology(
  params: ReadConfigFileSnapshotWithPluginMetadataResult & {
    nextConfig: OpenClawConfig;
    options: Pick<ConfigWriteOptions, "explicitSetPaths" | "explicitSetValueSource">;
    unsetPaths: readonly (readonly string[])[];
    env: NodeJS.ProcessEnv;
  },
) {
  const { snapshot, options, unsetPaths, env, pluginMetadata } = params;
  let nextConfig = params.nextConfig;
  const sourceRosterMigration = migratePersistedImplicitMainRoster(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.parsed,
  );
  const retainedLegacyDefaultAgentId = sourceRosterMigration.retainedLegacyDefaultAgentId;
  const previousEntries = listAgentEntries(snapshot.config);
  const nextEntries = listAgentEntries(nextConfig);
  const nextAgentIds = new Set(nextEntries.map((entry) => normalizeAgentId(entry.id)));
  const previousSoleAgentId = tryResolveDefaultAgentId(snapshot.config);
  const entersMultiAgent = previousEntries.length <= 1 && nextEntries.length > 1;
  const previousSoleRemains = Boolean(
    previousSoleAgentId && nextAgentIds.has(normalizeAgentId(previousSoleAgentId)),
  );
  const writesOwnershipTopology =
    !isDeepStrictEqual(previousEntries, nextEntries) ||
    [...(options.explicitSetPaths ?? []), ...unsetPaths].some(
      (writePath) =>
        writePath[0] === "agents" &&
        (writePath.length === 1 ||
          writePath[1] === "entries" ||
          writePath[1] === "list" ||
          writePath[1] === "ownership"),
    );
  const persistOwnership =
    entersMultiAgent || (retainedLegacyDefaultAgentId !== undefined && writesOwnershipTopology);
  const keepOwnership = nextEntries.length > 1 && snapshot.config.agents?.ownership === "explicit";
  const stampOwnership =
    (persistOwnership || keepOwnership) && nextConfig.agents?.ownership === undefined;
  if (stampOwnership) {
    nextConfig = {
      ...nextConfig,
      agents: { ...nextConfig.agents, ownership: "explicit" },
    };
  }

  const workspaceCollapse = pinSurvivorWorkspaceForRosterCollapse(snapshot.config, nextConfig, env);
  nextConfig = workspaceCollapse.config;

  const authInheritanceOwnership = prepareAuthInheritanceOwnerForWrite({
    currentConfig: snapshot.config,
    targetConfig: nextConfig,
    writesOwnershipTopology,
    explicitSetPaths: options.explicitSetPaths,
    env,
  });
  nextConfig = authInheritanceOwnership.config;

  const sessionStoreOwnership = prepareSessionStoreOwnershipForWrite({
    currentConfig: snapshot.config,
    currentStore: (snapshot.sourceConfigBeforeMigrations ?? snapshot.config).session?.store,
    targetConfig: nextConfig,
    env,
    explicitSetPaths: options.explicitSetPaths,
    explicitSetValueSource: options.explicitSetValueSource,
  });
  nextConfig = sessionStoreOwnership.config;
  const { sameFixedSessionStore } = sessionStoreOwnership;
  const retainedFleetOwner =
    retainedLegacyDefaultAgentId &&
    writesOwnershipTopology &&
    nextAgentIds.has(normalizeAgentId(retainedLegacyDefaultAgentId))
      ? retainedLegacyDefaultAgentId
      : undefined;
  const ownerAgentId =
    (entersMultiAgent && previousSoleRemains ? previousSoleAgentId : undefined) ??
    retainedFleetOwner;
  const ownershipMaterialization = ownerAgentId
    ? materializeLegacyAgentOwnershipForActiveChannelsResult(
        nextConfig,
        ownerAgentId,
        env,
        pluginMetadata?.manifestRegistry.plugins,
        { materializeSessionStore: sameFixedSessionStore, materializeWorkspace: true },
      )
    : { config: nextConfig, insertedPaths: [] };
  nextConfig = ownershipMaterialization.config;
  const insertedPaths = [
    ...(persistOwnership || keepOwnership
      ? (sourceRosterMigration.insertedPaths ?? []).filter(
          (entry) =>
            sameFixedSessionStore || entry.join(".") !== "agents.defaults.sessionStore.agentId",
        )
      : []),
    ...((persistOwnership || keepOwnership) &&
    retainedLegacyDefaultAgentId &&
    Array.isArray(snapshot.config.bindings) &&
    !isDeepStrictEqual(snapshot.sourceConfigBeforeMigrations?.bindings, snapshot.config.bindings)
      ? [["bindings"]]
      : []),
    ...ownershipMaterialization.insertedPaths.concat(workspaceCollapse.insertedPaths),
    ...authInheritanceOwnership.insertedPaths, // Persisting explicit ownership must replace the authored legacy roster too.
    ...(persistOwnership ? [["agents", "entries"]] : []), // Otherwise projection restores the retired default marker.
    ...(stampOwnership ? [["agents", "ownership"]] : []),
  ];

  const nextSessionStoreConfig = nextConfig.agents?.defaults?.sessionStore;
  if (
    !ownerAgentId &&
    writesOwnershipTopology &&
    previousEntries.length === 1 &&
    previousSoleAgentId &&
    !previousSoleRemains &&
    sameFixedSessionStore &&
    (nextSessionStoreConfig === undefined ||
      (isRecord(nextSessionStoreConfig) && !Object.hasOwn(nextSessionStoreConfig, "agentId")))
  ) {
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          sessionStore: {
            ...(isRecord(nextSessionStoreConfig) ? nextSessionStoreConfig : {}),
            agentId: normalizeAgentId(previousSoleAgentId),
          },
        },
      },
    };
    insertedPaths.push(["agents", "defaults", "sessionStore", "agentId"]);
  }

  const topologyPaths = [
    ...new Map(insertedPaths.map((entry) => [entry.join("\0"), entry])).values(),
  ];
  assertAutomaticBindingsWriteAllowed({
    bindingsIncludeOwned: snapshot.bindingsIncludeOwned === true,
    ownershipPaths: topologyPaths,
  });
  const explicitSetPaths = [...(options.explicitSetPaths ?? []), ...topologyPaths];
  const explicitSetValueSource = structuredClone(options.explicitSetValueSource ?? nextConfig);
  for (const ownershipPath of topologyPaths) {
    setConfigValueAtPath(
      explicitSetValueSource,
      ownershipPath,
      getConfigValueAtPath(nextConfig, ownershipPath),
    );
  }
  return {
    nextConfig,
    explicitSetPaths,
    explicitSetValueSource,
    preserveLegacyAgentRoster: Boolean(retainedLegacyDefaultAgentId) && !writesOwnershipTopology,
    cronOwner: persistOwnership
      ? retainedFleetOwner
        ? { provenOwnerAgentId: retainedFleetOwner }
        : {}
      : undefined,
  };
}
