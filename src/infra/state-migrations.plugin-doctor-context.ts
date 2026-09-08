import {
  inspectAcpSessionClaimsForDoctor,
  updateAcpSessionIdentityForDoctor,
} from "../acp/runtime/session-meta-doctor.js";
import {
  createChannelIngressQueue,
  listChannelIngressQueueAccountIdsReadOnly,
  type ChannelIngressQueue,
} from "../channels/message/ingress-queue.js";
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
import type {
  PluginDoctorChannelIngressQueueAccess,
  PluginDoctorChannelIngressQueueInspection,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { PluginDoctorRepairAuthority } from "./state-migrations.types.js";

type SessionEvidenceResult = Awaited<
  ReturnType<NonNullable<PluginDoctorStateMigrationContext["readSessionIdentityEvidenceBatch"]>>
>[number];
type DoctorSessionStoreTarget = { agentId: string; storePath: string };

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
  const probes: Array<
    DoctorSessionStoreTarget & { env: NodeJS.ProcessEnv; index: number; sessionId: string }
  > = [];
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
      probes.push({ ...target, env: params.env, index, sessionId: request.sessionId });
    }
  }
  const evidence = readSessionIdentityEvidenceBatch(probes);
  const observedByRequest: (typeof evidence)[] = params.requests.map(() => []);
  for (const [position, observed] of evidence.entries()) {
    observedByRequest[probes[position]!.index]!.push(observed);
  }
  return params.requests.map((request, index): SessionEvidenceResult => {
    const observed = observedByRequest[index]!;
    const current = observed.filter((entry) => entry.status === "current");
    if (
      !observed.length ||
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

/** Re-assert the caller's authority before every write, so a queue handle retained
 *  past the locked repair section fails instead of mutating durable rows. */
function guardIngressQueueMutations<TPayload, TMetadata, TCompletedMetadata>(
  queue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>,
  assertCurrent: () => void,
): ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata> {
  const guarded: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata> = {
    ...queue,
    enqueue: (...args) => {
      assertCurrent();
      return queue.enqueue(...args);
    },
    claimNext: (...args) => {
      assertCurrent();
      return queue.claimNext(...args);
    },
    claim: (...args) => {
      assertCurrent();
      return queue.claim(...args);
    },
    complete: (...args) => {
      assertCurrent();
      return queue.complete(...args);
    },
    release: (...args) => {
      assertCurrent();
      return queue.release(...args);
    },
    fail: (...args) => {
      assertCurrent();
      return queue.fail(...args);
    },
    delete: (...args) => {
      assertCurrent();
      return queue.delete(...args);
    },
    // Recovery predicates may await, so asserting once at call time is not enough: a
    // migration could start recovery, return, release the section, and only then let a
    // predicate resolve into the tombstone or claim-release write. Re-assert after every
    // predicate settles, immediately before the write it authorizes.
    recoverStaleClaims: (recoverOptions) => {
      assertCurrent();
      if (!recoverOptions) {
        return queue.recoverStaleClaims();
      }
      const { shouldRecover, shouldRecoverCorrupt, ...rest } = recoverOptions;
      const guardedRecovery: typeof recoverOptions = { ...rest };
      if (shouldRecover) {
        guardedRecovery.shouldRecover = async (claim) => {
          const decision = await shouldRecover(claim);
          assertCurrent();
          return decision;
        };
      }
      if (shouldRecoverCorrupt) {
        guardedRecovery.shouldRecoverCorrupt = async (claim) => {
          const decision = await shouldRecoverCorrupt(claim);
          assertCurrent();
          return decision;
        };
      }
      return queue.recoverStaleClaims(guardedRecovery);
    },
    prune: (...args) => {
      assertCurrent();
      return queue.prune(...args);
    },
  };
  // Optional members stay optional: bind the receiver up front so the wrapper needs
  // neither a detached method reference nor a type assertion to call it.
  const refreshClaim = queue.refreshClaim?.bind(queue);
  if (refreshClaim) {
    guarded.refreshClaim = (...args) => {
      assertCurrent();
      return refreshClaim(...args);
    };
  }
  const resubmit = queue.resubmit?.bind(queue);
  if (resubmit) {
    guarded.resubmit = (...args) => {
      assertCurrent();
      return resubmit(...args);
    };
  }
  return guarded;
}

/** Build a genuinely read-only object rather than a narrowed view of the queue.
 *  A `Pick<...>` return type would still hand the caller every mutating method at
 *  runtime, so the boundary has to exist in the value, not only in the type. */
function projectIngressQueueForInspection<TPayload, TMetadata>(
  queue: ChannelIngressQueue<TPayload, TMetadata>,
): PluginDoctorChannelIngressQueueInspection<TPayload, TMetadata> {
  const listFailed = queue.listFailed?.bind(queue);
  const projection: PluginDoctorChannelIngressQueueInspection<TPayload, TMetadata> = {
    listPending: (...args) => queue.listPending(...args),
    listClaims: () => queue.listClaims(),
  };
  if (listFailed) {
    projection.listFailed = (...args) => listFailed(...args);
  }
  return projection;
}

function buildChannelIngressQueueAccess(
  options: PluginDoctorChannelIngressAccessOptions,
): PluginDoctorChannelIngressQueueAccess[] {
  const { channelIds, stateDir, mutation } = options;
  return channelIds.map((channelId) => {
    const open = <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
      openOptions: { accountId?: string } | undefined,
      access: "read-write" | "read-only",
    ) =>
      createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
        channelId,
        ...(openOptions?.accountId === undefined ? {} : { accountId: openOptions.accountId }),
        stateDir,
        access,
      });
    const access: PluginDoctorChannelIngressQueueAccess = {
      channelId,
      // Detection runs before exclusive ownership, so it reads through the
      // non-creating read-only opener as well as a listing-only projection.
      openChannelIngressQueueForInspection: (openOptions) =>
        projectIngressQueueForInspection(open(openOptions, "read-only")),
      // Discovery runs before the inspection facade is even opened, so it takes the
      // same non-creating path rather than the write-capable opener.
      listChannelIngressQueueAccountIds: () =>
        listChannelIngressQueueAccountIdsReadOnly({ channelId, stateDir }),
    };
    if (mutation) {
      const assertCurrent = () => mutation.assertCurrent();
      access.openChannelIngressQueue = (openOptions) => {
        assertCurrent();
        return guardIngressQueueMutations(open(openOptions, "read-write"), assertCurrent);
      };
    }
    return access;
  });
}

