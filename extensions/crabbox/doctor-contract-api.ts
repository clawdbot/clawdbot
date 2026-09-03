import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WarmImageRecord, WarmProfileRecord } from "./src/crabbox-worker-warm-image-store.js";

type LegacyWarmImageRecord = WarmImageRecord & {
  operation?: WarmProfileRecord["operation"];
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

function isLegacyImage(value: unknown): value is LegacyWarmImageRecord {
  const image = asOptionalRecord(value);
  return Boolean(
    image &&
    Object.keys(image).every((key) => imageFields.has(key)) &&
    typeof image.checkpointId === "string" &&
    typeof image.kind === "string" &&
    (image.state === "pending" || image.state === "available") &&
    timestamp(image.createdAtMs) &&
    timestamp(image.lastUsedAtMs) &&
    (image.baseCommit === undefined || nonempty(image.baseCommit)) &&
    (image.checkpointId
      ? nonempty(image.checkpointId) && nonempty(image.kind)
      : image.kind === "" && image.state === "pending") &&
    isLegacyOperation(image.operation),
  );
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "crabbox-warm-profile-v2",
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
      const pending = images.filter(({ value }) => asOptionalRecord(value)?.version !== 2).length;
      const leases = listCrabboxLegacyWarmLeases(env);
      return pending || leases.length
        ? {
            preview: [
              ...(pending
                ? [
                    `- ${pending} legacy Crabbox warm-image row(s) require profile-envelope migration.`,
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
        if (asOptionalRecord(value)?.version === 2) {
          continue;
        }
        if (!isLegacyImage(value)) {
          warnings.push(
            `Crabbox warm profile ${key} has an unsupported record; left it unchanged for manual repair.`,
          );
          continue;
        }
        const { operation, ...image } = value;
        const migrated: WarmProfileRecord = {
          version: 2,
          ...(image.checkpointId ? { image } : {}),
          allocations: {},
          ...(operation
            ? { operation }
            : !image.checkpointId
              ? {
                  operation: {
                    type: "capture",
                    id: crabboxLegacyWarmImageCaptureSelector(key, value),
                    startedAtMs: image.createdAtMs,
                    phase: "uncertain",
                  },
                }
              : {}),
        };
        try {
          // The maintenance owner excludes the Gateway; compare again so a changed row
          // cannot lose a paid capture or retirement obligation during publication.
          const changed = await store.update?.(key, (current) =>
            JSON.stringify(current) === JSON.stringify(value) ? migrated : undefined,
          );
          if (changed) {
            changes.push(
              `Migrated Crabbox warm profile ${key} without inventing an allocation choice.`,
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
