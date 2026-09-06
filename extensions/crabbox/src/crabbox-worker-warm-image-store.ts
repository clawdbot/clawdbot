import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { parseCrabboxProfile } from "./crabbox-worker-profile.js";

export function resolveCrabboxWarmImageProfileKey(
  profile: ReturnType<typeof parseCrabboxProfile>,
  projectKey?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        backendProvider: profile.provider,
        setup: profile.setup ?? "",
        setupEnvKeys: [...(profile.setupEnv ?? [])].toSorted(),
        desktop: profile.desktop ?? false,
        // Exact class is intentionally conservative; cross-class reuse comes later.
        machineClass: profile.class,
        ...(projectKey ? { projectKey } : {}),
      }),
    )
    .digest("hex");
}

export type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  lastDemandAtMs: number | null;
  baseCommit?: string;
};

export type WarmAllocationRecord = {
  choice: { kind: "cold" } | { kind: "checkpoint"; checkpointId: string };
  machineClass: string;
  phase: "pending" | "prepared" | "enrolled";
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  demandAtMs: number | null;
  imageGeneration: { checkpointId: string; createdAtMs: number } | null;
  baseCommit?: string;
};

export type WarmProfileRecord = {
  version: 3;
  projectKey?: string;
  image?: WarmImageRecord;
  allocations: Record<string, WarmAllocationRecord>;
  operation?:
    | {
        type: "capture";
        id: string;
        startedAtMs: number;
        leaseId?: string;
        provider?: string;
        phase: "scrubbing" | "creating" | "uncertain";
      }
    | { type: "retire"; checkpointId: string };
};

export const WARM_IMAGE_MAX_ENTRIES = 128;
// Match the former enrollment registry's capacity without evicting replay obligations;
// 256 bounded lease records leave ample room under the plugin store's 1 MiB row limit.
export const WARM_IMAGE_MAX_ALLOCATIONS = 256;
const CAPTURE_WARNING_AGE_MS = 1_200_000;

export function crabboxLegacyWarmImageCaptureSelector(key: string, record: unknown): string {
  return `legacy-${createHash("sha256").update(JSON.stringify({ key, record })).digest("hex")}`;
}

const openLegacyLeases = (env?: NodeJS.ProcessEnv) =>
  createPluginStateSyncKeyedStore<unknown>("crabbox", {
    namespace: "warm-leases",
    maxEntries: 256,
    overflowPolicy: "evict-oldest",
    ...(env ? { env } : {}),
  });
const legacyLeaseSelector = (key: string, value: unknown) =>
  `legacy-lease-${createHash("sha256").update(JSON.stringify({ key, value })).digest("hex")}`;

export function listCrabboxLegacyWarmLeases(env?: NodeJS.ProcessEnv) {
  return openLegacyLeases(env)
    .entries()
    .map(({ key, value }) => ({
      leaseId: key,
      machineClass:
        isRecord(value) && typeof value.machineClass === "string" ? value.machineClass : undefined,
      selector: legacyLeaseSelector(key, value),
    }));
}

export function assertCrabboxWarmImageMigrationReady(): void {
  if (listCrabboxLegacyWarmLeases().length > 0) {
    throw new Error(
      "Crabbox has legacy worker allocations whose original image choices are unknown; run openclaw doctor --fix and follow its provider-cleanup recovery instructions before provisioning workers.",
    );
  }
}

function requireCanonicalProfile(record: WarmProfileRecord | undefined) {
  if (record && record.version !== 3) {
    throw new Error(
      "Crabbox warm-image state requires migration; run openclaw doctor --fix before provisioning workers.",
    );
  }
  const preparationKey = (value: unknown) =>
    value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  const demandAtMs = (value: unknown) =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const cacheIdentity = (value: { preparationKey: unknown; cacheKey: unknown; purpose: unknown }) =>
    preparationKey(value.cacheKey) &&
    (value.cacheKey === null
      ? value.purpose === null
      : value.preparationKey !== null &&
        (value.purpose === "session" || value.purpose === "reserve"));
  if (
    record &&
    (!isRecord(record.allocations) ||
      (record.image &&
        (!isRecord(record.image) ||
          !preparationKey(record.image.preparationKey) ||
          !cacheIdentity(record.image) ||
          !demandAtMs(record.image.lastDemandAtMs) ||
          (record.image.preparationKey !== null && record.image.lastDemandAtMs === null))) ||
      Object.values(record.allocations).some(
        (allocation) =>
          !isRecord(allocation) ||
          !preparationKey(allocation.preparationKey) ||
          !cacheIdentity(allocation) ||
          !demandAtMs(allocation.demandAtMs) ||
          (allocation.preparationKey !== null && allocation.demandAtMs === null) ||
          (allocation.imageGeneration !== null &&
            (!isRecord(allocation.imageGeneration) ||
              Object.keys(allocation.imageGeneration).length !== 2 ||
              typeof allocation.imageGeneration.checkpointId !== "string" ||
              !allocation.imageGeneration.checkpointId.trim() ||
              !Number.isSafeInteger(allocation.imageGeneration.createdAtMs) ||
              allocation.imageGeneration.createdAtMs < 0)),
      ))
  ) {
    throw new Error("Crabbox warm-image preparation state is invalid; run openclaw doctor --fix.");
  }
  return record;
}

