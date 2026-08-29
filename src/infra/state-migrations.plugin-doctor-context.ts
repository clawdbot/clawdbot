import type { DatabaseSync } from "node:sqlite";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { readSessionIdentityEvidenceBatch } from "../config/sessions/session-accessor.js";
import {
  resolveExistingAgentSessionStoreTargetsReadOnlyResult,
  type SessionStoreTargetsReadCache,
} from "../config/sessions/targets-read-availability.js";
import { dedupeSessionStoreTargetsBySqliteTarget } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  createPluginStateKeyedStore,
  getPluginStateCapacity,
  importPluginStateEntriesForDoctor,
  pluginStateDeleteEntriesIfUnchanged,
  pluginStateDoctorEntriesInKeyRange,
  type OpenKeyedStoreOptions,
} from "../plugin-state/plugin-state-store.js";
import type { PluginDoctorStateMigrationContext } from "../plugins/doctor-contract-module.js";
import { normalizeAgentId } from "../routing/session-key.js";

type SessionEvidenceResult = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["readSessionIdentityEvidenceBatch"]>>
>[number];
type DoctorSessionStoreTarget = { agentId: string; storePath: string };

export type PluginDoctorRepairAuthority = {
  assertCurrent(): void;
  assertOwnedInTransaction(database: DatabaseSync): void;
};

function resolveDoctorSessionIdentityEvidence(params: {
  cache: SessionStoreTargetsReadCache;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  requests: readonly { agentId: string; sessionId: string }[];
  targetsByAgent: Map<string, readonly DoctorSessionStoreTarget[] | null>;
}): SessionEvidenceResult[] {
  if (params.requests.length > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES) {
    throw new Error("Plugin doctor session evidence batch exceeds the maximum size.");
  }
  const probes: Array<DoctorSessionStoreTarget & { index: number; sessionId: string }> = [];
  for (const [index, request] of params.requests.entries()) {
    const agentId = normalizeAgentId(request.agentId);
    let targets = params.targetsByAgent.get(agentId);
    if (targets === undefined) {
      try {
        const resolved = resolveExistingAgentSessionStoreTargetsReadOnlyResult(
          params.config,
          agentId,
          {
            cache: params.cache,
            env: params.env,
          },
        );
        if (!resolved.available) {
          targets = null;
        } else {
          const candidates = resolved.targets.length
            ? resolved.targets
            : [
                {
                  agentId,
                  storePath: resolveSessionStorePathCore(params.config.session?.store, {
                    agentId,
                    env: params.env,
                  }),
                },
              ];
          targets = dedupeSessionStoreTargetsBySqliteTarget(candidates, {
            defaultAgentId: agentId,
            env: params.env,
          });
        }
      } catch {
        targets = null;
      }
      params.targetsByAgent.set(agentId, targets);
    }
    for (const target of targets ?? []) {
      probes.push({ ...target, index, sessionId: request.sessionId });
    }
  }
  const evidence = readSessionIdentityEvidenceBatch(
    probes.map(({ agentId, sessionId, storePath }) => ({
      agentId,
      env: params.env,
      sessionId,
      storePath,
    })),
  );
  const observedByRequest = new Map<number, typeof evidence>();
  for (const [position, observed] of evidence.entries()) {
    const index = probes[position]!.index;
    const previous = observedByRequest.get(index);
    if (previous) {
      previous.push(observed);
    } else {
      observedByRequest.set(index, [observed]);
    }
  }
  return params.requests.map((request, index): SessionEvidenceResult => {
    const observed = observedByRequest.get(index);
    const current = observed?.filter((entry) => entry.status === "current") ?? [];
    if (
      !observed?.length ||
      observed.some((entry) => entry.status === "unknown") ||
      current.length > 1
    ) {
      return { ...request, state: "unknown" };
    }
    return current[0]
      ? { ...request, state: "current", sessionKey: current[0].sessionKey }
      : { ...request, state: "absent" };
  });
}

export function createPluginDoctorStateMigrationContext(params: {
  pluginId: string;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  repairAuthority?: PluginDoctorRepairAuthority;
}): PluginDoctorStateMigrationContext {
  const { pluginId, env } = params;
  const cache: SessionStoreTargetsReadCache = new Map();
  const targetsByAgent = new Map<string, readonly DoctorSessionStoreTarget[] | null>();
  const context: PluginDoctorStateMigrationContext = {
    getPluginStateCapacity: () => getPluginStateCapacity(pluginId, env),
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctor(pluginId, { ...options, env: options.env ?? env }, entries);
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStore<T>(pluginId, { ...options, env: options.env ?? env });
    },
    readPluginStateEntriesInKeyRange(namespace, range) {
      params.repairAuthority?.assertCurrent();
      return pluginStateDoctorEntriesInKeyRange({
        pluginId,
        namespace,
        ...range,
        env,
      });
    },
    async readSessionIdentityEvidenceBatch(requests) {
      params.repairAuthority?.assertCurrent();
      const evidence = resolveDoctorSessionIdentityEvidence({
        cache,
        config: params.config,
        env,
        requests,
        targetsByAgent,
      });
      params.repairAuthority?.assertCurrent();
      return evidence;
    },
  };
  if (params.repairAuthority) {
    const authority = params.repairAuthority;
    context.deletePluginStateEntriesIfUnchanged = (namespace, entries) => {
      authority.assertCurrent();
      return pluginStateDeleteEntriesIfUnchanged({
        pluginId,
        namespace,
        entries,
        env,
        assertOwnedInTransaction: (database) => authority.assertOwnedInTransaction(database),
      });
    };
  }
  return context;
}