/** Host-fixed ingress access for one migration phase. `mutation` is supplied only by
 *  the locked repair section; without it the plugin sees inspection-only queues. */
export type PluginDoctorChannelIngressAccessOptions = {
  channelIds: readonly string[];
  stateDir: string;
  mutation?: { assertCurrent(): void };
};

export function createPluginDoctorStateMigrationContext(params: {
  pluginId: string;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  repairAuthority?: PluginDoctorRepairAuthority;
  channelIngress?: PluginDoctorChannelIngressAccessOptions;
}): PluginDoctorStateMigrationContext {
  const { pluginId, env } = params;
  const cache: SessionStoreTargetsReadCache = new Map();
  const targetsByAgent = new Map<string, readonly DoctorSessionStoreTarget[] | null>();
  const context: PluginDoctorStateMigrationContext = {
    inspectAcpSessionClaims: async () => {
      params.repairAuthority?.assertCurrent();
      const evidence = await inspectAcpSessionClaimsForDoctor(params);
      params.repairAuthority?.assertCurrent();
      return evidence;
    },
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
  if (params.channelIngress) {
    context.channelIngressQueues = buildChannelIngressQueueAccess(params.channelIngress);
  }
  if (params.repairAuthority) {
    const authority = params.repairAuthority;
    context.updateAcpSessionIdentity = (input) =>
      updateAcpSessionIdentityForDoctor(params, authority, input);
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
