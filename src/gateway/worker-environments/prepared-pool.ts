import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import {
  readWorkerProjectPreparation,
  type WorkerProviderPreparedIntent,
} from "./preparation-identity.js";
import { readWorkerProjectSnapshot } from "./project-preparation.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import type { WorkerEnvironmentStore } from "./store.js";

const DEFAULT_READY_WORKERS = 1;
const DEFAULT_MAX_TOTAL = 4;
const PREPARATION_CONCURRENCY = 2;

type PoolOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareIntent: (
    profileId: string,
    options: {
      projectPath: string;
      projectCommit: string;
      machineClass?: string;
      executionMode?: "worker-turn" | "remote-exec";
      setupAuthorized?: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<WorkerProviderPreparedIntent>;
  assertIntentCurrent: (profileId: string, intent: WorkerProviderPreparedIntent) => void;
  reconcile: (
    record: WorkerEnvironmentRecord,
    signal: AbortSignal,
    beforeReconcile: () => void,
  ) => Promise<void>;
  now: () => number;
  signal: AbortSignal;
  warn: (message: string) => void;
};

/** Environment rows own reserve inventory; placement activation establishes fresh demand. */
export function createPreparedWorkerPool(options: PoolOptions) {
  const { store, signal, now } = options;
  let inFlight: Promise<void> | undefined;
  let requested = false;
  const current = () => signal.throwIfAborted();
  const policy = (record: Pick<WorkerEnvironmentRecord, "profileId" | "providerId">) => {
    const config = options.getConfig().cloudWorkers;
    const profile = config?.profiles?.[record.profileId];
    return {
      target:
        profile && normalizeCapabilityProviderId(profile.provider) === record.providerId
          ? (profile.readyWorkers ?? DEFAULT_READY_WORKERS)
          : 0,
      maxTotal: config?.preparedPool?.maxTotal ?? DEFAULT_MAX_TOTAL,
    };
  };
  const groupKey = (record: WorkerEnvironmentRecord) => {
    const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
    return project ? JSON.stringify([record.providerId, record.profileId, project.key]) : undefined;
  };
  // Failed claims inherit only the original preparation window; success records
  // a separate fact that survives teardown and placement retirement.
  const demandAt = (record: WorkerEnvironmentRecord) =>
    record.lastActivatedAtMs ?? record.preparation?.demandAtMs;
  const retire = (record: WorkerEnvironmentRecord, reason: "expired" | "invalidated") => {
    if (!record.preparation) {
      return;
    }
    store.requestPreparedDestroy({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      preparationKey: record.preparation.key,
      reason,
      assertCurrent: current,
    });
  };
  const snapshotSettings = (record: WorkerEnvironmentRecord): WorkerProfile => {
    const settings = record.profileSnapshot.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error("Prepared worker profile settings are unavailable");
    }
    return settings;
  };
  const runPass = async () => {
    current();
    const records = store.list();
    const sources = new Map<string, { record: WorkerEnvironmentRecord; demandAtMs: number }>();
    for (const record of records) {
      const demandAtMs = demandAt(record);
      const key = groupKey(record);
      if (
        key &&
        demandAtMs !== undefined &&
        readWorkerProjectPreparation(record.profileSnapshot.project)
      ) {
        const previous = sources.get(key);
        if (!previous || demandAtMs > previous.demandAtMs) {
          sources.set(key, { record, demandAtMs });
        }
      }
    }
    // Validate source generations off the dispatch path. An old admin-approved recipe
    // never authorizes a different commit or setup script during an automatic refill.
    const eligible = new Map<
      string,
      {
        source: WorkerEnvironmentRecord;
        intent: WorkerProviderPreparedIntent;
        demandAtMs: number;
        expiresAtMs: number;
      }
    >();
    for (const [key, { record, demandAtMs }] of sources) {
      current();
      const limits = policy(record);
      if (limits.target === 0 || limits.maxTotal === 0) {
        continue;
      }
      try {
        const provider = options.resolveProvider(record.providerId);
        const timeout = provider?.resolvePreparedIdleTimeoutMs?.(snapshotSettings(record));
        if (
          !Number.isSafeInteger(timeout) ||
          !timeout ||
          timeout <= 0 ||
          demandAtMs + timeout <= now()
        ) {
          continue;
        }
        const project = readWorkerProjectSnapshot(record.profileSnapshot.project)!;
        const preparation = readWorkerProjectPreparation(record.profileSnapshot.project)!;
        const intent = await options.prepareIntent(record.profileId, {
          projectPath: project.root,
          projectCommit: project.baseCommit,
          ...(typeof record.profileSnapshot.machineClass === "string"
            ? { machineClass: record.profileSnapshot.machineClass }
            : {}),
          ...(record.profileSnapshot.executionMode === "worker-turn" ||
          record.profileSnapshot.executionMode === "remote-exec"
            ? { executionMode: record.profileSnapshot.executionMode }
            : {}),
          setupAuthorized: preparation.setupRecipe !== undefined,
          signal,
        });
        current();
        if (intent.providerId === record.providerId && intent.preparationKey === preparation.key) {
          eligible.set(key, {
            source: record,
            intent,
            demandAtMs,
            expiresAtMs: demandAtMs + timeout,
          });
        }
      } catch {
        current();
        options.warn(
          `Prepared worker source is unavailable (${record.profileId}); unused workers will retire`,
        );
      }
    }
    const unassigned = records.filter(
      (record) =>
        record.preparation?.consumedAtMs === null &&
        record.state !== "destroyed" &&
        record.state !== "failed",
    );
    const kept = new Map<string, number>();
    let totalKept = 0;
    const work: WorkerEnvironmentRecord[] = [];
    for (const record of unassigned.toSorted((a, b) => a.createdAtMs - b.createdAtMs)) {
      current();
      const key = groupKey(record);
      const generation = key ? eligible.get(key) : undefined;
      const limits = policy(record);
      const preparation = record.preparation!;
      const count = key ? (kept.get(key) ?? 0) : 0;
      const expired = preparation.expiresAtMs <= now();
      const valid =
        !expired &&
        generation?.intent.preparationKey === preparation.key &&
        count < limits.target &&
        totalKept < limits.maxTotal;
      if (record.destroyRequestedAtMs === null && !valid) {
        retire(record, expired ? "expired" : "invalidated");
      } else if (record.destroyRequestedAtMs === null && key) {
        kept.set(key, count + 1);
        totalKept += 1;
      }
      const latest = store.get(record.environmentId);
      if (latest?.preparation?.consumedAtMs === null) {
        work.push(latest);
      }
    }
    for (const [key, generation] of eligible) {
      const { source, intent, demandAtMs, expiresAtMs } = generation;
      const limits = policy(source);
      const project = readWorkerProjectSnapshot(intent.profileSnapshot.project)!;
      for (let index = kept.get(key) ?? 0; index < limits.target; index += 1) {
        current();
        const admitted = store.ensurePreparedIntent({
          intent: {
            ...deriveEnvironmentIntent(`prepared:${randomUUID()}`),
            providerId: intent.providerId,
            profileId: source.profileId,
            profileSnapshot: intent.profileSnapshot,
            preparation: { key: intent.preparationKey!, demandAtMs, expiresAtMs },
          },
          projectKey: project.key,
          target: limits.target,
          maxTotal: limits.maxTotal,
          assertCurrent: () => {
            current();
            options.assertIntentCurrent(source.profileId, intent);
            if (
              !isDeepStrictEqual(policy(source), limits) ||
              !isDeepStrictEqual(
                store.get(source.environmentId)?.profileSnapshot,
                source.profileSnapshot,
              )
            ) {
              throw new Error("Prepared worker admission policy changed");
            }
          },
        });
        if (!admitted) {
          break;
        }
        work.push(admitted);
      }
    }
    await runTasksWithConcurrency({
      tasks: work.map((record) => async () => {
        current();
        const latest = store.get(record.environmentId);
        // Assignment can win after enumeration; its placement owner now owns recovery.
        if (latest?.preparation?.consumedAtMs === null) {
          const beforeReconcile = () => {
            current();
            const owned = store.get(latest.environmentId);
            if (
              !owned ||
              owned.preparation?.consumedAtMs !== null ||
              owned.destroyRequestedAtMs !== null
            ) {
              return;
            }
            const key = groupKey(owned);
            const generation = key ? eligible.get(key) : undefined;
            const limits = policy(owned);
            const withinCapacity = store.isPreparedIntentWithinCapacity({
              environmentId: owned.environmentId,
              ...limits,
            });
            if (owned.preparation.expiresAtMs <= now()) {
              retire(owned, "expired");
            } else if (!generation || !withinCapacity) {
              retire(owned, "invalidated");
            } else {
              try {
                options.assertIntentCurrent(owned.profileId, generation.intent);
              } catch {
                current();
                // Intent drift must retain cleanup authority for a replay whose
                // original allocation response may have been lost.
                retire(owned, "invalidated");
              }
            }
          };
          beforeReconcile();
          await options.reconcile(store.get(latest.environmentId)!, signal, beforeReconcile);
        }
      }),
      limit: PREPARATION_CONCURRENCY,
      onTaskError: () => {
        if (!signal.aborted) {
          options.warn(
            "Prepared worker maintenance failed; its durable allocation remains retryable",
          );
        }
      },
    });
  };
  const schedule = () => {
    if (signal.aborted) {
      return Promise.resolve();
    }
    requested = true;
    return (inFlight ??= (async () => {
      try {
        while (requested && !signal.aborted) {
          requested = false;
          await runPass();
        }
      } finally {
        inFlight = undefined;
      }
    })());
  };
  const noteDemand = async (environmentId: string) => {
    current();
    const record = store.get(environmentId);
    const preparation = record && readWorkerProjectPreparation(record.profileSnapshot.project);
    if (record?.state !== "attached" || !record.leaseId || !preparation) {
      return;
    }
    const demandAtMs = record.lastActivatedAtMs;
    if (demandAtMs === null) {
      return;
    }
    const provider = options.resolveProvider(record.providerId);
    await provider?.notePreparedDemand?.(
      { leaseId: record.leaseId, profile: snapshotSettings(record) },
      {
        preparationKey: preparation.key,
        demandAtMs,
      },
    );
  };
  const candidates = (intent: WorkerProviderPreparedIntent) =>
    intent.preparationKey
      ? store.list().filter((record) => {
          const limits = policy(record);
          return (
            limits.target > 0 &&
            limits.maxTotal > 0 &&
            record.state === "ready" &&
            record.providerId === intent.providerId &&
            record.preparation !== null &&
            record.preparation.key === intent.preparationKey &&
            record.preparation.consumedAtMs === null &&
            record.preparation.expiresAtMs > now() &&
            record.destroyRequestedAtMs === null &&
            record.sharedHost === false &&
            record.nodeDeviceId !== null &&
            record.leaseId !== null
          );
        })
      : [];
  const maintain = async (environmentId?: string) => {
    if (signal.aborted) {
      return;
    }
    if (environmentId) {
      await noteDemand(environmentId).catch(() => {
        if (!signal.aborted) {
          options.warn("Prepared snapshot demand could not be recorded");
        }
      });
    }
    await schedule().catch(() => {
      if (!signal.aborted) {
        options.warn("Prepared worker maintenance failed; cleanup will retry");
      }
    });
  };
  const canPruneDemand = (record: WorkerEnvironmentRecord, nowMs: number): boolean => {
    const demandAtMs = demandAt(record);
    if (demandAtMs === undefined || !readWorkerProjectPreparation(record.profileSnapshot.project)) {
      return true;
    }
    // Unavailable policy cannot prove expiry. Retain metadata only; physical
    // cleanup is independent and must not wait for a provider to return.
    try {
      const timeout = options
        .resolveProvider(record.providerId)
        ?.resolvePreparedIdleTimeoutMs?.(snapshotSettings(record));
      return (
        timeout !== undefined &&
        Number.isSafeInteger(timeout) &&
        timeout > 0 &&
        demandAtMs + timeout <= nowMs
      );
    } catch {
      return false;
    }
  };
  return { schedule, noteDemand, candidates, maintain, canPruneDemand };
}