export const sameCrabboxWarmImageGeneration = (
  left: WarmAllocationRecord["imageGeneration"] | undefined,
  right: WarmAllocationRecord["imageGeneration"] | undefined,
) => left?.checkpointId === right?.checkpointId && left?.createdAtMs === right?.createdAtMs;

export function openCrabboxWarmImageStore(env?: NodeJS.ProcessEnv) {
  const store = createPluginStateSyncKeyedStore<WarmProfileRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: WARM_IMAGE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
  const canonical = {
    ...store,
    lookup(key: string) {
      return requireCanonicalProfile(store.lookup(key));
    },
    entries() {
      const entries = store.entries();
      for (const entry of entries) {
        requireCanonicalProfile(entry.value);
      }
      return entries;
    },
    update(
      key: string,
      update: (current: WarmProfileRecord | undefined) => WarmProfileRecord | undefined,
    ) {
      return store.update(key, (current) => update(requireCanonicalProfile(current)));
    },
  };
  const lookupLease = (id: string) => {
    const entries = canonical.entries().filter(({ value }) => Object.hasOwn(value.allocations, id));
    if (entries.length > 1) {
      throw new Error(
        `Crabbox lease ${id} has conflicting warm-image owners; run openclaw doctor --fix.`,
      );
    }
    const entry = entries[0];
    return entry
      ? { key: entry.key, projectKey: entry.value.projectKey, ...entry.value.allocations[id]! }
      : undefined;
  };

  const markPhase = (id: string, phase: "prepared" | "enrolled", baseCommit?: string) => {
    const owner = lookupLease(id);
    if (!owner) {
      return;
    }
    if (
      phase === "prepared" &&
      (!baseCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit))
    ) {
      throw new Error("Crabbox project preparation requires a verified Git commit.");
    }
    let rejection: string | undefined;
    canonical.update(owner.key, (record) => {
      const allocation = record?.allocations[id];
      if (!record || !allocation) {
        rejection = "Crabbox allocation closed before preparation completed.";
        return undefined;
      }
      if (record.operation?.type === "capture" && record.operation.leaseId === id) {
        rejection = "Crabbox allocation cannot enroll while its image capture is unresolved.";
        return undefined;
      }
      if (baseCommit && allocation.baseCommit && baseCommit !== allocation.baseCommit) {
        rejection = "Crabbox provision retry changed its prepared Git commit.";
        return undefined;
      }
      if (phase === "enrolled" && record.projectKey && allocation.phase === "pending") {
        rejection = "Crabbox project allocation must be prepared before enrollment.";
        return undefined;
      }
      return {
        ...record,
        allocations: {
          ...record.allocations,
          [id]: {
            ...allocation,
            phase: allocation.phase === "enrolled" ? "enrolled" : phase,
            ...(baseCommit ? { baseCommit } : {}),
          },
        },
      };
    });
    if (rejection) {
      throw new Error(rejection);
    }
  };

  return {
    ...canonical,
    lookupLease,
    markPrepared: (id: string, baseCommit: string) => markPhase(id, "prepared", baseCommit),
    markEnrolled: (id: string) => markPhase(id, "enrolled"),
    notePreparedDemand(id: string, preparation: { preparationKey: string; demandAtMs: number }) {
      const owner = lookupLease(id);
      const generation = owner?.imageGeneration;
      if (
        !owner ||
        owner.preparationKey !== preparation.preparationKey ||
        owner.cacheKey === null ||
        !generation ||
        !Number.isSafeInteger(preparation.demandAtMs) ||
        preparation.demandAtMs < 0
      ) {
        return;
      }
      // Assignment has no provider fork. Refresh only the exact image this lease
      // selected or produced, never a replacement published while it waited ready.
      canonical.update(owner.key, (record) =>
        record?.image &&
        record.image.cacheKey === owner.cacheKey &&
        sameCrabboxWarmImageGeneration(record.image, generation) &&
        record.allocations[id]?.preparationKey === owner.preparationKey &&
        record.allocations[id]?.cacheKey === owner.cacheKey &&
        record.allocations[id]?.purpose === owner.purpose &&
        sameCrabboxWarmImageGeneration(record.allocations[id]?.imageGeneration, generation)
          ? {
              ...record,
              image: {
                ...record.image,
                lastDemandAtMs: Math.max(record.image.lastDemandAtMs ?? 0, preparation.demandAtMs),
              },
            }
          : undefined,
      );
    },
  };
}

