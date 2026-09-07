import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  lastUsedAtMs: number;
  baseCommit?: string;
};

export type WarmAllocationRecord = {
  choice: { kind: "cold" } | { kind: "checkpoint"; checkpointId: string };
  machineClass: string;
  phase: "pending" | "prepared" | "enrolled";
  baseCommit?: string;
};

export type WarmProfileRecord = {
  version: 2;
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
  if (record && record.version !== 2) {
    throw new Error(
      "Crabbox warm-image state requires migration; run openclaw doctor --fix before provisioning workers.",
    );
  }
  return record;
}

export function openCrabboxWarmImageStore(env?: NodeJS.ProcessEnv) {
  const store = createPluginStateSyncKeyedStore<WarmProfileRecord>("crabbox", {
    namespace: "warm-images",
    maxEntries: WARM_IMAGE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
  return {
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
      lastUsedAtMs: value.image?.lastUsedAtMs,
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
