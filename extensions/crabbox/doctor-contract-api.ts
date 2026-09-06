import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  WarmAllocationRecord,
  WarmImageRecord,
  WarmProfileRecord,
} from "./src/crabbox-worker-warm-image-store.js";

type LegacyWarmImageRecord = Omit<
  WarmImageRecord,
  "lastDemandAtMs" | "preparationKey" | "cacheKey" | "purpose"
> & {
  lastUsedAtMs: number;
  operation?: WarmProfileRecord["operation"];
};
type LegacyWarmAllocationRecord = Omit<
  WarmAllocationRecord,
  "preparationKey" | "demandAtMs" | "imageGeneration" | "cacheKey" | "purpose"
>;
type LegacyWarmProfileRecord = Omit<WarmProfileRecord, "version" | "image" | "allocations"> & {
  version: 2;
  image?: LegacyWarmImageRecord;
  allocations: Record<string, LegacyWarmAllocationRecord>;
};
type PriorPreparedImage = Omit<WarmImageRecord, "cacheKey" | "purpose">;
type PriorPreparedAllocation = Omit<WarmAllocationRecord, "cacheKey" | "purpose">;
type PriorPreparedProfile = Omit<WarmProfileRecord, "image" | "allocations"> & {
  image?: PriorPreparedImage;
  allocations: Record<string, PriorPreparedAllocation>;
};

const imageFields = new Set([
  "checkpointId",
  "kind",
  "state",
  "createdAtMs",
  "lastUsedAtMs",
  "baseCommit",
  "operation",
]);
const captureFields = new Set(["type", "id", "startedAtMs", "leaseId", "provider", "phase"]);
const retirementFields = new Set(["type", "checkpointId"]);
const profileFields = new Set(["version", "projectKey", "image", "allocations", "operation"]);
const allocationFields = new Set(["choice", "machineClass", "phase", "baseCommit"]);
const preparedImageFields = new Set([
  ...[...imageFields].filter((field) => field !== "lastUsedAtMs" && field !== "operation"),
  "preparationKey",
  "lastDemandAtMs",
]);
const preparedAllocationFields = new Set([
  ...allocationFields,
  "preparationKey",
  "demandAtMs",
  "imageGeneration",
]);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isLegacyOperation(value: unknown): value is WarmProfileRecord["operation"] {
  if (value === undefined) {
    return true;
  }
  const operation = asOptionalRecord(value);
  if (!operation) {
    return false;
  }
  if (operation.type === "retire") {
    return (
      Object.keys(operation).every((key) => retirementFields.has(key)) &&
      nonempty(operation.checkpointId)
    );
  }
  return (
    operation.type === "capture" &&
    Object.keys(operation).every((key) => captureFields.has(key)) &&
    nonempty(operation.id) &&
    timestamp(operation.startedAtMs) &&
    (operation.leaseId === undefined || nonempty(operation.leaseId)) &&
    (operation.provider === undefined || nonempty(operation.provider)) &&
    (operation.phase === "scrubbing" ||
      operation.phase === "creating" ||
      operation.phase === "uncertain")
  );
}

function isImageMetadata(value: unknown) {
  const image = asOptionalRecord(value);
  return Boolean(
    image &&
    typeof image.checkpointId === "string" &&
    typeof image.kind === "string" &&
    (image.state === "pending" || image.state === "available") &&
    timestamp(image.createdAtMs) &&
    (image.baseCommit === undefined || nonempty(image.baseCommit)) &&
    (image.checkpointId
      ? nonempty(image.checkpointId) && nonempty(image.kind)
      : image.kind === "" && image.state === "pending"),
  );
}

function isLegacyImage(value: unknown): value is LegacyWarmImageRecord {
  const image = asOptionalRecord(value);
  return Boolean(
    image &&
    Object.keys(image).every((key) => imageFields.has(key)) &&
    isImageMetadata(image) &&
    timestamp(image.lastUsedAtMs) &&
    isLegacyOperation(image.operation),
  );
}

function isAllocationMetadata(value: unknown) {
  const allocation = asOptionalRecord(value);
  const choice = asOptionalRecord(allocation?.choice);
  return Boolean(
    allocation &&
    choice &&
    nonempty(allocation.machineClass) &&
    (allocation.phase === "pending" ||
      allocation.phase === "prepared" ||
      allocation.phase === "enrolled") &&
    (allocation.baseCommit === undefined || nonempty(allocation.baseCommit)) &&
    (choice.kind === "cold"
      ? Object.keys(choice).every((key) => key === "kind")
      : choice.kind === "checkpoint" &&
        Object.keys(choice).every((key) => key === "kind" || key === "checkpointId") &&
        nonempty(choice.checkpointId)),
  );
}