export function withoutCrabboxWarmImageOperation(record: WarmProfileRecord): WarmProfileRecord {
  const profile = { ...record };
  delete profile.operation;
  return profile;
}

export function crabboxWarmImageCaptureStatus(_key: string, record: WarmProfileRecord) {
  const capture = record.operation?.type === "capture" ? record.operation : undefined;
  if (!capture) {
    return undefined;
  }
  return {
    selector: capture.id,
    startedAtMs: capture.startedAtMs,
    ...(capture.leaseId ? { leaseId: capture.leaseId } : {}),
    ...(capture.provider ? { provider: capture.provider } : {}),
    phase: capture.phase,
    stale: Date.now() - capture.startedAtMs >= CAPTURE_WARNING_AGE_MS,
  };
}

export function isCrabboxWarmImageCapturePaused(
  capture: NonNullable<ReturnType<typeof crabboxWarmImageCaptureStatus>>,
): boolean {
  return capture.stale || capture.phase === "uncertain";
}

export function crabboxWarmImageRecoveryHint(selector: string): string {
  return `Stop the owning Gateway and capture processes, confirm any worker being recovered is stopped, and resolve any untracked checkpoint in the Crabbox catalog before running: openclaw crabbox warm-images --recover ${selector} --acknowledge-provider-cleanup. Then restart the Gateway; the next eligible worker can capture again.`;
}

export function listCrabboxWarmImages(env?: NodeJS.ProcessEnv) {
  return openCrabboxWarmImageStore(env)
    .entries()
    .map(({ key, value }) => ({
      profileKey: key,
      projectKey: value.projectKey,
      checkpointId: value.image?.checkpointId,
      state: value.image?.state ?? "no-image",
      createdAtMs: value.image?.createdAtMs,
      preparationKey: value.image?.preparationKey,
      cacheKey: value.image?.cacheKey,
      purpose: value.image?.purpose,
      lastDemandAtMs: value.image?.lastDemandAtMs,
      baseCommit: value.image?.baseCommit,
      allocations: value.allocations,
      capture: crabboxWarmImageCaptureStatus(key, value),
      retirement:
        value.operation?.type === "retire"
          ? { checkpointId: value.operation.checkpointId }
          : undefined,
    }));
}

/** Recovery closes only the capture generation; allocation decisions remain authoritative. */
export function clearCrabboxWarmImageCapture(key: string, selector: string): boolean {
  const store = openCrabboxWarmImageStore();
  const matches = (current: WarmProfileRecord) =>
    current.operation?.type === "capture" && current.operation.id === selector;
  if (
    store.deleteIf(
      key,
      (current) =>
        !current.image && Object.keys(current.allocations).length === 0 && matches(current),
    )
  ) {
    return true;
  }
  return store.update(key, (current) =>
    current && matches(current) ? withoutCrabboxWarmImageOperation(current) : undefined,
  );
}

export function recoverCrabboxWarmImageCapture(
  selector: string,
  acknowledgeProviderCleanup: boolean,
): void {
  if (!acknowledgeProviderCleanup) {
    throw new Error(
      "Recovery requires --acknowledge-provider-cleanup: confirm the original Gateway/capture processes and any worker being recovered are stopped, and any untracked provider artifact has been resolved. No state was changed.",
    );
  }
  if (selector.startsWith("legacy-lease-")) {
    const store = openLegacyLeases();
    const entry = store
      .entries()
      .find(({ key, value }) => legacyLeaseSelector(key, value) === selector);
    if (
      !entry ||
      !store.deleteIf(entry.key, (value) => legacyLeaseSelector(entry.key, value) === selector)
    ) {
      throw new Error(
        "Legacy allocation selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
      );
    }
    return;
  }
  const entry = openCrabboxWarmImageStore()
    .entries()
    .find(({ key, value }) => crabboxWarmImageCaptureStatus(key, value)?.selector === selector);
  if (!entry || !clearCrabboxWarmImageCapture(entry.key, selector)) {
    throw new Error(
      "Capture selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
    );
  }
}
