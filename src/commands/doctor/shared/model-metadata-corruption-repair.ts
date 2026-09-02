import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConfigAuditRecord } from "../../../config/io.audit.js";
import { getRecord } from "../../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveConfiguredModelCatalogOwnership } from "./legacy-config-migrations.runtime.models.catalog.js";

export type ModelMetadataCorruptionRepair = {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

const GENERATED_MODEL_FALLBACK = {
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  input: ["text"],
  maxTokens: 8192,
  reasoning: false,
} as const;
// The old writer persisted this complete generic-default tuple into untouched rows.
// Requiring every field avoids reclassifying ordinary explicit capability overrides.
const GENERATED_MODEL_FIELDS = ["cost", "input", "maxTokens", "reasoning"] as const;
export const MODEL_METADATA_CORRUPTION_AUDIT_LIMIT = 2048;

type ConfigWriteRecord = Extract<ConfigAuditRecord, { event: "config.write" }>;

function hasGeneratedFallbackFingerprint(model: Record<string, unknown>): boolean {
  return GENERATED_MODEL_FIELDS.every(
    (field) =>
      Object.hasOwn(model, field) &&
      isDeepStrictEqual(model[field], GENERATED_MODEL_FALLBACK[field]),
  );
}

function catalogDisagreesWithFallback(catalogRow: {
  cost?: unknown;
  input?: unknown;
  maxTokens?: unknown;
  reasoning?: unknown;
}): boolean {
  return GENERATED_MODEL_FIELDS.some(
    (field) => !isDeepStrictEqual(catalogRow[field], GENERATED_MODEL_FALLBACK[field]),
  );
}

function directlyAuthoredModel(params: {
  authoredRoot: unknown;
  providerId: string;
  modelIndex: number;
  modelId: string;
}): Record<string, unknown> | undefined {
  const provider = getRecord(getRecord(getRecord(params.authoredRoot)?.models)?.providers)?.[
    params.providerId
  ];
  const models = getRecord(provider)?.models;
  if (!Array.isArray(models)) {
    return undefined;
  }
  const model = getRecord(models[params.modelIndex]);
  return model?.id === params.modelId ? model : undefined;
}

function isSuccessfulWrite(record: ConfigWriteRecord): boolean {
  return record.result === "rename" || record.result === "copy-fallback";
}

function isHistoricalMaterializingWriter(record: ConfigWriteRecord): boolean {
  const updateFinalize = record.argv.some(
    (arg, index) => arg === "update" && record.argv[index + 1] === "finalize",
  );
  const repairDoctor =
    record.origin === "doctor" &&
    record.argv.includes("doctor") &&
    (record.argv.includes("--fix") || record.argv.includes("--yes"));
  return updateFinalize || repairDoctor;
}

function hasCandidateMetadataPaths(params: {
  record: ConfigWriteRecord;
  providerId: string;
  modelIndex: number;
}): boolean {
  if (!params.record.changedPaths) {
    return false;
  }
  const fields = new Set<string>();
  const prefix = `models.providers.${params.providerId}.models[${params.modelIndex}].`;
  for (const changedPath of params.record.changedPaths) {
    if (!changedPath.startsWith(prefix)) {
      continue;
    }
    const field = changedPath.slice(prefix.length).split(".", 1)[0];
    if (field && GENERATED_MODEL_FIELDS.some((candidate) => candidate === field)) {
      fields.add(field);
    }
  }
  return fields.size === GENERATED_MODEL_FIELDS.length;
}

function hasAuditProvenance(params: {
  auditRecords: readonly ConfigAuditRecord[];
  configPath: string;
  currentHash: string | null;
  providerId: string;
  modelIndex: number;
}): boolean {
  if (!params.currentHash) {
    return false;
  }
  const configPath = path.resolve(params.configPath);
  return params.auditRecords.some(
    (record) =>
      record.event === "config.write" &&
      isSuccessfulWrite(record) &&
      path.resolve(record.configPath) === configPath &&
      record.nextHash === params.currentHash &&
      isHistoricalMaterializingWriter(record) &&
      hasCandidateMetadataPaths({
        record,
        providerId: params.providerId,
        modelIndex: params.modelIndex,
      }),
  );
}

/** Repairs audit-proven model metadata written by the historical runtime-materialization bug. */
export function repairGeneratedModelMetadataCorruption(params: {
  config: OpenClawConfig;
  authoredRoot: unknown;
  configPath: string;
  currentHash: string | null;
  auditRecords: readonly ConfigAuditRecord[];
}): ModelMetadataCorruptionRepair {
  const next: OpenClawConfig = structuredClone(params.config);
  const providers = getRecord(getRecord(next.models)?.providers);
  if (!providers) {
    return { config: params.config, changes: [], warnings: [] };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const [providerId, providerValue] of Object.entries(providers)) {
    const provider = getRecord(providerValue);
    const models = provider?.models;
    if (!provider || !Array.isArray(models)) {
      continue;
    }
    for (const [modelIndex, modelValue] of models.entries()) {
      const model = getRecord(modelValue);
      const modelId = typeof model?.id === "string" ? model.id : "";
      if (!model || !modelId || !hasGeneratedFallbackFingerprint(model)) {
        continue;
      }
      const authoredModel = directlyAuthoredModel({
        authoredRoot: params.authoredRoot,
        providerId,
        modelIndex,
        modelId,
      });
      const catalog = resolveConfiguredModelCatalogOwnership({ providerId, provider, model });
      if (!catalog || !catalogDisagreesWithFallback(catalog.catalogRow)) {
        continue;
      }
      const modelPath = `models.providers.${providerId}.models[${modelIndex}]`;
      if (!catalog.ownsRoute) {
        warnings.push(
          `${modelPath} matches the historical generated model-metadata fingerprint, but its configured API route is not owned by the shipped provider catalog. It was left unchanged.`,
        );
        continue;
      }
      const auditProven = hasAuditProvenance({
        auditRecords: params.auditRecords,
        configPath: params.configPath,
        currentHash: params.currentHash,
        providerId,
        modelIndex,
      });
      if (!authoredModel || !hasGeneratedFallbackFingerprint(authoredModel) || !auditProven) {
        warnings.push(
          `${modelPath} matches the historical generated model-metadata fingerprint, but Doctor could not prove the responsible config write. It was left unchanged. If the provider catalog should own these capabilities, remove cost, input, maxTokens, and reasoning from this model entry.`,
        );
        continue;
      }
      for (const field of GENERATED_MODEL_FIELDS) {
        delete model[field];
      }
      changes.push(
        `Removed audit-proven generated model metadata from ${modelPath}: cost, input, maxTokens, reasoning.`,
      );
    }
  }
  return { config: changes.length > 0 ? next : params.config, changes, warnings };
}