function isLegacyAllocation(value: unknown): value is LegacyWarmAllocationRecord {
  const allocation = asOptionalRecord(value);
  return Boolean(
    allocation &&
    Object.keys(allocation).every((key) => allocationFields.has(key)) &&
    isAllocationMetadata(allocation),
  );
}

function needsCacheMigration(value: unknown): boolean {
  const profile = asOptionalRecord(value);
  const image = asOptionalRecord(profile?.image);
  const allocations = asOptionalRecord(profile?.allocations);
  return Boolean(
    profile?.version === 3 &&
    ((image && (image.cacheKey === undefined || image.purpose === undefined)) ||
      (allocations &&
        Object.values(allocations).some((entry) => {
          const allocation = asOptionalRecord(entry);
          return (
            allocation && (allocation.cacheKey === undefined || allocation.purpose === undefined)
          );
        }))),
  );
}

function isPriorPreparedProfile(value: unknown): value is PriorPreparedProfile {
  const profile = asOptionalRecord(value);
  const image = asOptionalRecord(profile?.image);
  const allocations = asOptionalRecord(profile?.allocations);
  const digest = (entry: unknown) =>
    entry === null || (typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry));
  const demand = (entry: unknown) =>
    entry === null || (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0);
  return Boolean(
    profile?.version === 3 &&
    Object.keys(profile).every((key) => profileFields.has(key)) &&
    (profile.projectKey === undefined || nonempty(profile.projectKey)) &&
    isLegacyOperation(profile.operation) &&
    (profile.image === undefined ||
      (image &&
        Object.keys(image).every((key) => preparedImageFields.has(key)) &&
        isImageMetadata(image) &&
        digest(image.preparationKey) &&
        demand(image.lastDemandAtMs) &&
        (image.preparationKey === null || image.lastDemandAtMs !== null))) &&
    allocations &&
    Object.values(allocations).every((entry) => {
      const allocation = asOptionalRecord(entry);
      const generation = asOptionalRecord(allocation?.imageGeneration);
      return (
        allocation &&
        Object.keys(allocation).every((key) => preparedAllocationFields.has(key)) &&
        isAllocationMetadata(allocation) &&
        digest(allocation.preparationKey) &&
        demand(allocation.demandAtMs) &&
        (allocation.preparationKey === null || allocation.demandAtMs !== null) &&
        (allocation.imageGeneration === null ||
          (generation &&
            Object.keys(generation).length === 2 &&
            nonempty(generation.checkpointId) &&
            Number.isSafeInteger(generation.createdAtMs) &&
            Number(generation.createdAtMs) >= 0))
      );
    }),
  );
}

function isLegacyProfile(value: unknown): value is LegacyWarmProfileRecord {
  const profile = asOptionalRecord(value);
  const allocations = asOptionalRecord(profile?.allocations);
  return Boolean(
    profile &&
    profile.version === 2 &&
    Object.keys(profile).every((key) => profileFields.has(key)) &&
    (profile.projectKey === undefined || nonempty(profile.projectKey)) &&
    (profile.image === undefined ||
      (isLegacyImage(profile.image) && profile.image.operation === undefined)) &&
    allocations &&
    Object.values(allocations).every(isLegacyAllocation) &&
    isLegacyOperation(profile.operation),
  );
}

function migrateImage({
  lastUsedAtMs: _lastUsedAtMs,
  operation: _operation,
  ...image
}: LegacyWarmImageRecord): WarmImageRecord {
  // Legacy use includes background forks, so it proves neither demand nor preparation identity.
  return { ...image, lastDemandAtMs: null, preparationKey: null, cacheKey: null, purpose: null };
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "crabbox-warm-profile-v3",
    label: "Crabbox warm profiles",
    doctorOnly: true,
    async detectLegacyState({ context, env }) {
      const { WARM_IMAGE_MAX_ENTRIES, listCrabboxLegacyWarmLeases } =
        await import("./src/crabbox-worker-warm-image-store.js");
      const images = await context
        .openPluginStateKeyedStore<unknown>({
          namespace: "warm-images",
          maxEntries: WARM_IMAGE_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        })
        .entries();
      const pending = images.filter(
        ({ value }) => asOptionalRecord(value)?.version !== 3 || needsCacheMigration(value),
      ).length;
      const leases = listCrabboxLegacyWarmLeases(env);
      return pending || leases.length
        ? {
            preview: [
              ...(pending
                ? [
                    `- ${pending} Crabbox warm-image row(s) require preparation/cache-record migration or manual repair.`,
                  ]
                : []),
              ...leases.map(
                (lease) =>
                  `- Legacy Crabbox lease ${lease.leaseId} requires provider cleanup acknowledgement: openclaw crabbox warm-images --recover ${lease.selector} --acknowledge-provider-cleanup`,
              ),
            ],
          }
        : null;
    },
    async migrateLegacyState({ context, env }) {
      const {
        WARM_IMAGE_MAX_ENTRIES,
        crabboxLegacyWarmImageCaptureSelector,
        listCrabboxLegacyWarmLeases,
      } = await import("./src/crabbox-worker-warm-image-store.js");
      const changes: string[] = [];
      const warnings: string[] = [];
      const store = context.openPluginStateKeyedStore<unknown>({
        namespace: "warm-images",
        maxEntries: WARM_IMAGE_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
      for (const { key, value } of await store.entries()) {
        if (asOptionalRecord(value)?.version === 3 && !needsCacheMigration(value)) {
          continue;
        }
        let migrated: WarmProfileRecord;
        if (isPriorPreparedProfile(value)) {
          // An opaque exact fingerprint cannot recover cache compatibility or allocation purpose.
          const { image, allocations, ...profile } = value;
          migrated = {
            ...profile,
            ...(image ? { image: { ...image, cacheKey: null, purpose: null } } : {}),
            allocations: Object.fromEntries(
              Object.entries(allocations).map(([id, allocation]) => [
                id,
                { ...allocation, cacheKey: null, purpose: null },
              ]),
            ),
          };
        } else if (isLegacyProfile(value)) {
          const { image, allocations, ...profile } = value;
          migrated = {
            ...profile,
            version: 3,
            ...(image ? { image: migrateImage(image) } : {}),
            allocations: Object.fromEntries(
              Object.entries(allocations).map(([id, allocation]) => [
                id,
                {
                  ...allocation,
                  preparationKey: null,
                  cacheKey: null,
                  purpose: null,
                  demandAtMs: null,
                  imageGeneration: null,
                },
              ]),
            ),
          };
        } else if (isLegacyImage(value)) {
          const { operation } = value;
          migrated = {
            version: 3,
            ...(value.checkpointId ? { image: migrateImage(value) } : {}),
            allocations: {},
            ...(operation
              ? { operation }
              : !value.checkpointId
                ? {
                    operation: {
                      type: "capture",
                      id: crabboxLegacyWarmImageCaptureSelector(key, value),
                      startedAtMs: value.createdAtMs,
                      phase: "uncertain",
                    },
                  }
                : {}),
          };
        } else {
          warnings.push(
            `Crabbox warm profile ${key} has an unsupported record; left it unchanged for manual repair.`,
          );
          continue;
        }
        try {
          // The maintenance owner excludes the Gateway; compare again so a changed row
          // cannot lose a paid capture or retirement obligation during publication.
          const changed = await store.update?.(key, (current) =>
            JSON.stringify(current) === JSON.stringify(value) ? migrated : undefined,
          );
          if (changed) {
            changes.push(
              `Migrated Crabbox warm profile ${key}, preserving resource obligations without inventing preparation, cache identity, purpose or demand.`,
            );
          } else {
            warnings.push(
              `Crabbox warm profile ${key} changed or atomic update is unavailable; left it unchanged.`,
            );
          }
        } catch (error) {
          warnings.push(
            `Failed migrating Crabbox warm profile ${key}; left it unchanged: ${String(error)}`,
          );
        }
      }
      const leases = listCrabboxLegacyWarmLeases(env);
      if (leases.length) {
        warnings.push(
          `${leases.length} legacy Crabbox lease row(s) still block warm-profile admission; their original cold/checkpoint choices are unknown.`,
        );
        for (const lease of leases) {
          warnings.push(
            `Resolve lease ${lease.leaseId} through its original Gateway or provider, stop the original Gateway/capture processes, and confirm provider cleanup before running: openclaw crabbox warm-images --recover ${lease.selector} --acknowledge-provider-cleanup. Then rerun openclaw doctor --fix. The row was not changed.`,
          );
        }
      }
      return { changes, warnings };
    },
  },
];
